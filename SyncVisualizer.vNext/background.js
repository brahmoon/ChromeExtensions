importScripts('constants.js');

chrome.runtime.onMessage.addListener(function (message) {
  if (!message || message.action !== MESSAGE_ACTIONS.openRuntime) {
    return;
  }

  const runtimeUrl = chrome.runtime.getURL('runtime.html');
  chrome.tabs.create({ url: runtimeUrl });
});
