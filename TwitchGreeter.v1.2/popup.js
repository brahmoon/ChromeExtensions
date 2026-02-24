// popup.js
const defaultSettings = {
  extensionEnabled: true,
  channelScope: 'all',
  targetChannelId: '',
  themeColor: '#000000'
};

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

function applyThemeColor(themeColor) {
  const normalized = normalizeHexColor(themeColor) || '#000000';
  const pastelBg = mixWithWhite(normalized, 0.88);
  document.documentElement.style.setProperty('--popup-bg-color', pastelBg);
}

document.addEventListener('DOMContentLoaded', function() {
  const channelScopeSelect = document.getElementById('channelScope');
  const channelIdRow = document.getElementById('channelIdRow');
  const channelIdInput = document.getElementById('channelIdInput');
  const enabledToggle = document.getElementById('enabledToggle');
  const themeColorInput = document.getElementById('themeColorInput');
  const themeColorPreview = document.getElementById('themeColorPreview');
  const themeColorPicker = document.getElementById('themeColorPicker');

  function updateChannelIdVisibility(scope) {
    channelIdRow.style.display = scope === 'specific' ? 'flex' : 'none';
  }

  function applyEnabledState(enabled) {
    enabledToggle.checked = enabled;
  }

  function notifyActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'settingsChanged' }, function() {
          if (chrome.runtime.lastError) {
            console.warn('設定通知に失敗:', chrome.runtime.lastError.message);
          }
        });
      }
    });
  }

  function applyThemeInputs(themeColor) {
    const normalized = normalizeHexColor(themeColor) || '#000000';
    themeColorInput.value = normalized;
    themeColorPicker.value = normalized;
    themeColorPreview.style.backgroundColor = normalized;
    applyThemeColor(normalized);
  }

  function saveThemeColor(themeColor) {
    chrome.storage.local.set({ themeColor: themeColor }, function() {
      notifyActiveTab();
    });
  }

  function loadSettings() {
    chrome.storage.local.get(defaultSettings, function(data) {
      const settings = {
        extensionEnabled: data.extensionEnabled,
        channelScope: data.channelScope,
        targetChannelId: data.targetChannelId,
        themeColor: data.themeColor
      };

      applyEnabledState(settings.extensionEnabled);
      channelScopeSelect.value = settings.channelScope;
      channelIdInput.value = settings.targetChannelId || '';
      updateChannelIdVisibility(settings.channelScope);
      applyThemeInputs(settings.themeColor);
    });
  }

  function loadGreetedUsers() {
    const userListElement = document.getElementById('userList');

    chrome.storage.local.get('greetedUsers', function(data) {
      userListElement.innerHTML = '';

      if (!data.greetedUsers || Object.keys(data.greetedUsers).length === 0) {
        userListElement.innerHTML = '<div class="empty-message">まだ挨拶したユーザーはいません</div>';
        return;
      }

      const sortedUsers = Object.entries(data.greetedUsers).sort((a, b) => {
        if (a[1].greeted && !b[1].greeted) return -1;
        if (!a[1].greeted && b[1].greeted) return 1;
        return (b[1].timestamp || 0) - (a[1].timestamp || 0);
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
          const userid = this.getAttribute('data-user-id');

          chrome.storage.local.get('greetedUsers', function(storageData) {
            const updatedUsers = storageData.greetedUsers || {};

            if (updatedUsers[userid]) {
              updatedUsers[userid].greeted = isChecked;
              if (isChecked) {
                updatedUsers[userid].timestamp = Date.now();
              }

              chrome.storage.local.set({ greetedUsers: updatedUsers }, function() {
                chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
                  if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                      action: 'updateGreetedStatus',
                      userId: userid,
                      greeted: isChecked
                    }, function() {
                      if (chrome.runtime.lastError) {
                        console.error('メッセージ送信エラー:', chrome.runtime.lastError.message);
                      }
                    });
                  }
                });
              });
            }
          });
        });

        userListElement.appendChild(userElement);
      }
    });
  }

  channelScopeSelect.addEventListener('change', function() {
    const scope = this.value;
    updateChannelIdVisibility(scope);

    chrome.storage.local.set({ channelScope: scope }, function() {
      notifyActiveTab();
    });
  });

  channelIdInput.addEventListener('input', function() {
    chrome.storage.local.set({ targetChannelId: this.value.trim() }, function() {
      notifyActiveTab();
    });
  });

  enabledToggle.addEventListener('change', function() {
    const enabled = this.checked;

    chrome.storage.local.set({ extensionEnabled: enabled }, function() {
      applyEnabledState(enabled);
      notifyActiveTab();
    });
  });

  themeColorInput.addEventListener('change', function() {
    const normalized = normalizeHexColor(this.value);
    if (!normalized) {
      applyThemeInputs('#000000');
      saveThemeColor('#000000');
      return;
    }

    applyThemeInputs(normalized);
    saveThemeColor(normalized);
  });

  themeColorPreview.addEventListener('click', function() {
    themeColorPicker.click();
  });

  themeColorPicker.addEventListener('input', function() {
    const normalized = normalizeHexColor(this.value) || '#000000';
    applyThemeInputs(normalized);
    saveThemeColor(normalized);
  });

  document.getElementById('resetBtn').addEventListener('click', function() {
    if (confirm('すべての挨拶履歴をリセットしますか？')) {
      chrome.storage.local.set({ greetedUsers: {} }, function() {
        loadGreetedUsers();

        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'resetAllGreetings'
            }, function() {
              if (chrome.runtime.lastError) {
                console.error('リセットメッセージ送信エラー:', chrome.runtime.lastError.message);
              }
            });
          }
        });
      });
    }
  });

  chrome.runtime.onMessage.addListener(function(message) {
    if (message.action === 'updateGreetedStatus') {
      loadGreetedUsers();
    }
  });

  loadSettings();
  loadGreetedUsers();
});
