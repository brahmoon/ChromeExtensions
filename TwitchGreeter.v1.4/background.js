const POPUP_WINDOW_URL = 'popup.html';
const POPUP_WINDOW_WIDTH = 420;
const POPUP_WINDOW_HEIGHT = 620;

chrome.action.onClicked.addListener(() => {
  chrome.windows.create({
    url: POPUP_WINDOW_URL,
    type: 'popup',
    width: POPUP_WINDOW_WIDTH,
    height: POPUP_WINDOW_HEIGHT
  });
});
