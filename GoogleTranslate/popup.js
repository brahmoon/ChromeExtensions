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
const NEWLINE_PATTERN = /(\r\n|\n|\r)/g;

const WIDTH_STORAGE_KEY = 'popupWidth';
const HEIGHT_STORAGE_KEY = 'popupHeight';
const SOURCE_LANGUAGE_STORAGE_KEY = 'preferredSourceLanguage';
const TARGET_LANGUAGE_STORAGE_KEY = 'preferredTargetLanguage';
const MIN_POPUP_WIDTH = 320;
const MIN_POPUP_HEIGHT = 240;
const DEFAULT_SOURCE_LANGUAGE = 'auto';
const DEFAULT_TARGET_LANGUAGE = 'ja';
const VALUE_TEXT_CACHE = new WeakMap();

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

function findValueLineElement(node, root) {
  let current = node;
  while (current && current !== root) {
    if (
      current.nodeType === Node.ELEMENT_NODE &&
      current.classList.contains('value-line')
    ) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

function resolvePositionWithinLine(lineElement, node, offset) {
  const textSpan = lineElement.querySelector('.value-line-text');
  if (!textSpan) {
    return null;
  }

  const textContent = textSpan.textContent || '';
  const textLength = textContent.length;
  const rawNewlineLength = Number(lineElement.dataset.newlineLength || '0');
  const newlineLength = Number.isFinite(rawNewlineLength) ? rawNewlineLength : 0;
  const maxRelative = textLength + newlineLength;

  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentNode;
    if (parent === textSpan) {
      const safeOffset = Math.max(0, Math.min(offset, node.nodeValue?.length ?? 0));
      return Math.min(maxRelative, safeOffset);
    }
    return resolvePositionWithinLine(lineElement, parent, offset);
  }

  if (node === textSpan) {
    return offset <= 0 ? 0 : textLength;
  }

  if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('newline-indicator')) {
    return offset <= 0 ? textLength : maxRelative;
  }

  if (node === lineElement) {
    if (offset <= 0) {
      return 0;
    }
    const children = Array.from(lineElement.childNodes);
    if (!children.length || offset >= children.length) {
      return maxRelative;
    }
    const child = children[offset];
    if (child === textSpan) {
      return 0;
    }
    if (child?.nodeType === Node.ELEMENT_NODE && child.classList.contains('newline-indicator')) {
      return textLength;
    }
    return textLength;
  }

  const parent = node.parentNode;
  if (!parent) {
    return null;
  }
  return resolvePositionWithinLine(lineElement, parent, offset);
}

function resolveOffsetWithinValue(root, node, offset) {
  const cache = VALUE_TEXT_CACHE.get(root);
  if (!cache) {
    return null;
  }

  if (node === root) {
    return cache.text.length;
  }

  const lineElement = findValueLineElement(node, root);
  if (!lineElement) {
    return null;
  }

  const rawStart = Number(lineElement.dataset.start);
  if (!Number.isFinite(rawStart)) {
    return null;
  }

  const relative = resolvePositionWithinLine(lineElement, node, offset);
  if (relative == null) {
    return null;
  }

  const absolute = rawStart + relative;
  return Math.max(0, Math.min(absolute, cache.text.length));
}

function ensureCopyHandler(element) {
  if (!element || element.dataset.copyHandlerAttached === 'true') {
    return;
  }

  const isNodeInside = (node) => {
    if (!node) {
      return false;
    }
    if (node === element) {
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return element.contains(node.parentNode);
    }
    return element.contains(node);
  };

  element.addEventListener('copy', (event) => {
    if (!element.classList.contains('has-newline-indicators')) {
      return;
    }

    const cache = VALUE_TEXT_CACHE.get(element);
    if (!cache || typeof cache.text !== 'string' || !cache.text.length) {
      return;
    }

    const selection = typeof window?.getSelection === 'function' ? window.getSelection() : null;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!isNodeInside(anchorNode) && !isNodeInside(focusNode)) {
      return;
    }

    const range = selection.getRangeAt(0);
    const start = resolveOffsetWithinValue(element, range.startContainer, range.startOffset);
    const end = resolveOffsetWithinValue(element, range.endContainer, range.endOffset);
    if (start == null || end == null || start === end) {
      return;
    }

    const from = Math.min(start, end);
    const to = Math.max(start, end);
    if (!event.clipboardData) {
      return;
    }

    event.preventDefault();
    event.clipboardData.setData('text/plain', cache.text.slice(from, to));
  });

  element.dataset.copyHandlerAttached = 'true';
}

function renderTextWithNewlineIndicators(element, value) {
  if (!element) {
    return;
  }

  ensureCopyHandler(element);

  const text = typeof value === 'string' ? value : value != null ? String(value) : '';
  element.dataset.rawValue = text;
  element.replaceChildren();

  if (!text) {
    element.classList.remove('has-newline-indicators');
    VALUE_TEXT_CACHE.delete(element);
    return;
  }

  const lines = [];
  let lastIndex = 0;
  let match;
  NEWLINE_PATTERN.lastIndex = 0;

  while ((match = NEWLINE_PATTERN.exec(text)) !== null) {
    lines.push({ content: text.slice(lastIndex, match.index), newline: match[0] });
    lastIndex = match.index + match[0].length;
  }

  lines.push({ content: text.slice(lastIndex), newline: null });

  let hasNewlines = false;
  let position = 0;

  for (const line of lines) {
    const contentLength = line.content.length;
    const newlineLength = line.newline ? line.newline.length : 0;
    const lineStart = position;
    const contentEnd = lineStart + contentLength;
    const lineEnd = contentEnd + newlineLength;

    const lineElement = document.createElement('div');
    lineElement.className = 'value-line';
    lineElement.dataset.start = String(lineStart);
    lineElement.dataset.contentEnd = String(contentEnd);
    lineElement.dataset.end = String(lineEnd);
    lineElement.dataset.newlineLength = String(newlineLength);

    const textSpan = document.createElement('span');
    textSpan.className = 'value-line-text';
    textSpan.textContent = line.content;
    textSpan.dataset.start = String(lineStart);
    textSpan.dataset.end = String(contentEnd);
    lineElement.appendChild(textSpan);

    if (line.newline) {
      hasNewlines = true;
      const indicator = document.createElement('span');
      indicator.className = 'newline-indicator';
      const code =
        line.newline === '\r\n' ? 'CRLF' : line.newline === '\r' ? 'CR' : 'LF';
      indicator.textContent = `↵ ${code}`;
      indicator.title = `改行 (${code})`;
      indicator.dataset.code = code;
      lineElement.appendChild(indicator);
    }

    element.appendChild(lineElement);
    position = lineEnd;
  }

  VALUE_TEXT_CACHE.set(element, { text, length: position });
  element.classList.toggle('has-newline-indicators', hasNewlines);
}

function showResult(data) {
  if (!data) {
    resultWrapper.hidden = true;
    detectedLanguageElement.textContent = '';
    renderTextWithNewlineIndicators(sourceTextElement, '');
    renderTextWithNewlineIndicators(translatedTextElement, '');
    updatedAtElement.textContent = '';
    return;
  }

  detectedLanguageElement.textContent = formatLanguage(
    data.detectedSourceLanguage || data.requestedSourceLanguage
  );
  renderTextWithNewlineIndicators(sourceTextElement, data.sourceText || '');
  renderTextWithNewlineIndicators(translatedTextElement, data.translatedText || '');
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
