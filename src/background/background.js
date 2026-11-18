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

// Opens the panel window (or raises it). With `search`, the search box ends up focused.
async function openPanelWindow({ search = false } = {}) {
  const existing = await findPanelWindow();
  if (existing) {
    await chrome.windows.update(existing.id, { focused: true, drawAttention: true });
    if (search) await chrome.runtime.sendMessage({ type: 'focusSearch' }).catch(() => {});
    return;
  }
  const { panelBounds } = await chrome.storage.local.get('panelBounds');
  await chrome.windows.create({
    url: PANEL_URL + (search ? '#search' : ''),
    type: 'popup',
    width: 360,
    height: 800,
    ...(panelBounds || {}),
  });
}

chrome.action.onClicked.addListener(() => openPanelWindow().catch((e) => console.error(e)));
chrome.commands.onCommand.addListener((command) => {
  if (command === 'search-tabs') openPanelWindow({ search: true }).catch((e) => console.error(e));
});

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
    state.nodes = state.nodes.filter((n) => !n.url?.startsWith(PANEL_URL)); // the panel never belongs in its own outline
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

// Index just after the last node of a group (end of the list if the group is empty).
function groupEndIndex(s, groupId) {
  for (let i = s.nodes.length - 1; i >= 0; i--) if (s.nodes[i].groupId === groupId) return i + 1;
  return s.nodes.length;
}

// ---------- recently closed tabs ----------
// Closing a tab drops it from the outline. Remember where it was so that
// reopening the same URL (e.g. Cmd+Shift+T) puts it back in place.
const CLOSED_LIMIT = 50;
const CLOSED_TTL_MS = 10 * 60 * 1000; // only restore position for tabs reopened within 10 minutes

function rememberClosed(s, n) {
  const sameGroup = s.nodes.filter((x) => x.groupId === n.groupId);
  const i = sameGroup.indexOf(n);
  const now = Date.now();
  s.closed = (s.closed || []).filter((c) => now - c.closedAt < CLOSED_TTL_MS);
  s.closed.unshift({
    closedAt: now,
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
  const now = Date.now();
  const ci = (s.closed || []).findIndex(
    (c) => c.url === url && now - c.closedAt < CLOSED_TTL_MS && s.groups.some((g) => g.id === c.groupId)
  );
  if (ci < 0) return false;
  const [rec] = s.closed.splice(ci, 1);
  n.groupId = rec.groupId;
  const inGroup = (id) => s.nodes.findIndex((x) => x.id === id && x.groupId === rec.groupId);
  let idx = rec.prevId ? inGroup(rec.prevId) + 1 || -1 : -1;
  if (idx < 0 && rec.nextId) idx = inGroup(rec.nextId);
  if (idx < 0) idx = groupEndIndex(s, rec.groupId);
  s.nodes.splice(idx, 0, n);
  return true;
}

// ---------- model helpers ----------
// Returns the node if it was put back where a recently closed tab used to be, else null.
function adopt(s, t) {
  const url = tabUrl(t);
  if (isBlank(url)) return null;
  let restored = null;

  // Re-link to a saved node with the same URL (restart / session restore).
  let n = s.nodes.find((x) => x.tabId == null && x.url === url);
  if (!n) {
    n = { id: uid(), groupId: INBOX };
    if (restoreClosed(s, n, url)) {
      restored = n;
    } else {
      // A tab belongs to the group that owns its window; otherwise follow its opener.
      const opener = t.openerTabId != null && s.nodes.find((x) => x.tabId === t.openerTabId);
      const windowGroup = s.groups.find((g) => g.windowId != null && g.windowId === t.windowId);
      n.groupId = windowGroup?.id ?? opener?.groupId ?? INBOX;
      if (opener && opener.groupId === n.groupId) s.nodes.splice(s.nodes.indexOf(opener) + 1, 0, n);
      else s.nodes.splice(groupEndIndex(s, n.groupId), 0, n);
    }
  }
  n.tabId = t.id;
  n.windowId = t.windowId;
  n.url = url;
  n.title = t.title || url;
  return restored;
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
  if (idx < 0) idx = groupEndIndex(s, groupId);
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
// By default a window never closes just because its last tab did (a blank tab is left behind).
// `closeEmptyWindows` lets it close, except for the very last browser window.
async function closeTabs(ids, { closeEmptyWindows = false } = {}) {
  if (!ids.length) return;
  const tabs = (await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  const byWin = {};
  for (const t of tabs) (byWin[t.windowId] ||= []).push(t.id);
  // Don't let closing the last tab of a window close the window.
  // Windows that would be left with no tabs.
  const emptying = [];
  for (const [w, closing] of Object.entries(byWin)) {
    const all = await chrome.tabs.query({ windowId: +w });
    if (all.every((t) => closing.includes(t.id))) emptying.push(+w);
  }
  // Keep a blank tab in each emptied window, or (when windows may close) in just one of them if
  // no other browser window would survive.
  let keep = emptying;
  if (closeEmptyWindows) {
    const total = (await chrome.windows.getAll({ windowTypes: ['normal'] })).length;
    keep = total > emptying.length ? [] : emptying.slice(0, 1);
  }
  for (const windowId of keep) await chrome.tabs.create({ windowId, active: true });
  await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
}

// ---------- group windows ----------
// Each group owns one browser window (group.windowId). Window IDs only live as long as the
// browser session, so they're cleared on startup and when a window closes.
const isLiveWindow = (id) =>
  id == null ? Promise.resolve(false) : chrome.windows.get(id).then((w) => w.type === 'normal', () => false);

async function liveGroupWindow(g) {
  return (await isLiveWindow(g.windowId)) ? g.windowId : null;
}

// Where a new window should open: the same position and size as `windowId` (or maximized if it is).
async function boundsOf(windowId) {
  const w = windowId == null ? null : await chrome.windows.get(windowId).catch(() => null);
  if (!w || w.state === 'minimized' || w.state === 'fullscreen') return {};
  if (w.state === 'maximized') return { state: 'maximized' };
  return { left: w.left, top: w.top, width: w.width, height: w.height };
}

// Open a window for a group where that group's window was last seen. A group that has never had
// one copies the position and size of `refWindowId` instead.
async function createGroupWindow(s, g, opts, refWindowId) {
  const bounds = g.bounds ?? (await boundsOf(refWindowId));
  const w = await chrome.windows.create({ ...opts, ...bounds }).catch(() => null);
  if (!w) return null;
  g.windowId = w.id;
  if (Object.keys(bounds).length) g.bounds = bounds;
  return w;
}

// The default group adopts a browser window nobody else owns (preferably the one you're using).
async function mapInboxWindow(s) {
  const inbox = s.groups.find((g) => g.id === INBOX);
  if (!inbox || (await liveGroupWindow(inbox)) != null) return;
  const owned = new Set(s.groups.filter((g) => g !== inbox && g.windowId != null).map((g) => g.windowId));
  const free = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter((w) => !owned.has(w.id));
  const w = free.find((x) => x.focused) || free[free.length - 1];
  if (!w) return void delete inbox.windowId;
  inbox.windowId = w.id;
  const bounds = await boundsOf(w.id);
  if (Object.keys(bounds).length) inbox.bounds = bounds;
}

// After a restart Chrome restores the windows but the group links are gone. Give each group the
// window holding most of its tabs (one window per group, biggest overlaps first).
function relinkGroupWindows(s) {
  const overlaps = [];
  for (const g of s.groups) {
    const counts = new Map();
    for (const n of s.nodes) if (n.groupId === g.id && n.tabId != null) counts.set(n.windowId, (counts.get(n.windowId) || 0) + 1);
    for (const [windowId, count] of counts) overlaps.push({ g, windowId, count });
  }
  const takenGroups = new Set();
  const takenWindows = new Set();
  for (const { g, windowId } of overlaps.sort((a, b) => b.count - a.count)) {
    if (takenGroups.has(g) || takenWindows.has(windowId)) continue;
    g.windowId = windowId;
    takenGroups.add(g);
    takenWindows.add(windowId);
  }
}

// Put an open tab into its group's window, opening a window for the group if it has none.
async function ensureInWindow(s, g, tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  if (g.id === INBOX) await mapInboxWindow(s);
  const windowId = await liveGroupWindow(g);
  if (windowId != null) {
    if (tab.windowId !== windowId) await chrome.tabs.move(tabId, { windowId, index: -1 }).catch(() => {});
    return;
  }
  await createGroupWindow(s, g, { tabId, focused: false }, tab.windowId);
}

async function openNode(s, n, active) {
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
  const g = s.groups.find((x) => x.id === n.groupId);
  if (g?.id === INBOX) await mapInboxWindow(s);
  const windowId = g && (await liveGroupWindow(g));
  const target = await targetWindowId();
  let t;
  if (g && windowId == null) {
    const w = await createGroupWindow(s, g, { url: n.url, focused: active }, target);
    t = w ? w.tabs[0] : await chrome.tabs.create({ url: n.url, active, windowId: target });
  } else {
    t = await chrome.tabs.create({ url: n.url, active, windowId: windowId ?? target });
  }
  n.tabId = t.id;
  n.windowId = t.windowId;
}

// ---------- commands from the panel ----------
const commands = {
  async sync(s) {
    await mapInboxWindow(s);
    reconcile(s, await chrome.tabs.query({}));
    return { state: s };
  },
  open: (s, m) => openNode(s, s.nodes.find((n) => n.id === m.nodeId), true),
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
  async moveNodes(s, m) {
    const before = new Map(s.nodes.map((n) => [n.id, n.groupId]));
    moveNodes(s, m.nodeIds, m.groupId, m.beforeId);
    const g = s.groups.find((x) => x.id === m.groupId);
    if (!g) return;
    // Tabs that changed group follow it into the group's window.
    for (const n of s.nodes) {
      if (n.tabId != null && before.has(n.id) && before.get(n.id) !== n.groupId && m.nodeIds.includes(n.id)) {
        await ensureInWindow(s, g, n.tabId);
      }
    }
  },
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
  setAllCollapsed(s, m) {
    for (const g of s.groups) g.collapsed = !!m.collapsed;
  },
  setGroupColor(s, m) {
    const g = s.groups.find((x) => x.id === m.groupId);
    if (g && Number.isInteger(m.color) && m.color >= 0) g.color = m.color;
  },
  // m.tabs: 'move' (default) sends the group's tabs to the default group; 'close' closes them all.
  async deleteGroup(s, m) {
    if (m.groupId === INBOX) return;
    const members = s.nodes.filter((n) => n.groupId === m.groupId);
    s.groups = s.groups.filter((g) => g.id !== m.groupId);
    if (m.tabs === 'close') {
      // Not remembered for position restore: the group they'd return to is gone.
      const gone = new Set(members);
      s.nodes = s.nodes.filter((n) => !gone.has(n));
      await closeTabs(members.filter((n) => n.tabId != null).map((n) => n.tabId), { closeEmptyWindows: true });
      return;
    }
    const inbox = s.groups.find((g) => g.id === INBOX);
    for (const n of members) n.groupId = INBOX;
    for (const n of members) if (n.tabId != null) await ensureInWindow(s, inbox, n.tabId);
  },
  // Gather every group's open tabs into that group's window (opens windows as needed).
  async arrangeWindows(s) {
    await mapInboxWindow(s);
    for (const g of s.groups) {
      for (const n of s.nodes.filter((x) => x.groupId === g.id && x.tabId != null)) await ensureInWindow(s, g, n.tabId);
    }
  },
  // Explicit "close but keep saved": demote first so onRemoved doesn't delete the nodes.
  async closeGroup(s, m) {
    const open = s.nodes.filter((n) => n.groupId === m.groupId && n.tabId != null);
    const ids = open.map((n) => n.tabId);
    for (const n of open) n.tabId = null;
    await closeTabs(ids);
  },
  // Bring the group's window to the front. With no window or real tab to show, do nothing:
  // raising an unrelated window would bury the panel.
  async focusGroup(s, m) {
    const g = s.groups.find((x) => x.id === m.groupId);
    const windowId = g && (await liveGroupWindow(g));
    if (windowId != null) return chrome.windows.update(windowId, { focused: true });
    for (const n of s.nodes) {
      if (n.groupId !== m.groupId || n.tabId == null) continue;
      const tab = await chrome.tabs.get(n.tabId).catch(() => null);
      if (!tab || tabUrl(tab).startsWith(PANEL_URL)) continue;
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  },
  async reloadGroup(s, m) {
    const open = s.nodes.filter((n) => n.groupId === m.groupId && n.tabId != null);
    await Promise.all(open.map((n) => chrome.tabs.reload(n.tabId).catch(() => {})));
  },
  async restoreGroup(s, m) {
    for (const n of s.nodes.filter((x) => x.groupId === m.groupId && x.tabId == null)) await openNode(s, n, false);
  },
  // Reopen every saved tab in every group (each opens in its group's window).
  // Replace all groups and tabs with an exported backup; live tabs re-link by URL.
  async importState(s, m) {
    const d = m.data;
    if (!d || !Array.isArray(d.groups) || !Array.isArray(d.nodes)) throw new Error('Not a Tabolith export');
    const str = (v) => (typeof v === 'string' ? v : '');
    const groups = d.groups
      .filter((g) => g && str(g.id))
      .map((g) => ({ id: str(g.id), name: str(g.name), collapsed: !!g.collapsed, color: Number(g.color) || 0 }));
    if (!groups.some((g) => g.id === INBOX)) groups.unshift({ id: INBOX, name: INBOX_NAME, collapsed: false, color: 0 });
    const ids = new Set(groups.map((g) => g.id));
    const nodes = d.nodes
      .filter((n) => n && str(n.id) && str(n.url) && !n.url.startsWith(PANEL_URL))
      .map((n) => ({ id: str(n.id), groupId: ids.has(n.groupId) ? n.groupId : INBOX, url: n.url, title: str(n.title) || n.url, tabId: null }));
    s.groups = groups;
    s.nodes = nodes;
    delete s.pendingGroup;
    reconcile(s, await chrome.tabs.query({}));
    return { state: s };
  },
  async restoreAll(s) {
    for (const n of s.nodes.filter((x) => x.tabId == null)) await openNode(s, n, false);
  },
  async newTab(s, m) {
    const g = s.groups.find((x) => x.id === m.groupId);
    if (g?.id === INBOX) await mapInboxWindow(s);
    const windowId = g && (await liveGroupWindow(g));
    const target = await targetWindowId();
    let t;
    if (g && windowId == null) {
      const w = await createGroupWindow(s, g, { focused: true }, target);
      t = w ? w.tabs[0] : await chrome.tabs.create({ active: true, windowId: target });
    } else {
      t = await chrome.tabs.create({ active: true, windowId: windowId ?? target });
    }
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
// Put a tab that was restored from the closed list back into its old group's window.
async function returnToGroupWindow(s, n) {
  const g = n && s.groups.find((x) => x.id === n.groupId);
  const windowId = g && (await liveGroupWindow(g));
  if (windowId != null && n.windowId !== windowId) await chrome.tabs.move(n.tabId, { windowId, index: -1 }).catch(() => {});
}

chrome.tabs.onCreated.addListener((t) =>
  run(async (s) => {
    if (!s.nodes.some((n) => n.tabId === t.id)) await returnToGroupWindow(s, adopt(s, t));
  })
);

chrome.tabs.onUpdated.addListener((id, change, t) =>
  run(async (s) => {
    const n = s.nodes.find((x) => x.tabId === id);
    if (!n) {
      if (!isBlank(tabUrl(t))) {
        await returnToGroupWindow(s, adopt(s, t));
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

// Dragging a tab into another group's window moves it into that group (an unowned window means the default group).
chrome.tabs.onAttached.addListener((tabId, info) =>
  run((s) => {
    const n = s.nodes.find((x) => x.tabId === tabId);
    if (!n) return;
    n.windowId = info.newWindowId;
    const owner = s.groups.find((x) => x.windowId === info.newWindowId);
    const groupId = owner?.id ?? INBOX; // unowned windows are the default group's territory
    if (groupId !== n.groupId) moveNodes(s, [n.id], groupId, null);
  })
);

const boundsTimers = new Map();
chrome.windows.onBoundsChanged?.addListener((w) => {
  clearTimeout(boundsTimers.get(w.id));
  boundsTimers.set(
    w.id,
    setTimeout(() => {
      boundsTimers.delete(w.id);
      run(async (s) => {
        const g = s.groups.find((x) => x.windowId === w.id);
        const bounds = g && (await boundsOf(w.id));
        if (bounds && Object.keys(bounds).length) g.bounds = bounds;
      }).catch(() => {});
    }, 500)
  );
});

chrome.windows.onRemoved.addListener((windowId) =>
  run((s) => {
    for (const g of s.groups) if (g.windowId === windowId) delete g.windowId;
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
chrome.runtime.onStartup.addListener(async () => {
  await run(async (s) => {
    for (const n of s.nodes) n.tabId = null;
    for (const g of s.groups) delete g.windowId; // window IDs don't survive a restart
    reconcile(s, await chrome.tabs.query({}));
    relinkGroupWindows(s);
    await mapInboxWindow(s);
  });
  // Optional (⚙ menu): open the Tabolith window along with Chrome.
  const { openOnStartup } = await chrome.storage.local.get('openOnStartup');
  if (openOnStartup) await openPanelWindow();
});

chrome.runtime.onInstalled.addListener(() =>
  run(async (s) => reconcile(s, await chrome.tabs.query({})))
);
