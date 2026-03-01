const POPUP_WINDOW_URL = 'popup.html';
const POPUP_WINDOW_WIDTH = 520;
const POPUP_WINDOW_HEIGHT = 680;

function focusExistingPopupWindow(callback) {
  const popupUrlPrefix = chrome.runtime.getURL(POPUP_WINDOW_URL);
  chrome.windows.getAll({ populate: true }, windows => {
    const existing = windows.find(win =>
      (win.tabs || []).some(tab => (tab.url || '').startsWith(popupUrlPrefix))
    );
    if (!existing?.id) { callback(false); return; }
    chrome.windows.update(existing.id, { focused: true, drawAttention: true }, () => callback(true));
  });
}

function notifyPopup(message) {
  const popupUrlPrefix = chrome.runtime.getURL(POPUP_WINDOW_URL);
  chrome.windows.getAll({ populate: true }, windows => {
    windows.forEach(win => (win.tabs || []).forEach(tab => {
      if ((tab.url || '').startsWith(popupUrlPrefix) && tab.id)
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }));
  });
}

chrome.action.onClicked.addListener(() => {
  focusExistingPopupWindow(found => {
    if (found) return;
    chrome.windows.create({ url: POPUP_WINDOW_URL, type: 'popup', width: POPUP_WINDOW_WIDTH, height: POPUP_WINDOW_HEIGHT });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.action === 'openPopupWindow') {
    focusExistingPopupWindow(found => {
      if (found) { sendResponse({ opened: true, reused: true }); return; }
      chrome.windows.create({ url: POPUP_WINDOW_URL, type: 'popup', width: POPUP_WINDOW_WIDTH, height: POPUP_WINDOW_HEIGHT },
        () => sendResponse({ opened: true, reused: false }));
    });
    return true;
  }

  // チャンネルマップ形式でエモートを受信・保存
  if (message.action === 'emotesCollected') {
    const channelMap = message.channelMap || {};
    chrome.storage.local.get(['emoteChannels'], data => {
      const stored = data.emoteChannels || {};
      // 受信チャンネルのエモートを更新（削除判定は十分なデータが揃ってから）
      for (const [ch, emotes] of Object.entries(channelMap)) {
        stored[ch] = { emotes, updatedAt: Date.now() };
      }
      chrome.storage.local.set({ emoteChannels: stored }, () => {
        notifyPopup({ action: 'emotesUpdated', channelMap: stored });
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  // エモート削除チェック（十分な遅延後に確認）
  if (message.action === 'verifyChannelEmotes') {
    const { channelName, emoteIds } = message;
    chrome.storage.local.get(['emoteChannels'], data => {
      const stored = data.emoteChannels || {};
      if (!stored[channelName]) { sendResponse({ ok: false }); return; }
      const current = stored[channelName].emotes || [];
      const liveSet = new Set(emoteIds);
      const filtered = current.filter(e => liveSet.has(e.emoteId));
      if (filtered.length !== current.length) {
        stored[channelName].emotes = filtered;
        chrome.storage.local.set({ emoteChannels: stored }, () => {
          notifyPopup({ action: 'emotesUpdated', channelMap: stored });
        });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'insertEmote') {
    chrome.tabs.query({ url: ['*://*.twitch.tv/*', '*://dashboard.twitch.tv/*'] }, tabs => {
      tabs.forEach(tab => { if (tab.id) chrome.tabs.sendMessage(tab.id, { action: 'insertEmoteToChat', emoteId: message.emoteId }).catch(() => {}); });
    });
    sendResponse({ ok: true });
    return true;
  }
});
