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


// ---------- state ----------
async function load() {
  const { state } = await chrome.storage.local.get('state');
  if (state) {
    state.nodes = state.nodes.filter((n) => !n.url?.startsWith(PANEL_URL)); // the panel never belongs in its own outline
    return state;
  }
  return { groups: [], nodes: [] };
}
const save = async (s) => {
  await chrome.storage.local.set({ state: s });
  scheduleSync(s);
};

function applyImport(s, d) {
  if (!d || !Array.isArray(d.groups) || !Array.isArray(d.nodes)) throw new Error('Not a Tabolith export');
  const str = (v) => (typeof v === 'string' ? v : '');
  const groups = d.groups
    .filter((g) => g && str(g.id))
    .map((g) => ({ id: str(g.id), name: str(g.name), collapsed: !!g.collapsed, color: Number(g.color) || 0 }));
  const ids = new Set(groups.map((g) => g.id));
  s.groups = groups;
  s.nodes = d.nodes
    .filter((n) => n && str(n.id) && str(n.url) && !n.url.startsWith(PANEL_URL) && ids.has(n.groupId))
    .map((n) => ({ id: str(n.id), groupId: n.groupId, url: n.url, title: str(n.title) || n.url, tabId: null }));
  delete s.pendingGroup;
}

// ---------- optional sync (chrome.storage.sync) ----------
// The tree is gzipped + base64'd and split into chunks to fit sync's 8KB-per-item / 100KB quotas.
// The on/off flag lives in sync too, so a reinstall picks the setting and the data back up.
const SYNC_CHUNK = 7000;
const SYNC_MAX = 90000;
let syncTimer;
let lastSynced = null;

const snapshot = (s) => ({
  groups: s.groups.map(({ id, name, collapsed, color }) => ({ id, name, collapsed, color })),
  nodes: s.nodes.map(({ id, groupId, url, title }) => ({ id, groupId, url, title })),
});
async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
async function pack(obj) {
  const u8 = await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream('gzip'));
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function unpack(str) {
  const u8 = await pipe(Uint8Array.from(atob(str), (c) => c.charCodeAt(0)), new DecompressionStream('gzip'));
  return JSON.parse(new TextDecoder().decode(u8));
}
async function pushSync(snap, force) {
  if (!force && !(await chrome.storage.sync.get('tb_on')).tb_on) return;
  const packed = await pack(snap);
  if (!force && packed === lastSynced) return;
  if (packed.length > SYNC_MAX) throw new Error('Too much to fit in Chrome sync (about 90KB compressed).');
  const old = (await chrome.storage.sync.get('tb_n')).tb_n || 0;
  const parts = Math.ceil(packed.length / SYNC_CHUNK);
  const items = { tb_n: parts };
  for (let i = 0; i < parts; i++) items['tb_' + i] = packed.slice(i * SYNC_CHUNK, (i + 1) * SYNC_CHUNK);
  await chrome.storage.sync.set(items);
  const stale = [];
  for (let i = parts; i < old; i++) stale.push('tb_' + i);
  if (stale.length) await chrome.storage.sync.remove(stale);
  lastSynced = packed;
  await chrome.storage.local.remove('syncError');
}
async function pullSync(ignoreFlag) {
  const { tb_on, tb_n } = await chrome.storage.sync.get(['tb_on', 'tb_n']);
  if ((!tb_on && !ignoreFlag) || !tb_n) return null;
  const keys = Array.from({ length: tb_n }, (_, i) => 'tb_' + i);
  const got = await chrome.storage.sync.get(keys);
  if (keys.some((k) => typeof got[k] !== 'string')) return null;
  return unpack(keys.map((k) => got[k]).join(''));
}
function scheduleSync(s) {
  clearTimeout(syncTimer);
  const snap = snapshot(s);
  syncTimer = setTimeout(
    () => pushSync(snap).catch((e) => chrome.storage.local.set({ syncError: String(e.message || e) })),
    5000
  );
}

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
// Tabs with no URL yet, and the panel itself, never go in the outline. New-tab pages do.
const isIgnored = (u) => !u || u.startsWith(PANEL_URL);
const isNewTabPage = (u) =>
  u === 'about:blank' || u.startsWith('chrome://newtab') || u.startsWith('chrome://new-tab-page') || u.startsWith('chrome-search://');
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
  if (n.tabId != null && !isNewTabPage(n.url)) rememberClosed(s, n); // a new-tab page has no place worth returning to
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
  if (isIgnored(url)) return null;
  let restored = null;

  // Re-link to a saved node with the same URL (restart / session restore).
  let n = s.nodes.find((x) => x.tabId == null && x.url === url);
  if (!n) {
    n = { id: uid() };
    if (restoreClosed(s, n, url)) {
      restored = n;
    } else {
      // A tab belongs to the group that owns its window; otherwise follow its opener.
      // Tabs in windows we don't track (popups, incognito) stay out of the outline.
      const opener = t.openerTabId != null && s.nodes.find((x) => x.tabId === t.openerTabId);
      const windowGroup = s.groups.find((g) => g.windowId != null && g.windowId === t.windowId);
      n.groupId = windowGroup?.id ?? opener?.groupId;
      if (!n.groupId) return null;
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
      if (!isIgnored(tabUrl(t))) {
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

// Every browser window is a group. A window nobody owns gets a new group of its own, named
// "Window N"; it's deleted again if the window closes while it is still empty and unrenamed.
async function ensureWindowGroup(s, windowId) {
  if (windowId == null) return null;
  const owner = s.groups.find((g) => g.windowId === windowId);
  if (owner) return owner;
  const w = await chrome.windows.get(windowId).catch(() => null);
  if (!w || w.type !== 'normal' || w.incognito) return null;
  const used = s.groups.map((g) => /^Window (\d+)$/.exec(g.name)?.[1]).filter(Boolean).map(Number);
  const g = {
    id: uid(),
    name: `Window ${Math.max(0, ...used) + 1}`,
    collapsed: false,
    color: (s.groups.length % 8) + 1,
    windowId,
    auto: true,
  };
  const bounds = await boundsOf(windowId);
  if (Object.keys(bounds).length) g.bounds = bounds;
  s.groups.push(g);
  return g;
}

// Link open tabs to the outline: re-link saved tabs, give each window a group (an existing group
// that holds most of its tabs, else a new one), then adopt the tabs that had no group yet.
async function reconcileAll(s) {
  reconcile(s, await chrome.tabs.query({}));
  relinkGroupWindows(s);
  await assignWindowGroups(s);
  reconcile(s, await chrome.tabs.query({}));
}

// Give every unowned window a group and move the tabs it holds into it.
async function assignWindowGroups(s) {
  for (const w of await chrome.windows.getAll({ windowTypes: ['normal'] })) {
    if (s.groups.some((g) => g.windowId === w.id)) continue;
    const g = await ensureWindowGroup(s, w.id);
    if (!g) continue;
    const mine = s.nodes.filter((n) => n.tabId != null && n.windowId === w.id && n.groupId !== g.id).map((n) => n.id);
    if (mine.length) moveNodes(s, mine, g.id, null);
  }
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
  const owned = s.groups.filter((g) => g.windowId != null);
  const takenGroups = new Set(owned);
  const takenWindows = new Set(owned.map((g) => g.windowId));
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
    await reconcileAll(s);
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
    if (g && m.name?.trim()) {
      g.name = m.name.trim();
      delete g.auto;
    }
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
  // Deleting a group closes all of its tabs.
  async deleteGroup(s, m) {
    const members = s.nodes.filter((n) => n.groupId === m.groupId);
    s.groups = s.groups.filter((g) => g.id !== m.groupId);
    // Not remembered for position restore: the group they'd return to is gone.
    const gone = new Set(members);
    s.nodes = s.nodes.filter((n) => !gone.has(n));
    await closeTabs(members.filter((n) => n.tabId != null).map((n) => n.tabId), { closeEmptyWindows: true });
    await assignWindowGroups(s); // a last surviving window still needs a group
  },
  // Gather every group's open tabs into that group's window (opens windows as needed).
  async arrangeWindows(s) {
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
  // Replace all groups and tabs with an exported backup; live tabs re-link by URL.
  async importState(s, m) {
    applyImport(s, m.data);
    await reconcileAll(s);
    return { state: s };
  },
  // Turn sync with the Google account on or off.
  async setSync(s, m) {
    if (!m.on) {
      await chrome.storage.sync.clear();
      await chrome.storage.local.remove('syncError');
      return {};
    }
    // Brand-new install with a synced copy available: restore it instead of overwriting it.
    if (!s.nodes.length) {
      const snap = await pullSync(true);
      if (snap) {
        applyImport(s, snap);
        await reconcileAll(s);
        await chrome.storage.sync.set({ tb_on: true });
        return { state: s, restored: true };
      }
    }
    await pushSync(snapshot(s), true);
    await chrome.storage.sync.set({ tb_on: true });
    return {};
  },
  // Reopen every saved tab in every group (each opens in its group's window).
  async restoreAll(s) {
    for (const n of s.nodes.filter((x) => x.tabId == null)) await openNode(s, n, false);
  },
  async newTab(s, m) {
    const g = s.groups.find((x) => x.id === m.groupId);
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
// Put a tab that was restored from the closed list back into its old group's window. If that
// group has no window any more, the tab stays where it is and joins that window's group instead.
async function returnToGroupWindow(s, n) {
  if (!n) return;
  const g = s.groups.find((x) => x.id === n.groupId);
  const windowId = g && (await liveGroupWindow(g));
  if (windowId != null) {
    if (n.windowId !== windowId) await chrome.tabs.move(n.tabId, { windowId, index: -1 }).catch(() => {});
    return;
  }
  const here = s.groups.find((x) => x.windowId === n.windowId);
  if (here && here.id !== n.groupId) moveNodes(s, [n.id], here.id, null);
}

// A tab opened with "new tab" in a group goes into that group.
function applyPendingGroup(s, tabId) {
  if (s.pendingGroup?.tabId !== tabId) return;
  const added = s.nodes.find((x) => x.tabId === tabId);
  if (added) moveNodes(s, [added.id], s.pendingGroup.groupId, null);
  delete s.pendingGroup;
}

chrome.tabs.onCreated.addListener((t) =>
  run(async (s) => {
    if (s.nodes.some((n) => n.tabId === t.id)) return;
    await ensureWindowGroup(s, t.windowId);
    await returnToGroupWindow(s, adopt(s, t));
    applyPendingGroup(s, t.id);
  })
);

chrome.tabs.onUpdated.addListener((id, change, t) =>
  run(async (s) => {
    const n = s.nodes.find((x) => x.tabId === id);
    if (!n) {
      if (!isIgnored(tabUrl(t))) {
        await ensureWindowGroup(s, t.windowId);
        await returnToGroupWindow(s, adopt(s, t));
        applyPendingGroup(s, id);
      }
      return;
    }
    if (change.url && !isIgnored(change.url)) n.url = change.url;
    if (change.title) n.title = change.title;
    n.windowId = t.windowId;
  })
);

// Closing a tab removes it from the outline. When its whole window is closing
// (e.g. Chrome quitting) keep it as a saved entry so it survives a restart (except new-tab pages).
chrome.tabs.onRemoved.addListener((id, info) =>
  run((s) => {
    const n = s.nodes.find((x) => x.tabId === id);
    if (n) {
      if (!info.isWindowClosing || isNewTabPage(n.url)) removeNode(s, n);
      else n.tabId = null; // keep a closing window's tabs saved; an empty new-tab page isn't worth saving
    }
    if (s.pendingGroup?.tabId === id) delete s.pendingGroup;
  })
);

// Dragging a tab into another group's window moves it into that group (a new window becomes a new group).
chrome.tabs.onAttached.addListener((tabId, info) =>
  run(async (s) => {
    const n = s.nodes.find((x) => x.tabId === tabId);
    if (!n) return;
    n.windowId = info.newWindowId;
    const owner = await ensureWindowGroup(s, info.newWindowId); // a window nobody owns becomes a new group
    if (owner && owner.id !== n.groupId) moveNodes(s, [n.id], owner.id, null);
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

chrome.windows.onCreated.addListener((w) => {
  if (w.type === 'normal') run((s) => ensureWindowGroup(s, w.id).then(() => {}));
});

chrome.windows.onRemoved.addListener((windowId) =>
  run((s) => {
    for (const g of s.groups) {
      if (g.windowId !== windowId) continue;
      delete g.windowId;
      // A window group nobody used or renamed goes away with its window.
      if (g.auto && !s.nodes.some((n) => n.groupId === g.id)) s.groups = s.groups.filter((x) => x !== g);
    }
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
    await reconcileAll(s);
  });
  // Optional (⚙ menu): open the Tabolith window along with Chrome.
  const { openOnStartup } = await chrome.storage.local.get('openOnStartup');
  if (openOnStartup) await openPanelWindow();
});

chrome.runtime.onInstalled.addListener(() =>
  run(async (s) => {
    // Fresh install with sync enabled on this account: bring the saved tree back.
    if (!s.nodes.length) {
      try {
        const snap = await pullSync();
        if (snap) applyImport(s, snap);
      } catch (e) {
        console.error('Tabolith: sync restore failed', e);
      }
    }
    await reconcileAll(s);
  })
);
