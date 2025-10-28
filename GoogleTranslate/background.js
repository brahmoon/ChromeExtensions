const MENU_ID = 'google-translate-selection';
const TRANSLATION_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const TRANSLATION_PAGE_URL = chrome.runtime.getURL('popup.html');

async function findTranslationTab() {
  try {
    const tabs = await chrome.tabs.query({ url: TRANSLATION_PAGE_URL });
    if (!tabs.length) {
      return null;
    }
    const [tab] = tabs;
    try {
      const window = await chrome.windows.get(tab.windowId);
      return { tab, window };
    } catch (_error) {
      return null;
    }
  } catch (_error) {
    return null;
  }
}

async function focusOrCreateTranslationWindow() {
  const existing = await findTranslationTab();
  if (existing) {
    const { window, tab } = existing;
    const updateInfo = { focused: true };
    if (window?.state === 'minimized') {
      updateInfo.state = 'normal';
    }
    try {
      await chrome.windows.update(window.id, updateInfo);
    } catch (_error) {
      return chrome.windows.create({ url: TRANSLATION_PAGE_URL, type: 'popup', focused: true });
    }
    if (tab) {
      try {
        await chrome.tabs.update(tab.id, { active: true });
      } catch (_error) {
        // Ignore failures to activate the tab.
      }
    }
    return window;
  }

  return chrome.windows.create({ url: TRANSLATION_PAGE_URL, type: 'popup', focused: true });
}

async function toggleTranslationWindow() {
  const existing = await findTranslationTab();
  if (!existing) {
    await chrome.windows.create({ url: TRANSLATION_PAGE_URL, type: 'popup', focused: true });
    return;
  }

  const { window, tab } = existing;
  if (window?.state === 'minimized') {
    try {
      await chrome.windows.update(window.id, { state: 'normal', focused: true });
    } catch (_error) {
      await chrome.windows.create({ url: TRANSLATION_PAGE_URL, type: 'popup', focused: true });
      return;
    }
    if (tab) {
      try {
        await chrome.tabs.update(tab.id, { active: true });
      } catch (_error) {
        // Ignore activation errors.
      }
    }
    return;
  }

  try {
    await chrome.windows.remove(window.id);
  } catch (_error) {
    // Window might already be gone; ignore errors.
  }
}

chrome.action.onClicked.addListener(() => {
  toggleTranslationWindow().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Google翻訳',
    contexts: ['selection']
  });
});

async function performTranslation(text) {
  const url = `${TRANSLATION_ENDPOINT}?client=gtx&sl=auto&tl=ja&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('翻訳リクエストに失敗しました');
  }
  const data = await response.json();
  const sentences = data[0] || [];
  const translatedText = sentences.map((sentence) => sentence[0]).join('');
  const detectedSourceLanguage = data[2] || 'auto';
  return {
    sourceText: text,
    translatedText,
    detectedSourceLanguage,
    updatedAt: new Date().toISOString()
  };
}

async function storeTranslation(data, origin = 'manual') {
  const payload = { ...data, origin };
  await chrome.storage.local.set({ latestTranslation: payload });
  chrome.runtime.sendMessage({ type: 'translationResult', data: payload });
  await focusOrCreateTranslationWindow();
  return payload;
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText) {
    return;
  }
  const text = info.selectionText.trim();
  if (!text) {
    return;
  }
  performTranslation(text)
    .then((data) => storeTranslation(data, 'contextMenu'))
    .catch((error) => {
      chrome.runtime.sendMessage({
        type: 'translationError',
        error: error.message || String(error)
      });
    });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'translateText') {
    const text = (message.text || '').trim();
    if (!text) {
      sendResponse({ ok: false, error: '翻訳するテキストを入力してください。' });
      return;
    }
    performTranslation(text)
      .then((data) => storeTranslation(data, message.origin || 'manual'))
      .then((payload) => sendResponse({ ok: true, data: payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === 'getLatestTranslation') {
    chrome.storage.local
      .get('latestTranslation')
      .then((result) => {
        sendResponse({ ok: true, data: result.latestTranslation || null });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }

  return undefined;
});
