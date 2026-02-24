// content.js
let greetedUsers = {};
let chatObserver = null;
let resetPanelState = {
  rendered: false,
  dimmed: false,
  panelElement: null,
  panelParent: null
};

const defaultSettings = {
  extensionEnabled: true,
  channelScope: 'all',
  targetChannelId: '',
  themeColor: '#000000'
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
  const base = normalizeHexColor(themeColor) || '#000000';
  const panelBg = mixColor(base, '#ffffff', 0.35);
  const panelBorder = mixColor(base, '#000000', 0.15);
  const textColor = mixColor(base, '#ffffff', 0.88);

  document.documentElement.style.setProperty('--greeting-panel-bg', panelBg);
  document.documentElement.style.setProperty('--greeting-panel-border', panelBorder);
  document.documentElement.style.setProperty('--greeting-panel-text', textColor);
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
          if (node.nodeType === Node.ELEMENT_NODE) {
            const messageElements = node.querySelectorAll('.chat-line__message');
            messageElements.forEach(addCheckboxToMessage);

            const noticeElements = node.querySelectorAll('.user-notice-line');
            noticeElements.forEach(addCheckboxToMessage);
          }
        });
      }
    });
  });

  chatObserver.observe(chatContainer, { childList: true, subtree: true });

  const existingMessages = document.querySelectorAll('.chat-line__message');
  existingMessages.forEach(addCheckboxToMessage);

  const existingNotices = document.querySelectorAll('div[data-test-selector="user-notice-line"]');
  existingNotices.forEach(addCheckboxToMessage);
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
    <button type="button" class="greeting-close-button" aria-label="パネルを閉じる">×</button>
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

  panelParent.appendChild(panel);
  chatContainer.insertBefore(panelParent, chatContainer.firstChild);

  resetPanelState.rendered = true;
  resetPanelState.panelElement = panel;
  resetPanelState.panelParent = panelParent;
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
  } else {
    const text = messageElement.innerText;
    const match = text.match(/^(.+?)が.+を引き換えました$/);
    userId = match ? match[1] : null;
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

  const usernameContainer = messageElement.querySelector('.chat-line__username-container');
  if (usernameContainer) {
    usernameContainer.insertBefore(checkbox, usernameContainer.firstChild);
  } else {
    messageElement.insertBefore(checkbox, messageElement.firstChild);
  }
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
