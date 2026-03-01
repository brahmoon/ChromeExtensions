const POPUP_WINDOW_URL = 'popup.html';
const POPUP_WINDOW_WIDTH = 480;
const POPUP_WINDOW_HEIGHT = 640;

function focusExistingPopupWindow(callback) {
  const popupUrlPrefix = chrome.runtime.getURL(POPUP_WINDOW_URL);

  chrome.windows.getAll({ populate: true }, windows => {
    const existingWindow = windows.find(win =>
      (win.tabs || []).some(tab => (tab.url || '').startsWith(popupUrlPrefix))
    );

    if (!existingWindow || !existingWindow.id) {
      callback(false);
      return;
    }

    chrome.windows.update(existingWindow.id, { focused: true, drawAttention: true }, () => {
      callback(true);
    });
  });
}

chrome.action.onClicked.addListener(() => {
  focusExistingPopupWindow(found => {
    if (found) return;

    chrome.windows.create({
      url: POPUP_WINDOW_URL,
      type: 'popup',
      width: POPUP_WINDOW_WIDTH,
      height: POPUP_WINDOW_HEIGHT
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.action === 'openPopupWindow') {
    focusExistingPopupWindow(found => {
      if (found) {
        sendResponse({ opened: true, reused: true });
        return;
      }
      chrome.windows.create({
        url: POPUP_WINDOW_URL,
        type: 'popup',
        width: POPUP_WINDOW_WIDTH,
        height: POPUP_WINDOW_HEIGHT
      }, () => {
        sendResponse({ opened: true, reused: false });
      });
    });
    return true;
  }

  // エモートデータをストレージに保存してpopupに通知
  if (message.action === 'emotesCollected') {
    chrome.storage.local.set({ collectedEmotes: message.emotes }, () => {
      // 開いているpopupウィンドウに通知
      const popupUrlPrefix = chrome.runtime.getURL(POPUP_WINDOW_URL);
      chrome.windows.getAll({ populate: true }, windows => {
        windows.forEach(win => {
          (win.tabs || []).forEach(tab => {
            if ((tab.url || '').startsWith(popupUrlPrefix) && tab.id) {
              chrome.tabs.sendMessage(tab.id, { action: 'emotesUpdated', emotes: message.emotes });
            }
          });
        });
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  // content.jsへエモート入力を転送
  if (message.action === 'insertEmote') {
    chrome.tabs.query({ url: ['*://*.twitch.tv/*', '*://dashboard.twitch.tv/*'] }, tabs => {
      tabs.forEach(tab => {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { action: 'insertEmoteToChat', emoteId: message.emoteId });
        }
      });
    });
    sendResponse({ ok: true });
    return true;
  }
});
