const PANEL_ID = 'tab-manager-panel';
const PANEL_TRANSITION_MS = 350;
const EXTENSION_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
const TOGGLE_BUTTON_ID = 'tab-manager-toggle';
const TOGGLE_BUTTON_SIZE = 48;
const TOGGLE_MARGIN_RIGHT = 5;
const TOGGLE_OPACITY_INACTIVE = 0.3;

function createPanelElement() {
  const iframe = document.createElement('iframe');
  iframe.id = PANEL_ID;
  iframe.src = chrome.runtime.getURL('panel.html');
  iframe.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    width: 400px;
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
    top: 50%;
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
    transition: opacity 180ms ease-in-out;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
  `;

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
    event.preventDefault();
    openPanel();
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
  button.style.display = 'flex';
  button.style.opacity = String(TOGGLE_OPACITY_INACTIVE);
}

function hideToggleButton() {
  const button = ensureToggleButton();
  button.style.display = 'none';
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

    if (event.data?.type === 'TabManagerClosePanel') {
      closePanel();
    }
  };

  window.addEventListener('message', messageHandler);
  window.__tabManagerMessageHandler = messageHandler;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', showToggleButton, { once: true });
} else {
  showToggleButton();
}
