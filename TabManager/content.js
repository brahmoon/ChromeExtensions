const PANEL_ID = 'tab-manager-panel';
const PANEL_WIDTH = 400;
const TRANSITION_DURATION = 400;

function createPanel() {
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
    box-shadow: -3px 0 8px rgba(0, 0, 0, 0.3);
    transform: translateX(100%);
    transition: transform ${TRANSITION_DURATION}ms ease-out;
    background: transparent;
  `;
  return iframe;
}

function openPanel() {
  if (document.getElementById(PANEL_ID)) {
    return;
  }
  const iframe = createPanel();
  document.body.appendChild(iframe);
  requestAnimationFrame(() => {
    iframe.style.transform = 'translateX(0)';
  });
}

function closePanel() {
  const iframe = document.getElementById(PANEL_ID);
  if (!iframe) {
    return;
  }
  iframe.style.transform = 'translateX(100%)';
  const removePanel = () => {
    iframe.removeEventListener('transitionend', removePanel);
    if (iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  };
  iframe.addEventListener('transitionend', removePanel, { once: true });
}

function togglePanel() {
  if (document.getElementById(PANEL_ID)) {
    closePanel();
  } else {
    openPanel();
  }
}

if (!document.getElementById(PANEL_ID)) {
  openPanel();
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message?.type) {
    return;
  }
  if (message.type === 'closePanel') {
    closePanel();
  } else if (message.type === 'openPanel') {
    openPanel();
  } else if (message.type === 'togglePanel') {
    togglePanel();
  }
});
