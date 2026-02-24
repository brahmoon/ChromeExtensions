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
  channelScope: 'all',
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
  const buttonBg = isLightTheme ? mixColor(panelBg, '#000000', 0.28) : mixColor(panelBg, '#ffffff', 0.2);
  const buttonHoverBg = isLightTheme ? mixColor(panelBg, '#000000', 0.4) : mixColor(panelBg, '#ffffff', 0.3);
  const buttonText = isLightTheme ? '#ffffff' : '#f7f3ff';

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
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M19.9 12.66a1 1 0 0 1 0-1.32l1.28-1.44a1 1 0 0 0 .12-1.17l-2-3.46a1 1 0 0 0-1.07-.48l-1.88.38a1 1 0 0 1-1.15-.66l-.61-1.83a1 1 0 0 0-.95-.68h-4a1 1 0 0 0-1 .68l-.56 1.83a1 1 0 0 1-1.15.66L5 4.79a1 1 0 0 0-1 .48L2 8.73a1 1 0 0 0 .1 1.17l1.27 1.44a1 1 0 0 1 0 1.32L2.1 14.1a1 1 0 0 0-.1 1.17l2 3.46a1 1 0 0 0 1.07.48l1.88-.38a1 1 0 0 1 1.15.66l.61 1.83a1 1 0 0 0 1 .68h4a1 1 0 0 0 .95-.68l.61-1.83a1 1 0 0 1 1.15-.66l1.88.38a1 1 0 0 0 1.07-.48l2-3.46a1 1 0 0 0-.12-1.17ZM18.41 14l.8.9l-1.28 2.22l-1.18-.24a3 3 0 0 0-3.45 2L12.92 20h-2.56L10 18.86a3 3 0 0 0-3.45-2l-1.18.24l-1.3-2.21l.8-.9a3 3 0 0 0 0-4l-.8-.9l1.28-2.2l1.18.24a3 3 0 0 0 3.45-2L10.36 4h2.56l.38 1.14a3 3 0 0 0 3.45 2l1.18-.24l1.28 2.22l-.8.9a3 3 0 0 0 0 3.98Zm-6.77-6a4 4 0 1 0 4 4a4 4 0 0 0-4-4Zm0 6a2 2 0 1 1 2-2a2 2 0 0 1-2 2Z"/></svg>
      </button>
      <button type="button" class="greeting-close-button" aria-label="パネルを閉じる">×</button>
    </div>
    <div class="greeting-reset-label">以下のボタンで挨拶記録をリセットできます。</div>
    <div class="greeting-reset-buttons">
      <button type="button" class="greeting-reset-button greeting-reset-confirm">リセット</button>
      <button type="button" class="greeting-reset-button greeting-reset-skip">今回はしない</button>
    </div>
  `;

  const dimPanel = () => {
    panel.classList.add('is-inactive');
    resetPanelState.dimmed = true;
  };

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

  const openSettingsModal = () => {
    if (resetPanelState.settingsModalElement) {
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'greeting-settings-modal';

    const iframe = document.createElement('iframe');
    iframe.className = 'greeting-settings-frame';
    iframe.src = chrome.runtime.getURL('popup.html?modal=1');
    iframe.title = 'Twitch Greeter 設定';
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write');

    overlay.addEventListener('click', event => {
      if (event.target === overlay) {
        closeSettingsModal();
      }
    });

    window.addEventListener('message', event => {
      if (event.source !== iframe.contentWindow || event.data !== 'closeTwitchGreeterModal') {
        return;
      }
      closeSettingsModal();
    }, { once: true });

    overlay.appendChild(iframe);
    document.body.appendChild(overlay);
    resetPanelState.settingsModalElement = overlay;
    document.addEventListener('keydown', handleModalEscape);
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
      dimPanel();
    }
  });

  panel.querySelector('.greeting-reset-skip').addEventListener('click', function() {
    removePanel();
  });

  panel.querySelector('.greeting-close-button').addEventListener('click', function() {
    removePanel();
  });

  panel.querySelector('.greeting-settings-button').addEventListener('click', function() {
    openSettingsModal();
  });

  panelParent.appendChild(panel);
  chatContainer.insertBefore(panelParent, chatContainer.firstChild);

  resetPanelState.rendered = true;
  resetPanelState.panelElement = panel;
  resetPanelState.panelParent = panelParent;
}

function extractUserIdFromNotice(messageElement) {
  const text = (messageElement.textContent || '').replace(/\s+/g, ' ').trim();
  const suffix = 'を引き換えました';

  if (!text.endsWith(suffix)) {
    return null;
  }

  const beforeSuffix = text.slice(0, -suffix.length);
  const lastGaIndex = beforeSuffix.lastIndexOf('が');

  if (lastGaIndex <= 0) {
    return null;
  }

  return beforeSuffix.slice(0, lastGaIndex).trim();
}

function placeCheckbox(messageElement, checkbox) {
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

  messageElement.insertBefore(checkbox, messageElement.firstChild);
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

  const checkbox = document.createElement('div');
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
      const nameElem = messageElement.querySelector('.chat-author__display-name');
      const dispName = nameElem && nameElem.textContent ? nameElem.textContent : userId;
      greetedUsers[userid] = {
        greeted: true,
        timestamp: Date.now(),
        username: dispName
      };
    } else if (greetedUsers[userid]) {
      greetedUsers[userid].greeted = false;
    }

    chrome.storage.local.set({ greetedUsers: greetedUsers });
  });

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
