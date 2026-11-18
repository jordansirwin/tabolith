const INBOX = 'inbox';
const COLORS = [
  '#8b949e', '#e5534b', '#e0823d', '#c9a227', '#57ab5a', '#39a9c7', '#6d8cf5', '#b083f0', '#e275ad',
  '#1fa89a', '#8cc63f', '#f2a900', '#a0724a', '#ff7f6e', '#d6409f', '#4b52c9', '#5bb8f5', '#6b7b8c', '#6fd6a3',
  '#a63d40', '#8a8f3a', '#2f7d4f', '#2f5fa8', '#b9a6f0', '#f4b183',
];
const COLOR_NAMES = [
  'Gray', 'Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Purple', 'Pink',
  'Teal', 'Lime', 'Amber', 'Brown', 'Coral', 'Magenta', 'Indigo', 'Sky', 'Slate', 'Mint',
  'Maroon', 'Olive', 'Forest', 'Navy', 'Lavender', 'Peach',
];

const FONT_SIZES = [8, 9, 10, 11, 12, 13, 14];
// The default lives in panel.css (:root --font-size); read it before any override is applied.
const DEFAULT_FONT_SIZE = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--font-size'), 10) || 12;
let fontSize = DEFAULT_FONT_SIZE;
function applyFontSize(px) {
  fontSize = FONT_SIZES.includes(px) ? px : DEFAULT_FONT_SIZE;
  document.documentElement.style.setProperty('--font-size', fontSize + 'px');
}
// Per-window UI preference: localStorage is synchronous, so the saved size applies before first paint.
try {
  applyFontSize(Number(localStorage.getItem('fontSize')));
} catch {}

const tree = document.getElementById('tree');
let state = { groups: [], nodes: [] };
let activeTabId = null;
let dragging = null; // { type: 'node' | 'group', id }
let pendingRender = false;
let editing = null; // group id being renamed
let filter = '';
const selected = new Set(); // node ids
let selectedGroup = null; // group id
let anchorId = null; // last plain/ctrl-clicked row, for shift-range
let visibleOrder = []; // node ids in rendered order

// Surface failures (e.g. a stale service worker that doesn't know a command yet).
const send = (msg) =>
  chrome.runtime.sendMessage(msg).then(
    (r) => {
      if (r?.error) console.error('Tabolith:', msg.cmd, r.error);
      return r;
    },
    (err) => {
      console.error('Tabolith:', msg.cmd, 'failed:', err?.message || err);
    }
  );
const favicon = (url) => `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=32`;

const groupColor = (g) => COLORS[(g.color || 0) % COLORS.length];

function groupDot(g) {
  const dot = el('span', 'dot');
  dot.style.background = groupColor(g);
  return dot;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function iconButton(label, title, onClick) {
  const b = el('button', null, label);
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return b;
}

// ---------- drag & drop helpers ----------
const half = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
};
function clearMarks() {
  document
    .querySelectorAll('.drop-before, .drop-after, .drop-into, .drop-end')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-end'));
}
function startDrag(e, type, id, node) {
  // Dragging a selected row drags the whole selection.
  const ids = type === 'node' ? targetIds(id) : [id];
  dragging = { type, id, ids };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  setTimeout(() => {
    node.classList.add('dragging');
    if (ids.length > 1) document.querySelectorAll('.row.selected').forEach((r) => r.classList.add('dragging'));
  }, 0);
}
function endDrag() {
  dragging = null;
  clearMarks();
  if (pendingRender) {
    pendingRender = false;
    render();
  }
}
function drop(cmd) {
  clearMarks();
  dragging = null;
  send(cmd);
}
// Chrome's native edge auto-scroll is unreliable in the side panel, so do it by hand.
tree.addEventListener('dragover', (e) => {
  if (!dragging) return;
  const r = tree.getBoundingClientRect();
  const zone = Math.min(60, r.height / 3);
  let dy = 0;
  if (e.clientY < r.top + zone) dy = -Math.ceil(((r.top + zone - e.clientY) / zone) * 18);
  else if (e.clientY > r.bottom - zone) dy = Math.ceil(((e.clientY - (r.bottom - zone)) / zone) * 18);
  if (dy) tree.scrollTop += dy;
});
const dragIs = (t) => dragging && dragging.type === t;

// ---------- context menu ----------
let menu = null;
function closeMenu() {
  menu?.remove();
  menu = null;
}
// items: [{ label, onClick, disabled, dot, submenu: [...items], subClass } | '-']
function buildMenu(container, items) {
  for (const it of items) {
    if (it === '-') {
      container.append(el('div', 'ctx-sep'));
      continue;
    }
    const row = el('div', 'ctx-item' + (it.disabled ? ' disabled' : ''));
    if (it.dot) row.append(it.dot);
    row.append(el('span', it.submenu ? 'grow' : null, it.label));
    if (it.submenu) addSubmenu(row, it.submenu, it.subClass);
    else if (!it.disabled) {
      row.addEventListener('click', () => {
        closeMenu();
        it.onClick();
      });
    }
    container.append(row);
  }
}

function addSubmenu(parent, items, subClass) {
  parent.classList.add('has-sub');
  parent.append(el('span', 'ctx-arrow', '▸'));
  const sub = el('div', 'ctx ctx-sub' + (subClass ? ' ' + subClass : ''));
  buildMenu(sub, items);
  parent.append(sub);

  const openSub = () => {
    parent.classList.add('open');
    const pr = parent.getBoundingClientRect();
    const sr = sub.getBoundingClientRect();
    // Prefer the right side; flip left if it doesn't fit.
    const left = pr.right + sr.width <= innerWidth ? pr.right - 2 : Math.max(0, pr.left - sr.width + 2);
    sub.style.left = left + 'px';
    sub.style.top = Math.max(0, Math.min(pr.top - 4, innerHeight - sr.height)) + 'px';
  };
  // Small close delay so the pointer can travel diagonally into the submenu.
  let closeTimer = null;
  parent.addEventListener('mouseenter', () => {
    clearTimeout(closeTimer);
    openSub();
  });
  parent.addEventListener('mouseleave', () => {
    closeTimer = setTimeout(() => parent.classList.remove('open'), 250);
  });
  parent.addEventListener('click', (ev) => {
    ev.stopPropagation(); // keep the menu open; click toggles the submenu (touch)
    openSub();
  });
}

// Context-menu entry point for mouse events.
function showMenu(e, items) {
  e.preventDefault();
  // Don't let the document-level handler below immediately close the new menu.
  e.stopPropagation();
  openMenuAt(e.clientX, e.clientY, items);
}

function openMenuAt(x, y, items) {
  closeMenu();
  menu = el('div', 'ctx');
  buildMenu(menu, items);
  document.body.append(menu);
  // Keep the menu inside the window.
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(0, Math.min(x, innerWidth - r.width)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, innerHeight - r.height)) + 'px';
}

function nodeMenuItems(n) {
  const ids = targetIds(n.id);
  const gid = new Map(state.nodes.map((x) => [x.id, x.groupId]));
  const fromGroups = new Set(ids.map((id) => gid.get(id)));
  const moveTo = (groupId) => send({ cmd: 'moveNodes', nodeIds: ids, groupId, beforeId: null });
  return [
    {
      label: ids.length > 1 ? `Move ${ids.length} tabs to group` : 'Move to group',
      submenu: [
        ...state.groups.map((g) => ({
          label: g.name,
          dot: groupDot(g),
          disabled: fromGroups.size === 1 && fromGroups.has(g.id),
          onClick: () => moveTo(g.id),
        })),
        '-',
        {
          label: '+ New group…',
          async onClick() {
            const r = await send({ cmd: 'addGroup', name: 'New group' });
            if (!r?.id) return;
            await moveTo(r.id);
            editing = r.id;
            render();
          },
        },
      ],
    },
    {
      label: ids.length > 1 ? `Close ${ids.length} tabs` : 'Close tab',
      onClick: () => {
        selected.clear();
        send({ cmd: 'deleteNodes', nodeIds: ids });
      },
    },
  ];
}

function groupMenuItems(g) {
  const gs = state.groups;
  const i = gs.findIndex((x) => x.id === g.id);
  const first = i === 0;
  const last = i === gs.length - 1;
  const moveBefore = (beforeId) => () => send({ cmd: 'moveGroup', groupId: g.id, beforeId });
  return [
    {
      label: 'Rename',
      disabled: g.id === INBOX,
      onClick: () => {
        editing = g.id;
        render();
      },
    },
    {
      label: 'Color',
      subClass: 'ctx-compact',
      submenu: COLORS.map((_, i) => ({
        label: COLOR_NAMES[i],
        dot: groupDot({ color: i }),
        disabled: (g.color || 0) % COLORS.length === i,
        onClick: () => send({ cmd: 'setGroupColor', groupId: g.id, color: i }),
      })),
    },
    {
      label: 'Reload tabs',
      disabled: !state.nodes.some((n) => n.groupId === g.id && n.tabId != null),
      onClick: () => send({ cmd: 'reloadGroup', groupId: g.id }),
    },
    {
      label: 'Move',
      submenu: [
        { label: 'To top', disabled: first, onClick: moveBefore(gs[0].id) },
        { label: 'To bottom', disabled: last, onClick: moveBefore(null) },
        { label: 'Up', disabled: first, onClick: moveBefore(gs[i - 1]?.id) },
        { label: 'Down', disabled: last, onClick: moveBefore(gs[i + 2]?.id ?? null) },
      ],
    },
  ];
}
// An empty group is deleted right away; otherwise ask what should happen to its tabs.
function confirmDeleteGroup(g, count, anchor) {
  if (!count) return send({ cmd: 'deleteGroup', groupId: g.id });
  const noun = count === 1 ? 'tab' : 'tabs';
  const r = anchor.getBoundingClientRect();
  openMenuAt(r.left - 120, r.bottom + 2, [
    { label: `Move ${count} ${noun} to Unorganized Mess`, onClick: () => send({ cmd: 'deleteGroup', groupId: g.id, tabs: 'move' }) },
    { label: `Close ${count === 1 ? 'the tab' : `all ${count} tabs`}`, onClick: () => send({ cmd: 'deleteGroup', groupId: g.id, tabs: 'close' }) },
  ]);
}

async function exportData() {
  const { state: st } = await chrome.storage.local.get('state');
  const data = {
    tabolith: 1,
    groups: st.groups.map(({ id, name, collapsed, color }) => ({ id, name, collapsed, color })),
    nodes: st.nodes.map(({ id, groupId, url, title }) => ({ id, groupId, url, title })),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `tabolith-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return alert('That file is not valid JSON.');
    }
    if (!Array.isArray(data?.groups) || !Array.isArray(data?.nodes)) return alert('That is not a Tabolith export.');
    if (!confirm(`Replace all current groups and tabs with ${data.groups.length} groups and ${data.nodes.length} tabs from this file?`)) return;
    const r = await send({ cmd: 'importState', data });
    if (r?.error) alert('Import failed: ' + r.error);
  };
  input.click();
}

let openOnStartup = false; // refreshed each time the settings menu opens
const CONFIRM_RESTORE_OVER = 20; // ask before reopening more saved tabs than this

function settingsMenuItems() {
  const savedCount = state.nodes.filter((n) => n.tabId == null).length;
  return [
    {
      label: savedCount ? `Reopen all saved tabs (${savedCount})` : 'Reopen all saved tabs',
      disabled: !savedCount,
      onClick: () => {
        if (savedCount > CONFIRM_RESTORE_OVER && !confirm(`Reopen ${savedCount} saved tabs?`)) return;
        send({ cmd: 'restoreAll' });
      },
    },
    {
      label: 'Arrange groups into windows',
      onClick: () => send({ cmd: 'arrangeWindows' }),
    },
    {
      label: `${openOnStartup ? '✓ ' : ''}Open when Chrome starts`,
      onClick: () => {
        openOnStartup = !openOnStartup;
        chrome.storage.local.set({ openOnStartup });
      },
    },
    {
      label: 'Font size',
      subClass: 'ctx-compact',
      submenu: FONT_SIZES.map((px) => ({
        label: `${px}px${px === fontSize ? ' ✓' : ''}`,
        onClick: () => {
          applyFontSize(px);
          try {
            localStorage.setItem('fontSize', px);
          } catch {}
        },
      })),
    },
    {
      label: 'Import/Export',
      submenu: [
        { label: 'Export groups and tabs…', onClick: exportData },
        { label: 'Import groups and tabs…', onClick: importData },
      ],
    },
  ];
}
document.addEventListener('click', closeMenu);
document.addEventListener('contextmenu', (e) => {
  if (menu && !menu.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (menu) closeMenu();
  else if ((selected.size || selectedGroup) && document.activeElement?.tagName !== 'INPUT') {
    selected.clear();
    selectedGroup = null;
    paintSelection();
  }
});
window.addEventListener('blur', closeMenu);
tree.addEventListener('scroll', closeMenu);

// ---------- rendering ----------
// A row acts on the whole selection if it's part of it, otherwise just itself.
const targetIds = (id) => (selected.has(id) ? [...selected] : [id]);

function selectOnly(id) {
  selectedGroup = null;
  selected.clear();
  selected.add(id);
  anchorId = id;
  paintSelection();
}

function selectGroup(id) {
  selected.clear();
  selectedGroup = id;
  paintSelection();
}

function paintSelection() {
  document.querySelectorAll('.row[data-id]').forEach((r) => r.classList.toggle('selected', selected.has(r.dataset.id)));
  document.querySelectorAll('.ghead[data-gid]').forEach((h) => h.classList.toggle('selected', h.dataset.gid === selectedGroup));
}

function renderNode(n, g, siblings) {
  const live = n.tabId != null;
  const row = el('div', `row ${live ? 'live' : 'saved'}${live && n.tabId === activeTabId ? ' active' : ''}`);
  row.draggable = true;
  row.title = n.url;

  const img = el('img');
  img.src = favicon(n.url);
  img.addEventListener('error', () => (img.style.visibility = 'hidden'));
  row.append(img, el('span', 'title', n.title || n.url));

  const x = el('button', 'x', '×');
  x.title = live ? 'Close tab and remove it from the outline' : 'Remove from outline';
  x.addEventListener('dblclick', (e) => e.stopPropagation());
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    send({ cmd: 'deleteNode', nodeId: n.id });
  });
  row.append(x);

  visibleOrder.push(n.id);
  if (selected.has(n.id)) row.classList.add('selected');
  row.dataset.id = n.id;
  // Single click only selects; double-click opens. Selection changes toggle
  // classes in place (no re-render) so the second click of a double-click
  // still lands on the same element and fires dblclick.
  row.addEventListener('click', (e) => {
    selectedGroup = null;
    if (e.shiftKey && anchorId && visibleOrder.includes(anchorId)) {
      const a = visibleOrder.indexOf(anchorId);
      const b = visibleOrder.indexOf(n.id);
      if (!e.metaKey && !e.ctrlKey) selected.clear();
      for (const id of visibleOrder.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(id);
    } else if (e.metaKey || e.ctrlKey) {
      selected.has(n.id) ? selected.delete(n.id) : selected.add(n.id);
      anchorId = n.id;
    } else {
      selectOnly(n.id);
      return;
    }
    paintSelection();
  });
  row.addEventListener('dblclick', (e) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) return;
    send({ cmd: 'open', nodeId: n.id });
  });
  row.addEventListener('contextmenu', (e) => {
    // Right-clicking outside the selection selects just that row.
    if (!selected.has(n.id)) selectOnly(n.id);
    showMenu(e, nodeMenuItems(n));
  });
  row.addEventListener('dragstart', (e) => startDrag(e, 'node', n.id, row));
  row.addEventListener('dragend', endDrag);
  row.addEventListener('dragover', (e) => {
    if (!dragIs('node')) return;
    e.preventDefault();
    e.stopPropagation();
    clearMarks();
    row.classList.add('drop-' + half(e));
  });
  row.addEventListener('drop', (e) => {
    if (!dragIs('node')) return;
    e.preventDefault();
    e.stopPropagation();
    const i = siblings.findIndex((s) => s.id === n.id);
    const beforeId = half(e) === 'before' ? n.id : siblings[i + 1]?.id ?? null;
    drop({ cmd: 'moveNodes', nodeIds: dragging.ids, groupId: g.id, beforeId });
  });
  return row;
}

function renderGroup(g, all, shown, searching) {
  const sec = el('section', 'group');
  const collapsed = g.collapsed && !searching;

  const head = el('div', 'ghead');
  head.draggable = editing !== g.id;
  head.dataset.gid = g.id;
  head.style.setProperty('--gc', groupColor(g));
  if (selectedGroup === g.id) head.classList.add('selected');
  head.append(iconButton(collapsed ? '▸' : '▾', collapsed ? 'Expand' : 'Collapse', () => send({ cmd: 'toggleGroup', groupId: g.id })));
  head.lastChild.className = 'chev';

  head.append(groupDot(g));

  if (editing === g.id) {
    const input = el('input', 'gname-input');
    input.value = g.name;
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      editing = null;
      // Re-render once the rename lands (storage may not change if the name is unchanged).
      if (commit && input.value.trim()) send({ cmd: 'renameGroup', groupId: g.id, name: input.value }).then(render);
      else render();
    };
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    head.append(input);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  } else {
    head.append(el('span', 'gname', g.name));
  }

  const live = all.filter((n) => n.tabId != null).length;
  head.append(el('span', 'count', live ? `${live}/${all.length}` : `${all.length}`));

  const actions = el('div', 'gactions');
  actions.append(iconButton('+', 'New tab in this group', () => send({ cmd: 'newTab', groupId: g.id })));
  if (live) actions.append(iconButton('⏏', 'Close open tabs (keep them saved)', () => send({ cmd: 'closeGroup', groupId: g.id })));
  if (live < all.length) actions.append(iconButton('↺', 'Reopen saved tabs', () => send({ cmd: 'restoreGroup', groupId: g.id })));
  if (g.id !== INBOX) actions.append(iconButton('×', 'Delete group', (e) => confirmDeleteGroup(g, all.length, e.currentTarget)));
  head.append(actions);

  head.addEventListener('click', () => selectGroup(g.id));
  head.addEventListener('dblclick', (e) => {
    if (!e.target.closest('button, input')) send({ cmd: 'focusGroup', groupId: g.id });
  });
  head.addEventListener('contextmenu', (e) => {
    selectGroup(g.id);
    showMenu(e, groupMenuItems(g));
  });
  head.addEventListener('dragstart', (e) => startDrag(e, 'group', g.id, head));
  head.addEventListener('dragend', endDrag);
  head.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    clearMarks();
    head.classList.add(dragIs('node') ? 'drop-into' : 'drop-' + half(e));
  });
  head.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragIs('node')) {
      drop({ cmd: 'moveNodes', nodeIds: dragging.ids, groupId: g.id, beforeId: all[0]?.id ?? null });
    } else {
      const i = state.groups.findIndex((x) => x.id === g.id);
      const beforeId = half(e) === 'before' ? g.id : state.groups[i + 1]?.id ?? null;
      drop({ cmd: 'moveGroup', groupId: dragging.id, beforeId });
    }
  });
  sec.append(head);

  if (!collapsed) {
    for (const n of shown) sec.append(renderNode(n, g, all));
    if (!shown.length && !searching) sec.append(el('div', 'empty', 'Drop tabs here'));
  }

  // Dropping on blank space inside a group appends to its end.
  sec.addEventListener('dragover', (e) => {
    if (!dragIs('node')) return;
    e.preventDefault();
    clearMarks();
    sec.classList.add('drop-end');
  });
  sec.addEventListener('drop', (e) => {
    if (!dragIs('node')) return;
    e.preventDefault();
    drop({ cmd: 'moveNodes', nodeIds: dragging.ids, groupId: g.id, beforeId: null });
  });
  return sec;
}

// One button: collapses everything if any group is open, otherwise expands everything.
const toggleAll = document.getElementById('toggle-all');
const anyExpanded = () => state.groups.some((g) => !g.collapsed);
function updateToggleAll() {
  const collapse = anyExpanded();
  toggleAll.textContent = collapse ? '⊟' : '⊞';
  toggleAll.title = collapse ? 'Collapse all groups' : 'Expand all groups';
  toggleAll.setAttribute('aria-label', toggleAll.title);
}
toggleAll.addEventListener('click', () => send({ cmd: 'setAllCollapsed', collapsed: anyExpanded() }));

function render() {
  // Don't rebuild the tree under an open rename box or an in-progress drag.
  if (dragging || (editing && tree.querySelector('.gname-input'))) {
    pendingRender = true;
    return;
  }
  const q = filter.trim().toLowerCase();
  if (selected.size) {
    const ids = new Set(state.nodes.map((n) => n.id));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
  }
  if (selectedGroup && !state.groups.some((g) => g.id === selectedGroup)) selectedGroup = null;
  updateToggleAll();
  visibleOrder = [];
  tree.textContent = '';
  for (const g of state.groups) {
    const all = state.nodes.filter((n) => n.groupId === g.id);
    const nameHit = q && g.name.toLowerCase().includes(q);
    const shown = !q || nameHit ? all : all.filter((n) => `${n.title} ${n.url}`.toLowerCase().includes(q));
    if (q && !shown.length) continue;
    tree.append(renderGroup(g, all, shown, !!q));
  }
}

// ---------- wiring ----------
document.getElementById('search').addEventListener('input', (e) => {
  filter = e.target.value;
  render();
});
document.getElementById('settings').addEventListener('click', async (e) => {
  e.stopPropagation(); // keep the document-level click handler from closing the new menu
  const r = e.currentTarget.getBoundingClientRect();
  openOnStartup = !!(await chrome.storage.local.get('openOnStartup')).openOnStartup;
  openMenuAt(r.right - 120, r.bottom + 2, settingsMenuItems()); // under the button, mostly right-aligned
});
document.getElementById('add-group').addEventListener('click', async () => {
  const r = await send({ cmd: 'addGroup', name: 'New group' });
  if (r?.id) {
    editing = r.id;
    render();
  }
});

// Show the shortcut as it is currently bound (it can be changed at chrome://extensions/shortcuts).
async function updateSearchHint() {
  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'search-tabs');
  document.getElementById('search').placeholder = cmd?.shortcut ? `Search tabs… (${cmd.shortcut})` : 'Search tabs…';
}
updateSearchHint();
window.addEventListener('focus', updateSearchHint); // picks up a rebind made in another tab

function focusSearch() {
  const box = document.getElementById('search');
  box.focus();
  box.select();
}
// Sent by the background when the keyboard shortcut raises an already-open panel.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'focusSearch') focusSearch();
});
if (location.hash === '#search') focusSearch(); // the shortcut opened a fresh panel

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state?.newValue) {
    state = changes.state.newValue;
    render();
  }
});

// This UI runs in its own popup window, so "current window" is the panel itself.
// Track the active tab of the focused (or most recent) normal browser window.
async function refreshActive() {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const w = wins.find((x) => x.focused) || wins.find((x) => x.tabs?.some((t) => t.id === activeTabId)) || wins[0];
  activeTabId = w?.tabs?.find((t) => t.active)?.id ?? null;
  render();
}
chrome.tabs.onActivated.addListener(refreshActive);
chrome.windows.onFocusChanged.addListener(refreshActive);

(async () => {
  const r = await send({ cmd: 'sync' });
  if (r?.state) state = r.state;
  await refreshActive();
})();
