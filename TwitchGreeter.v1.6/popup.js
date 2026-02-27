// popup.js
// shared/constants.js, shared/storage.js が先に読み込まれていることを前提とする

function normalizeHexColor(color) {
  if (!color) return null;
  const value = color.trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16)
  };
}

function rgbToHex({ r, g, b }) {
  const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
  return `#${[clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function mixWithWhite(hex, ratio) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#f7f3ff';
  return rgbToHex({
    r: rgb.r + (255 - rgb.r) * ratio,
    g: rgb.g + (255 - rgb.g) * ratio,
    b: rgb.b + (255 - rgb.b) * ratio
  });
}

function rgbToHsl({ r, g, b }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case red:   h = ((green - blue) / delta) % 6; break;
      case green: h = (blue - red) / delta + 2;     break;
      default:    h = (red - green) / delta + 4;    break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s: s * 100, l: l * 100 };
}

function hslToRgb({ h, s, l }) {
  const hue = ((h % 360) + 360) % 360;
  const saturation = Math.max(0, Math.min(100, s)) / 100;
  const lightness = Math.max(0, Math.min(100, l)) / 100;

  if (saturation === 0) {
    const gray = lightness * 255;
    return { r: gray, g: gray, b: gray };
  }

  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;

  let r1 = 0, g1 = 0, b1 = 0;

  if      (hue < 60)  { r1 = c; g1 = x; }
  else if (hue < 120) { r1 = x; g1 = c; }
  else if (hue < 180) { g1 = c; b1 = x; }
  else if (hue < 240) { g1 = x; b1 = c; }
  else if (hue < 300) { r1 = x; b1 = c; }
  else                { r1 = c; b1 = x; }

  return {
    r: (r1 + m) * 255,
    g: (g1 + m) * 255,
    b: (b1 + m) * 255
  };
}

function adjustColorByHsl(hex, lightnessDelta, saturationDelta) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#ddd8e8';

  const hsl = rgbToHsl(rgb);
  const adjusted = {
    h: hsl.h,
    s: Math.max(0, Math.min(100, hsl.s + saturationDelta)),
    l: Math.max(0, Math.min(100, hsl.l + lightnessDelta))
  };

  return rgbToHex(hslToRgb(adjusted));
}

function applyThemeColor(themeColor) {
  const normalized = normalizeHexColor(themeColor) || '#6441a5';
  const pastelBg = mixWithWhite(normalized, 0.88);
  const bottomControlsBg = adjustColorByHsl(pastelBg, -10, 5);

  document.documentElement.style.setProperty('--popup-bg-color', pastelBg);
  document.documentElement.style.setProperty('--popup-bottom-controls-bg', bottomControlsBg);
}

// -----------------------------------------------------------------------
// UI ヘルパー
// -----------------------------------------------------------------------

function updateChannelIdVisibility(scope) {
  document.getElementById('channelIdRow').style.display = scope === 'specific' ? 'flex' : 'none';
}

function applyEnabledState(enabled) {
  document.getElementById('enabledToggle').checked = enabled;
}

function applyThemeInputs(themeColor) {
  const normalized = normalizeHexColor(themeColor) || '#6441a5';
  document.getElementById('themeColorInput').value = normalized;
  document.getElementById('themeColorPicker').value = normalized;
  document.getElementById('themeColorPreview').style.backgroundColor = normalized;
  applyThemeColor(normalized);
}

function isMissingReceiverError(errorMessage) {
  return (errorMessage || '').includes('Could not establish connection. Receiving end does not exist.');
}

function sendMessageToTab(tabId, message, warningPrefix) {
  chrome.tabs.sendMessage(tabId, message, function() {
    if (!chrome.runtime.lastError) return;
    const errorMessage = chrome.runtime.lastError.message || '';
    if (isMissingReceiverError(errorMessage)) {
      console.debug(`${warningPrefix}: ${errorMessage}`);
      return;
    }
    console.warn(`${warningPrefix}: ${errorMessage}`);
  });
}

function sendMessageToTwitchTabs(message) {
  chrome.tabs.query({ url: ['*://*.twitch.tv/*'] }, function(tabs) {
    tabs.forEach(tab => {
      if (!tab.id) return;
      sendMessageToTab(tab.id, message, 'Twitchタブ通知に失敗');
    });
  });
}

// -----------------------------------------------------------------------
// 設定の読み込み・保存（syncSettings 単一オブジェクト）
// -----------------------------------------------------------------------

/**
 * 設定の一部を更新する（読み込み→マージ→保存）
 * storage.onChanged が content.js への通知を担うため、メッセージ送信は不要
 */
async function updateSetting(patch) {
  const current = await loadSyncSettings();
  await saveSyncSettings({ ...current, ...patch });
}

async function loadSettings() {
  const settings = await loadSyncSettings();

  applyEnabledState(settings.featureEnabled);
  document.getElementById('channelScope').value = settings.scopeMode;
  document.getElementById('channelIdInput').value = settings.scopeTargetId || '';
  updateChannelIdVisibility(settings.scopeMode);
  applyThemeInputs(settings.themeToken);
}

// -----------------------------------------------------------------------
// ユーザ一覧の読み込み（Option B 形式）
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// ユーザーリスト差分更新
// -----------------------------------------------------------------------

/**
 * 1件分の user-item 要素を生成して返す。
 * イベントリスナーも付与する。
 */
function createUserItemElement(userId, userData) {
  const userElement = document.createElement('div');
  userElement.className = 'user-item';
  userElement.dataset.userId = userId;

  const timestamp = userData.timestamp ? new Date(userData.timestamp).toLocaleString() : '不明';
  const username = userData.username || userId;

  userElement.innerHTML = `
    <div class="user-info">
      <input type="checkbox" class="user-checkbox" data-user-id="${userId}" ${userData.greeted ? 'checked' : ''}>
      <span class="user-name">${username}</span>
    </div>
    <span class="user-time">${timestamp}</span>
  `;

  const checkbox = userElement.querySelector('.user-checkbox');
  checkbox.addEventListener('change', async function() {
    const isChecked = this.checked;
    const uid = this.getAttribute('data-user-id');

    // entity 更新（個別キーのみ。index は変更不要）
    await saveEntity(uid, { ...userData, greeted: isChecked });

    // entityDelta を送信（storage 書き込み完了後）
    sendMessageToTwitchTabs({
      action: ACTIONS.ENTITY_DELTA,
      delta: { [uid]: { greeted: isChecked } }
    });
  });

  return userElement;
}

/**
 * ソート順に従って挿入すべき位置を返す。
 * greeted=false が先（未挨拶）、greeted=true が後（挨拶済）。
 * 同 greeted 内では timestamp 昇順。
 */
function findInsertPosition(userListElement, userData) {
  const items = userListElement.querySelectorAll('.user-item');
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemCheckbox = item.querySelector('.user-checkbox');
    const itemGreeted = itemCheckbox ? itemCheckbox.checked : false;
    const itemTime = parseInt(item.dataset.timestamp || '0', 10);

    const newGreeted = Boolean(userData.greeted);
    const newTime = userData.timestamp || 0;

    // greeted=false（未挨拶）は greeted=true（挨拶済）より前
    if (!newGreeted && itemGreeted) return item;
    if (newGreeted && !itemGreeted) continue;

    // 同 greeted 内では timestamp 昇順
    if (newTime < itemTime) return item;
  }
  return null; // 末尾に追加
}

/**
 * 初回フル描画。リスト全体を構築する。
 * ページ読み込み時・リセット時のみ呼ぶ。
 */
async function loadGreetedUsers() {
  const userListElement = document.getElementById('userList');
  userListElement.innerHTML = '';

  const index = await loadIndex();
  const entities = await loadAllEntities();

  if (index.ids.length === 0) {
    userListElement.innerHTML = '<div class="empty-message">まだ挨拶したユーザーはいません</div>';
    return;
  }

  const sortedUsers = Object.entries(entities).sort((a, b) => {
    const aGreeted = Boolean(a[1].greeted);
    const bGreeted = Boolean(b[1].greeted);
    if (aGreeted !== bGreeted) return aGreeted ? 1 : -1;
    return (a[1].timestamp || 0) - (b[1].timestamp || 0);
  });

  const fragment = document.createDocumentFragment();
  for (const [userId, userData] of sortedUsers) {
    const el = createUserItemElement(userId, userData);
    el.dataset.timestamp = userData.timestamp || 0;
    fragment.appendChild(el);
  }
  userListElement.appendChild(fragment);
}

/**
 * 差分更新。storage.onChanged で entity / index が変化したときに呼ぶ。
 * - 新規ユーザー：要素を挿入する（スクロール位置を維持）
 * - greeted 変化：チェックボックスのみ更新する
 * - 削除：要素を除去する
 */
async function patchUserList(changedKey, newValue) {
  const userListElement = document.getElementById('userList');

  // index が変化した場合（リセットなど）はフル再描画
  if (changedKey === STORAGE_KEYS.ENTITIES_INDEX) {
    await loadGreetedUsers();
    return;
  }

  // entity キーの変化
  if (!changedKey.startsWith(STORAGE_KEYS.ENTITY_PREFIX)) return;

  const userId = changedKey.replace(STORAGE_KEYS.ENTITY_PREFIX, '');
  const existing = userListElement.querySelector(`.user-item[data-user-id="${userId}"]`);

  // 削除（null）
  if (newValue === null || newValue === undefined) {
    if (existing) existing.remove();
    // リストが空になったら空メッセージを表示
    if (userListElement.querySelectorAll('.user-item').length === 0) {
      userListElement.innerHTML = '<div class="empty-message">まだ挨拶したユーザーはいません</div>';
    }
    return;
  }

  // greeted 変化のみ（既存要素のチェックボックスだけ更新）
  if (existing) {
    const checkbox = existing.querySelector('.user-checkbox');
    if (checkbox && checkbox.checked !== Boolean(newValue.greeted)) {
      checkbox.checked = Boolean(newValue.greeted);
    }
    return;
  }

  // 新規追加
  // 空メッセージがあれば除去
  const emptyMsg = userListElement.querySelector('.empty-message');
  if (emptyMsg) emptyMsg.remove();

  const el = createUserItemElement(userId, newValue);
  el.dataset.timestamp = newValue.timestamp || 0;

  // ソート順に従って挿入位置を決定
  const before = findInsertPosition(userListElement, newValue);
  userListElement.insertBefore(el, before); // before=null のときは末尾挿入
}

// -----------------------------------------------------------------------
// DOMContentLoaded
// -----------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', function() {
  const channelScopeSelect  = document.getElementById('channelScope');
  const channelIdInput      = document.getElementById('channelIdInput');
  const enabledToggle       = document.getElementById('enabledToggle');
  const themeColorInput     = document.getElementById('themeColorInput');
  const themeColorPreview   = document.getElementById('themeColorPreview');
  const themeColorPicker    = document.getElementById('themeColorPicker');
  const popupCloseButton    = document.getElementById('popupCloseButton');

  // ---- 設定 UI イベント ----

  channelScopeSelect.addEventListener('change', function() {
    updateChannelIdVisibility(this.value);
    updateSetting({ scopeMode: this.value });
  });

  channelIdInput.addEventListener('input', function() {
    updateSetting({ scopeTargetId: this.value.trim() });
  });

  enabledToggle.addEventListener('change', function() {
    applyEnabledState(this.checked);
    updateSetting({ featureEnabled: this.checked });
  });

  themeColorInput.addEventListener('change', function() {
    const normalized = normalizeHexColor(this.value);
    if (!normalized) {
      applyThemeInputs('#6441a5');
      updateSetting({ themeToken: '#6441a5' });
      return;
    }
    applyThemeInputs(normalized);
    updateSetting({ themeToken: normalized });
  });

  themeColorPreview.addEventListener('click', function() {
    themeColorPicker.click();
  });

  themeColorPicker.addEventListener('input', function() {
    const normalized = normalizeHexColor(this.value) || '#6441a5';
    applyThemeInputs(normalized);
    updateSetting({ themeToken: normalized });
  });

  // ---- リセットボタン ----
  // index を空にする（entity個別キーは孤立データとして残す）
  // content.js は storage.onChanged → applyIndex(空) → clearLocalCacheAndDom() で自動反映

  document.getElementById('resetBtn').addEventListener('click', async function() {
    if (confirm('すべての挨拶履歴をリセットしますか？')) {
      await resetIndex();
      loadGreetedUsers();
    }
  });

  // ---- 閉じるボタン ----

  popupCloseButton.addEventListener('click', function() {
    const isModal = new URLSearchParams(window.location.search).get('modal') === '1';
    if (isModal && window.parent && window.parent !== window) {
      window.parent.postMessage('closeTwitchGreeterModal', '*');
      return;
    }
    window.close();
  });

  // ---- storage.onChanged：差分更新（Option B フィルタリング） ----
  // entity キーは patchUserList で1件ずつ差分更新する。
  // index キーの変化（リセット等）はフル再描画にフォールバックする。

  chrome.storage.onChanged.addListener(function(changes, areaName) {
    if (areaName !== 'local') return;

    for (const key in changes) {
      if (key === STORAGE_KEYS.ENTITIES_INDEX) {
        // index 変化（リセットなど）→ フル再描画
        patchUserList(key, changes[key].newValue);
        return;
      }
      if (key.startsWith(STORAGE_KEYS.ENTITY_PREFIX)) {
        // entity 変化 → 差分更新（スクロール位置・ちらつきなし）
        patchUserList(key, changes[key].newValue);
      }
    }
  });

  // ---- 初期読み込み ----

  loadSettings();
  loadGreetedUsers();
});
