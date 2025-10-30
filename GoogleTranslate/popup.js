const form = document.getElementById('translate-form');
const textInput = document.getElementById('text-input');
const translateButton = document.getElementById('translate-button');
const statusElement = document.getElementById('status');
const resultWrapper = document.getElementById('result');
const detectedLanguageElement = document.getElementById('detected-language');
const sourceTextElement = document.getElementById('source-text');
const translatedTextElement = document.getElementById('translated-text');
const updatedAtElement = document.getElementById('updated-at');
const resizeHandle = document.getElementById('resize-handle');
const sourceLanguageSelect = document.getElementById('source-language');
const targetLanguageSelect = document.getElementById('target-language');

const WIDTH_STORAGE_KEY = 'popupWidth';
const HEIGHT_STORAGE_KEY = 'popupHeight';
const SOURCE_LANGUAGE_STORAGE_KEY = 'preferredSourceLanguage';
const TARGET_LANGUAGE_STORAGE_KEY = 'preferredTargetLanguage';
const MIN_POPUP_WIDTH = 320;
const MIN_POPUP_HEIGHT = 240;
const DEFAULT_SOURCE_LANGUAGE = 'auto';
const DEFAULT_TARGET_LANGUAGE = 'ja';

function clampDimension(value, minimum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return minimum;
  }
  const rounded = Math.round(value);
  if (Number.isNaN(rounded)) {
    return minimum;
  }
  return Math.max(minimum, rounded);
}

function clampSize(width, height) {
  return {
    width: clampDimension(width ?? window.outerWidth, MIN_POPUP_WIDTH),
    height: clampDimension(height ?? window.outerHeight, MIN_POPUP_HEIGHT)
  };
}

function applyPopupSize(width, height) {
  const clamped = clampSize(width, height);
  try {
    window.resizeTo(clamped.width, clamped.height);
  } catch (error) {
    console.error('Failed to resize popup window', error);
  }
  return clamped;
}

async function restorePopupSize() {
  if (!resizeHandle) {
    return;
  }
  const storageArea = chrome?.storage?.local;
  if (!storageArea) {
    return;
  }
  try {
    const stored = await new Promise((resolve, reject) => {
      const callback = (items) => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
        } else {
          resolve(items);
        }
      };
      const maybePromise = storageArea.get([WIDTH_STORAGE_KEY, HEIGHT_STORAGE_KEY], callback);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve).catch(reject);
      }
    });
    const width = stored?.[WIDTH_STORAGE_KEY];
    const height = stored?.[HEIGHT_STORAGE_KEY];
    if (typeof width === 'number' || typeof height === 'number') {
      applyPopupSize(width, height);
    }
  } catch (error) {
    console.error('Failed to restore popup size', error);
  }
}

function persistPopupSize(width, height) {
  const storageArea = chrome?.storage?.local;
  if (!storageArea) {
    return;
  }
  const { width: clampedWidth, height: clampedHeight } = clampSize(width, height);
  try {
    const maybePromise = storageArea.set(
      { [WIDTH_STORAGE_KEY]: clampedWidth, [HEIGHT_STORAGE_KEY]: clampedHeight },
      () => {
        const error = chrome.runtime?.lastError;
        if (error) {
          console.error('Failed to save popup size', error);
        }
      }
    );
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch((error) => console.error('Failed to save popup size', error));
    }
  } catch (error) {
    console.error('Failed to save popup size', error);
  }
}

function setupResizeHandle() {
  if (!resizeHandle) {
    return;
  }

  let isDragging = false;
  let startX = 0;
  let startWidth = 0;

  resizeHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    isDragging = true;
    startX = event.screenX;
    startWidth = window.outerWidth;
    document.body.classList.add('resizing');
    if (typeof resizeHandle.setPointerCapture === 'function') {
      resizeHandle.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
  });

  resizeHandle.addEventListener('pointermove', (event) => {
    if (!isDragging) {
      return;
    }
    const delta = event.screenX - startX;
    const newWidth = clampDimension(startWidth + delta, MIN_POPUP_WIDTH);
    applyPopupSize(newWidth, window.outerHeight);
  });

  function stopResizing(event) {
    if (!isDragging) {
      return;
    }
    isDragging = false;
    document.body.classList.remove('resizing');
    if (
      event?.pointerId != null &&
      typeof resizeHandle.hasPointerCapture === 'function' &&
      resizeHandle.hasPointerCapture(event.pointerId)
    ) {
      resizeHandle.releasePointerCapture(event.pointerId);
    }
    persistPopupSize(window.outerWidth, window.outerHeight);
  }

  resizeHandle.addEventListener('pointerup', stopResizing);
  resizeHandle.addEventListener('pointercancel', stopResizing);

  window.addEventListener('blur', () => {
    if (!isDragging) {
      return;
    }
    isDragging = false;
    document.body.classList.remove('resizing');
    persistPopupSize(window.outerWidth, window.outerHeight);
  });
}

function setStatus(message, kind = 'info') {
  if (!message) {
    statusElement.hidden = true;
    statusElement.textContent = '';
    statusElement.dataset.kind = '';
    return;
  }
  statusElement.hidden = false;
  statusElement.textContent = message;
  statusElement.dataset.kind = kind;
}

function createNewlineTokenLabel(token) {
  switch (token) {
    case '\r\n':
      return { label: '⏎ CRLF', type: 'crlf' };
    case '\r':
      return { label: '⏎ CR', type: 'cr' };
    case '\n':
    default:
      return { label: '⏎ LF', type: 'lf' };
  }
}

function renderTextWithVisibleNewlines(element, text) {
  if (!element) {
    return;
  }

  element.replaceChildren();

  if (!text) {
    return;
  }

  const fragment = document.createDocumentFragment();
  const newlinePattern = /\r\n|\r|\n/g;
  let lastIndex = 0;
  let match;

  while ((match = newlinePattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      fragment.append(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const { label, type } = createNewlineTokenLabel(token);
    const marker = document.createElement('span');
    marker.className = 'newline-token';
    marker.dataset.type = type;
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', `改行 (${label.replace('⏎ ', '')})`);
    marker.title = label.replace('⏎ ', '');
    marker.textContent = label;
    fragment.append(marker);

    const lineBreak = document.createElement('br');
    lineBreak.setAttribute('aria-hidden', 'true');
    fragment.append(lineBreak);

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    fragment.append(text.slice(lastIndex));
  }

  element.append(fragment);
}

function formatLanguage(code) {
  if (!code || code === 'auto') {
    return '自動判別';
  }
  return code.toUpperCase();
}

function formatDate(value) {
  if (!value) {
    return '';
  }
  try {
    return new Date(value).toLocaleString();
  } catch (error) {
    return value;
  }
}

function showResult(data) {
  if (!data) {
    resultWrapper.hidden = true;
    detectedLanguageElement.textContent = '';
    renderTextWithVisibleNewlines(sourceTextElement, '');
    renderTextWithVisibleNewlines(translatedTextElement, '');
    updatedAtElement.textContent = '';
    return;
  }

  detectedLanguageElement.textContent = formatLanguage(
    data.detectedSourceLanguage || data.requestedSourceLanguage
  );
  renderTextWithVisibleNewlines(sourceTextElement, data.sourceText || '');
  renderTextWithVisibleNewlines(translatedTextElement, data.translatedText || '');
  updatedAtElement.textContent = formatDate(data.updatedAt);
  resultWrapper.hidden = false;
}

function setSelectValue(selectElement, value, fallback) {
  if (!selectElement) {
    return fallback;
  }
  const options = Array.from(selectElement.options).map((option) => option.value);
  const nextValue = options.includes(value) ? value : fallback;
  selectElement.value = nextValue;
  return nextValue;
}

function persistPreferredLanguages(sourceLanguage, targetLanguage) {
  const storageArea = chrome?.storage?.local;
  if (!storageArea) {
    return;
  }
  const payload = {};
  if (typeof sourceLanguage === 'string' && sourceLanguage) {
    payload[SOURCE_LANGUAGE_STORAGE_KEY] = sourceLanguage;
  }
  if (typeof targetLanguage === 'string' && targetLanguage) {
    payload[TARGET_LANGUAGE_STORAGE_KEY] = targetLanguage;
  }
  if (!Object.keys(payload).length) {
    return;
  }
  try {
    const maybePromise = storageArea.set(payload, () => {
      const error = chrome.runtime?.lastError;
      if (error) {
        console.error('Failed to save language preference', error);
      }
    });
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch((error) => console.error('Failed to save language preference', error));
    }
  } catch (error) {
    console.error('Failed to save language preference', error);
  }
}

async function loadPreferredLanguages() {
  const storageArea = chrome?.storage?.local;
  if (!storageArea) {
    setSelectValue(sourceLanguageSelect, DEFAULT_SOURCE_LANGUAGE, DEFAULT_SOURCE_LANGUAGE);
    setSelectValue(targetLanguageSelect, DEFAULT_TARGET_LANGUAGE, DEFAULT_TARGET_LANGUAGE);
    return;
  }
  try {
    const stored = await new Promise((resolve, reject) => {
      const callback = (items) => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
        } else {
          resolve(items);
        }
      };
      const maybePromise = storageArea.get(
        [SOURCE_LANGUAGE_STORAGE_KEY, TARGET_LANGUAGE_STORAGE_KEY],
        callback
      );
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve).catch(reject);
      }
    });
    const storedSource = stored?.[SOURCE_LANGUAGE_STORAGE_KEY];
    const storedTarget = stored?.[TARGET_LANGUAGE_STORAGE_KEY];
    setSelectValue(sourceLanguageSelect, storedSource, DEFAULT_SOURCE_LANGUAGE);
    setSelectValue(targetLanguageSelect, storedTarget, DEFAULT_TARGET_LANGUAGE);
  } catch (error) {
    console.error('Failed to load language preference', error);
    setSelectValue(sourceLanguageSelect, DEFAULT_SOURCE_LANGUAGE, DEFAULT_SOURCE_LANGUAGE);
    setSelectValue(targetLanguageSelect, DEFAULT_TARGET_LANGUAGE, DEFAULT_TARGET_LANGUAGE);
  }
}

async function loadLatestTranslation() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getLatestTranslation' });
    if (response?.ok && response.data) {
      showResult(response.data);
      textInput.value = response.data.sourceText || '';
      if (response.data.requestedSourceLanguage) {
        setSelectValue(
          sourceLanguageSelect,
          response.data.requestedSourceLanguage,
          DEFAULT_SOURCE_LANGUAGE
        );
      }
      if (response.data.targetLanguage) {
        setSelectValue(targetLanguageSelect, response.data.targetLanguage, DEFAULT_TARGET_LANGUAGE);
      }
    }
  } catch (error) {
    console.error('Failed to load latest translation', error);
  }
}

async function requestTranslation(text, origin) {
  translateButton.disabled = true;
  setStatus('翻訳中...', 'progress');
  try {
    const sourceLanguage = sourceLanguageSelect?.value || DEFAULT_SOURCE_LANGUAGE;
    const targetLanguage = targetLanguageSelect?.value || DEFAULT_TARGET_LANGUAGE;
    persistPreferredLanguages(sourceLanguage, targetLanguage);
    const response = await chrome.runtime.sendMessage({
      type: 'translateText',
      text,
      origin,
      sourceLanguage,
      targetLanguage
    });
    if (!response?.ok) {
      throw new Error(response?.error || '翻訳に失敗しました。');
    }
    showResult(response.data);
    setStatus('翻訳が完了しました。', 'success');
    return response.data;
  } catch (error) {
    setStatus(error.message || '翻訳に失敗しました。', 'error');
    throw error;
  } finally {
    translateButton.disabled = false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = textInput.value;
  if (!text.trim()) {
    setStatus('テキストを入力してください。', 'error');
    return;
  }
  try {
    await requestTranslation(text, 'popup');
  } catch (error) {
    console.error('Translation failed', error);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'translationResult') {
    showResult(message.data);
    if (message.data?.origin === 'contextMenu') {
      textInput.value = message.data.sourceText || '';
      setStatus('選択したテキストを翻訳しました。', 'success');
    }
    if (message.data?.requestedSourceLanguage) {
      setSelectValue(
        sourceLanguageSelect,
        message.data.requestedSourceLanguage,
        DEFAULT_SOURCE_LANGUAGE
      );
    }
    if (message.data?.targetLanguage) {
      setSelectValue(targetLanguageSelect, message.data.targetLanguage, DEFAULT_TARGET_LANGUAGE);
    }
  } else if (message?.type === 'translationError') {
    setStatus(message.error || '翻訳に失敗しました。', 'error');
  }
});

loadLatestTranslation();
loadPreferredLanguages();
restorePopupSize();
setupResizeHandle();

if (sourceLanguageSelect) {
  sourceLanguageSelect.addEventListener('change', () => {
    const sourceLanguage = sourceLanguageSelect.value || DEFAULT_SOURCE_LANGUAGE;
    const targetLanguage = targetLanguageSelect?.value || DEFAULT_TARGET_LANGUAGE;
    persistPreferredLanguages(sourceLanguage, targetLanguage);
  });
}

if (targetLanguageSelect) {
  targetLanguageSelect.addEventListener('change', () => {
    const sourceLanguage = sourceLanguageSelect?.value || DEFAULT_SOURCE_LANGUAGE;
    const targetLanguage = targetLanguageSelect.value || DEFAULT_TARGET_LANGUAGE;
    persistPreferredLanguages(sourceLanguage, targetLanguage);
  });
}
