// Uber Tabs service worker.
// Owns the tree model (groups + nodes) and persists it in chrome.storage.local.
// A node is a "live" tab when node.tabId != null, otherwise a "saved" tab that
// survives tab close / Chrome shutdown and can be reopened from the panel.

// The UI lives in its own standalone popup-type window (not Chrome's side panel).
const PANEL_URL = chrome.runtime.getURL('src/sidepanel/panel.html');

async function findPanelWindow() {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
  return wins.find((w) => w.tabs?.some((t) => (t.url || t.pendingUrl || '').startsWith(PANEL_URL)));
}

async function openPanelWindow() {
  const existing = await findPanelWindow();
  if (existing) {
    await chrome.windows.update(existing.id, { focused: true, drawAttention: true });
    return;
  }
  const { panelBounds } = await chrome.storage.local.get('panelBounds');
  await chrome.windows.create({
    url: PANEL_URL,
    type: 'popup',
    width: 360,
    height: 800,
    ...(panelBounds || {}),
  });
}

chrome.action.onClicked.addListener(() => openPanelWindow().catch((e) => console.error(e)));

// Remember where the user put the window.
chrome.windows.onBoundsChanged?.addListener(async (w) => {
  if (w.type !== 'popup' || !(await findPanelWindow().then((p) => p?.id === w.id))) return;
  chrome.storage.local.set({ panelBounds: { left: w.left, top: w.top, width: w.width, height: w.height } });
});

// Tabs should open in a normal browser window, never inside the panel window.
async function targetWindowId() {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  return (wins.find((w) => w.focused) || wins[wins.length - 1])?.id;
}

const INBOX = 'inbox';

// ---------- state ----------
async function load() {
  const { state } = await chrome.storage.local.get('state');
  return (
    state || {
      groups: [{ id: INBOX, name: 'Inbox', collapsed: false, color: 0 }],
      nodes: [],
    }
  );
}
const save = (s) => chrome.storage.local.set({ state: s });

// Serialize every mutation so concurrent events can't clobber each other.
let queue = Promise.resolve();
function run(fn) {
  const res = queue.then(async () => {
    const s = await load();
    const out = await fn(s);
    await save(s);
    return out;
  });
  queue = res.catch((e) => console.error(e));
  return res;
}

const uid = () => crypto.randomUUID();
const isBlank = (u) =>
  !u ||
  u.startsWith(PANEL_URL) ||
  u === 'about:blank' ||
  u.startsWith('chrome://newtab') ||
  u.startsWith('chrome://new-tab-page') ||
  u.startsWith('chrome-search://');
const tabUrl = (t) => t.url || t.pendingUrl || '';

// ---------- model helpers ----------
function adopt(s, t) {
  const url = tabUrl(t);
  if (isBlank(url)) return;

  // Re-link to a saved node with the same URL (restart / session restore).
  let n = s.nodes.find((x) => x.tabId == null && x.url === url);
  if (!n) {
    n = { id: uid(), groupId: INBOX };
    const opener = t.openerTabId != null && s.nodes.find((x) => x.tabId === t.openerTabId);
    if (opener) {
      n.groupId = opener.groupId;
      s.nodes.splice(s.nodes.indexOf(opener) + 1, 0, n);
    } else {
      s.nodes.push(n);
    }
  }
  n.tabId = t.id;
  n.windowId = t.windowId;
  n.url = url;
  n.title = t.title || url;
}

function reconcile(s, tabs) {
  const live = new Set(tabs.map((t) => t.id));
  for (const n of s.nodes) if (n.tabId != null && !live.has(n.tabId)) n.tabId = null;
  const linked = new Map(s.nodes.filter((n) => n.tabId != null).map((n) => [n.tabId, n]));
  for (const t of tabs) {
    const n = linked.get(t.id);
    if (n) {
      n.windowId = t.windowId;
      if (!isBlank(tabUrl(t))) {
        n.url = tabUrl(t);
        n.title = t.title || n.url;
      }
    } else {
      adopt(s, t);
    }
  }
}

function moveNode(s, nodeId, groupId, beforeId) {
  const n = s.nodes.find((x) => x.id === nodeId);
  if (!n || !s.groups.some((g) => g.id === groupId)) return;
  if (beforeId === nodeId) {
    n.groupId = groupId;
    return;
  }
  s.nodes.splice(s.nodes.indexOf(n), 1);
  n.groupId = groupId;
  let idx = beforeId ? s.nodes.findIndex((x) => x.id === beforeId) : -1;
  if (idx < 0) {
    idx = s.nodes.map((x) => x.groupId).lastIndexOf(groupId) + 1;
    if (idx === 0) idx = s.nodes.length;
  }
  s.nodes.splice(idx, 0, n);
}

function moveGroup(s, groupId, beforeId) {
  const g = s.groups.find((x) => x.id === groupId);
  if (!g || beforeId === groupId) return;
  s.groups.splice(s.groups.indexOf(g), 1);
  const idx = beforeId ? s.groups.findIndex((x) => x.id === beforeId) : -1;
  s.groups.splice(idx < 0 ? s.groups.length : idx, 0, g);
}

// ---------- chrome helpers ----------
async function closeTabs(ids) {
  if (!ids.length) return;
  const tabs = (await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  const byWin = {};
  for (const t of tabs) (byWin[t.windowId] ||= []).push(t.id);
  // Don't let closing the last tab of a window close the window.
  for (const [w, closing] of Object.entries(byWin)) {
    const all = await chrome.tabs.query({ windowId: +w });
    if (all.every((t) => closing.includes(t.id))) await chrome.tabs.create({ windowId: +w, active: true });
  }
  await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
}

async function openNode(n, active) {
  if (n.tabId != null) {
    try {
      const t = await chrome.tabs.get(n.tabId);
      if (active) {
        await chrome.tabs.update(t.id, { active: true });
        await chrome.windows.update(t.windowId, { focused: true });
      }
      return;
    } catch {
      n.tabId = null;
    }
  }
  const t = await chrome.tabs.create({ url: n.url, active, windowId: await targetWindowId() });
  n.tabId = t.id;
  n.windowId = t.windowId;
}

// ---------- commands from the panel ----------
const commands = {
  async sync(s) {
    reconcile(s, await chrome.tabs.query({}));
    return { state: s };
  },
  open: (s, m) => openNode(s.nodes.find((n) => n.id === m.nodeId), true),
  async closeTab(s, m) {
    const n = s.nodes.find((x) => x.id === m.nodeId);
    if (n?.tabId != null) await closeTabs([n.tabId]);
  },
  async deleteNode(s, m) {
    const i = s.nodes.findIndex((x) => x.id === m.nodeId);
    if (i < 0) return;
    const [n] = s.nodes.splice(i, 1);
    if (n.tabId != null) await closeTabs([n.tabId]);
  },
  moveNode: (s, m) => moveNode(s, m.nodeId, m.groupId, m.beforeId),
  moveGroup: (s, m) => moveGroup(s, m.groupId, m.beforeId),
  addGroup(s, m) {
    const g = { id: uid(), name: m.name || 'New group', collapsed: false, color: s.groups.length % 8 + 1 };
    s.groups.push(g);
    return { id: g.id };
  },
  renameGroup(s, m) {
    const g = s.groups.find((x) => x.id === m.groupId);
    if (g && m.name?.trim()) g.name = m.name.trim();
  },
  toggleGroup(s, m) {
    const g = s.groups.find((x) => x.id === m.groupId);
    if (g) g.collapsed = !g.collapsed;
  },
  recolorGroup(s, m) {
    const g = s.groups.find((x) => x.id === m.groupId);
    if (g) g.color = ((g.color || 0) + 1) % 9;
  },
  deleteGroup(s, m) {
    if (m.groupId === INBOX) return;
    for (const n of s.nodes) if (n.groupId === m.groupId) n.groupId = INBOX;
    s.groups = s.groups.filter((g) => g.id !== m.groupId);
  },
  async closeGroup(s, m) {
    await closeTabs(s.nodes.filter((n) => n.groupId === m.groupId && n.tabId != null).map((n) => n.tabId));
  },
  async restoreGroup(s, m) {
    for (const n of s.nodes.filter((x) => x.groupId === m.groupId && x.tabId == null)) await openNode(n, false);
  },
  async newTab(s, m) {
    const t = await chrome.tabs.create({ active: true, windowId: await targetWindowId() });
    // Blank tabs aren't listed until they navigate; remember the target group.
    s.pendingGroup = { tabId: t.id, groupId: m.groupId };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const fn = commands[msg?.cmd];
  if (!fn) return false;
  run((s) => fn(s, msg)).then((r) => respond(r ?? {}), (e) => respond({ error: String(e) }));
  return true;
});

// ---------- tab events ----------
chrome.tabs.onCreated.addListener((t) =>
  run((s) => {
    if (!s.nodes.some((n) => n.tabId === t.id)) adopt(s, t);
  })
);

chrome.tabs.onUpdated.addListener((id, change, t) =>
  run((s) => {
    const n = s.nodes.find((x) => x.tabId === id);
    if (!n) {
      if (!isBlank(tabUrl(t))) {
        adopt(s, t);
        if (s.pendingGroup?.tabId === id) {
          const added = s.nodes.find((x) => x.tabId === id);
          if (added) moveNode(s, added.id, s.pendingGroup.groupId, null);
          delete s.pendingGroup;
        }
      }
      return;
    }
    if (change.url && !isBlank(change.url)) n.url = change.url;
    if (change.title) n.title = change.title;
    n.windowId = t.windowId;
  })
);

chrome.tabs.onRemoved.addListener((id) =>
  run((s) => {
    const n = s.nodes.find((x) => x.tabId === id);
    if (n) n.tabId = null;
    if (s.pendingGroup?.tabId === id) delete s.pendingGroup;
  })
);

chrome.tabs.onReplaced.addListener((added, removed) =>
  run((s) => {
    const n = s.nodes.find((x) => x.tabId === removed);
    if (n) n.tabId = added;
  })
);

// ---------- lifecycle ----------
// Tab IDs don't survive a browser restart: demote everything to "saved", then
// re-link tabs that Chrome restores (matched by URL).
chrome.runtime.onStartup.addListener(() =>
  run(async (s) => {
    for (const n of s.nodes) n.tabId = null;
    reconcile(s, await chrome.tabs.query({}));
  })
);

chrome.runtime.onInstalled.addListener(() =>
  run(async (s) => reconcile(s, await chrome.tabs.query({})))
);
