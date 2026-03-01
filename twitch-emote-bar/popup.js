// popup.js - Twitch Emote Bar

const emoteGrid = document.getElementById('emoteGrid');
const stateMessage = document.getElementById('stateMessage');
const emoteCount = document.getElementById('emoteCount');
const searchInput = document.getElementById('searchInput');
const sizeSlider = document.getElementById('sizeSlider');
const resetOrderBtn = document.getElementById('resetOrderBtn');
const closeBtn = document.getElementById('closeBtn');

let allEmotes = [];        // 取得済みエモート（順序保持）
let customOrder = null;    // ユーザーがドラッグで変えた順序（emoteId[]）
let currentFilter = '';

// ===== ストレージ =====

function saveOrder() {
  if (customOrder) {
    chrome.storage.local.set({ emoteBarOrder: customOrder });
  }
}

function loadState(callback) {
  chrome.storage.local.get(['collectedEmotes', 'emoteBarOrder', 'emoteBarSize'], data => {
    if (data.emoteBarSize) {
      sizeSlider.value = data.emoteBarSize;
      document.documentElement.style.setProperty('--emote-size', data.emoteBarSize + 'px');
    }

    if (data.emoteBarOrder) {
      customOrder = data.emoteBarOrder;
    }

    if (data.collectedEmotes && data.collectedEmotes.length > 0) {
      allEmotes = data.collectedEmotes;
    }

    callback();
  });
}

// ===== 順序適用 =====

function getOrderedEmotes(emotes) {
  if (!customOrder || customOrder.length === 0) return emotes;

  const map = new Map(emotes.map(e => [e.emoteId, e]));
  const ordered = [];
  const used = new Set();

  for (const id of customOrder) {
    if (map.has(id)) {
      ordered.push(map.get(id));
      used.add(id);
    }
  }

  // customOrderにない新規エモートを末尾に追加
  for (const e of emotes) {
    if (!used.has(e.emoteId)) {
      ordered.push(e);
    }
  }

  return ordered;
}

// ===== レンダリング =====

function renderEmotes() {
  const query = currentFilter.toLowerCase();
  const source = getOrderedEmotes(allEmotes);
  const filtered = query
    ? source.filter(e => e.emoteId.toLowerCase().includes(query))
    : source;

  emoteCount.textContent = `${filtered.length} エモート`;

  if (filtered.length === 0) {
    emoteGrid.style.display = 'none';
    stateMessage.style.display = 'flex';

    if (allEmotes.length > 0) {
      stateMessage.innerHTML = `
        <div class="state-icon">🔍</div>
        <p>「${currentFilter}」に一致するエモートがありません。</p>
      `;
    } else {
      stateMessage.innerHTML = `
        <div class="state-icon">😊</div>
        <p>Twitchのエモートピッカーを開くと<br>エモートが自動的に取得されます。</p>
        <p style="font-size:11px"><strong>スタンプ</strong>ボタンをクリックしてみてください。</p>
      `;
    }
    return;
  }

  emoteGrid.style.display = 'grid';
  stateMessage.style.display = 'none';

  // 差分更新（既存セルを再利用しない：シンプルに全再描画）
  emoteGrid.innerHTML = '';
  filtered.forEach(emote => {
    const cell = createEmoteCell(emote);
    emoteGrid.appendChild(cell);
  });
}

function createEmoteCell(emote) {
  const cell = document.createElement('div');
  cell.className = 'emote-cell';
  cell.setAttribute('data-emote-id', emote.emoteId);
  cell.setAttribute('draggable', 'true');

  const img = document.createElement('img');
  img.src = emote.imageUrl;
  img.alt = emote.emoteId;
  img.draggable = false;
  img.loading = 'lazy';

  const label = document.createElement('div');
  label.className = 'emote-label';
  label.textContent = emote.emoteId;

  cell.appendChild(img);
  cell.appendChild(label);

  // クリックでチャットに入力
  cell.addEventListener('click', () => {
    insertEmote(emote.emoteId);

    cell.classList.add('inserted');
    setTimeout(() => cell.classList.remove('inserted'), 400);
  });

  // ドラッグ&ドロップ
  setupDragEvents(cell, emote.emoteId);

  return cell;
}

// ===== チャット入力 =====

function insertEmote(emoteId) {
  chrome.runtime.sendMessage({ action: 'insertEmote', emoteId });
}

// ===== ドラッグ&ドロップ =====

let dragSrcId = null;

function setupDragEvents(cell, emoteId) {
  cell.addEventListener('dragstart', e => {
    dragSrcId = emoteId;
    cell.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', emoteId);
  });

  cell.addEventListener('dragend', () => {
    cell.classList.remove('dragging');
    dragSrcId = null;
    document.querySelectorAll('.emote-cell.drag-over').forEach(c => c.classList.remove('drag-over'));
  });

  cell.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragSrcId !== emoteId) {
      cell.classList.add('drag-over');
    }
  });

  cell.addEventListener('dragleave', () => {
    cell.classList.remove('drag-over');
  });

  cell.addEventListener('drop', e => {
    e.preventDefault();
    cell.classList.remove('drag-over');

    if (!dragSrcId || dragSrcId === emoteId) return;

    // 現在の表示順を取得
    const currentOrder = getOrderedEmotes(allEmotes).map(e => e.emoteId);
    const fromIdx = currentOrder.indexOf(dragSrcId);
    const toIdx = currentOrder.indexOf(emoteId);
    if (fromIdx === -1 || toIdx === -1) return;

    // 順序を入れ替える
    currentOrder.splice(fromIdx, 1);
    currentOrder.splice(toIdx, 0, dragSrcId);

    customOrder = currentOrder;
    saveOrder();
    renderEmotes();
  });
}

// ===== イベント =====

searchInput.addEventListener('input', () => {
  currentFilter = searchInput.value.trim();
  renderEmotes();
});

sizeSlider.addEventListener('input', () => {
  const size = parseInt(sizeSlider.value);
  document.documentElement.style.setProperty('--emote-size', size + 'px');
  chrome.storage.local.set({ emoteBarSize: size });
});

resetOrderBtn.addEventListener('click', () => {
  customOrder = null;
  chrome.storage.local.remove('emoteBarOrder');
  renderEmotes();
});

closeBtn.addEventListener('click', () => {
  window.close();
});

// ===== バックグラウンドからのエモート更新受信 =====

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'emotesUpdated' && message.emotes) {
    allEmotes = message.emotes;
    renderEmotes();
  }
});

// ===== ストレージ変更の監視（別タブなどからの更新） =====

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.collectedEmotes) {
    allEmotes = changes.collectedEmotes.newValue || [];
    renderEmotes();
  }
});

// ===== 初期化 =====

loadState(() => {
  renderEmotes();
});
