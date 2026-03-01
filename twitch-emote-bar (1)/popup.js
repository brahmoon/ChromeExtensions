// popup.js - Twitch Emote Bar v2

// ===== State =====
// emoteChannels: { [channelName]: { emotes: [{emoteId, imageUrl}], updatedAt } }
// userSections:  { [sectionId]: { name, emotes: [{emoteId, imageUrl}], order: [{emoteId}] } }
// channelOrders: { [channelName]: [emoteId, ...] }
// settings:      { emoteSize }

let emoteChannels = {};   // チャンネルセクション（チャンネルソース）
let userSections = {};    // ユーザー定義セクション
let channelOrders = {};   // チャンネルセクション内の並び順
let settings = { emoteSize: 44 };
let currentFilter = '';
let dragState = null;     // { emoteId, srcSectionId, srcType('channel'|'user'), element }

// ===== DOM refs =====
const sectionsContainer = document.getElementById('sectionsContainer');
const stateMessage = document.getElementById('stateMessage');
const emoteCount = document.getElementById('emoteCount');
const searchInput = document.getElementById('searchInput');
const sizeSlider = document.getElementById('sizeSlider');
const addSectionBtn = document.getElementById('addSectionBtn');
const closeBtn = document.getElementById('closeBtn');
const ctxMenu = document.getElementById('ctxMenu');
const modalOverlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modalInput = document.getElementById('modalInput');
const modalCancel = document.getElementById('modalCancel');
const modalOk = document.getElementById('modalOk');

// ===== Storage =====

function saveAll() {
  chrome.storage.local.set({ emoteChannels, userSections, channelOrders, settings });
}

function loadAll(cb) {
  chrome.storage.local.get(['emoteChannels', 'userSections', 'channelOrders', 'settings'], d => {
    emoteChannels = d.emoteChannels || {};
    userSections = d.userSections || {};
    channelOrders = d.channelOrders || {};
    settings = { emoteSize: 44, ...(d.settings || {}) };
    cb();
  });
}

// ===== Modal =====

function showModal(title, placeholder, defaultValue, cb) {
  modalTitle.textContent = title;
  modalInput.placeholder = placeholder;
  modalInput.value = defaultValue || '';
  modalOverlay.style.display = 'flex';
  modalInput.focus();

  const finish = (ok) => {
    modalOverlay.style.display = 'none';
    modalOk.onclick = null; modalCancel.onclick = null;
    modalInput.onkeydown = null;
    if (ok) cb(modalInput.value.trim());
  };
  modalOk.onclick = () => finish(true);
  modalCancel.onclick = () => finish(false);
  modalInput.onkeydown = e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
}

// ===== Context Menu =====

function closeCtxMenu() { ctxMenu.style.display = 'none'; ctxMenu.innerHTML = ''; }

function showCtxMenu(x, y, items) {
  ctxMenu.innerHTML = '';
  items.forEach(item => {
    if (item.type === 'separator') {
      const sep = document.createElement('div'); sep.className = 'ctx-menu-separator'; ctxMenu.appendChild(sep);
    } else if (item.type === 'label') {
      const lbl = document.createElement('div'); lbl.className = 'ctx-submenu-label'; lbl.textContent = item.text; ctxMenu.appendChild(lbl);
    } else {
      const el = document.createElement('div');
      el.className = 'ctx-menu-item' + (item.cls ? ' ' + item.cls : '');
      el.textContent = (item.icon ? item.icon + ' ' : '') + item.text;
      el.onclick = () => { closeCtxMenu(); item.action(); };
      ctxMenu.appendChild(el);
    }
  });
  ctxMenu.style.display = 'block';
  // 画面端調整
  ctxMenu.style.left = x + 'px'; ctxMenu.style.top = y + 'px';
  const rect = ctxMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) ctxMenu.style.left = (window.innerWidth - rect.width - 4) + 'px';
  if (rect.bottom > window.innerHeight) ctxMenu.style.top = (y - rect.height) + 'px';
}

document.addEventListener('click', () => closeCtxMenu());
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); });

// ===== Render =====

function applySize() {
  document.documentElement.style.setProperty('--emote-size', settings.emoteSize + 'px');
  sizeSlider.value = settings.emoteSize;
}

function getChannelOrderedEmotes(channelName) {
  const data = emoteChannels[channelName];
  if (!data) return [];
  const emotes = data.emotes || [];
  const order = channelOrders[channelName];
  if (!order || order.length === 0) return emotes;
  const map = new Map(emotes.map(e => [e.emoteId, e]));
  const result = [];
  const used = new Set();
  for (const id of order) { if (map.has(id)) { result.push(map.get(id)); used.add(id); } }
  for (const e of emotes) { if (!used.has(e.emoteId)) result.push(e); }
  return result;
}

function getUserSectionOrderedEmotes(sectionId) {
  const sec = userSections[sectionId];
  if (!sec) return [];
  const emotes = sec.emotes || [];
  const order = sec.order || [];
  if (order.length === 0) return emotes;
  const map = new Map(emotes.map(e => [e.emoteId, e]));
  const result = [];
  const used = new Set();
  for (const id of order) { if (map.has(id)) { result.push(map.get(id)); used.add(id); } }
  for (const e of emotes) { if (!used.has(e.emoteId)) result.push(e); }
  return result;
}

function filterEmotes(emotes) {
  if (!currentFilter) return emotes;
  const q = currentFilter.toLowerCase();
  return emotes.filter(e => e.emoteId.toLowerCase().includes(q));
}

function createEmoteCell(emote, sectionId, sectionType) {
  const cell = document.createElement('div');
  cell.className = 'emote-cell';
  cell.setAttribute('data-emote-id', emote.emoteId);
  cell.setAttribute('data-section-id', sectionId);
  cell.setAttribute('data-section-type', sectionType);
  cell.setAttribute('draggable', 'true');

  const img = document.createElement('img');
  img.src = emote.imageUrl; img.alt = emote.emoteId; img.draggable = false; img.loading = 'lazy';
  const label = document.createElement('div');
  label.className = 'emote-label'; label.textContent = emote.emoteId;
  cell.appendChild(img); cell.appendChild(label);

  // クリック → チャット入力
  cell.addEventListener('click', e => {
    if (e.button !== 0) return;
    chrome.runtime.sendMessage({ action: 'insertEmote', emoteId: emote.emoteId });
    cell.classList.add('inserted');
    setTimeout(() => cell.classList.remove('inserted'), 350);
  });

  // 右クリック → コンテキストメニュー
  cell.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    buildEmoteContextMenu(e.clientX, e.clientY, emote, sectionId, sectionType);
  });

  // Drag
  cell.addEventListener('dragstart', e => {
    dragState = { emoteId: emote.emoteId, emote, srcSectionId: sectionId, srcType: sectionType };
    cell.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', emote.emoteId);
  });
  cell.addEventListener('dragend', () => {
    cell.classList.remove('dragging');
    dragState = null;
    document.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
  });
  cell.addEventListener('dragover', e => {
    e.preventDefault();
    if (!dragState) return;
    // セクション間ドロップ禁止
    if (dragState.srcSectionId !== sectionId) { e.dataTransfer.dropEffect = 'none'; return; }
    e.dataTransfer.dropEffect = 'move';
    if (dragState.emoteId !== emote.emoteId) cell.classList.add('drag-over');
  });
  cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
  cell.addEventListener('drop', e => {
    e.preventDefault();
    cell.classList.remove('drag-over');
    if (!dragState || dragState.emoteId === emote.emoteId) return;
    if (dragState.srcSectionId !== sectionId) return; // セクション間禁止

    if (sectionType === 'channel') {
      const ordered = getChannelOrderedEmotes(sectionId).map(x => x.emoteId);
      const fi = ordered.indexOf(dragState.emoteId), ti = ordered.indexOf(emote.emoteId);
      if (fi !== -1 && ti !== -1) { ordered.splice(fi, 1); ordered.splice(ti, 0, dragState.emoteId); }
      channelOrders[sectionId] = ordered;
    } else {
      const sec = userSections[sectionId];
      const order = (sec.order && sec.order.length > 0) ? [...sec.order] : sec.emotes.map(x => x.emoteId);
      const fi = order.indexOf(dragState.emoteId), ti = order.indexOf(emote.emoteId);
      if (fi !== -1 && ti !== -1) { order.splice(fi, 1); order.splice(ti, 0, dragState.emoteId); }
      sec.order = order;
    }
    saveAll(); renderAll();
  });

  return cell;
}

function buildEmoteContextMenu(x, y, emote, sectionId, sectionType) {
  const items = [];

  // ユーザーセクションへの複製追加
  const userSecIds = Object.keys(userSections);
  if (userSecIds.length > 0) {
    items.push({ type: 'label', text: 'ユーザーセクションに追加' });
    userSecIds.forEach(sid => {
      const sec = userSections[sid];
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

  // ユーザーセクションの場合は削除
  if (sectionType === 'user') {
    items.push({
      text: 'このセクションから削除', cls: 'danger', icon: '✕',
      action: () => {
        const sec = userSections[sectionId];
        sec.emotes = (sec.emotes || []).filter(e => e.emoteId !== emote.emoteId);
        sec.order = (sec.order || []).filter(id => id !== emote.emoteId);
        saveAll(); renderAll();
      }
    });
  }

  showCtxMenu(x, y, items);
}

function createUserSection(preAddEmote) {
  showModal('セクション名を入力', '例: よく使う、ゲーム用…', '', name => {
    if (!name) return;
    const sid = 'user_' + Date.now();
    userSections[sid] = { name, emotes: preAddEmote ? [preAddEmote] : [], order: [] };
    saveAll(); renderAll();
  });
}

function renderSection(sectionId, sectionType, emotes, headerHtml, avatarEl) {
  const section = document.createElement('div');
  section.className = 'section' + (sectionType === 'user' ? ' user-section' : '');
  section.setAttribute('data-section-id', sectionId);

  // Header
  const header = document.createElement('div'); header.className = 'section-header';
  if (avatarEl) header.appendChild(avatarEl);
  const nameEl = document.createElement('span'); nameEl.className = 'section-name'; nameEl.textContent = headerHtml;
  const countEl = document.createElement('span'); countEl.className = 'section-count';
  countEl.textContent = emotes.length + ' エモート';
  header.appendChild(nameEl); header.appendChild(countEl);

  // Buttons
  const actions = document.createElement('div'); actions.className = 'section-actions';
  if (sectionType === 'user') {
    const renameBtn = document.createElement('button'); renameBtn.className = 'section-btn'; renameBtn.textContent = '✎';
    renameBtn.title = '名前変更';
    renameBtn.onclick = () => showModal('セクション名を変更', '', userSections[sectionId].name, name => {
      if (!name) return;
      userSections[sectionId].name = name; saveAll(); renderAll();
    });
    const delBtn = document.createElement('button'); delBtn.className = 'section-btn danger'; delBtn.textContent = '✕';
    delBtn.title = 'セクション削除';
    delBtn.onclick = () => { if (confirm(`「${userSections[sectionId].name}」を削除しますか？`)) { delete userSections[sectionId]; saveAll(); renderAll(); } };
    const resetBtn = document.createElement('button'); resetBtn.className = 'section-btn'; resetBtn.textContent = '↺';
    resetBtn.title = '並び順リセット';
    resetBtn.onclick = () => { userSections[sectionId].order = []; saveAll(); renderAll(); };
    actions.appendChild(renameBtn); actions.appendChild(resetBtn); actions.appendChild(delBtn);
  } else {
    const resetBtn = document.createElement('button'); resetBtn.className = 'section-btn'; resetBtn.textContent = '↺';
    resetBtn.title = '並び順リセット';
    resetBtn.onclick = () => { delete channelOrders[sectionId]; saveAll(); renderAll(); };
    actions.appendChild(resetBtn);
  }
  header.appendChild(actions);
  section.appendChild(header);

  // Grid
  const grid = document.createElement('div'); grid.className = 'emote-grid section-drop-zone';
  grid.setAttribute('data-section-id', sectionId);

  const filtered = filterEmotes(emotes);
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--text-muted);font-size:11px;padding:8px 4px;';
    empty.textContent = currentFilter ? '検索結果なし' : '（エモートがありません）';
    grid.appendChild(empty);
  } else {
    filtered.forEach(emote => grid.appendChild(createEmoteCell(emote, sectionId, sectionType)));
  }
  section.appendChild(grid);
  return section;
}

function renderAll() {
  sectionsContainer.innerHTML = '';
  const channelNames = Object.keys(emoteChannels);
  const userSecIds = Object.keys(userSections);
  const hasAny = channelNames.length > 0 || userSecIds.length > 0;

  if (!hasAny) { stateMessage.style.display = 'flex'; return; }
  stateMessage.style.display = 'none';

  let totalEmotes = 0;

  // ユーザーセクション（上部に表示）
  userSecIds.forEach(sid => {
    const sec = userSections[sid];
    const emotes = getUserSectionOrderedEmotes(sid);
    totalEmotes += emotes.length;
    const avatarEl = document.createElement('div'); avatarEl.className = 'section-avatar-placeholder'; avatarEl.textContent = '★';
    const secEl = renderSection(sid, 'user', emotes, sec.name, avatarEl);
    sectionsContainer.appendChild(secEl);
  });

  // チャンネルセクション
  channelNames.forEach(ch => {
    const emotes = getChannelOrderedEmotes(ch);
    totalEmotes += emotes.length;
    const avatarEl = document.createElement('img'); avatarEl.className = 'section-avatar'; avatarEl.alt = ch;
    // チャンネルアバター画像は取得できないためプレースホルダー
    avatarEl.src = `https://avatar.tobi.sh/${encodeURIComponent(ch)}.svg`;
    avatarEl.onerror = () => { avatarEl.style.display='none'; };
    const secEl = renderSection(ch, 'channel', emotes, ch, avatarEl);
    sectionsContainer.appendChild(secEl);
  });

  emoteCount.textContent = `${totalEmotes} エモート`;
  applySize();
}

// ===== Events =====

searchInput.addEventListener('input', () => { currentFilter = searchInput.value.trim(); renderAll(); });
sizeSlider.addEventListener('input', () => { settings.emoteSize = parseInt(sizeSlider.value); applySize(); saveAll(); });
closeBtn.addEventListener('click', () => window.close());
addSectionBtn.addEventListener('click', () => createUserSection(null));

// ===== Messages from background =====

chrome.runtime.onMessage.addListener(msg => {
  if (msg.action === 'emotesUpdated' && msg.channelMap) {
    emoteChannels = msg.channelMap;
    renderAll();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.emoteChannels) {
    emoteChannels = changes.emoteChannels.newValue || {};
    renderAll();
  }
});

// ===== Init =====
loadAll(() => { applySize(); renderAll(); });
