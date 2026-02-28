const PANEL_ID = 'tmx-tab-manager-panel';
const PANEL_WIDTH = 400;
const PANEL_EXPANDED_WIDTH = '100vw';
const PREVIEW_OVERLAY_ID = 'tmx-tab-manager-preview-overlay';
const PREVIEW_OVERLAY_MIN_HEIGHT = 180;
const PREVIEW_OVERLAY_TRANSITION_MS = 180;
const PREVIEW_OVERLAY_SANDBOX = 'allow-same-origin';
const PREVIEW_OVERLAY_UPDATE_MESSAGE = 'TabManagerPreviewOverlayUpdate';
const PREVIEW_OVERLAY_VISIBILITY_MESSAGE = 'TabManagerPreviewOverlayVisibility';
const EXTENSION_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
const EXTENSION_ELEMENT_ATTRIBUTE = 'data-tmx-tab-manager-element';

let previewOverlayElements = null;
let previewOverlayVisible = false;
let panelExpanded = false;

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

function getPanelRightInset() {
  return panelExpanded ? '0px' : `${PANEL_WIDTH}px`;
}

function applyPanelLayout(iframe) {
  if (!iframe) {
    return;
  }

  iframe.style.width = panelExpanded ? PANEL_EXPANDED_WIDTH : `${PANEL_WIDTH}px`;
  iframe.style.left = panelExpanded ? '0' : 'auto';
  iframe.style.right = '0';

  if (previewOverlayElements?.container) {
    previewOverlayElements.container.style.right = getPanelRightInset();
  }
}

function ensurePreviewOverlayElements() {
  if (previewOverlayElements) {
    return previewOverlayElements;
  }

  const container = document.createElement('div');
  container.id = PREVIEW_OVERLAY_ID;
  container.setAttribute(EXTENSION_ELEMENT_ATTRIBUTE, '');
  container.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: ${getPanelRightInset()};
    bottom: 0;
    z-index: 999998;
    pointer-events: none;
    opacity: 0;
    transform: translateX(-12px);
    transition: opacity ${PREVIEW_OVERLAY_TRANSITION_MS}ms ease, transform ${PREVIEW_OVERLAY_TRANSITION_MS}ms ease;
    display: none;
    padding: 24px;
    box-sizing: border-box;
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
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
    }

    :host {
      display: flex;
      justify-content: flex-start;
      align-items: stretch;
    }

    .overlay-shell[data-mode='placeholder'] {
      background: rgba(17, 18, 20, 0.92);
    }

    .overlay-inner {
      position: relative;
      width: 100%;
      height: 100%;
      min-height: ${PREVIEW_OVERLAY_MIN_HEIGHT}px;
      background: #111;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1 1 auto;
    }

    .overlay-frame {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
      background: #111;
      overflow: hidden;
    }

    .overlay-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 28px 18px;
      text-align: center;
      min-height: ${PREVIEW_OVERLAY_MIN_HEIGHT}px;
      width: 100%;
      height: 100%;
      color: #9aa0a6;
      font-size: 13px;
      overflow: hidden;
    }

    .overlay-placeholder p {
      margin: 0;
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
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#111;overflow:hidden;}body{display:flex;align-items:center;justify-content:center;}img{width:100%;height:100%;object-fit:contain;}</style></head><body><img src="${safeImage}" alt="${safeTitle}"></body></html>`;
}

function updatePreviewOverlayContent(detail = {}) {
  const { shell, inner } = ensurePreviewOverlayElements();
  const state = detail && detail.state;

  if (state !== 'image') {
    const message = detail && typeof detail.message === 'string' ? detail.message : '';
    inner.innerHTML = '';

    const placeholder = document.createElement('div');
    placeholder.className = 'overlay-placeholder';

    if (message) {
      const text = document.createElement('p');
      text.textContent = message;
      placeholder.appendChild(text);
    }

    inner.appendChild(placeholder);
    shell.dataset.mode = 'placeholder';
    shell.setAttribute('aria-busy', 'false');
    return;
  }

  const image = typeof detail.image === 'string' ? detail.image : '';
  if (!image) {
    updatePreviewOverlayContent({ state: 'placeholder', message: '' });
    return;
  }

  const title = typeof detail.title === 'string' && detail.title.trim().length > 0 ? detail.title.trim() : 'Tab preview';
  inner.innerHTML = '';

  const iframe = document.createElement('iframe');
  iframe.className = 'overlay-frame';
  iframe.setAttribute('sandbox', PREVIEW_OVERLAY_SANDBOX);
  iframe.setAttribute('title', `${title} のプレビュー`);
  iframe.setAttribute('scrolling', 'no');
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
    container.style.display = 'flex';
    container.style.opacity = '1';
    container.style.transform = 'translateX(0)';
    return;
  }

  previewOverlayVisible = true;
  container.style.display = 'flex';
  container.style.opacity = '0';
  container.style.transform = 'translateX(-12px)';

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
    container.style.transform = 'translateX(-12px)';
    return;
  }

  container.__hideHandler = handleTransitionEnd;
  container.addEventListener('transitionend', handleTransitionEnd);

  requestAnimationFrame(() => {
    container.style.opacity = '0';
    container.style.transform = 'translateX(-12px)';
  });
}

function disposePreviewOverlay() {
  if (!previewOverlayElements) {
    return;
  }

  const { container } = previewOverlayElements;
  if (container?.isConnected) {
    container.remove();
  }
  previewOverlayElements = null;
  previewOverlayVisible = false;
}

function createPanelElement() {
  const iframe = document.createElement('iframe');
  iframe.id = PANEL_ID;
  iframe.setAttribute(EXTENSION_ELEMENT_ATTRIBUTE, '');
  iframe.src = chrome.runtime.getURL('panel.html');
  iframe.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    left: auto;
    width: ${PANEL_WIDTH}px;
    height: 100%;
    z-index: 999999;
    border: none;
    box-shadow: -3px 0 8px rgba(0,0,0,0.3);
    transform: translateX(0);
  `;

  const preventScroll = (event) => {
    event.preventDefault();
  };

  iframe.addEventListener('wheel', preventScroll, { passive: false });
  iframe.addEventListener('touchmove', preventScroll, { passive: false });
  return iframe;
}

function getPanel() {
  return document.getElementById(PANEL_ID);
}

function openPanel() {
  const existing = getPanel();
  if (existing) {
    applyPanelLayout(existing);
    existing.style.transform = 'translateX(0)';
    return existing;
  }

  const iframe = createPanelElement();
  (document.body || document.documentElement).appendChild(iframe);
  applyPanelLayout(iframe);
  iframe.style.transform = 'translateX(0)';
  return iframe;
}

function closePanel() {
  panelExpanded = false;
  hidePreviewOverlay();
  disposePreviewOverlay();
  const iframe = getPanel();
  if (!iframe) {
    return;
  }

  if (iframe.isConnected) {
    iframe.remove();
  }
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

    if (event.data?.type === 'TabManagerExpandedViewChanged') {
      panelExpanded = Boolean(event.data?.detail?.expanded);
      applyPanelLayout(getPanel());
      return;
    }

    if (event.data?.type === 'TabManagerClosePanel') {
      panelExpanded = false;
      closePanel();
    }
  };

  window.addEventListener('message', messageHandler);
  window.__tabManagerMessageHandler = messageHandler;
}
