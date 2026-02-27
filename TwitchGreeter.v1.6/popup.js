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

    if (aGreeted !== bGreeted) {
      return aGreeted ? 1 : -1;
    }

    return (a[1].timestamp || 0) - (b[1].timestamp || 0);
  });

  for (const [userId, userData] of sortedUsers) {
    const userElement = document.createElement('div');
    userElement.className = 'user-item';

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

    userListElement.appendChild(userElement);
  }
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

  // ---- storage.onChanged：ユーザ一覧の自動再描画（Option B フィルタリング） ----

  chrome.storage.onChanged.addListener(function(changes, areaName) {
    if (areaName !== 'local') return;

    for (const key in changes) {
      if (
        key === STORAGE_KEYS.ENTITIES_INDEX ||
        key.startsWith(STORAGE_KEYS.ENTITY_PREFIX)
      ) {
        loadGreetedUsers();
        return; // 1回の変更バッチで複数キーが変わっても再描画は1度だけ
      }
    }
  });

  // ---- 初期読み込み ----

  loadSettings();
  loadGreetedUsers();
});
