const PREVIEW_DEFAULT_MESSAGE = 'タブにカーソルを合わせるとここにプレビューが表示されます';
const PREVIEW_LOADING_MESSAGE = 'プレビューを読み込んでいます…';
const PREVIEW_DISABLED_MESSAGE = 'プロパティからプレビューを有効にしてください。';
const PREVIEW_ERROR_MESSAGE = 'プレビューを取得できませんでした。';

let tabListElement = null;
let propertiesPanelElement = null;
let propertiesButtonElement = null;
let previewToggleElement = null;
let previewContainerElement = null;
let previewPlaceholderElement = null;
let previewFrameElement = null;

let isPreviewEnabled = false;
let hoveredPreviewTabId = null;
let currentPreviewTabId = null;

function createPlaceholderFavicon(tab) {
  const span = document.createElement('span');
  span.className = 'tab-favicon tab-favicon--placeholder';

  const title = (tab.title || tab.url || '').trim();
  const initial = title.charAt(0);
  span.textContent = initial ? initial.toUpperCase() : '•';

  return span;
}

function createFaviconElement(tab) {
  const faviconUrl = tab.favIconUrl;
  if (typeof faviconUrl === 'string' && faviconUrl.length > 0) {
    const img = document.createElement('img');
    img.className = 'tab-favicon';
    img.src = faviconUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      img.replaceWith(createPlaceholderFavicon(tab));
    });
    return img;
  }

  return createPlaceholderFavicon(tab);
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderTabs(tabs) {
  if (!tabListElement) {
    return;
  }

  tabListElement.innerHTML = '';

  for (const tab of tabs) {
    const li = document.createElement('li');
    li.className = 'tab-item';
    if (tab.active) {
      li.classList.add('is-active');
    }

    const tabId = tab.id;
    if (typeof tabId === 'number') {
      li.dataset.tabId = String(tabId);
    }

    const favicon = createFaviconElement(tab);

    const fullTitle = tab.title || '(no title)';

    const content = document.createElement('div');
    content.className = 'tab-text';
    content.textContent = fullTitle;
    content.title = fullTitle;

    const closeButton = document.createElement('button');
    closeButton.className = 'tab-close-btn';
    closeButton.type = 'button';
    closeButton.textContent = '✕';
    closeButton.title = 'タブを閉じる';
    closeButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        if (typeof tabId === 'number') {
          await chrome.tabs.remove(tabId);
        }
      } catch (error) {
        console.error('Failed to close tab:', error);
      }
    });

    li.appendChild(favicon);
    li.appendChild(content);
    li.appendChild(closeButton);
    li.title = fullTitle;

    li.addEventListener('click', async () => {
      try {
        if (typeof tabId === 'number') {
          await chrome.tabs.update(tabId, { active: true });
        }
        if (typeof tab.windowId === 'number') {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } catch (error) {
        console.error('Failed to activate tab:', error);
      }
    });

    li.addEventListener('mouseenter', () => {
      handleTabHoverStart(tab);
    });

    li.addEventListener('mouseleave', () => {
      if (typeof tabId === 'number') {
        handleTabHoverEnd(tabId);
      }
    });

    tabListElement.appendChild(li);
  }
}

function showPreviewMessage(message) {
  if (!previewPlaceholderElement || !previewFrameElement) {
    return;
  }
  previewPlaceholderElement.textContent = message;
  previewPlaceholderElement.style.display = 'block';
  previewFrameElement.classList.remove('is-visible');
  previewFrameElement.removeAttribute('srcdoc');
}

function resetPreviewToDefault() {
  showPreviewMessage(PREVIEW_DEFAULT_MESSAGE);
}

function showPreviewImage(tabId, dataUrl) {
  if (!previewFrameElement || !previewPlaceholderElement) {
    return;
  }

  const safeDataUrl = escapeHtmlAttribute(dataUrl || '');
  previewFrameElement.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #111; display: flex; align-items: center; justify-content: center; height: 100vh; }
    img { max-width: 100%; max-height: 100%; display: block; }
  </style></head><body><img src="${safeDataUrl}" alt="Tab preview"></body></html>`;
  previewFrameElement.classList.add('is-visible');
  previewPlaceholderElement.style.display = 'none';
  currentPreviewTabId = tabId;
}

async function requestPreview(tabId, { expedite = false } = {}) {
  if (!isPreviewEnabled || typeof tabId !== 'number') {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TabManagerRequestPreview',
      tabId,
      expedite: Boolean(expedite),
    });

    if (hoveredPreviewTabId !== tabId) {
      return;
    }

    if (response?.status === 'ready' && response.dataUrl) {
      showPreviewImage(tabId, response.dataUrl);
    } else if (response?.status === 'disabled') {
      showPreviewMessage(PREVIEW_DISABLED_MESSAGE);
    } else if (response?.status === 'error') {
      showPreviewMessage(PREVIEW_ERROR_MESSAGE);
    } else {
      showPreviewMessage(PREVIEW_LOADING_MESSAGE);
    }
  } catch (error) {
    if (hoveredPreviewTabId === tabId) {
      showPreviewMessage(PREVIEW_ERROR_MESSAGE);
    }
  }
}

function handleTabHoverStart(tab) {
  const tabId = tab.id;
  if (!isPreviewEnabled || typeof tabId !== 'number') {
    return;
  }

  hoveredPreviewTabId = tabId;
  if (previewContainerElement) {
    previewContainerElement.setAttribute('aria-hidden', 'false');
  }
  showPreviewMessage(PREVIEW_LOADING_MESSAGE);
  requestPreview(tabId, { expedite: true });
}

function handleTabHoverEnd(tabId) {
  if (hoveredPreviewTabId !== tabId) {
    return;
  }

  hoveredPreviewTabId = null;
  currentPreviewTabId = null;
  if (isPreviewEnabled) {
    resetPreviewToDefault();
  }
}

function queuePreviewsForTabs(tabs) {
  if (!isPreviewEnabled || !Array.isArray(tabs)) {
    return;
  }

  const tabIds = tabs
    .map((tab) => tab?.id)
    .filter((tabId) => typeof tabId === 'number');

  if (tabIds.length === 0) {
    return;
  }

  chrome.runtime
    .sendMessage({ type: 'TabManagerSetPreviewOrder', tabIds })
    .catch(() => {});
}

async function refreshTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    renderTabs(tabs);
    queuePreviewsForTabs(tabs);
  } catch (error) {
    console.error('Failed to refresh tabs:', error);
  }
}

function togglePropertiesPanel() {
  if (!propertiesButtonElement || !propertiesPanelElement) {
    return;
  }

  const isExpanded = propertiesButtonElement.getAttribute('aria-expanded') === 'true';
  const nextState = !isExpanded;
  propertiesButtonElement.setAttribute('aria-expanded', String(nextState));
  propertiesPanelElement.setAttribute('aria-hidden', String(!nextState));
}

function attachEventListeners() {
  const closeButton = document.getElementById('close-btn');
  if (closeButton) {
    closeButton.addEventListener('click', () => {
      window.parent.postMessage({ type: 'TabManagerClosePanel' }, '*');
      chrome.runtime
        .sendMessage({ type: 'TabManagerPanelClosedByUser' })
        .catch((error) => {
          console.error('Failed to notify background about panel close:', error);
        });
    });
  }

  if (propertiesButtonElement) {
    propertiesButtonElement.addEventListener('click', () => {
      togglePropertiesPanel();
    });
  }

  if (previewToggleElement) {
    previewToggleElement.addEventListener('change', async (event) => {
      const nextEnabled = Boolean(event.target.checked);
      previewToggleElement.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'TabManagerSetPreviewEnabled',
          enabled: nextEnabled,
        });
        const effectiveEnabled = Boolean(response?.enabled);
        applyPreviewEnabled(effectiveEnabled);
        if (effectiveEnabled) {
          refreshTabs();
        }
      } catch (error) {
        console.error('Failed to update preview setting:', error);
        previewToggleElement.checked = isPreviewEnabled;
      } finally {
        previewToggleElement.disabled = false;
      }
    });
  }

  const safeRefreshTabs = () => {
    refreshTabs();
  };

  chrome.tabs.onActivated.addListener(() => {
    safeRefreshTabs();
  });

  chrome.tabs.onCreated.addListener(() => {
    safeRefreshTabs();
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (hoveredPreviewTabId === tabId || currentPreviewTabId === tabId) {
      hoveredPreviewTabId = null;
      currentPreviewTabId = null;
      if (isPreviewEnabled) {
        resetPreviewToDefault();
      }
    }
    safeRefreshTabs();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url) {
      safeRefreshTabs();
    }
  });
}

function applyPreviewEnabled(enabled) {
  isPreviewEnabled = Boolean(enabled);

  if (previewToggleElement) {
    previewToggleElement.checked = isPreviewEnabled;
  }

  if (previewContainerElement) {
    previewContainerElement.setAttribute('aria-hidden', String(!isPreviewEnabled));
  }

  hoveredPreviewTabId = null;
  currentPreviewTabId = null;

  if (isPreviewEnabled) {
    resetPreviewToDefault();
  } else {
    showPreviewMessage(PREVIEW_DEFAULT_MESSAGE);
  }
}

async function initializePreviewState() {
  if (!previewToggleElement) {
    applyPreviewEnabled(false);
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: 'TabManagerGetPreviewState' });
    const enabled = Boolean(response?.enabled);
    applyPreviewEnabled(enabled);
  } catch (error) {
    console.error('Failed to retrieve preview state:', error);
    applyPreviewEnabled(false);
  }
}

function initializeElements() {
  tabListElement = document.getElementById('tab-list');
  propertiesPanelElement = document.getElementById('properties-panel');
  propertiesButtonElement = document.getElementById('properties-btn');
  previewToggleElement = document.getElementById('preview-toggle');
  previewContainerElement = document.getElementById('preview-container');
  previewPlaceholderElement = document.getElementById('preview-placeholder');
  previewFrameElement = document.getElementById('preview-frame');
}

function setupHeaderBehavior() {
  const header = document.querySelector('header');
  if (!header) {
    return;
  }

  const updateHeaderState = () => {
    const scrollSource = tabListElement || window;
    const scrollTop = scrollSource === window ? window.scrollY : tabListElement.scrollTop;
    const shouldBeCompact = scrollTop > 0;
    header.classList.toggle('is-compact', shouldBeCompact);
  };

  if (tabListElement) {
    tabListElement.addEventListener('scroll', updateHeaderState, { passive: true });
  } else {
    window.addEventListener('scroll', updateHeaderState, { passive: true });
  }
  updateHeaderState();
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message?.type) {
    return;
  }

  if (message.type === 'TabManagerPreviewReady') {
    if (!isPreviewEnabled) {
      return;
    }
    const tabId = message.tabId;
    if (typeof tabId !== 'number') {
      return;
    }
    if (hoveredPreviewTabId === tabId && message.dataUrl) {
      showPreviewImage(tabId, message.dataUrl);
    }
  } else if (message.type === 'TabManagerPreviewCleared') {
    const tabId = message.tabId;
    if (typeof tabId !== 'number') {
      return;
    }
    if (hoveredPreviewTabId === tabId) {
      if (isPreviewEnabled) {
        showPreviewMessage(PREVIEW_LOADING_MESSAGE);
      }
    } else if (currentPreviewTabId === tabId) {
      currentPreviewTabId = null;
      if (isPreviewEnabled) {
        resetPreviewToDefault();
      }
    }
  } else if (message.type === 'TabManagerPreviewsCleared') {
    currentPreviewTabId = null;
    hoveredPreviewTabId = null;
    if (isPreviewEnabled) {
      resetPreviewToDefault();
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initializeElements();
  attachEventListeners();
  setupHeaderBehavior();
  initializePreviewState().then(() => {
    refreshTabs();
  });
});
