const PANEL_ID = 'tab-manager-panel';
const PANEL_TRANSITION_MS = 350;
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
