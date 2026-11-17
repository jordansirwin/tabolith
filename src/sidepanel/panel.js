const INBOX = 'inbox';
const COLORS = ['#8b949e', '#e5534b', '#e0823d', '#c9a227', '#57ab5a', '#39a9c7', '#6d8cf5', '#b083f0', '#e275ad'];

const tree = document.getElementById('tree');
let state = { groups: [], nodes: [] };
let activeTabId = null;
let dragging = null; // { type: 'node' | 'group', id }
let pendingRender = false;
let editing = null; // group id being renamed
let filter = '';

const send = (msg) => chrome.runtime.sendMessage(msg);
const favicon = (url) => `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=32`;

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
  dragging = { type, id };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  setTimeout(() => node.classList.add('dragging'), 0);
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

// ---------- rendering ----------
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
  x.title = live ? 'Close tab (keeps it saved here). Alt-click to remove entirely.' : 'Remove from outline';
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    send({ cmd: live && !e.altKey ? 'closeTab' : 'deleteNode', nodeId: n.id });
  });
  row.append(x);

  row.addEventListener('click', () => send({ cmd: 'open', nodeId: n.id }));
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
    drop({ cmd: 'moveNode', nodeId: dragging.id, groupId: g.id, beforeId });
  });
  return row;
}

function renderGroup(g, all, shown, searching) {
  const sec = el('section', 'group');
  const collapsed = g.collapsed && !searching;

  const head = el('div', 'ghead');
  head.draggable = editing !== g.id;
  head.append(el('span', 'chev', collapsed ? '▸' : '▾'));

  const dot = el('span', 'dot');
  dot.style.background = COLORS[(g.color || 0) % COLORS.length];
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

  head.addEventListener('click', () => send({ cmd: 'toggleGroup', groupId: g.id }));
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
      drop({ cmd: 'moveNode', nodeId: dragging.id, groupId: g.id, beforeId: all[0]?.id ?? null });
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
    drop({ cmd: 'moveNode', nodeId: dragging.id, groupId: g.id, beforeId: null });
  });
  return sec;
}

function render() {
  if (dragging) {
    pendingRender = true;
    return;
  }
  const q = filter.trim().toLowerCase();
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
