const PANEL_ID = 'tab-manager-panel';
const PANEL_TRANSITION_MS = 350;
const PANEL_WIDTH = 400;
const PREVIEW_OVERLAY_ID = 'tab-manager-preview-overlay';
const PREVIEW_OVERLAY_WIDTH = 320;
const PREVIEW_OVERLAY_MARGIN = 12;
const PREVIEW_OVERLAY_MIN_HEIGHT = 180;
const PREVIEW_OVERLAY_TRANSITION_MS = 180;
const PREVIEW_OVERLAY_SANDBOX = 'allow-same-origin';
const PREVIEW_OVERLAY_UPDATE_MESSAGE = 'TabManagerPreviewOverlayUpdate';
const PREVIEW_OVERLAY_VISIBILITY_MESSAGE = 'TabManagerPreviewOverlayVisibility';
const EXTENSION_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
const TOGGLE_BUTTON_ID = 'tab-manager-toggle';
const TOGGLE_BUTTON_SIZE = 36;
const TOGGLE_MARGIN_RIGHT = 5;
const TOGGLE_OPACITY_INACTIVE = 0.3;
const TOGGLE_TRANSITION_MS = 220;
const TOGGLE_STORAGE_KEY = 'tabManagerToggleTop';
const TOGGLE_INITIAL_TOP = 15;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function getStoredToggleTop() {
  try {
    const result = await chrome.storage.local.get(TOGGLE_STORAGE_KEY);
    const rawValue = result?.[TOGGLE_STORAGE_KEY];
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function storeToggleTop(top) {
  try {
    chrome.storage.local.set({ [TOGGLE_STORAGE_KEY]: Number(top) });
  } catch (error) {
    // ignore storage failures
  }
}

function getButtonTop(button) {
  const stored = Number(button.dataset.toggleTop);
  return Number.isFinite(stored) ? stored : null;
}

function setButtonTop(button, top, { persist = false } = {}) {
  const clampedTop = clamp(top, 0, Math.max(window.innerHeight - TOGGLE_BUTTON_SIZE, 0));
  button.style.top = `${clampedTop}px`;
  button.dataset.toggleTop = String(clampedTop);
  if (persist) {
    storeToggleTop(clampedTop);
  }
  return clampedTop;
}

function applyStoredToggleTop(button) {
  const fallbackTop = clamp(
    TOGGLE_INITIAL_TOP,
    0,
    Math.max(window.innerHeight - TOGGLE_BUTTON_SIZE, 0)
  );
  const fallbackApplied = setButtonTop(button, fallbackTop);

  getStoredToggleTop()
    .then((storedTop) => {
      if (storedTop == null) {
        return;
      }
      const clamped = setButtonTop(button, storedTop);
      if (clamped !== storedTop) {
        storeToggleTop(clamped);
      }
    })
    .catch(() => {});

  return fallbackApplied;
}

let previewOverlayElements = null;
let previewOverlayVisible = false;

function escapeHtmlAttribute(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ensurePreviewOverlayElements() {
  if (previewOverlayElements) {
    return previewOverlayElements;
  }

  const container = document.createElement('div');
  container.id = PREVIEW_OVERLAY_ID;
  container.style.cssText = `
    position: fixed;
    top: 16px;
    right: ${PANEL_WIDTH + PREVIEW_OVERLAY_MARGIN}px;
    width: ${PREVIEW_OVERLAY_WIDTH}px;
    z-index: 999998;
    pointer-events: none;
    opacity: 0;
    transform: translateX(16px);
    transition: opacity ${PREVIEW_OVERLAY_TRANSITION_MS}ms ease, transform ${PREVIEW_OVERLAY_TRANSITION_MS}ms ease;
    display: none;
  `;

  const shadowRoot = container.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
    }

    *, *::before, *::after {
      box-sizing: border-box;
    }

    .overlay-shell {
      background: rgba(20, 21, 24, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      min-height: ${PREVIEW_OVERLAY_MIN_HEIGHT}px;
      overflow: hidden;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
      color: #e8eaed;
      font-family: 'Noto Sans JP', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    .overlay-shell[data-mode='placeholder'] {
      background: rgba(17, 18, 20, 0.92);
    }

    .overlay-inner {
      position: relative;
      min-height: ${PREVIEW_OVERLAY_MIN_HEIGHT}px;
      background: #111;
    }

    .overlay-frame {
      width: 100%;
      height: ${PREVIEW_OVERLAY_MIN_HEIGHT}px;
      border: none;
      display: block;
      background: #111;
    }

    .overlay-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 20px 14px;
      text-align: center;
      min-height: ${PREVIEW_OVERLAY_MIN_HEIGHT}px;
      color: #9aa0a6;
      font-size: 13px;
    }

    .overlay-placeholder.is-loading {
      color: #bdc1c6;
    }

    .overlay-placeholder p {
      margin: 0;
    }

    .overlay-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid rgba(255, 255, 255, 0.18);
      border-top-color: rgba(138, 180, 248, 0.9);
      border-radius: 50%;
      animation: overlay-spin 1s linear infinite;
    }

    .overlay-placeholder:not(.is-loading) .overlay-spinner {
      display: none;
    }

    @keyframes overlay-spin {
      to {
        transform: rotate(360deg);
      }
    }
  `;

  shadowRoot.appendChild(style);

  const shell = document.createElement('div');
  shell.className = 'overlay-shell';
  shell.dataset.mode = 'placeholder';
  shell.setAttribute('role', 'status');
  shell.setAttribute('aria-live', 'polite');
  shell.setAttribute('aria-hidden', 'true');

  const inner = document.createElement('div');
  inner.className = 'overlay-inner';
  shell.appendChild(inner);
  shadowRoot.appendChild(shell);

  const host = document.body || document.documentElement;
  host.appendChild(container);

  previewOverlayElements = { container, shell, inner };
  return previewOverlayElements;
}

function buildPreviewSrcdoc(image, title) {
  const safeImage = escapeHtmlAttribute(image);
  const safeTitle = escapeHtmlAttribute(title);
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><style>body{margin:0;background:#111;display:flex;align-items:center;justify-content:center;}img{width:100%;height:100%;object-fit:cover;}</style></head><body><img src="${safeImage}" alt="${safeTitle}"></body></html>`;
}

function updatePreviewOverlayContent(detail = {}) {
  const { shell, inner } = ensurePreviewOverlayElements();
  const state = detail && detail.state;

  if (state !== 'image') {
    const isLoading = Boolean(detail && detail.loading);
    const message = detail && typeof detail.message === 'string' ? detail.message : '';
    inner.innerHTML = '';

    const placeholder = document.createElement('div');
    placeholder.className = 'overlay-placeholder';
    if (isLoading) {
      placeholder.classList.add('is-loading');
    }

    const spinner = document.createElement('div');
    spinner.className = 'overlay-spinner';
    placeholder.appendChild(spinner);

    if (message) {
      const text = document.createElement('p');
      text.textContent = message;
      placeholder.appendChild(text);
    }

    inner.appendChild(placeholder);
    shell.dataset.mode = isLoading ? 'loading' : 'placeholder';
    shell.setAttribute('aria-busy', isLoading ? 'true' : 'false');
    return;
  }

  const image = typeof detail.image === 'string' ? detail.image : '';
  if (!image) {
    updatePreviewOverlayContent({ state: 'placeholder', loading: false, message: '' });
    return;
  }

  const title = typeof detail.title === 'string' && detail.title.trim().length > 0 ? detail.title.trim() : 'Tab preview';
  inner.innerHTML = '';

  const iframe = document.createElement('iframe');
  iframe.className = 'overlay-frame';
  iframe.setAttribute('sandbox', PREVIEW_OVERLAY_SANDBOX);
  iframe.setAttribute('title', `${title} のプレビュー`);
  iframe.srcdoc = buildPreviewSrcdoc(image, title);

  inner.appendChild(iframe);
  shell.dataset.mode = 'image';
  shell.setAttribute('aria-busy', 'false');
}

function showPreviewOverlay() {
  const { container, shell } = ensurePreviewOverlayElements();

  if (container.__hideHandler) {
    container.removeEventListener('transitionend', container.__hideHandler);
    delete container.__hideHandler;
  }

  shell.setAttribute('aria-hidden', 'false');

  if (previewOverlayVisible) {
    container.style.display = 'block';
    container.style.opacity = '1';
    container.style.transform = 'translateX(0)';
    return;
  }

  previewOverlayVisible = true;
  container.style.display = 'block';
  container.style.opacity = '0';
  container.style.transform = 'translateX(16px)';

  requestAnimationFrame(() => {
    container.style.opacity = '1';
    container.style.transform = 'translateX(0)';
  });
}

function hidePreviewOverlay({ immediate = false } = {}) {
  if (!previewOverlayElements) {
    return;
  }

  const { container, shell } = previewOverlayElements;

  if (container.__hideHandler) {
    container.removeEventListener('transitionend', container.__hideHandler);
    delete container.__hideHandler;
  }

  const handleTransitionEnd = () => {
    container.style.display = 'none';
    container.removeEventListener('transitionend', handleTransitionEnd);
    delete container.__hideHandler;
  };

  shell.setAttribute('aria-hidden', 'true');
  previewOverlayVisible = false;

  if (immediate) {
    handleTransitionEnd();
    container.style.opacity = '0';
    container.style.transform = 'translateX(16px)';
    return;
  }

  container.__hideHandler = handleTransitionEnd;
  container.addEventListener('transitionend', handleTransitionEnd);

  requestAnimationFrame(() => {
    container.style.opacity = '0';
    container.style.transform = 'translateX(16px)';
  });
}

function createPanelElement() {
  const iframe = document.createElement('iframe');
  iframe.id = PANEL_ID;
  iframe.src = chrome.runtime.getURL('panel.html');
  iframe.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    width: ${PANEL_WIDTH}px;
    height: 100%;
    z-index: 999999;
    border: none;
    box-shadow: -3px 0 8px rgba(0,0,0,0.3);
    transform: translateX(100%);
    transition: transform ${PANEL_TRANSITION_MS}ms ease-out;
  `;
  iframe.dataset.state = 'opening';
  return iframe;
}

function getPanel() {
  return document.getElementById(PANEL_ID);
}

function getToggleButton() {
  return document.getElementById(TOGGLE_BUTTON_ID);
}

function createToggleButton() {
  const button = document.createElement('button');
  button.id = TOGGLE_BUTTON_ID;
  button.type = 'button';
  button.textContent = '<';
  button.setAttribute('aria-label', 'Tab Manager を開く');
  button.style.cssText = `
    position: fixed;
    right: ${TOGGLE_MARGIN_RIGHT}px;
    width: ${TOGGLE_BUTTON_SIZE}px;
    height: ${TOGGLE_BUTTON_SIZE}px;
    margin: 0;
    padding: 0;
    border-radius: 50%;
    border: none;
    background: rgba(32, 33, 36, 0.85);
    color: #fff;
    cursor: pointer;
    z-index: 999998;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    line-height: 1;
    opacity: ${TOGGLE_OPACITY_INACTIVE};
    transition: opacity 180ms ease-in-out, transform ${TOGGLE_TRANSITION_MS}ms ease-out;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
    transform: translateX(150%);
    touch-action: none;
  `;

  applyStoredToggleTop(button);

  let isDragging = false;
  let dragPointerId = null;
  let dragOffsetY = 0;
  let dragMoved = false;

  const finishDrag = (pointerId, shouldPersist) => {
    if (!isDragging || pointerId !== dragPointerId) {
      return;
    }
    isDragging = false;
    dragPointerId = null;
    if (shouldPersist && dragMoved) {
      const top = getButtonTop(button);
      if (top != null) {
        storeToggleTop(top);
      }
    }
    dragOffsetY = 0;
    const resetDragFlag = () => {
      delete button.dataset.justDragged;
    };
    if (dragMoved) {
      button.dataset.justDragged = 'true';
      setTimeout(resetDragFlag, 0);
    }
    dragMoved = false;
    delete button.dataset.dragging;
  };

  button.addEventListener('mouseenter', () => {
    button.style.opacity = '1';
  });

  button.addEventListener('mouseleave', () => {
    button.style.opacity = String(TOGGLE_OPACITY_INACTIVE);
  });

  button.addEventListener('focus', () => {
    button.style.opacity = '1';
  });

  button.addEventListener('blur', () => {
    button.style.opacity = String(TOGGLE_OPACITY_INACTIVE);
  });

  button.addEventListener('click', (event) => {
    if (button.dataset.justDragged === 'true' || button.dataset.dragging === 'true') {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    openPanel();
  });

  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') {
      return;
    }
    isDragging = true;
    dragMoved = false;
    dragPointerId = event.pointerId;
    button.dataset.dragging = 'true';
    const rect = button.getBoundingClientRect();
    dragOffsetY = event.clientY - rect.top;
    button.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  button.addEventListener('pointermove', (event) => {
    if (!isDragging || event.pointerId !== dragPointerId) {
      return;
    }
    const nextTop = event.clientY - dragOffsetY;
    const previousTop = getButtonTop(button);
    const clamped = setButtonTop(button, nextTop);
    if (!dragMoved && previousTop != null && Math.abs(clamped - previousTop) > 0.5) {
      dragMoved = true;
    } else if (!dragMoved && previousTop == null) {
      dragMoved = true;
    }
  });

  const pointerUpListener = (event) => {
    if (event.pointerId === dragPointerId) {
      try {
        button.releasePointerCapture(event.pointerId);
      } catch (error) {
        // ignore release failures
      }
    }
    finishDrag(event.pointerId, true);
  };

  button.addEventListener('pointerup', pointerUpListener);
  button.addEventListener('pointercancel', pointerUpListener);

  window.addEventListener('resize', () => {
    const top = getButtonTop(button);
    if (top == null) {
      return;
    }
    const clamped = clamp(top, 0, Math.max(window.innerHeight - TOGGLE_BUTTON_SIZE, 0));
    if (clamped !== top) {
      setButtonTop(button, clamped, { persist: true });
    }
  });

  return button;
}

function ensureToggleButton() {
  let button = getToggleButton();
  if (button) {
    return button;
  }

  button = createToggleButton();
  const container = document.body || document.documentElement;
  container.appendChild(button);
  return button;
}

function showToggleButton() {
  const button = ensureToggleButton();
  if (button.__hideHandler) {
    button.removeEventListener('transitionend', button.__hideHandler);
    delete button.__hideHandler;
  }
  applyStoredToggleTop(button);
  button.style.display = 'flex';
  button.style.opacity = String(TOGGLE_OPACITY_INACTIVE);
  button.style.transform = 'translateX(150%)';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      button.style.transform = 'translateX(0)';
    });
  });
}

function hideToggleButton() {
  const button = ensureToggleButton();
  if (button.__hideHandler) {
    button.removeEventListener('transitionend', button.__hideHandler);
    delete button.__hideHandler;
  }

  if (button.style.display === 'none') {
    button.style.transform = 'translateX(150%)';
    return;
  }

  const handleTransitionEnd = () => {
    button.style.display = 'none';
    button.removeEventListener('transitionend', handleTransitionEnd);
    delete button.__hideHandler;
  };

  button.__hideHandler = handleTransitionEnd;
  button.addEventListener('transitionend', handleTransitionEnd);
  requestAnimationFrame(() => {
    button.style.transform = 'translateX(150%)';
    button.style.opacity = String(TOGGLE_OPACITY_INACTIVE);
  });
}

function openPanel() {
  const existing = getPanel();
  if (existing) {
    if (existing.dataset.state === 'closing') {
      if (existing.__closeHandler) {
        existing.removeEventListener('transitionend', existing.__closeHandler);
        delete existing.__closeHandler;
      }
      if (existing.__closeTimeout) {
        clearTimeout(existing.__closeTimeout);
        delete existing.__closeTimeout;
      }
    }
    existing.dataset.state = 'open';
    hideToggleButton();
    requestAnimationFrame(() => {
      existing.style.transform = 'translateX(0)';
    });
    return existing;
  }

  const iframe = createPanelElement();
  (document.body || document.documentElement).appendChild(iframe);
  requestAnimationFrame(() => {
    iframe.dataset.state = 'open';
    iframe.style.transform = 'translateX(0)';
  });
  hideToggleButton();
  return iframe;
}

function closePanel() {
  hidePreviewOverlay();
  const iframe = getPanel();
  if (!iframe) {
    showToggleButton();
    return;
  }

  if (iframe.dataset.state === 'closing') {
    return;
  }

  iframe.dataset.state = 'closing';

  const handleTransitionEnd = () => {
    iframe.removeEventListener('transitionend', handleTransitionEnd);
    delete iframe.__closeHandler;
    delete iframe.__closeTimeout;
    if (iframe.isConnected) {
      iframe.remove();
    }
    showToggleButton();
  };

  iframe.__closeHandler = handleTransitionEnd;
  iframe.addEventListener('transitionend', handleTransitionEnd);

  iframe.__closeTimeout = setTimeout(handleTransitionEnd, PANEL_TRANSITION_MS + 60);

  requestAnimationFrame(() => {
    iframe.style.transform = 'translateX(100%)';
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message?.type) {
    return;
  }

  if (message.type === 'openPanel') {
    openPanel();
  } else if (message.type === 'closePanel') {
    closePanel();
  }
});

if (!window.__tabManagerMessageHandler) {
  const messageHandler = (event) => {
    if (event.origin !== EXTENSION_ORIGIN) {
      return;
    }

    if (event.data?.type === PREVIEW_OVERLAY_UPDATE_MESSAGE) {
      updatePreviewOverlayContent(event.data?.detail || {});
      return;
    }

    if (event.data?.type === PREVIEW_OVERLAY_VISIBILITY_MESSAGE) {
      const detail = event.data?.detail || {};
      const visible = Boolean(detail.visible);
      const immediate = Boolean(detail.immediate);
      if (visible) {
        showPreviewOverlay();
      } else {
        hidePreviewOverlay({ immediate });
      }
      return;
    }

    if (event.data?.type === 'TabManagerClosePanel') {
      closePanel();
    }
  };

  window.addEventListener('message', messageHandler);
  window.__tabManagerMessageHandler = messageHandler;
}

if (!window.__tabManagerStorageListener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes) {
      return;
    }

    const change = changes[TOGGLE_STORAGE_KEY];
    if (!change) {
      return;
    }

    const newValue = Number(change.newValue);
    if (!Number.isFinite(newValue)) {
      return;
    }

    const button = getToggleButton();
    if (!button) {
      return;
    }

    const currentTop = getButtonTop(button);
    if (currentTop != null && Math.abs(currentTop - newValue) < 0.5) {
      return;
    }

    setButtonTop(button, newValue);
  });

  window.__tabManagerStorageListener = true;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', showToggleButton, { once: true });
} else {
  showToggleButton();
}
