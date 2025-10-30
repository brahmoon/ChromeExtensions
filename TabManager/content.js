const PANEL_ID = 'tab-manager-panel';
const PANEL_TRANSITION_MS = 350;
const EXTENSION_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');

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
    requestAnimationFrame(() => {
      existing.style.transform = 'translateX(0)';
    });
    return existing;
  }

  const iframe = createPanelElement();
  document.body.appendChild(iframe);
  requestAnimationFrame(() => {
    iframe.dataset.state = 'open';
    iframe.style.transform = 'translateX(0)';
  });
  return iframe;
}

function closePanel() {
  const iframe = getPanel();
  if (!iframe || iframe.dataset.state === 'closing') {
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

  if (message.type === 'togglePanel') {
    if (getPanel()) {
      closePanel();
    } else {
      openPanel();
    }
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

openPanel();
