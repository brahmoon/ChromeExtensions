const MENU_ID = 'google-translate-selection';
const TRANSLATION_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const TRANSLATION_PAGE_URL = chrome.runtime.getURL('popup.html');
const WIDTH_STORAGE_KEY = 'popupWidth';
const HEIGHT_STORAGE_KEY = 'popupHeight';
const MIN_POPUP_WIDTH = 320;
const MIN_POPUP_HEIGHT = 240;

function clampDimension(value, minimum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  if (Number.isNaN(rounded)) {
    return null;
  }
  return Math.max(minimum, rounded);
}

async function getStoredPopupBounds() {
  try {
    const stored = await chrome.storage.local.get([WIDTH_STORAGE_KEY, HEIGHT_STORAGE_KEY]);
    return {
      width: clampDimension(stored?.[WIDTH_STORAGE_KEY], MIN_POPUP_WIDTH),
      height: clampDimension(stored?.[HEIGHT_STORAGE_KEY], MIN_POPUP_HEIGHT)
    };
  } catch (_error) {
    return { width: null, height: null };
  }
}

async function storePopupBounds(bounds) {
  const payload = {};
  if (Object.prototype.hasOwnProperty.call(bounds, 'width')) {
    const clampedWidth = clampDimension(bounds.width, MIN_POPUP_WIDTH);
    if (clampedWidth != null) {
      payload[WIDTH_STORAGE_KEY] = clampedWidth;
    }
  }
  if (Object.prototype.hasOwnProperty.call(bounds, 'height')) {
    const clampedHeight = clampDimension(bounds.height, MIN_POPUP_HEIGHT);
    if (clampedHeight != null) {
      payload[HEIGHT_STORAGE_KEY] = clampedHeight;
    }
  }

  if (!Object.keys(payload).length) {
    return;
  }

  try {
    await chrome.storage.local.set(payload);
  } catch (_error) {
    // Ignore storage failures; bounds persistence is best-effort.
  }
}

let translationWindowId = null;

function rememberTranslationWindow(window) {
  if (window?.id != null) {
    translationWindowId = window.id;
  }
}

async function createTranslationWindow() {
  const { width, height } = await getStoredPopupBounds();
  const options = { url: TRANSLATION_PAGE_URL, type: 'popup', focused: true };
  if (width) {
    options.width = width;
  }
  if (height) {
    options.height = height;
  }
  const createdWindow = await chrome.windows.create(options);
  rememberTranslationWindow(createdWindow);
  return createdWindow;
}

async function findTranslationTab() {
  try {
    const tabs = await chrome.tabs.query({ url: TRANSLATION_PAGE_URL });
    if (!tabs.length) {
      return null;
    }
    const [tab] = tabs;
    try {
      const window = await chrome.windows.get(tab.windowId);
      rememberTranslationWindow(window);
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

  return createTranslationWindow();
}

async function toggleTranslationWindow() {
  const existing = await findTranslationTab();
  if (!existing) {
    await createTranslationWindow();
    return;
  }

  const { window, tab } = existing;
  if (window?.state === 'minimized') {
    try {
      await chrome.windows.update(window.id, { state: 'normal', focused: true });
    } catch (_error) {
      await createTranslationWindow();
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

chrome.windows.onRemoved.addListener((windowId) => {
  if (translationWindowId === windowId) {
    translationWindowId = null;
  }
});

chrome.windows.onBoundsChanged.addListener(async (window) => {
  if (!window || window.type !== 'popup' || window.id == null) {
    return;
  }

  if (translationWindowId == null) {
    const translation = await findTranslationTab();
    if (!translation || translation.window?.id !== window.id) {
      return;
    }
  }

  if (window.id !== translationWindowId) {
    return;
  }

  if (typeof window.width !== 'number' && typeof window.height !== 'number') {
    return;
  }

  await storePopupBounds({ width: window.width, height: window.height });
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
