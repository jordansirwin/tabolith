const INBOX = 'inbox';
const COLORS = ['#8b949e', '#e5534b', '#e0823d', '#c9a227', '#57ab5a', '#39a9c7', '#6d8cf5', '#b083f0', '#e275ad'];

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
      if (r?.error) console.error('Uber Tabs:', msg.cmd, r.error);
      return r;
    },
    (err) => {
      console.error('Uber Tabs:', msg.cmd, 'failed:', err?.message || err);
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
    onClick();
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
const dragIs = (t) => dragging && dragging.type === t;

// ---------- context menu ----------
let menu = null;
function closeMenu() {
  menu?.remove();
  menu = null;
}
// items: [{ label, onClick, disabled, dot, submenu: [...items] } | '-']
function buildMenu(container, items) {
  for (const it of items) {
    if (it === '-') {
      container.append(el('div', 'ctx-sep'));
      continue;
    }
    const row = el('div', 'ctx-item' + (it.disabled ? ' disabled' : ''));
    if (it.dot) row.append(it.dot);
    row.append(el('span', it.submenu ? 'grow' : null, it.label));
    if (it.submenu) addSubmenu(row, it.submenu);
    else if (!it.disabled) {
      row.addEventListener('click', () => {
        closeMenu();
        it.onClick();
      });
    }
    container.append(row);
  }
}

function addSubmenu(parent, items) {
  parent.classList.add('has-sub');
  parent.append(el('span', 'ctx-arrow', '▸'));
  const sub = el('div', 'ctx ctx-sub');
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

function showMenu(e, items) {
  e.preventDefault();
  // Don't let the document-level handler below immediately close the new menu.
  e.stopPropagation();
  closeMenu();
  menu = el('div', 'ctx');
  buildMenu(menu, items);
  document.body.append(menu);
  // Keep the menu inside the window.
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(0, Math.min(e.clientX, innerWidth - r.width)) + 'px';
  menu.style.top = Math.max(0, Math.min(e.clientY, innerHeight - r.height)) + 'px';
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

  const dot = groupDot(g);
  dot.title = 'Change color';
  dot.addEventListener('click', (e) => {
    e.stopPropagation();
    send({ cmd: 'recolorGroup', groupId: g.id });
  });
  head.append(dot);

  if (editing === g.id) {
    const input = el('input', 'gname-input');
    input.value = g.name;
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      editing = null;
      if (commit && input.value.trim()) send({ cmd: 'renameGroup', groupId: g.id, name: input.value });
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
    const name = el('span', 'gname', g.name);
    name.title = 'Double-click to rename';
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      editing = g.id;
      render();
    });
    head.append(name);
  }

  const live = all.filter((n) => n.tabId != null).length;
  head.append(el('span', 'count', live ? `${live}/${all.length}` : `${all.length}`));

  const actions = el('div', 'gactions');
  actions.append(iconButton('+', 'New tab in this group', () => send({ cmd: 'newTab', groupId: g.id })));
  if (live) actions.append(iconButton('⏏', 'Close open tabs (keep them saved)', () => send({ cmd: 'closeGroup', groupId: g.id })));
  if (live < all.length) actions.append(iconButton('↺', 'Reopen saved tabs', () => send({ cmd: 'restoreGroup', groupId: g.id })));
  if (g.id !== INBOX) actions.append(iconButton('×', 'Delete group (tabs move to Inbox)', () => send({ cmd: 'deleteGroup', groupId: g.id })));
  head.append(actions);

  head.addEventListener('click', () => selectGroup(g.id));
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

function render() {
  if (dragging) {
    pendingRender = true;
    return;
  }
  const q = filter.trim().toLowerCase();
  if (selected.size) {
    const ids = new Set(state.nodes.map((n) => n.id));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
  }
  if (selectedGroup && !state.groups.some((g) => g.id === selectedGroup)) selectedGroup = null;
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
document.getElementById('add-group').addEventListener('click', async () => {
  const r = await send({ cmd: 'addGroup', name: 'New group' });
  if (r?.id) {
    editing = r.id;
    render();
  }
});

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
