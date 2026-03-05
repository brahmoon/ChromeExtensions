// FocusFlow background.js - Service Worker (MV3)
// 役割: コンテキストメニュー登録・バッジ更新のみ。IndexedDBはポップアップ側で管理。

chrome.runtime.onInstalled.addListener(() => {
  // コンテキストメニュー: ページ全体
  chrome.contextMenus.create({
    id: 'add-page-as-task',
    title: 'このページをFocusFlowに追加',
    contexts: ['page', 'link']
  });

  // コンテキストメニュー: 選択テキスト
  chrome.contextMenus.create({
    id: 'add-selection-as-task',
    title: '「%s」をタスクに追加',
    contexts: ['selection']
  });
});

// コンテキストメニュークリックハンドラ
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;

  let title = '';
  let url = tab.url || '';
  let sourceTitle = tab.title || '';

  if (info.menuItemId === 'add-page-as-task') {
    title = tab.title || url;
    if (info.linkUrl) {
      url = info.linkUrl;
      title = info.linkUrl;
    }
  } else if (info.menuItemId === 'add-selection-as-task') {
    title = info.selectionText || '';
  }

  // ポップアップまたはストレージ経由でタスクをInboxに追加
  const pendingTask = {
    title: title.slice(0, 200),
    sourceUrl: url,
    sourceTitle: sourceTitle,
    timestamp: Date.now()
  };

  chrome.storage.local.set({ pendingTask }, () => {
    // ポップアップが開いている場合は通知
    chrome.runtime.sendMessage({ type: 'PENDING_TASK_ADDED', task: pendingTask })
      .catch(() => {
        // ポップアップが閉じている場合は無視（storage経由で処理される）
      });
  });

  // バッジで通知
  chrome.action.setBadgeText({ text: '✚' });
  chrome.action.setBadgeBackgroundColor({ color: '#E8A838' });
  setTimeout(() => {
    updateBadgeFromStorage();
  }, 3000);
});

// バッジ更新関数
function updateBadgeFromStorage() {
  chrome.storage.local.get(['badgeCount'], (result) => {
    const count = result.badgeCount || 0;
    if (count > 0) {
      chrome.action.setBadgeText({ text: String(count) });
      chrome.action.setBadgeBackgroundColor({ color: '#E05C5C' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  });
}

// ストレージ変更でバッジを更新
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.badgeCount) {
    const count = changes.badgeCount.newValue || 0;
    if (count > 0) {
      chrome.action.setBadgeText({ text: String(count) });
      chrome.action.setBadgeBackgroundColor({ color: '#E05C5C' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  }
});

// タブ切り替え時にバッジ更新
chrome.tabs.onActivated.addListener(() => {
  updateBadgeFromStorage();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    updateBadgeFromStorage();
  }
});
