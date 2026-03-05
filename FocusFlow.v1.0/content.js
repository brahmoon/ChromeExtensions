// FocusFlow content.js
// 最小限の実装。ページ情報をバックグラウンドに渡す役割のみ。

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_PAGE_INFO') {
    sendResponse({
      title: document.title,
      url: window.location.href
    });
  }
});
