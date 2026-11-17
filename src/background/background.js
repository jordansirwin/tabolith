// Tabolith service worker.
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
const INBOX_NAME = 'Unorganized Mess';

// ---------- state ----------
async function load() {
  const { state } = await chrome.storage.local.get('state');
  if (state) {
    // The default group's name is fixed (it can't be renamed).
    const inbox = state.groups.find((g) => g.id === INBOX);
    if (inbox) inbox.name = INBOX_NAME;
    return state;
  }
  return {
    groups: [{ id: INBOX, name: INBOX_NAME, collapsed: false, color: 0 }],
    nodes: [],
  };
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

// ---------- recently closed tabs ----------
// Closing a tab drops it from the outline. Remember where it was so that
// reopening the same URL (e.g. Cmd+Shift+T) puts it back in place.
const CLOSED_LIMIT = 50;

function rememberClosed(s, n) {
  const sameGroup = s.nodes.filter((x) => x.groupId === n.groupId);
  const i = sameGroup.indexOf(n);
  (s.closed ||= []).unshift({
    url: n.url,
    groupId: n.groupId,
    prevId: sameGroup[i - 1]?.id ?? null,
    nextId: sameGroup[i + 1]?.id ?? null,
  });
  s.closed.length = Math.min(s.closed.length, CLOSED_LIMIT);
}

// Remove a node from the outline, remembering its position if it had an open tab.
function removeNode(s, n) {
  if (n.tabId != null) rememberClosed(s, n);
  s.nodes.splice(s.nodes.indexOf(n), 1);
}

// If `url` was recently closed, insert `n` where it used to be. Returns whether it did.
function restoreClosed(s, n, url) {
  const ci = (s.closed || []).findIndex((c) => c.url === url && s.groups.some((g) => g.id === c.groupId));
  if (ci < 0) return false;
  const [rec] = s.closed.splice(ci, 1);
  n.groupId = rec.groupId;
  const inGroup = (id) => s.nodes.findIndex((x) => x.id === id && x.groupId === rec.groupId);
  let idx = rec.prevId ? inGroup(rec.prevId) + 1 || -1 : -1;
  if (idx < 0 && rec.nextId) idx = inGroup(rec.nextId);
  if (idx < 0) {
    idx = s.nodes.length;
    for (let i = s.nodes.length - 1; i >= 0; i--) {
      if (s.nodes[i].groupId === rec.groupId) {
        idx = i + 1;
        break;
      }
    }
  }
  s.nodes.splice(idx, 0, n);
  return true;
}

// ---------- model helpers ----------
function adopt(s, t) {
  const url = tabUrl(t);
  if (isBlank(url)) return;

  // Re-link to a saved node with the same URL (restart / session restore).
  let n = s.nodes.find((x) => x.tabId == null && x.url === url);
  if (!n) {
    n = { id: uid(), groupId: INBOX };
    const opener = t.openerTabId != null && s.nodes.find((x) => x.tabId === t.openerTabId);
    if (!restoreClosed(s, n, url)) {
      if (opener) {
        n.groupId = opener.groupId;
        s.nodes.splice(s.nodes.indexOf(opener) + 1, 0, n);
      } else {
        s.nodes.push(n);
      }
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

// Move one or more nodes into a group before `beforeId` (or at its end), keeping their relative order.
function moveNodes(s, ids, groupId, beforeId) {
  const set = new Set(ids);
  if (!s.groups.some((g) => g.id === groupId)) return;
  const moving = s.nodes.filter((n) => set.has(n.id));
  if (!moving.length) return;
  // If the anchor is itself being moved, anchor on the next node that stays put.
  let anchor = beforeId;
  if (anchor && set.has(anchor)) {
    let i = s.nodes.findIndex((x) => x.id === anchor);
    while (i < s.nodes.length && set.has(s.nodes[i].id)) i++;
    anchor = s.nodes[i]?.id ?? null;
  }
  s.nodes = s.nodes.filter((n) => !set.has(n.id));
  for (const n of moving) n.groupId = groupId;
  let idx = anchor ? s.nodes.findIndex((x) => x.id === anchor) : -1;
  if (idx < 0) {
    idx = s.nodes.length;
    for (let i = s.nodes.length - 1; i >= 0; i--) {
      if (s.nodes[i].groupId === groupId) {
        idx = i + 1;
        break;
      }
    }
  }
  s.nodes.splice(idx, 0, ...moving);
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
  async deleteNode(s, m) {
    const n = s.nodes.find((x) => x.id === m.nodeId);
    if (!n) return;
    removeNode(s, n);
    if (n.tabId != null) await closeTabs([n.tabId]);
  },
  async deleteNodes(s, m) {
    const ids = new Set(m.nodeIds);
    const gone = s.nodes.filter((x) => ids.has(x.id));
    for (const n of gone) removeNode(s, n);
    const tabIds = gone.filter((n) => n.tabId != null).map((n) => n.tabId);
    if (tabIds.length) await closeTabs(tabIds);
  },
  moveNodes: (s, m) => moveNodes(s, m.nodeIds, m.groupId, m.beforeId),
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
  // Explicit "close but keep saved": demote first so onRemoved doesn't delete the nodes.
  async closeGroup(s, m) {
    const open = s.nodes.filter((n) => n.groupId === m.groupId && n.tabId != null);
    const ids = open.map((n) => n.tabId);
    for (const n of open) n.tabId = null;
    await closeTabs(ids);
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
          if (added) moveNodes(s, [added.id], s.pendingGroup.groupId, null);
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

// Closing a tab removes it from the outline. When its whole window is closing
// (e.g. Chrome quitting) keep it as a saved entry so it survives a restart.
chrome.tabs.onRemoved.addListener((id, info) =>
  run((s) => {
    const n = s.nodes.find((x) => x.tabId === id);
    if (n) {
      if (info.isWindowClosing) n.tabId = null;
      else removeNode(s, n);
    }
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
