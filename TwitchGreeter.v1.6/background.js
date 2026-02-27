importScripts('shared/constants.js');

const POPUP_WINDOW_URL = 'popup.html';
const POPUP_WINDOW_WIDTH = 420;
const POPUP_WINDOW_HEIGHT = 620;

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
    if (found) {
      return;
    }

    chrome.windows.create({
      url: POPUP_WINDOW_URL,
      type: 'popup',
      width: POPUP_WINDOW_WIDTH,
      height: POPUP_WINDOW_HEIGHT
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.action !== ACTIONS.OPEN_POPUP_WINDOW) {
    return;
  }

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
});
