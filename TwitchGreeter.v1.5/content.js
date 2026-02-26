// content.js
let greetedUsers = {};
let chatObserver = null;
let resetPanelState = {
  rendered: false,
  dimmed: false,
  panelElement: null,
  panelParent: null,
  settingsModalElement: null
};

const defaultSettings = {
  extensionEnabled: true,
  channelScope: 'specific',
  targetChannelId: '',
  themeColor: '#6441a5'
};

let currentSettings = { ...defaultSettings };

const defaultSyncSettings = {
  featureEnabled: true,
  scopeMode: 'specific',
  scopeTargetId: '',
  themeToken: '#6441a5'
};

const TRACKED_INDEX_KEY = 'trackedEntities:index';
const TRACKED_ENTITY_PREFIX = 'trackedEntity:';
let isBootstrapped = false;
const pendingMessageQueue = [];

function getEntityKey(entityId) {
  return `${TRACKED_ENTITY_PREFIX}${entityId}`;
}

function isDeepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyIndex(indexValue) {
  const ids = indexValue?.ids || [];
  const valid = new Set(ids);

  if (ids.length === 0) {
    greetedUsers = {};
    clearAllCheckboxes();
    return;
  }

  Object.keys(greetedUsers).forEach(userId => {
    if (!valid.has(userId)) {
      delete greetedUsers[userId];
      updateUserCheckboxes(userId, false);
    }
  });
}

function clearAllCheckboxes() {
  document.querySelectorAll('.greeting-checkbox input').forEach(checkbox => {
    checkbox.checked = false;
  });
}

function loadSyncSettingsAndApply(callback) {
  chrome.storage.local.get(['syncSettings', 'extensionEnabled', 'channelScope', 'targetChannelId', 'themeColor'], function(data) {
    const resolved = {
      extensionEnabled: data.syncSettings?.featureEnabled ?? data.extensionEnabled ?? defaultSyncSettings.featureEnabled,
      channelScope: data.syncSettings?.scopeMode ?? data.channelScope ?? defaultSyncSettings.scopeMode,
      targetChannelId: data.syncSettings?.scopeTargetId ?? data.targetChannelId ?? defaultSyncSettings.scopeTargetId,
      themeColor: data.syncSettings?.themeToken ?? data.themeColor ?? defaultSyncSettings.themeToken
    };

    currentSettings = resolved;
    applyThemeColor(currentSettings.themeColor);
    applyFeatureState();

    if (!data.syncSettings) {
      chrome.storage.local.set({
        syncSettings: {
          featureEnabled: resolved.extensionEnabled,
          scopeMode: resolved.channelScope,
          scopeTargetId: resolved.targetChannelId,
          themeToken: resolved.themeColor
        }
      });
    }

    if (callback) callback();
  });
}

function loadTrackedUsers(callback) {
  chrome.storage.local.get([TRACKED_INDEX_KEY, 'greetedUsers'], function(data) {
    const ids = data[TRACKED_INDEX_KEY]?.ids || [];

    if (ids.length === 0 && data.greetedUsers && Object.keys(data.greetedUsers).length > 0) {
      const writes = {};
      const migratedIds = [];
      Object.entries(data.greetedUsers).forEach(([id, value]) => {
        writes[getEntityKey(id)] = value;
        migratedIds.push(id);
      });
      writes[TRACKED_INDEX_KEY] = { ids: migratedIds };
      chrome.storage.local.set(writes, function() {
        callback(data.greetedUsers);
      });
      return;
    }

    if (ids.length === 0) {
      callback({});
      return;
    }

    chrome.storage.local.get(ids.map(getEntityKey), function(entityData) {
      const users = {};
      ids.forEach(id => {
        if (entityData[getEntityKey(id)]) {
          users[id] = entityData[getEntityKey(id)];
        }
      });
      callback(users);
    });
  });
}

function saveTrackedUser(userId, value, callback) {
  chrome.storage.local.set({ [getEntityKey(userId)]: value }, function() {
    chrome.storage.local.get(TRACKED_INDEX_KEY, function(data) {
      const currentIds = data[TRACKED_INDEX_KEY]?.ids || [];
      const merged = Array.from(new Set([...currentIds, userId]));
      chrome.storage.local.set({ [TRACKED_INDEX_KEY]: { ids: merged } }, function() {
        if (callback) callback();
      });
    });
  });
}


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
  if (!currentSettings.extensionEnabled) {
    return false;
  }

  if (currentSettings.channelScope === 'specific') {
    const target = (currentSettings.targetChannelId || '').trim().toLowerCase();
    if (!target) {
      return false;
    }
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

function loadSettingsAndApply() {
  loadSyncSettingsAndApply();
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

loadTrackedUsers(function(users) {
  greetedUsers = users;
  loadSettingsAndApply();
  isBootstrapped = true;
  while (pendingMessageQueue.length > 0) {
    const queued = pendingMessageQueue.shift();
    handleIncomingMessage(queued.message, queued.sendResponse);
  }
});

function handleIncomingMessage(message, sendResponse) {
  if (message.action === 'entityDelta') {
    const delta = message.delta || {};
    Object.keys(delta).forEach(userId => {
      if (!greetedUsers[userId]) return;
      const incoming = delta[userId];
      if (!incoming) return;
      greetedUsers[userId] = { ...greetedUsers[userId], ...incoming };
      updateUserCheckboxes(userId, Boolean(greetedUsers[userId].greeted));
    });
  } else if (message.action === 'settingsChanged') {
    loadSettingsAndApply();
  }

  sendResponse({ success: true });
}

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (!isBootstrapped) {
    pendingMessageQueue.push({ message, sendResponse });
    return true;
  }

  handleIncomingMessage(message, sendResponse);
  return true;
});


chrome.storage.onChanged.addListener(function(changes, areaName) {
  if (areaName !== 'local') {
    return;
  }

  for (const key in changes) {
    if (key === TRACKED_INDEX_KEY) {
      applyIndex(changes[key].newValue);
      if ((changes[key].newValue?.ids || []).length === 0) {
        greetedUsers = {};
      }
      continue;
    }

    if (key.startsWith(TRACKED_ENTITY_PREFIX)) {
      const entityId = key.replace(TRACKED_ENTITY_PREFIX, '');
      const indexIds = new Set(Object.keys(greetedUsers));
      const nextValue = changes[key].newValue;

      if (!indexIds.has(entityId) && !nextValue) {
        continue;
      }

      if (isDeepEqual(greetedUsers[entityId], nextValue)) {
        continue;
      }

      if (nextValue) {
        greetedUsers[entityId] = nextValue;
        updateUserCheckboxes(entityId, Boolean(nextValue.greeted));
      }
      continue;
    }

    if (key === 'syncSettings') {
      loadSettingsAndApply();
    }
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

  const clearGreetings = () => {
    greetedUsers = {};
    const allCheckboxes = document.querySelectorAll('.greeting-checkbox input');
    allCheckboxes.forEach(checkbox => {
      checkbox.checked = false;
    });
    chrome.storage.local.set({ [TRACKED_INDEX_KEY]: { ids: [] } });
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
    chrome.runtime.sendMessage({ action: 'openPopupWindow' });
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

function ensureDetectedUserTracked(messageElement, userId) {
  if (!userId || greetedUsers[userId]) {
    return;
  }

  const resolvedUsername = resolveUsernameFromMessage(messageElement, userId);
  const normalizedUsername = (resolvedUsername || '').trim().toLowerCase();

  const alreadyTrackedSameName = Object.values(greetedUsers).some(user => {
    if (!user || !user.username) {
      return false;
    }
    return user.username.trim().toLowerCase() === normalizedUsername;
  });

  if (alreadyTrackedSameName) {
    return;
  }

  greetedUsers[userId] = {
    greeted: false,
    timestamp: Date.now(),
    username: resolvedUsername
  };

  saveTrackedUser(userId, greetedUsers[userId]);
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
  checkbox.innerHTML = `
    <input type="checkbox" id="greeting-${userId}-${Date.now()}"
           ${(greetedUsers[userId] && greetedUsers[userId].greeted) ? 'checked' : ''}
           data-user-id="${userId}">
  `;

  const inputElement = checkbox.querySelector('input');
  inputElement.addEventListener('change', function() {
    const userid = this.getAttribute('data-user-id');
    const isChecked = this.checked;

    updateUserCheckboxes(userid, isChecked);

    if (isChecked) {
      greetedUsers[userid] = {
        greeted: true,
        timestamp: Date.now(),
        username: resolveUsernameFromMessage(messageElement, userId)
      };
    } else if (greetedUsers[userid]) {
      greetedUsers[userid].greeted = false;
    }

    saveTrackedUser(userid, greetedUsers[userid], function() {
      chrome.runtime.sendMessage({
        action: 'entityDelta',
        delta: { [userid]: greetedUsers[userid] }
      });
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

function applyGreetedStatus() {
  for (const userId in greetedUsers) {
    if (greetedUsers[userId].greeted) {
      updateUserCheckboxes(userId, true);
    }
  }
}

function cleanupOldGreetings() {
  const now = Date.now();
  const oneDayInMs = 24 * 60 * 60 * 1000;
  let changed = false;

  for (const userId in greetedUsers) {
    if (greetedUsers[userId].timestamp && (now - greetedUsers[userId].timestamp > oneDayInMs)) {
      greetedUsers[userId].greeted = false;
      changed = true;
    }
  }

  if (changed) {
    const updates = Object.keys(greetedUsers);
    let pending = updates.length;
    if (!pending) {
      applyGreetedStatus();
      return;
    }
    updates.forEach(userId => {
      saveTrackedUser(userId, greetedUsers[userId], function() {
        pending -= 1;
        if (pending === 0) {
          applyGreetedStatus();
        }
      });
    });
  }
}

cleanupOldGreetings();
setInterval(cleanupOldGreetings, 60 * 60 * 1000);
