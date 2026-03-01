// popup.js - Twitch Emote Bar v2

// ===== State =====
let emoteChannels = {};
let userSections  = {};
let channelOrders = {};
let settings      = { emoteSize: 44 };
// 折りたたみ状態: { [sectionId]: true(collapsed) }
let collapsedSections = {};
// セクション表示順: ['user_xxx', 'ch_yyy', ...] — idリスト
let sectionDisplayOrder = [];

let currentFilter  = '';
let emoteDragState = null;  // エモート内ドラッグ
let secDragState   = null;  // セクションドラッグ { sectionId, element }

// ===== DOM refs =====
const sectionsContainer = document.getElementById('sectionsContainer');
const stateMessage      = document.getElementById('stateMessage');
const emoteCount        = document.getElementById('emoteCount');
const searchInput       = document.getElementById('searchInput');
const sizeSlider        = document.getElementById('sizeSlider');
const addSectionBtn     = document.getElementById('addSectionBtn');
const closeBtn          = document.getElementById('closeBtn');
const ctxMenu           = document.getElementById('ctxMenu');
const modalOverlay      = document.getElementById('modalOverlay');
const modalTitle        = document.getElementById('modalTitle');
const modalInput        = document.getElementById('modalInput');
const modalCancel       = document.getElementById('modalCancel');
const modalOk           = document.getElementById('modalOk');

// ===== Storage =====

function saveAll() {
  chrome.storage.local.set({ emoteChannels, userSections, channelOrders, settings, collapsedSections, sectionDisplayOrder });
}

function loadAll(cb) {
  chrome.storage.local.get(
    ['emoteChannels','userSections','channelOrders','settings','collapsedSections','sectionDisplayOrder'], d => {
    emoteChannels       = d.emoteChannels       || {};
    userSections        = d.userSections        || {};
    channelOrders       = d.channelOrders       || {};
    settings            = { emoteSize: 44, ...(d.settings || {}) };
    collapsedSections   = d.collapsedSections   || {};
    sectionDisplayOrder = d.sectionDisplayOrder || [];
    cb();
  });
}

// ===== Section order helpers =====

/** 全セクションIDの正規リストを返す（ユーザー→チャンネル順、新規は末尾） */
function getOrderedSectionIds() {
  const allIds = [
    ...Object.keys(userSections),
    ...Object.keys(emoteChannels)
  ];
  const stored = sectionDisplayOrder.filter(id => allIds.includes(id));
  const newIds = allIds.filter(id => !stored.includes(id));
  return [...stored, ...newIds];
}

// ===== Modal =====

function showModal(title, placeholder, defaultValue, cb) {
  modalTitle.textContent    = title;
  modalInput.placeholder    = placeholder;
  modalInput.value          = defaultValue || '';
  modalOverlay.style.display = 'flex';
  setTimeout(() => modalInput.focus(), 50);

  const finish = ok => {
    modalOverlay.style.display = 'none';
    modalOk.onclick = modalCancel.onclick = modalInput.onkeydown = null;
    if (ok) cb(modalInput.value.trim());
  };
  modalOk.onclick        = () => finish(true);
  modalCancel.onclick    = () => finish(false);
  modalInput.onkeydown   = e => { if (e.key==='Enter') finish(true); if (e.key==='Escape') finish(false); };
}

// ===== Context Menu =====

function closeCtxMenu() { ctxMenu.style.display = 'none'; ctxMenu.innerHTML = ''; }

function showCtxMenu(x, y, items) {
  ctxMenu.innerHTML = '';
  items.forEach(item => {
    if (item.type === 'separator') {
      const s = document.createElement('div'); s.className = 'ctx-menu-separator'; ctxMenu.appendChild(s);
    } else if (item.type === 'label') {
      const l = document.createElement('div'); l.className = 'ctx-submenu-label'; l.textContent = item.text; ctxMenu.appendChild(l);
    } else {
      const el = document.createElement('div');
      el.className = 'ctx-menu-item' + (item.cls ? ' '+item.cls : '');
      el.textContent = (item.icon ? item.icon+' ' : '') + item.text;
      el.onclick = () => { closeCtxMenu(); item.action(); };
      ctxMenu.appendChild(el);
    }
  });
  ctxMenu.style.display = 'block';
  ctxMenu.style.left = x+'px'; ctxMenu.style.top = y+'px';
  const r = ctxMenu.getBoundingClientRect();
  if (r.right  > window.innerWidth)  ctxMenu.style.left = (window.innerWidth  - r.width  - 4)+'px';
  if (r.bottom > window.innerHeight) ctxMenu.style.top  = (y - r.height)+'px';
}

document.addEventListener('click',   () => closeCtxMenu());
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); });

// ===== Helpers =====

function applySize() {
  document.documentElement.style.setProperty('--emote-size', settings.emoteSize+'px');
  sizeSlider.value = settings.emoteSize;
}

function getOrderedEmotes(sectionId) {
  const isUser = sectionId.startsWith('user_');
  if (isUser) {
    const sec = userSections[sectionId];
    if (!sec) return [];
    const emotes = sec.emotes || [];
    const order  = sec.order  || [];
    if (!order.length) return emotes;
    const map = new Map(emotes.map(e => [e.emoteId, e]));
    const used = new Set();
    const res  = [];
    for (const id of order) { if (map.has(id)) { res.push(map.get(id)); used.add(id); } }
    for (const e of emotes) { if (!used.has(e.emoteId)) res.push(e); }
    return res;
  } else {
    const data = emoteChannels[sectionId];
    if (!data) return [];
    const emotes = data.emotes || [];
    const order  = channelOrders[sectionId];
    if (!order || !order.length) return emotes;
    const map = new Map(emotes.map(e => [e.emoteId, e]));
    const used = new Set();
    const res  = [];
    for (const id of order) { if (map.has(id)) { res.push(map.get(id)); used.add(id); } }
    for (const e of emotes) { if (!used.has(e.emoteId)) res.push(e); }
    return res;
  }
}

function filterEmotes(emotes) {
  if (!currentFilter) return emotes;
  const q = currentFilter.toLowerCase();
  return emotes.filter(e => e.emoteId.toLowerCase().includes(q));
}

// ===== Lock icon SVG =====
const LOCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
  <path fill="#cccccc" d="M43.16 21H41v-8.63C41 6.69 35.3 1 29.63 1h-9.48C14.48 1 9.01 6.69 9.01 12.37V21H6.62c-.68 0-1.61 1.06-1.61 1.66v25.46c0 .6.93.88 1.61.88h36.55c.68 0 1.84-.28 1.84-.88V22.66c0-.6-1.16-1.66-1.84-1.66zM29.71 45h-9.65l2.03-9.97c-1.22-.87-2.02-2.5-2.02-4.11c0-2.64 2.16-4.89 4.83-4.89s4.83 2.09 4.83 4.73c0 1.61-.8 3.43-2.02 4.3L29.73 45zM34 21H16v-8.63C16 9.79 17.69 8 20.24 8h9.29C32.08 8 34 9.79 34 12.37z"/>
</svg>`;

// ===== Emote Cell =====

function createEmoteCell(emote, sectionId, sectionType) {
  const cell = document.createElement('div');
  cell.className = 'emote-cell' + (emote.locked ? ' locked' : '');
  cell.setAttribute('data-emote-id', emote.emoteId);
  cell.setAttribute('data-section-id', sectionId);
  cell.setAttribute('data-section-type', sectionType);
  if (!emote.locked) cell.setAttribute('draggable', 'true');

  const img = document.createElement('img');
  img.src = emote.imageUrl; img.alt = emote.emoteId; img.draggable = false; img.loading = 'lazy';
  const label = document.createElement('div');
  label.className = 'emote-label'; label.textContent = emote.emoteId;
  cell.appendChild(img); cell.appendChild(label);

  // ロック済みオーバーレイ
  if (emote.locked) {
    const overlay = document.createElement('div'); overlay.className = 'lock-overlay';
    const lockIcon = document.createElement('div'); lockIcon.className = 'lock-icon';
    lockIcon.innerHTML = LOCK_SVG;
    cell.appendChild(overlay); cell.appendChild(lockIcon);
  }

  // クリック → ロック済みは無効
  if (!emote.locked) {
    cell.addEventListener('click', e => {
      if (e.button !== 0) return;
      chrome.runtime.sendMessage({ action: 'insertEmote', emoteId: emote.emoteId });
      cell.classList.add('inserted');
      setTimeout(() => cell.classList.remove('inserted'), 350);
    });
  }

  // 右クリック → コンテキストメニュー（ロック済みでも追加は可能）
  cell.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    buildEmoteContextMenu(e.clientX, e.clientY, emote, sectionId, sectionType);
  });

  if (!emote.locked) {
    // エモートドラッグ（セクション内のみ）
    cell.addEventListener('dragstart', e => {
      emoteDragState = { emoteId: emote.emoteId, emote, srcSectionId: sectionId, srcType: sectionType };
      cell.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', emote.emoteId);
      e.stopPropagation(); // セクションドラッグに漏れないよう
    });
    cell.addEventListener('dragend', () => {
      cell.classList.remove('dragging');
      emoteDragState = null;
      document.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
    });
    cell.addEventListener('dragover', e => {
      e.preventDefault(); e.stopPropagation();
      if (!emoteDragState) return;
      if (emoteDragState.srcSectionId !== sectionId) { e.dataTransfer.dropEffect = 'none'; return; }
      e.dataTransfer.dropEffect = 'move';
      if (emoteDragState.emoteId !== emote.emoteId) cell.classList.add('drag-over');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
    cell.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      cell.classList.remove('drag-over');
      if (!emoteDragState || emoteDragState.emoteId === emote.emoteId) return;
      if (emoteDragState.srcSectionId !== sectionId) return;
      reorderEmote(sectionId, sectionType, emoteDragState.emoteId, emote.emoteId);
    });
  }

  return cell;
}

function reorderEmote(sectionId, sectionType, fromId, toId) {
  if (sectionType === 'channel') {
    const ordered = getOrderedEmotes(sectionId).map(x => x.emoteId);
    const fi = ordered.indexOf(fromId), ti = ordered.indexOf(toId);
    if (fi !== -1 && ti !== -1) { ordered.splice(fi, 1); ordered.splice(ti, 0, fromId); }
    channelOrders[sectionId] = ordered;
  } else {
    const sec = userSections[sectionId];
    const order = (sec.order && sec.order.length) ? [...sec.order] : sec.emotes.map(x => x.emoteId);
    const fi = order.indexOf(fromId), ti = order.indexOf(toId);
    if (fi !== -1 && ti !== -1) { order.splice(fi, 1); order.splice(ti, 0, fromId); }
    sec.order = order;
  }
  saveAll(); renderAll();
}

// ===== Emote context menu =====

function buildEmoteContextMenu(x, y, emote, sectionId, sectionType) {
  const items = [];
  const userSecIds = Object.keys(userSections);

  if (userSecIds.length > 0) {
    items.push({ type: 'label', text: 'ユーザーセクションに追加' });
    userSecIds.forEach(sid => {
      const sec     = userSections[sid];
      const already = (sec.emotes || []).some(e => e.emoteId === emote.emoteId);
      items.push({
        text: sec.name + (already ? ' ✓' : ''),
        cls: already ? '' : 'user',
        action: () => {
          if (already) return;
          sec.emotes = [...(sec.emotes || []), emote];
          saveAll(); renderAll();
        }
      });
    });
    items.push({ type: 'separator' });
  } else {
    items.push({ text: 'セクションを作成して追加…', cls: 'user', icon: '＋', action: () => createUserSection(emote) });
    items.push({ type: 'separator' });
  }

  if (sectionType === 'user') {
    items.push({
      text: 'このセクションから削除', cls: 'danger', icon: '✕',
      action: () => {
        const sec   = userSections[sectionId];
        sec.emotes  = (sec.emotes || []).filter(e => e.emoteId !== emote.emoteId);
        sec.order   = (sec.order  || []).filter(id => id !== emote.emoteId);
        saveAll(); renderAll();
      }
    });
  }

  showCtxMenu(x, y, items);
}

// ===== User section =====

function createUserSection(preAddEmote) {
  showModal('セクション名を入力', '例: よく使う、ゲーム用…', '', name => {
    if (!name) return;
    const sid = 'user_' + Date.now();
    userSections[sid] = { name, emotes: preAddEmote ? [preAddEmote] : [], order: [] };
    saveAll(); renderAll();
  });
}

// ===== Section render =====

function renderSection(sectionId) {
  const isUser       = sectionId.startsWith('user_');
  const sectionType  = isUser ? 'user' : 'channel';
  const sectionName  = isUser ? userSections[sectionId]?.name : sectionId;
  const emotes       = getOrderedEmotes(sectionId);
  const collapsed    = !!collapsedSections[sectionId];

  const section = document.createElement('div');
  section.className = 'section' + (isUser ? ' user-section' : '') + (collapsed ? ' collapsed' : '');
  section.setAttribute('data-section-id', sectionId);

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'section-header draggable-header';
  header.setAttribute('draggable', 'true');

  // Toggle chevron
  const toggle = document.createElement('span');
  toggle.className = 'section-toggle'; toggle.textContent = '▾';
  header.appendChild(toggle);

  // Avatar
  if (isUser) {
    const av = document.createElement('div'); av.className = 'section-avatar-placeholder'; av.textContent = '★';
    header.appendChild(av);
  }

  const nameEl  = document.createElement('span'); nameEl.className = 'section-name'; nameEl.textContent = sectionName || '';
  const countEl = document.createElement('span'); countEl.className = 'section-count';
  countEl.textContent = emotes.length + ' エモート';
  header.appendChild(nameEl); header.appendChild(countEl);

  // Action buttons
  const actions = document.createElement('div'); actions.className = 'section-actions';
  if (isUser) {
    const renameBtn = document.createElement('button'); renameBtn.className = 'section-btn'; renameBtn.textContent = '✎'; renameBtn.title = '名前変更';
    renameBtn.onclick = e => { e.stopPropagation(); showModal('セクション名を変更', '', userSections[sectionId].name, n => { if(!n) return; userSections[sectionId].name=n; saveAll(); renderAll(); }); };
    const resetBtn  = document.createElement('button'); resetBtn.className = 'section-btn'; resetBtn.textContent = '↺'; resetBtn.title = '並び順リセット';
    resetBtn.onclick = e => { e.stopPropagation(); userSections[sectionId].order=[]; saveAll(); renderAll(); };
    const delBtn    = document.createElement('button'); delBtn.className = 'section-btn danger'; delBtn.textContent = '✕'; delBtn.title = 'セクション削除';
    delBtn.onclick  = e => { e.stopPropagation(); if(confirm(`「${userSections[sectionId].name}」を削除しますか？`)) { delete userSections[sectionId]; saveAll(); renderAll(); } };
    actions.appendChild(renameBtn); actions.appendChild(resetBtn); actions.appendChild(delBtn);
  } else {
    const resetBtn = document.createElement('button'); resetBtn.className = 'section-btn'; resetBtn.textContent = '↺'; resetBtn.title = '並び順リセット';
    resetBtn.onclick = e => { e.stopPropagation(); delete channelOrders[sectionId]; saveAll(); renderAll(); };
    actions.appendChild(resetBtn);
  }
  header.appendChild(actions);
  section.appendChild(header);

  // ── Body (grid) ──
  const body = document.createElement('div'); body.className = 'section-body';
  const grid = document.createElement('div'); grid.className = 'emote-grid';
  grid.setAttribute('data-section-id', sectionId);

  const filtered = filterEmotes(emotes);
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--text-muted);font-size:11px;padding:6px 4px;';
    empty.textContent = currentFilter ? '検索結果なし' : '（エモートがありません）';
    grid.appendChild(empty);
  } else {
    filtered.forEach(e => grid.appendChild(createEmoteCell(e, sectionId, sectionType)));
  }
  body.appendChild(grid);
  section.appendChild(body);

  // ── Toggle collapse on header click ──
  header.addEventListener('click', e => {
    // ボタンクリックは除外
    if (e.target.closest('.section-btn')) return;
    collapsedSections[sectionId] = !collapsedSections[sectionId];
    saveAll();
    section.classList.toggle('collapsed', collapsedSections[sectionId]);
  });

  // ── Section drag (header drag) ──
  header.addEventListener('dragstart', e => {
    // エモートドラッグ中は無視
    if (emoteDragState) { e.preventDefault(); return; }
    secDragState = { sectionId, element: section };
    section.classList.add('section-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-section-id', sectionId);
  });
  header.addEventListener('dragend', () => {
    section.classList.remove('section-dragging');
    secDragState = null;
    document.querySelectorAll('.section-drag-target').forEach(el => el.classList.remove('section-drag-target'));
  });

  // セクション自体を drop zone にする
  section.addEventListener('dragover', e => {
    // エモートドラッグ中はセルの stopPropagation が効かない隙間でも
    // preventDefault() を呼ばないとブラウザがドロップ禁止にしてしまうため
    // emote ドラッグ中は常に preventDefault() してセルの drop を妨げない
    if (emoteDragState) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; return; }
    if (!secDragState || secDragState.sectionId === sectionId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    section.classList.add('section-drag-target');
  });
  section.addEventListener('dragleave', e => {
    if (!e.relatedTarget || !section.contains(e.relatedTarget))
      section.classList.remove('section-drag-target');
  });
  section.addEventListener('drop', e => {
    section.classList.remove('section-drag-target');
    if (!secDragState || secDragState.sectionId === sectionId) return;
    if (emoteDragState) return;
    e.preventDefault();
    reorderSection(secDragState.sectionId, sectionId);
  });

  return section;
}

function reorderSection(fromId, toId) {
  const order = getOrderedSectionIds();
  const fi = order.indexOf(fromId), ti = order.indexOf(toId);
  if (fi === -1 || ti === -1) return;
  order.splice(fi, 1); order.splice(ti, 0, fromId);
  sectionDisplayOrder = order;
  saveAll(); renderAll();
}

// ===== Render all =====

function renderAll() {
  sectionsContainer.innerHTML = '';
  const orderedIds = getOrderedSectionIds();
  const hasAny = orderedIds.length > 0;

  if (!hasAny) { stateMessage.style.display = 'flex'; return; }
  stateMessage.style.display = 'none';

  let totalEmotes = 0;
  orderedIds.forEach(id => {
    const emotes = getOrderedEmotes(id);
    totalEmotes += emotes.length;
    sectionsContainer.appendChild(renderSection(id));
  });

  emoteCount.textContent = `${totalEmotes} エモート`;
  applySize();
}

// ===== Events =====

searchInput.addEventListener('input',   () => { currentFilter = searchInput.value.trim(); renderAll(); });
sizeSlider.addEventListener('input',    () => { settings.emoteSize = parseInt(sizeSlider.value); applySize(); saveAll(); });
closeBtn.addEventListener('click',      () => window.close());
addSectionBtn.addEventListener('click', () => createUserSection(null));

// ===== Messages =====

chrome.runtime.onMessage.addListener(msg => {
  if (msg.action === 'emotesUpdated' && msg.channelMap) { emoteChannels = msg.channelMap; renderAll(); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.emoteChannels) { emoteChannels = changes.emoteChannels.newValue || {}; renderAll(); }
});

// ===== Init =====
loadAll(() => { applySize(); renderAll(); });
