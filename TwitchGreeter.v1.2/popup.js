// popup.js
const defaultSettings = {
  extensionEnabled: true,
  channelScope: 'all',
  targetChannelId: ''
};

document.addEventListener('DOMContentLoaded', function() {
  const managedUi = document.getElementById('managedUi');
  const channelScopeSelect = document.getElementById('channelScope');
  const channelIdRow = document.getElementById('channelIdRow');
  const channelIdInput = document.getElementById('channelIdInput');
  const enabledToggle = document.getElementById('enabledToggle');

  function updateChannelIdVisibility(scope) {
    channelIdRow.style.display = scope === 'specific' ? 'flex' : 'none';
  }

  function applyEnabledState(enabled) {
    managedUi.classList.toggle('is-hidden', !enabled);
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

  function loadSettings() {
    chrome.storage.local.get(defaultSettings, function(data) {
      const settings = {
        extensionEnabled: data.extensionEnabled,
        channelScope: data.channelScope,
        targetChannelId: data.targetChannelId
      };

      applyEnabledState(settings.extensionEnabled);
      channelScopeSelect.value = settings.channelScope;
      channelIdInput.value = settings.targetChannelId || '';
      updateChannelIdVisibility(settings.channelScope);
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
