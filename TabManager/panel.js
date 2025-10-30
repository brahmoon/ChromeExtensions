const PREVIEW_ENABLED_STORAGE_KEY = 'tabManagerPreviewEnabled';
const PREVIEW_DATA_STORAGE_KEY = 'tabManagerPreviewData';
const PREVIEW_REQUEST_MESSAGE = 'TabManagerRequestPreview';
const PREVIEW_SYNC_MESSAGE = 'TabManagerSyncPreviewOrder';
const PREVIEW_SET_ENABLED_MESSAGE = 'TabManagerSetPreviewEnabled';
const PREVIEW_UPDATED_MESSAGE = 'TabManagerPreviewUpdated';
const PREVIEW_REMOVED_MESSAGE = 'TabManagerPreviewRemoved';
const PREVIEW_OVERLAY_UPDATE_MESSAGE = 'TabManagerPreviewOverlayUpdate';
const PREVIEW_OVERLAY_VISIBILITY_MESSAGE = 'TabManagerPreviewOverlayVisibility';
const PREVIEW_TOGGLE_ID = 'preview-toggle';
const PROPERTY_BUTTON_ID = 'property-btn';
const TAB_VIEW_ID = 'tab-view';
const OPTIONS_VIEW_ID = 'options-view';
const PREVIEW_LOADING_MESSAGE = 'プレビューを生成しています…';
const PREVIEW_DEFAULT_MESSAGE = 'タブをホバーしてプレビューを表示';
const PREVIEW_DISABLED_MESSAGE = '設定画面からプレビューを有効にしてください';
const PREVIEW_UNAVAILABLE_MESSAGE = 'このタブのプレビュー画像は利用できません';
const PREVIEW_REMOVAL_REASON_UNSUPPORTED = 'unsupported';
const PREVIEW_RENDER_THROTTLE_MS = 150;

let previewEnabled = false;
let previewCache = {};
const previewUnavailableTabs = new Set();
let activePreviewTabId = null;
let previewRenderTimeout = null;
let optionsViewOpen = false;

function postToParentMessage(type, detail = {}) {
  if (window.parent && window.parent !== window) {
    try {
      window.parent.postMessage({ type, detail }, '*');
    } catch (error) {
      // ignore messaging failures
    }
  }
}

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

function renderPreviewPlaceholder(message, { loading = false } = {}) {
  postToParentMessage(PREVIEW_OVERLAY_UPDATE_MESSAGE, {
    state: 'placeholder',
    message: typeof message === 'string' ? message : '',
    loading: Boolean(loading),
  });
}

function renderPreviewImage(preview, tab) {
  const { image } = preview || {};
  if (typeof image !== 'string' || image.length === 0) {
    renderPreviewPlaceholder(PREVIEW_DEFAULT_MESSAGE);
    return;
  }

  const title = (tab?.title || tab?.url || 'Tab preview').trim();
  postToParentMessage(PREVIEW_OVERLAY_UPDATE_MESSAGE, {
    state: 'image',
    image,
    title,
  });
}

function updatePreviewVisibility() {
  if (!previewEnabled) {
    postToParentMessage(PREVIEW_OVERLAY_VISIBILITY_MESSAGE, {
      visible: false,
      immediate: true,
    });
    renderPreviewPlaceholder(PREVIEW_DISABLED_MESSAGE);
  } else if (activePreviewTabId == null) {
    renderPreviewPlaceholder(PREVIEW_DEFAULT_MESSAGE);
  }
}

function updatePreviewCacheFromStorage(storageValue) {
  if (!storageValue || typeof storageValue !== 'object') {
    previewCache = {};
    previewUnavailableTabs.clear();
    return;
  }
  previewCache = { ...storageValue };
  previewUnavailableTabs.clear();
}

function updatePreviewToggleUI() {
  const toggle = document.getElementById(PREVIEW_TOGGLE_ID);
  if (toggle) {
    toggle.checked = previewEnabled;
  }
}

function schedulePreviewRender(preview, tab) {
  if (previewRenderTimeout) {
    clearTimeout(previewRenderTimeout);
    previewRenderTimeout = null;
  }

  previewRenderTimeout = setTimeout(() => {
    if (!previewEnabled) {
      return;
    }
    if (!preview || typeof preview.image !== 'string') {
      renderPreviewPlaceholder(PREVIEW_UNAVAILABLE_MESSAGE);
      return;
    }
    renderPreviewImage(preview, tab);
  }, PREVIEW_RENDER_THROTTLE_MS);
}

function handlePreviewResponse(tab, response) {
  if (!tab || typeof tab.id !== 'number' || tab.id !== activePreviewTabId) {
    return;
  }

  const tabId = tab.id;

  if (!response) {
    if (previewUnavailableTabs.has(tabId)) {
      renderPreviewPlaceholder(PREVIEW_UNAVAILABLE_MESSAGE);
    } else {
      renderPreviewPlaceholder(PREVIEW_LOADING_MESSAGE, { loading: true });
    }
    return;
  }

  if (response.status === 'ready' && response.preview) {
    if (typeof response.preview.image !== 'string' || response.preview.image.length === 0) {
      previewUnavailableTabs.add(tabId);
      renderPreviewPlaceholder(PREVIEW_UNAVAILABLE_MESSAGE);
      return;
    }
    previewUnavailableTabs.delete(tabId);
    previewCache[String(tab.id)] = response.preview;
    schedulePreviewRender(response.preview, tab);
    return;
  }

  if (response.status === 'unavailable') {
    previewUnavailableTabs.add(tabId);
    renderPreviewPlaceholder(PREVIEW_UNAVAILABLE_MESSAGE);
    return;
  }

  if (response.status === 'queued') {
    if (previewUnavailableTabs.has(tabId)) {
      renderPreviewPlaceholder(PREVIEW_UNAVAILABLE_MESSAGE);
    } else {
      renderPreviewPlaceholder(PREVIEW_LOADING_MESSAGE, { loading: true });
    }
  }
}

function requestPreviewForTab(tab, { priority = false } = {}) {
  if (!previewEnabled || !tab || typeof tab.id !== 'number') {
    return;
  }

  chrome.runtime
    .sendMessage({
      type: PREVIEW_REQUEST_MESSAGE,
      tabId: tab.id,
      url: tab.url,
      priority,
    })
    .then((response) => {
      handlePreviewResponse(tab, response);
    })
    .catch(() => {
      if (previewUnavailableTabs.has(tab.id)) {
        renderPreviewPlaceholder(PREVIEW_UNAVAILABLE_MESSAGE);
      } else {
        renderPreviewPlaceholder(PREVIEW_LOADING_MESSAGE, { loading: true });
      }
    });
}

function handleTabHover(tab) {
  if (!previewEnabled || !tab || typeof tab.id !== 'number') {
    return;
  }

  activePreviewTabId = tab.id;

  postToParentMessage(PREVIEW_OVERLAY_VISIBILITY_MESSAGE, {
    visible: true,
  });

  const cached = previewCache[String(tab.id)];
  if (cached && typeof cached.image === 'string') {
    previewUnavailableTabs.delete(tab.id);
    schedulePreviewRender(cached, tab);
    requestPreviewForTab(tab, { priority: true });
    return;
  }

  if (previewUnavailableTabs.has(tab.id)) {
    renderPreviewPlaceholder(PREVIEW_UNAVAILABLE_MESSAGE);
  } else {
    renderPreviewPlaceholder(PREVIEW_LOADING_MESSAGE, { loading: true });
  }
  requestPreviewForTab(tab, { priority: true });
}

function handleTabLeave(tabId) {
  if (tabId !== activePreviewTabId) {
    return;
  }
  activePreviewTabId = null;

  postToParentMessage(PREVIEW_OVERLAY_VISIBILITY_MESSAGE, {
    visible: false,
  });

  if (previewEnabled) {
    renderPreviewPlaceholder(PREVIEW_DEFAULT_MESSAGE);
  } else {
    renderPreviewPlaceholder(PREVIEW_DISABLED_MESSAGE);
  }
}

function syncPreviewQueue(tabIds) {
  if (!previewEnabled || !Array.isArray(tabIds) || tabIds.length === 0) {
    return;
  }

  chrome.runtime.sendMessage({
    type: PREVIEW_SYNC_MESSAGE,
    tabIds,
  }).catch(() => {});
}

function applyPreviewSettings(enabled, { skipRefresh = false } = {}) {
  previewEnabled = Boolean(enabled);
  updatePreviewToggleUI();
  updatePreviewVisibility();
  if (!previewEnabled) {
    if (previewRenderTimeout) {
      clearTimeout(previewRenderTimeout);
      previewRenderTimeout = null;
    }
    activePreviewTabId = null;
    previewUnavailableTabs.clear();
  }
  if (previewEnabled && !skipRefresh) {
    refreshTabs();
  }
}

function getPropertyButton() {
  return document.getElementById(PROPERTY_BUTTON_ID);
}

function setPropertyButtonExpanded(expanded) {
  const button = getPropertyButton();
  if (!button) {
    return;
  }
  button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function handleKeydown(event) {
  if (event.key === 'Escape' && optionsViewOpen) {
    toggleOptionsView(false);
  }
}

function getOptionsView() {
  return document.getElementById(OPTIONS_VIEW_ID);
}

function getTabView() {
  return document.getElementById(TAB_VIEW_ID);
}

function applyOptionsViewState() {
  const tabView = getTabView();
  if (tabView) {
    tabView.hidden = optionsViewOpen;
    tabView.setAttribute('aria-hidden', optionsViewOpen ? 'true' : 'false');
  }

  const optionsView = getOptionsView();
  if (optionsView) {
    optionsView.hidden = !optionsViewOpen;
    optionsView.setAttribute('aria-hidden', optionsViewOpen ? 'false' : 'true');
  }

  setPropertyButtonExpanded(optionsViewOpen);
}

function toggleOptionsView(forceState) {
  const nextState =
    typeof forceState === 'boolean' ? forceState : !optionsViewOpen;
  if (nextState === optionsViewOpen) {
    return;
  }
  optionsViewOpen = nextState;
  applyOptionsViewState();
}

function handlePreviewToggleChange(event) {
  const nextValue = Boolean(event.target?.checked);
  applyPreviewSettings(nextValue);
  chrome.runtime
    .sendMessage({ type: PREVIEW_SET_ENABLED_MESSAGE, enabled: nextValue })
    .catch(() => {});
}

function setupOptionsControls() {
  const button = getPropertyButton();
  if (button) {
    setPropertyButtonExpanded(optionsViewOpen);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleOptionsView();
    });
  }

  const toggle = document.getElementById(PREVIEW_TOGGLE_ID);
  if (toggle) {
    toggle.addEventListener('change', handlePreviewToggleChange);
  }

  window.addEventListener('keydown', handleKeydown);

  applyOptionsViewState();
}

async function initializePreviewState() {
  try {
    const stored = await chrome.storage.local.get({
      [PREVIEW_ENABLED_STORAGE_KEY]: true,
      [PREVIEW_DATA_STORAGE_KEY]: {},
    });
    updatePreviewCacheFromStorage(stored[PREVIEW_DATA_STORAGE_KEY]);
    applyPreviewSettings(Boolean(stored[PREVIEW_ENABLED_STORAGE_KEY]), { skipRefresh: true });
  } catch (error) {
    previewCache = {};
    applyPreviewSettings(true, { skipRefresh: true });
  }

  if (previewEnabled) {
    renderPreviewPlaceholder(PREVIEW_DEFAULT_MESSAGE);
  } else {
    renderPreviewPlaceholder(PREVIEW_DISABLED_MESSAGE);
  }
}

async function refreshTabs() {
  const tabs = await chrome.tabs.query({});

  const list = document.getElementById('tab-list');
  list.innerHTML = '';

  const tabIdsForQueue = [];

  for (const tab of tabs) {
    if (typeof tab.id === 'number') {
      tabIdsForQueue.push(tab.id);
    }

    const li = document.createElement('li');
    li.className = 'tab-item';
    if (tab.active) {
      li.classList.add('is-active');
    }

    if (typeof tab.id === 'number') {
      li.dataset.tabId = String(tab.id);
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
        await chrome.tabs.remove(tab.id);
      } catch (error) {
        console.error('Failed to close tab:', error);
      }
    });

    li.appendChild(favicon);
    li.appendChild(content);
    li.appendChild(closeButton);
    li.title = fullTitle;

    li.addEventListener('mouseenter', () => {
      handleTabHover(tab);
    });

    li.addEventListener('mouseleave', () => {
      if (typeof tab.id === 'number') {
        handleTabLeave(tab.id);
      }
    });

    li.addEventListener('click', async () => {
      await chrome.tabs.update(tab.id, { active: true });
      if (typeof tab.windowId === 'number') {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    });

    list.appendChild(li);
  }

  syncPreviewQueue(tabIdsForQueue);
}

function attachEventListeners() {
  document.getElementById('close-btn').addEventListener('click', () => {
    window.parent.postMessage({ type: 'TabManagerClosePanel' }, '*');
    chrome.runtime.sendMessage({ type: 'TabManagerPanelClosedByUser' }).catch((error) => {
      console.error('Failed to notify background about panel close:', error);
    });
  });

  chrome.tabs.onActivated.addListener(refreshTabs);
  chrome.tabs.onCreated.addListener(refreshTabs);
  chrome.tabs.onRemoved.addListener(refreshTabs);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url) {
      refreshTabs();
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  setupOptionsControls();
  await initializePreviewState();
  attachEventListeners();
  setupHeaderBehavior();
  refreshTabs();
});

function setupHeaderBehavior() {
  const header = document.querySelector('header');
  if (!header) {
    return;
  }

  const updateHeaderState = () => {
    const shouldBeCompact = window.scrollY > 0;
    header.classList.toggle('is-compact', shouldBeCompact);
  };

  window.addEventListener('scroll', updateHeaderState, { passive: true });
  updateHeaderState();
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message?.type) {
    return;
  }

  if (message.type === PREVIEW_UPDATED_MESSAGE) {
    const tabId = message.tabId;
    const preview = message.preview;
    if (typeof tabId !== 'number' || !preview) {
      return;
    }

    previewCache[String(tabId)] = preview;
    previewUnavailableTabs.delete(tabId);

    if (!previewEnabled || tabId !== activePreviewTabId) {
      return;
    }

    const tabInfo = message.tabInfo && typeof message.tabInfo === 'object' ? message.tabInfo : null;
    if (tabInfo) {
      schedulePreviewRender(preview, { id: tabId, title: tabInfo.title, url: tabInfo.url });
      return;
    }

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (!tab || tab.id !== activePreviewTabId) {
          return;
        }
        schedulePreviewRender(preview, tab);
      })
      .catch(() => {});
  } else if (message.type === PREVIEW_REMOVED_MESSAGE) {
    const tabId = message.tabId;
    if (typeof tabId !== 'number') {
      return;
    }
    delete previewCache[String(tabId)];

    const reason = typeof message.reason === 'string' ? message.reason : '';
    previewUnavailableTabs.delete(tabId);
    if (reason === PREVIEW_REMOVAL_REASON_UNSUPPORTED) {
      previewUnavailableTabs.add(tabId);
    }

    if (tabId === activePreviewTabId) {
      if (reason === PREVIEW_REMOVAL_REASON_UNSUPPORTED) {
        renderPreviewPlaceholder(PREVIEW_UNAVAILABLE_MESSAGE);
        postToParentMessage(PREVIEW_OVERLAY_VISIBILITY_MESSAGE, { visible: true });
      } else {
        activePreviewTabId = null;
        postToParentMessage(PREVIEW_OVERLAY_VISIBILITY_MESSAGE, {
          visible: false,
          immediate: true,
        });
        renderPreviewPlaceholder(
          previewEnabled ? PREVIEW_DEFAULT_MESSAGE : PREVIEW_DISABLED_MESSAGE
        );
      }
    }
  }
});

window.addEventListener('beforeunload', () => {
  postToParentMessage(PREVIEW_OVERLAY_VISIBILITY_MESSAGE, { visible: false, immediate: true });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes) {
    return;
  }

  const previewEnabledChange = changes[PREVIEW_ENABLED_STORAGE_KEY];
  if (previewEnabledChange) {
    const newValue = Boolean(previewEnabledChange.newValue);
    if (newValue !== previewEnabled) {
      applyPreviewSettings(newValue);
    }
  }

  const previewDataChange = changes[PREVIEW_DATA_STORAGE_KEY];
  if (previewDataChange) {
    updatePreviewCacheFromStorage(previewDataChange.newValue);
    if (previewEnabled && activePreviewTabId != null) {
      const preview = previewCache[String(activePreviewTabId)];
      if (preview && typeof preview.image === 'string') {
        chrome.tabs
          .get(activePreviewTabId)
          .then((tab) => {
            if (!tab || tab.id !== activePreviewTabId) {
              return;
            }
            schedulePreviewRender(preview, tab);
          })
          .catch(() => {});
      }
    }
  }
});
