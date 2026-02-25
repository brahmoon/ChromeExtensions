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
    ? adjustColorByHsl(panelBg, 14, -10)
    : adjustColorByHsl(panelBg, -14, 5);
  const buttonText = isLightTheme && getLightness(buttonBg) >= 75
    ? '#444444'
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
  chrome.storage.local.get(defaultSettings, function(data) {
    currentSettings = {
      extensionEnabled: data.extensionEnabled,
      channelScope: data.channelScope,
      targetChannelId: data.targetChannelId,
      themeColor: data.themeColor
    };

    applyThemeColor(currentSettings.themeColor);
    applyFeatureState();
  });
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

chrome.storage.local.get('greetedUsers', function(data) {
  if (data.greetedUsers) {
    greetedUsers = data.greetedUsers;
  }
  loadSettingsAndApply();
});

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.action === 'updateGreetedStatus') {
    updateUserCheckboxes(message.userId, message.greeted);
    if (greetedUsers[message.userId]) {
      greetedUsers[message.userId].greeted = message.greeted;
    }
  } else if (message.action === 'resetAllGreetings') {
    const allCheckboxes = document.querySelectorAll('.greeting-checkbox input');
    allCheckboxes.forEach(checkbox => {
      checkbox.checked = false;
    });

    for (const userId in greetedUsers) {
      if (greetedUsers[userId]) {
        greetedUsers[userId].greeted = false;
      }
    }
  } else if (message.action === 'settingsChanged') {
    loadSettingsAndApply();
  }

  sendResponse({ success: true });
  return true;
});


chrome.storage.onChanged.addListener(function(changes, areaName) {
  if (areaName !== 'local') {
    return;
  }

  if (changes.greetedUsers) {
    greetedUsers = changes.greetedUsers.newValue || {};
    applyGreetedStatus();
  }

  if (changes.themeColor || changes.extensionEnabled || changes.channelScope || changes.targetChannelId) {
    loadSettingsAndApply();
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
    chrome.storage.local.set({ greetedUsers: {} });
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

  panelParent.appendChild(panel);
  chatContainer.insertBefore(panelParent, chatContainer.firstChild);

  resetPanelState.rendered = true;
  resetPanelState.panelElement = panel;
  resetPanelState.panelParent = panelParent;
}

function extractUserIdFromNotice(messageElement) {
  const text = (messageElement || '').replace(/\s+/g, '');
  const suffix = 'を引き換えました[0-9]+$';

  if (text.match(suffix) == null) {
    return null;
  }

  const beforeSuffix = text.slice(0, -suffix.length);
  const lastGaIndex = beforeSuffix.lastIndexOf('が');

  if (lastGaIndex <= 0) {
    return null;
  }

  return beforeSuffix.slice(0, lastGaIndex).trim();
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

  greetedUsers[userId] = {
    greeted: false,
    timestamp: Date.now(),
    username: resolveUsernameFromMessage(messageElement, userId)
  };

  chrome.storage.local.set({ greetedUsers: greetedUsers });
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
    userId = extractUserIdFromNotice(messageElement.innerText);
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

    chrome.storage.local.set({ greetedUsers: greetedUsers });
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
    chrome.storage.local.set({ greetedUsers: greetedUsers });
    applyGreetedStatus();
  }
}

cleanupOldGreetings();
setInterval(cleanupOldGreetings, 60 * 60 * 1000);
