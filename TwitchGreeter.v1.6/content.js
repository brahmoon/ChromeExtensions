// content.js
// shared/constants.js, shared/storage.js が先に読み込まれていることを前提とする

let chatObserver = null;
let resetPanelState = {
  rendered: false,
  dimmed: false,
  panelElement: null,
  panelParent: null,
  settingsModalElement: null
};

// -----------------------------------------------------------------------
// localCache：設定・index・entity の in-memory キャッシュ
// -----------------------------------------------------------------------

const localCache = {
  settings: { ...DEFAULT_SYNC_SETTINGS },
  index: { ids: [] },
  entities: {},
  getIndex() { return this.index; },
  get(id) { return this.entities[id] ?? null; },
  set(id, val) { this.entities[id] = val; },
  delete(id) { delete this.entities[id]; },
  clear() { this.entities = {}; this.index = { ids: [] }; }
};

// -----------------------------------------------------------------------
// ブートストラップ制御
// -----------------------------------------------------------------------

let isBootstrapped = false;
const pendingMessageQueue = [];

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

function getLightness(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;

  const values = [rgb.r, rgb.g, rgb.b].map(value => value / 255);
  const max = Math.max(...values);
  const min = Math.min(...values);
  return ((max + min) / 2) * 100;
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
      case red:
        h = ((green - blue) / delta) % 6;
        break;
      case green:
        h = (blue - red) / delta + 2;
        break;
      default:
        h = (red - green) / delta + 4;
        break;
    }

    h *= 60;
    if (h < 0) {
      h += 360;
    }
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

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hue < 60) {
    r1 = c;
    g1 = x;
  } else if (hue < 120) {
    r1 = x;
    g1 = c;
  } else if (hue < 180) {
    g1 = c;
    b1 = x;
  } else if (hue < 240) {
    g1 = x;
    b1 = c;
  } else if (hue < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  return {
    r: (r1 + m) * 255,
    g: (g1 + m) * 255,
    b: (b1 + m) * 255
  };
}

function adjustColorByHsl(hex, lightnessDelta, saturationDelta) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#5f4b8b';

  const hsl = rgbToHsl(rgb);
  return rgbToHex(hslToRgb({
    h: hsl.h,
    s: Math.max(0, Math.min(100, hsl.s + saturationDelta)),
    l: Math.max(0, Math.min(100, hsl.l + lightnessDelta))
  }));
}

function mixColor(hexA, hexB, ratio) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return '#5f4b8b';
  return rgbToHex({
    r: a.r * (1 - ratio) + b.r * ratio,
    g: a.g * (1 - ratio) + b.g * ratio,
    b: a.b * (1 - ratio) + b.b * ratio
  });
}

function applyThemeColor(themeColor) {
  const base = normalizeHexColor(themeColor) || '#6441a5';
  const panelBg = mixColor(base, '#ffffff', 0.35);
  const panelBorder = mixColor(base, '#000000', 0.15);
  const panelLightness = getLightness(panelBg);
  const isLightTheme = panelLightness > 65;
  const textColor = isLightTheme ? '#444444' : mixColor(base, '#ffffff', 0.88);
  const buttonBg = isLightTheme
    ? adjustColorByHsl(panelBg, -8, -10)
    : adjustColorByHsl(panelBg, 8, 5);
  const buttonHoverBg = isLightTheme
    ? adjustColorByHsl(panelBg, -20, -10)
    : adjustColorByHsl(panelBg, -14, 5);
  const buttonText = isLightTheme && getLightness(buttonBg) >= 75
    ? '#555555'
    : (isLightTheme ? '#ffffff' : '#f7f3ff');

  document.documentElement.style.setProperty('--greeting-panel-bg', panelBg);
  document.documentElement.style.setProperty('--greeting-panel-border', panelBorder);
  document.documentElement.style.setProperty('--greeting-panel-text', textColor);
  document.documentElement.style.setProperty('--greeting-reset-button-bg', buttonBg);
  document.documentElement.style.setProperty('--greeting-reset-button-hover-bg', buttonHoverBg);
  document.documentElement.style.setProperty('--greeting-reset-button-text', buttonText);
}

function getCurrentChannelId() {
  const pathParts = window.location.pathname.split('/').filter(Boolean);

  if (pathParts[0] === 'popout') {
    return pathParts[1] ? pathParts[1].toLowerCase() : '';
  }

  return pathParts[0] ? pathParts[0].toLowerCase() : '';
}

function isFeatureActiveOnCurrentPage() {
  const s = localCache.settings;
  if (!s.featureEnabled) return false;

  if (s.scopeMode === 'specific') {
    const target = (s.scopeTargetId || '').trim().toLowerCase();
    if (!target) return false;
    return getCurrentChannelId() === target;
  }

  return true;
}

function hideInjectedElements() {
  document.querySelectorAll('.greeting-checkbox, .greeting-reset-layout').forEach(element => {
    element.style.display = 'none';
  });
}

function showInjectedElements() {
  document.querySelectorAll('.greeting-checkbox, .greeting-reset-layout').forEach(element => {
    element.style.display = '';
  });
}

function stopObserver() {
  if (chatObserver) {
    chatObserver.disconnect();
    chatObserver = null;
  }
}

// -----------------------------------------------------------------------
// apply 系関数（循環更新防止ガード付き・冪等）
// -----------------------------------------------------------------------

function applySettings(newSettings) {
  if (!newSettings) return;
  const merged = { ...DEFAULT_SYNC_SETTINGS, ...newSettings };
  if (JSON.stringify(localCache.settings) === JSON.stringify(merged)) return;

  localCache.settings = merged;
  applyThemeColor(merged.themeToken);
  applyFeatureState();
}

function applyEntityState(entityId, newValue) {
  // 削除（null）の場合
  if (newValue === null) {
    localCache.delete(entityId);
    updateUserCheckboxes(entityId, false);
    return;
  }

  const cached = localCache.get(entityId);
  // 値が同一なら何もしない（循環更新・重複処理の防止）
  if (JSON.stringify(cached) === JSON.stringify(newValue)) return;

  localCache.set(entityId, newValue);
  updateUserCheckboxes(entityId, newValue.greeted ?? false);
}

function applyIndex(newIndex, oldIndex) {
  if (JSON.stringify(localCache.index) === JSON.stringify(newIndex)) return;

  const previousIds = oldIndex?.ids ?? localCache.index.ids.slice();
  localCache.index = newIndex;

  // index が空 → 全リセット
  if (newIndex.ids.length === 0) {
    clearLocalCacheAndDom();
    return;
  }

  // 削除された id の entity をキャッシュ・DOM から除去
  const removedIds = previousIds.filter(id => !newIndex.ids.includes(id));
  for (const id of removedIds) {
    localCache.delete(id);
    updateUserCheckboxes(id, false);
  }

  // 孤立キーのクリーンアップ（非同期・補助的）
  cleanupOrphanedEntityKeys(previousIds, newIndex.ids);
}

function clearLocalCacheAndDom() {
  localCache.clear();
  document.querySelectorAll('.greeting-checkbox input').forEach(cb => {
    cb.checked = false;
  });
}

function applyGreetedStatus() {
  for (const userId of localCache.index.ids) {
    const entity = localCache.get(userId);
    if (entity && entity.greeted) {
      updateUserCheckboxes(userId, true);
    }
  }
}

// -----------------------------------------------------------------------
// bootstrap：起動時に storage から全状態を読み込む
// -----------------------------------------------------------------------

async function bootstrap() {
  // Step 1: 設定を読み込む
  const settings = await loadSyncSettings();
  localCache.settings = settings;
  applyThemeColor(settings.themeToken);

  // Step 2: index を読み込み、entity を一括取得する
  localCache.index = await loadIndex();
  localCache.entities = await loadAllEntities();

  // Step 3: UI を反映する
  applyFeatureState();

  // Step 4: ブートストラップ完了
  isBootstrapped = true;

  // Step 5: キューに溜まったメッセージを処理する
  while (pendingMessageQueue.length > 0) {
    const msg = pendingMessageQueue.shift();
    handleMessage(msg);
  }
}

function applyFeatureState() {
  const isActive = isFeatureActiveOnCurrentPage();

  if (!isActive) {
    stopObserver();
    hideInjectedElements();
    return;
  }

  showInjectedElements();

  if (!chatObserver) {
    setupMutationObserver();
  }

  applyGreetedStatus();
}

// -----------------------------------------------------------------------
// 起動
// -----------------------------------------------------------------------

bootstrap();

// -----------------------------------------------------------------------
// メッセージ受信（entityDelta）
// -----------------------------------------------------------------------

function handleEntityDelta(delta) {
  const index = localCache.getIndex();

  for (const [entityId, newValue] of Object.entries(delta)) {
    // index 存在チェック（null は削除操作なので除外）
    if (newValue !== null && !index.ids.includes(entityId)) continue;

    applyEntityState(entityId, newValue);
  }
}

function handleMessage(message) {
  if (message.action === ACTIONS.ENTITY_DELTA) {
    handleEntityDelta(message.delta ?? {});
  }
}

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (!message || !message.action) return;

  if (!isBootstrapped) {
    pendingMessageQueue.push(message);
    sendResponse({ success: true });
    return true;
  }

  handleMessage(message);
  sendResponse({ success: true });
  return true;
});

// -----------------------------------------------------------------------
// storage.onChanged（Option B フィルタリング・最終整合）
// -----------------------------------------------------------------------

chrome.storage.onChanged.addListener(function(changes, area) {
  if (area !== 'local') return;

  for (const key in changes) {
    if (key.startsWith(STORAGE_KEYS.ENTITY_PREFIX)) {
      const entityId = key.replace(STORAGE_KEYS.ENTITY_PREFIX, '');
      applyEntityState(entityId, changes[key].newValue ?? null);
    } else if (key === STORAGE_KEYS.ENTITIES_INDEX) {
      const newIndex = changes[key].newValue ?? { ids: [] };
      const oldIndex = changes[key].oldValue ?? { ids: [] };
      applyIndex(newIndex, oldIndex);
    } else if (key === STORAGE_KEYS.SYNC_SETTINGS) {
      applySettings(changes[key].newValue);
    }
    // それ以外のキーは無視する
  }
});

const NOTICE_SELECTOR = 'div[data-test-selector="user-notice-line"], .user-notice-line';

function collectMessageTargets(rootElement) {
  const targets = [];

  if (!rootElement || rootElement.nodeType !== Node.ELEMENT_NODE) {
    return targets;
  }

  if (rootElement.matches('.chat-line__message') || rootElement.matches(NOTICE_SELECTOR)) {
    targets.push(rootElement);
  }

  rootElement.querySelectorAll(`.chat-line__message, ${NOTICE_SELECTOR}`).forEach(element => {
    targets.push(element);
  });

  return targets;
}

function setupMutationObserver() {
  const chatContainer = document.querySelector('.chat-scrollable-area__message-container');

  if (!chatContainer) {
    setTimeout(setupMutationObserver, 1000);
    return;
  }

  insertResetPanel(chatContainer);

  chatObserver = new MutationObserver(mutations => {
    if (!isFeatureActiveOnCurrentPage()) {
      return;
    }

    mutations.forEach(mutation => {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          collectMessageTargets(node).forEach(addCheckboxToMessage);
        });
      }
    });
  });

  chatObserver.observe(chatContainer, { childList: true, subtree: true });

  document.querySelectorAll(`.chat-line__message, ${NOTICE_SELECTOR}`).forEach(addCheckboxToMessage);
}

function insertResetPanel(chatContainer) {
  if (resetPanelState.rendered) {
    return;
  }

  const panelParent = document.createElement('div');
  panelParent.className = 'Layout-sc-1xcs6mc-0 greeting-reset-layout';

  const panel = document.createElement('div');
  panel.className = 'greeting-reset-panel';
  panel.innerHTML = `
    <div class="greeting-panel-actions">
      <button type="button" class="greeting-settings-button" aria-label="設定を開く">
        <svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M19.9 12.66a1 1 0 0 1 0-1.32l1.28-1.44a1 1 0 0 0 .12-1.17l-2-3.46a1 1 0 0 0-1.07-.48l-1.88.38a1 1 0 0 1-1.15-.66l-.61-1.83a1 1 0 0 0-.95-.68h-4a1 1 0 0 0-1 .68l-.56 1.83a1 1 0 0 1-1.15.66L5 4.79a1 1 0 0 0-1 .48L2 8.73a1 1 0 0 0 .1 1.17l1.27 1.44a1 1 0 0 1 0 1.32L2.1 14.1a1 1 0 0 0-.1 1.17l2 3.46a1 1 0 0 0 1.07.48l1.88-.38a1 1 0 0 1 1.15.66l.61 1.83a1 1 0 0 0 1 .68h4a1 1 0 0 0 .95-.68l.61-1.83a1 1 0 0 1 1.15-.66l1.88.38a1 1 0 0 0 1.07-.48l2-3.46a1 1 0 0 0-.12-1.17ZM18.41 14l.8.9l-1.28 2.22l-1.18-.24a3 3 0 0 0-3.45 2L12.92 20h-2.56L10 18.86a3 3 0 0 0-3.45-2l-1.18.24l-1.3-2.21l.8-.9a3 3 0 0 0 0-4l-.8-.9l1.28-2.2l1.18.24a3 3 0 0 0 3.45-2L10.36 4h2.56l.38 1.14a3 3 0 0 0 3.45 2l1.18-.24l1.28 2.22l-.8.9a3 3 0 0 0 0 3.98Zm-6.77-6a4 4 0 1 0 4 4a4 4 0 0 0-4-4Zm0 6a2 2 0 1 1 2-2a2 2 0 0 1-2 2Z"/></svg>
      </button>
      <button type="button" class="greeting-close-button" aria-label="パネルを閉じる">×</button>
    </div>
    <div class="greeting-reset-label">以下のボタンで挨拶記録をリセットできます。</div>
    <div class="greeting-reset-buttons">
      <button type="button" class="greeting-reset-button greeting-reset-confirm">リセット</button>
      <button type="button" class="greeting-reset-button greeting-reset-skip">今回はしない</button>
    </div>
  `;


  const removePanel = () => {
    panelParent.remove();
    resetPanelState.rendered = false;
    resetPanelState.panelElement = null;
    resetPanelState.panelParent = null;
  };

  const closeSettingsModal = () => {
    if (!resetPanelState.settingsModalElement) {
      return;
    }

    resetPanelState.settingsModalElement.remove();
    resetPanelState.settingsModalElement = null;
    document.removeEventListener('keydown', handleModalEscape);
  };

  const handleModalEscape = event => {
    if (event.key === 'Escape') {
      closeSettingsModal();
    }
  };

  const clearGreetings = async () => {
    // index を空にする（storage.onChanged → applyIndex(空) → clearLocalCacheAndDom() で自動反映）
    await resetIndex();
  };

  panel.querySelector('.greeting-reset-confirm').addEventListener('click', function() {
    if (confirm('挨拶記録をリセットしますか？')) {
      clearGreetings();
    }
  });

  panel.querySelector('.greeting-reset-skip').addEventListener('click', function() {
    removePanel();
  });

  panel.querySelector('.greeting-close-button').addEventListener('click', function() {
    removePanel();
  });

  panel.querySelector('.greeting-settings-button').addEventListener('click', function() {
    chrome.runtime.sendMessage({ action: ACTIONS.OPEN_POPUP_WINDOW });
  });

  panelParent.appendChild(panel);
  chatContainer.insertBefore(panelParent, chatContainer.firstChild);

  resetPanelState.rendered = true;
  resetPanelState.panelElement = panel;
  resetPanelState.panelParent = panelParent;
}

function extractUserIdFromNotice(messageElement) {
  if (!messageElement) {
    return null;
  }

  const noticeText = (messageElement.innerText || '').replace(/\s+/g, '');

  const exchangeMatch = noticeText.match(/^(.*)が.*を引き換えました[0-9]+$/);
  if (exchangeMatch && exchangeMatch[1]) {
    return exchangeMatch[1].trim() || null;
  }

  const rawNoticeText = (messageElement.innerText || '').trim();
  if (rawNoticeText.includes('サブスクしました')) {
    const sanGaIndex = rawNoticeText.lastIndexOf('さんが');
    if (sanGaIndex > 0) {
      const textBeforeSanGa = rawNoticeText.slice(0, sanGaIndex).trim();
      const usernameCandidates = textBeforeSanGa
        .split(/[\s:：!！。]/)
        .map(part => part.trim())
        .filter(Boolean);

      if (usernameCandidates.length > 0) {
        return usernameCandidates[usernameCandidates.length - 1];
      }
    }
  }

  if (!noticeText.includes('連続視聴記録')) {
    return null;
  }

  const intlLoginElement = messageElement.querySelector('span.intl-login');
  if (!intlLoginElement || !intlLoginElement.parentNode) {
    return null;
  }

  let previousNode = intlLoginElement.previousSibling;
  while (previousNode) {
    if (previousNode.nodeType === Node.TEXT_NODE) {
      const usernameFromText = (previousNode.textContent || '').trim();
      if (usernameFromText) {
        return usernameFromText;
      }
    }

    if (previousNode.nodeType === Node.ELEMENT_NODE && previousNode.tagName === 'SPAN') {
      const usernameFromSpan = (previousNode.textContent || '').trim();
      if (usernameFromSpan) {
        return usernameFromSpan;
      }
    }

    previousNode = previousNode.previousSibling;
  }

  const parentNode = intlLoginElement.parentNode;
  if (parentNode && parentNode.childNodes) {
    const textBeforeIntlLogin = [];

    for (const childNode of parentNode.childNodes) {
      if (childNode === intlLoginElement) {
        break;
      }
      textBeforeIntlLogin.push((childNode.textContent || '').trim());
    }

    const fallbackUsername = textBeforeIntlLogin.join('').trim();
    if (fallbackUsername) {
      return fallbackUsername;
    }
  }

  return null;
}


function resolveUsernameFromMessage(messageElement, userId) {
  if (messageElement.matches('.chat-line__message')) {
    const nameElem = messageElement.querySelector('.chat-author__display-name');
    if (nameElem && nameElem.textContent) {
      return nameElem.textContent.trim();
    }
  }

  if (messageElement.matches(NOTICE_SELECTOR)) {
    const noticeNameElement = messageElement.querySelector('[data-a-user]');
    if (noticeNameElement) {
      const noticeName = noticeNameElement.getAttribute('data-a-user');
      if (noticeName) {
        return noticeName.trim();
      }
    }
  }

  return userId;
}

async function ensureDetectedUserTracked(messageElement, userId) {
  if (!userId || localCache.get(userId)) {
    return;
  }

  const resolvedUsername = resolveUsernameFromMessage(messageElement, userId);
  const normalizedUsername = (resolvedUsername || '').trim().toLowerCase();

  const alreadyTrackedSameName = Object.values(localCache.entities).some(user => {
    if (!user || !user.username) return false;
    return user.username.trim().toLowerCase() === normalizedUsername;
  });

  if (alreadyTrackedSameName) {
    return;
  }

  const newEntity = {
    greeted: false,
    timestamp: Date.now(),
    username: resolvedUsername
  };

  // 楽観的更新（UI 即時反映）
  localCache.set(userId, newEntity);
  localCache.index.ids.push(userId);

  // storage への書き込み（entity先行 → index更新の順序を保証）
  await addEntity(userId, newEntity);
}

function placeCheckbox(messageElement, checkbox) {
  const timestampElement = messageElement.querySelector('.chat-line__timestamp');
  if (timestampElement && timestampElement.parentNode) {
    timestampElement.parentNode.insertBefore(checkbox, timestampElement);
    return;
  }

  const usernameContainer = messageElement.querySelector('.chat-line__username-container');
  if (usernameContainer) {
    usernameContainer.insertBefore(checkbox, usernameContainer.firstChild);
    return;
  }

  const noticeMessageContainer = messageElement.querySelector('[data-test-selector="user-notice-line-message"]');
  if (noticeMessageContainer) {
    noticeMessageContainer.insertBefore(checkbox, noticeMessageContainer.firstChild);
    return;
  }

  if (messageElement.matches(NOTICE_SELECTOR)) {
    messageElement.classList.add('greeting-notice-with-checkbox');
  }

  messageElement.insertBefore(checkbox, messageElement.firstChild);
}

function placeCheckboxForNoticeMessage(messageElement, checkbox) {
  const noticeMessageContainer = messageElement.querySelector('[data-test-selector="user-notice-line-message"]');
  if (!noticeMessageContainer) {
    placeCheckbox(messageElement, checkbox);
    return;
  }

  const textNodeWalker = document.createTreeWalker(
    noticeMessageContainer,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node.textContent && node.textContent.trim().length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    }
  );

  const firstTextNode = textNodeWalker.nextNode();
  if (firstTextNode && firstTextNode.parentNode) {
    firstTextNode.parentNode.insertBefore(checkbox, firstTextNode);
    return;
  }

  noticeMessageContainer.insertBefore(checkbox, noticeMessageContainer.firstChild);
}

function addCheckboxToMessage(messageElement) {
  if (!isFeatureActiveOnCurrentPage()) {
    return;
  }

  if (messageElement.querySelector('.greeting-checkbox')) {
    return;
  }

  let userId = null;

  if (messageElement.matches('.chat-line__message')) {
    userId = messageElement.getAttribute('data-a-user');
  } else if (messageElement.matches(NOTICE_SELECTOR)) {
    userId = extractUserIdFromNotice(messageElement);
  }

  if (!userId) return;

  ensureDetectedUserTracked(messageElement, userId);

  const checkbox = document.createElement('span');
  checkbox.className = 'greeting-checkbox';
  const entity = localCache.get(userId);
  checkbox.innerHTML = `
    <input type="checkbox" id="greeting-${userId}-${Date.now()}"
           ${(entity && entity.greeted) ? 'checked' : ''}
           data-user-id="${userId}">
  `;

  const inputElement = checkbox.querySelector('input');
  inputElement.addEventListener('change', async function() {
    const userid = this.getAttribute('data-user-id');
    const isChecked = this.checked;

    // 楽観的更新（UI 即時反映）
    updateUserCheckboxes(userid, isChecked);

    const current = localCache.get(userid);
    const updated = current
      ? { ...current, greeted: isChecked }
      : { greeted: isChecked, timestamp: Date.now(), username: resolveUsernameFromMessage(messageElement, userid) };

    localCache.set(userid, updated);

    // storage 更新（entity のみ。index は変更不要）
    await saveEntity(userid, updated);

    // entityDelta 送信（storage 書き込み完了後）
    chrome.runtime.sendMessage({
      action: ACTIONS.ENTITY_DELTA,
      delta: { [userid]: { greeted: isChecked } }
    }, function() {
      // NO_RECEIVER は warning 扱い（クラッシュしない）
      if (chrome.runtime.lastError) {
        console.debug('entityDelta 送信失敗（popup 未起動）:', chrome.runtime.lastError.message);
      }
    });
  });

  if (messageElement.matches(NOTICE_SELECTOR)) {
    placeCheckboxForNoticeMessage(messageElement, checkbox);
    return;
  }

  placeCheckbox(messageElement, checkbox);
}

function updateUserCheckboxes(userId, isChecked) {
  const checkboxes = document.querySelectorAll(`.greeting-checkbox input[data-user-id="${userId}"]`);
  checkboxes.forEach(checkbox => {
    checkbox.checked = isChecked;
  });
}

async function cleanupOldGreetings() {
  const now = Date.now();
  const oneDayInMs = 24 * 60 * 60 * 1000;

  for (const userId of localCache.index.ids) {
    const entity = localCache.get(userId);
    if (entity && entity.timestamp && (now - entity.timestamp > oneDayInMs) && entity.greeted) {
      const updated = { ...entity, greeted: false };
      localCache.set(userId, updated);
      await saveEntity(userId, updated);
      updateUserCheckboxes(userId, false);
    }
  }
}

cleanupOldGreetings();
setInterval(cleanupOldGreetings, 60 * 60 * 1000);
