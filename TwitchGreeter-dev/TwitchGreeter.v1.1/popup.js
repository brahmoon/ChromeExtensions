// popup.js
document.addEventListener('DOMContentLoaded', function() {
  // 挨拶済みユーザーのリストを表示
  function loadGreetedUsers() {
    const userListElement = document.getElementById('userList');
    
    chrome.storage.local.get('greetedUsers', function(data) {
      userListElement.innerHTML = '';
      
      if (!data.greetedUsers || Object.keys(data.greetedUsers).length === 0) {
        userListElement.innerHTML = '<div class="empty-message">まだ挨拶したユーザーはいません</div>';
        return;
      }
      
      // ユーザーを挨拶済み/未挨拶でソート
      const sortedUsers = Object.entries(data.greetedUsers).sort((a, b) => {
        // まず挨拶済みかどうかでソート
        if (a[1].greeted && !b[1].greeted) return -1;
        if (!a[1].greeted && b[1].greeted) return 1;
        
        // 次にタイムスタンプでソート（新しい順）
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
          
          chrome.storage.local.get('greetedUsers', function(data) {
            const updatedUsers = data.greetedUsers || {};
            
            if (updatedUsers[userid]) {
              updatedUsers[userid].greeted = isChecked;
              if (isChecked) {
                updatedUsers[userid].timestamp = Date.now();
              }
              
              chrome.storage.local.set({ 'greetedUsers': updatedUsers }, function() {
                // アクティブなタブに変更を通知
                chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                  if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                      action: 'updateGreetedStatus',
                      userId: userid,
                      greeted: isChecked
                    }, function(response) {
                      // 応答を受け取ったことを確認（オプション）
                      if (chrome.runtime.lastError) {
                        console.error('メッセージ送信エラー:', chrome.runtime.lastError);
                      } else if (response && response.success) {
                        console.log('チェックボックス状態の更新が成功しました');
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
  
  // エクスポート機能は削除
  
  // リセットボタンの処理
  document.getElementById('resetBtn').addEventListener('click', function() {
    if (confirm('すべての挨拶履歴をリセットしますか？')) {
      chrome.storage.local.set({ 'greetedUsers': {} }, function() {
        loadGreetedUsers();
        
        // アクティブなタブに変更を通知
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'resetAllGreetings'
            }, function(response) {
              // 応答を受け取ったことを確認（オプション）
              if (chrome.runtime.lastError) {
                console.error('リセットメッセージ送信エラー:', chrome.runtime.lastError);
              } else if (response && response.success) {
                console.log('すべてのチェックボックスのリセットが成功しました');
              }
            });
          }
        });
      });
    }
  });
  
  // メッセージリスナー（コンテンツスクリプトからの通知を受け取る）
  chrome.runtime.onMessage.addListener(function(message) {
    if (message.action === 'updateGreetedStatus') {
      loadGreetedUsers();
    }
  });
  
  // 初期ロード
  loadGreetedUsers();
});