// popup.js
const defaultSyncSettings = {
  featureEnabled: true,
  scopeMode: 'specific',
  scopeTargetId: '',
  themeToken: '#6441a5'
};

const TRACKED_INDEX_KEY = 'trackedEntities:index';
const TRACKED_ENTITY_PREFIX = 'trackedEntity:';

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

function getEntityKey(entityId) {
  return `${TRACKED_ENTITY_PREFIX}${entityId}`;
}

function toLegacySettings(syncSettings) {
  return {
    extensionEnabled: syncSettings.featureEnabled,
    channelScope: syncSettings.scopeMode,
    targetChannelId: syncSettings.scopeTargetId,
    themeColor: syncSettings.themeToken
  };
}

function loadSyncSettings(callback) {
  chrome.storage.local.get(['syncSettings', 'extensionEnabled', 'channelScope', 'targetChannelId', 'themeColor'], function(data) {
    const syncSettings = {
      featureEnabled: data.syncSettings?.featureEnabled ?? data.extensionEnabled ?? defaultSyncSettings.featureEnabled,
      scopeMode: data.syncSettings?.scopeMode ?? data.channelScope ?? defaultSyncSettings.scopeMode,
      scopeTargetId: data.syncSettings?.scopeTargetId ?? data.targetChannelId ?? defaultSyncSettings.scopeTargetId,
      themeToken: data.syncSettings?.themeToken ?? data.themeColor ?? defaultSyncSettings.themeToken
    };

    if (!data.syncSettings) {
      chrome.storage.local.set({ syncSettings: syncSettings });
    }

    callback(syncSettings);
  });
}

function saveSyncSettings(patch, callback) {
  loadSyncSettings(function(current) {
    const merged = { ...current, ...patch };
    chrome.storage.local.set({ syncSettings: merged }, function() {
      if (callback) callback(merged);
    });
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

    const keys = ids.map(getEntityKey);
    chrome.storage.local.get(keys, function(entityData) {
      const users = {};
      ids.forEach(id => {
        const entity = entityData[getEntityKey(id)];
        if (entity) {
          users[id] = entity;
        }
      });
      callback(users);
    });
  });
}

function upsertTrackedUser(userId, userValue, callback) {
  const entityKey = getEntityKey(userId);
  chrome.storage.local.set({ [entityKey]: userValue }, function() {
    chrome.storage.local.get(TRACKED_INDEX_KEY, function(data) {
      const current = data[TRACKED_INDEX_KEY]?.ids || [];
      const merged = Array.from(new Set([...current, userId]));
      chrome.storage.local.set({ [TRACKED_INDEX_KEY]: { ids: merged } }, function() {
        if (callback) callback();
      });
    });
  });
}

document.addEventListener('DOMContentLoaded', function() {
  const channelScopeSelect = document.getElementById('channelScope');
  const channelIdRow = document.getElementById('channelIdRow');
  const channelIdInput = document.getElementById('channelIdInput');
  const enabledToggle = document.getElementById('enabledToggle');
  const themeColorInput = document.getElementById('themeColorInput');
  const themeColorPreview = document.getElementById('themeColorPreview');
  const themeColorPicker = document.getElementById('themeColorPicker');
  const popupCloseButton = document.getElementById('popupCloseButton');

  function updateChannelIdVisibility(scope) {
    channelIdRow.style.display = scope === 'specific' ? 'flex' : 'none';
  }

  function applyEnabledState(enabled) {
    enabledToggle.checked = enabled;
  }

  function isMissingReceiverError(errorMessage) {
    return (errorMessage || '').includes('Could not establish connection. Receiving end does not exist.');
  }

  function sendMessageToTab(tabId, message, warningPrefix) {
    chrome.tabs.sendMessage(tabId, message, function() {
      if (!chrome.runtime.lastError) {
        return;
      }

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

  function notifyFeatureStateChanged() {
    sendMessageToTwitchTabs({ action: 'settingsChanged' });
  }

  function notifyImmediateActivationIfMatched(channelId) {
    const trimmed = (channelId || '').trim().toLowerCase();
    if (!trimmed) {
      notifyFeatureStateChanged();
      return;
    }

    chrome.tabs.query({ active: true, lastFocusedWindow: true, url: ['*://*.twitch.tv/*'] }, function(tabs) {
      const activeTwitchTab = tabs[0];
      if (!activeTwitchTab || !activeTwitchTab.id || !activeTwitchTab.url) {
        notifyFeatureStateChanged();
        return;
      }

      let pathChannel = '';
      try {
        const url = new URL(activeTwitchTab.url);
        const parts = url.pathname.split('/').filter(Boolean);
        pathChannel = (parts[0] === 'popout' ? parts[1] : parts[0] || '').toLowerCase();
      } catch (error) {
        notifyFeatureStateChanged();
        return;
      }

      if (pathChannel === trimmed) {
        sendMessageToTab(activeTwitchTab.id, { action: 'settingsChanged' }, '即時反映通知に失敗');
        return;
      }

      notifyFeatureStateChanged();
    });
  }

  function applyThemeInputs(themeColor) {
    const normalized = normalizeHexColor(themeColor) || '#6441a5';
    themeColorInput.value = normalized;
    themeColorPicker.value = normalized;
    themeColorPreview.style.backgroundColor = normalized;
    applyThemeColor(normalized);
  }

  function loadSettings() {
    loadSyncSettings(function(syncSettings) {
      const settings = toLegacySettings(syncSettings);
      applyEnabledState(settings.extensionEnabled);
      channelScopeSelect.value = settings.channelScope;
      channelIdInput.value = settings.targetChannelId || '';
      updateChannelIdVisibility(settings.channelScope);
      applyThemeInputs(settings.themeColor);
    });
  }

  function loadGreetedUsers() {
    const userListElement = document.getElementById('userList');

    loadTrackedUsers(function(users) {
      userListElement.innerHTML = '';

      if (Object.keys(users).length === 0) {
        userListElement.innerHTML = '<div class="empty-message">まだ挨拶したユーザーはいません</div>';
        return;
      }

      const sortedUsers = Object.entries(users).sort((a, b) => {
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
        checkbox.addEventListener('change', function() {
          const isChecked = this.checked;
          const userIdFromRow = this.getAttribute('data-user-id');
          upsertTrackedUser(userIdFromRow, { ...userData, greeted: isChecked }, function() {
            sendMessageToTwitchTabs({
              action: 'entityDelta',
              delta: {
                [userIdFromRow]: { ...userData, greeted: isChecked }
              }
            });
          });
        });

        userListElement.appendChild(userElement);
      }
    });
  }

  channelScopeSelect.addEventListener('change', function() {
    const scope = this.value;
    updateChannelIdVisibility(scope);

    saveSyncSettings({ scopeMode: scope }, function() {
      notifyFeatureStateChanged();
    });
  });

  channelIdInput.addEventListener('input', function() {
    const channelId = this.value.trim();

    saveSyncSettings({ scopeTargetId: channelId }, function() {
      if (channelScopeSelect.value === 'specific') {
        notifyImmediateActivationIfMatched(channelId);
        return;
      }
      notifyFeatureStateChanged();
    });
  });

  enabledToggle.addEventListener('change', function() {
    const enabled = this.checked;

    saveSyncSettings({ featureEnabled: enabled }, function() {
      applyEnabledState(enabled);
      notifyFeatureStateChanged();
    });
  });

  themeColorInput.addEventListener('change', function() {
    const normalized = normalizeHexColor(this.value);
    const color = normalized || '#6441a5';
    applyThemeInputs(color);
    saveSyncSettings({ themeToken: color }, notifyFeatureStateChanged);
  });

  themeColorPreview.addEventListener('click', function() {
    themeColorPicker.click();
  });

  themeColorPicker.addEventListener('input', function() {
    const normalized = normalizeHexColor(this.value) || '#6441a5';
    applyThemeInputs(normalized);
    saveSyncSettings({ themeToken: normalized }, notifyFeatureStateChanged);
  });

  popupCloseButton.addEventListener('click', function() {
    const isModal = new URLSearchParams(window.location.search).get('modal') === '1';
    if (isModal && window.parent && window.parent !== window) {
      window.parent.postMessage('closeTwitchGreeterModal', '*');
      return;
    }

    window.close();
  });

  document.getElementById('resetBtn').addEventListener('click', function() {
    if (confirm('すべての挨拶履歴をリセットしますか？')) {
      chrome.storage.local.set({ [TRACKED_INDEX_KEY]: { ids: [] } }, function() {
        loadGreetedUsers();
        sendMessageToTwitchTabs({ action: 'entityDelta', delta: {} });
      });
    }
  });

  chrome.runtime.onMessage.addListener(function(message) {
    if (message.action === 'entityDelta') {
      loadGreetedUsers();
    }
  });

  chrome.storage.onChanged.addListener(function(changes, areaName) {
    if (areaName !== 'local') return;

    if (changes[TRACKED_INDEX_KEY] || Object.keys(changes).some(key => key.startsWith(TRACKED_ENTITY_PREFIX))) {
      loadGreetedUsers();
    }

    if (changes.syncSettings) {
      loadSettings();
    }
  });

  loadSettings();
  loadGreetedUsers();
});
