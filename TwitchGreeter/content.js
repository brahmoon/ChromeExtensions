// content.js
let greetedUsers = {};

// 保存されたデータを読み込む
chrome.storage.local.get('greetedUsers', function(data) {
  if (data.greetedUsers) {
    greetedUsers = data.greetedUsers;
    applyGreetedStatus();
  }
});

// メッセージリスナーを設定（popup.jsからのメッセージを受け取る）
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.action === 'updateGreetedStatus') {
    // 特定のユーザーのチェックボックス状態を更新
    updateUserCheckboxes(message.userId, message.greeted);
    
    // ローカルのgreetedUsersオブジェクトも更新
    if (greetedUsers[message.userId]) {
      greetedUsers[message.userId].greeted = message.greeted;
    }
  } else if (message.action === 'resetAllGreetings') {
    // すべてのチェックボックスをリセット
    const allCheckboxes = document.querySelectorAll('.greeting-checkbox input');
    allCheckboxes.forEach(checkbox => {
      checkbox.checked = false;
    });
    
    // ローカルのgreetedUsersオブジェクトもリセット
    for (const userId in greetedUsers) {
      if (greetedUsers[userId]) {
        greetedUsers[userId].greeted = false;
      }
    }
  }
  
  // 応答を返して処理完了を通知
  sendResponse({ success: true });
  return true; // 非同期応答を可能にする
});

// チャットメッセージを監視して新しいメッセージにチェックボックスを追加
function setupMutationObserver() {
  const chatContainer = document.querySelector('.chat-scrollable-area__message-container');
  
  if (!chatContainer) {
    // チャットコンテナが見つからない場合、1秒後に再試行
    setTimeout(setupMutationObserver, 1000);
    return;
  }
  
  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const messageElements = node.querySelectorAll('.chat-line__message');
            messageElements.forEach(addCheckboxToMessage);
            
            const noticeElements = node.querySelectorAll('.user-notice-line');
            noticeElements.forEach(addCheckboxToMessage);
            console.log(noticeElements);
          }
        });
      }
    });
  });
  
  observer.observe(chatContainer, { childList: true, subtree: true });
  
  // 既存のメッセージにもチェックボックスを追加
  const existingMessages = document.querySelectorAll('.chat-line__message');
  existingMessages.forEach(addCheckboxToMessage);
  
  const existingNotices = document.querySelectorAll('div[data-test-selector="user-notice-line"]');
  existingNotices.forEach(addCheckboxToMessage);
}

// メッセージにチェックボックスを追加
function addCheckboxToMessage(messageElement) {
  if (messageElement.querySelector('.greeting-checkbox')) {
    return;
  }

  let userId = null;

  // 引き換え通知かどうか判定してユーザー名抽出
  if (messageElement.matches('.chat-line__message')) {
    userId = messageElement.getAttribute('data-a-user');
    const text = messageElement.innerText;
    const match = text.match(/^(.+?)が.+を引き換えました$/);
    console.log(match ? match[1] : null);
  } else {
    const text = messageElement.innerText;
    const match = text.match(/^(.+?)が.+を引き換えました$/);
    userId = match ? match[1] : null;
    console.log("aaaaaaaaaa");
  }

  if (!userId) return;
  console.log(userId);
  
  // チェックボックス要素を作成
  const checkbox = document.createElement('div');
  checkbox.className = 'greeting-checkbox';
  checkbox.innerHTML = `
    <input type="checkbox" id="greeting-${userId}-${Date.now()}" 
           ${(greetedUsers[userId] && greetedUsers[userId].greeted) ? 'checked' : ''} 
           data-user-id="${userId}">
  `;
  
  // チェックボックス変更イベントのリスナー
  const inputElement = checkbox.querySelector('input');
  inputElement.addEventListener('change', function() {
    const userid = this.getAttribute('data-user-id');
    const isChecked = this.checked;
    
    // 同じユーザーのすべてのチェックボックスを更新
    updateUserCheckboxes(userid, isChecked);
    
    // ストレージに保存
    if (isChecked) {
      const nameElem = messageElement.querySelector('.chat-author__display-name');
      const dispName = nameElem && nameElem.textContent ? nameElem.textContent : userId;
      greetedUsers[userid] = {
        greeted: true,
        timestamp: Date.now(),
        username: dispName
      };
    } else {
      if (greetedUsers[userid]) {
        greetedUsers[userid].greeted = false;
      }
    }
    
    chrome.storage.local.set({ 'greetedUsers': greetedUsers });
  });
  
  // 挿入位置を決定
  // ユーザーネームコンテナを探す
  const usernameContainer = messageElement.querySelector('.chat-line__username-container');
  if (usernameContainer) {
    // ユーザー名の前にチェックボックスを挿入
    usernameContainer.insertBefore(checkbox, usernameContainer.firstChild);
  } else {
    messageElement.insertBefore(checkbox, messageElement.firstChild);
    console.log("checkbox added");
  }
}

// 特定のユーザーのすべてのチェックボックスを更新
function updateUserCheckboxes(userId, isChecked) {
  const checkboxes = document.querySelectorAll(`.greeting-checkbox input[data-user-id="${userId}"]`);
  checkboxes.forEach(checkbox => {
    checkbox.checked = isChecked;
  });
}

// 既に挨拶済みユーザーのステータスを適用
function applyGreetedStatus() {
  for (const userId in greetedUsers) {
    if (greetedUsers[userId].greeted) {
      updateUserCheckboxes(userId, true);
    }
  }
}

// セッション期限切れの挨拶をリセット（24時間経過したものなど）
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
    chrome.storage.local.set({ 'greetedUsers': greetedUsers });
    applyGreetedStatus();
  }
}

// 起動時にクリーンアップを実行し、定期的に実行
cleanupOldGreetings();
setInterval(cleanupOldGreetings, 60 * 60 * 1000); // 1時間ごとにチェック

// 監視を開始
setupMutationObserver();