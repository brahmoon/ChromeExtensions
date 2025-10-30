const PREVIEW_ENABLED_STORAGE_KEY = 'tabManagerPreviewEnabled';
const PREVIEW_DATA_STORAGE_KEY = 'tabManagerPreviewData';
const PREVIEW_REQUEST_MESSAGE = 'TabManagerRequestPreview';
const PREVIEW_SYNC_MESSAGE = 'TabManagerSyncPreviewOrder';
const PREVIEW_SET_ENABLED_MESSAGE = 'TabManagerSetPreviewEnabled';
const PREVIEW_UPDATED_MESSAGE = 'TabManagerPreviewUpdated';
const PREVIEW_REMOVED_MESSAGE = 'TabManagerPreviewRemoved';
const PREVIEW_OVERLAY_UPDATE_MESSAGE = 'TabManagerPreviewOverlayUpdate';
const PREVIEW_OVERLAY_VISIBILITY_MESSAGE = 'TabManagerPreviewOverlayVisibility';
const PREVIEW_CLEAR_CACHE_MESSAGE = 'TabManagerClearPreviewCache';
const PREVIEW_TOGGLE_ID = 'preview-toggle';
const PROPERTY_BUTTON_ID = 'property-btn';
const TAB_VIEW_ID = 'tab-view';
const OPTIONS_VIEW_ID = 'options-view';
const PREVIEW_CACHE_CLEAR_BUTTON_ID = 'preview-cache-clear-btn';
const PREVIEW_CACHE_SIZE_ID = 'preview-cache-size';
const TAB_LIST_ID = 'tab-list';
const PREVIEW_DEFAULT_MESSAGE = 'タブをホバーしてプレビューを表示';
const PREVIEW_DISABLED_MESSAGE = '設定画面からプレビューを有効にしてください';
const PREVIEW_UNAVAILABLE_MESSAGE = 'このタブのプレビュー画像は利用できません';
const PREVIEW_REMOVAL_REASON_UNSUPPORTED = 'unsupported';
const PREVIEW_RENDER_THROTTLE_MS = 150;

const TAB_GROUP_COLORS = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#188038',
  pink: '#d81b60',
  purple: '#9334e6',
  cyan: '#12b5cb',
  orange: '#fa7b17',
};

let previewEnabled = false;
let previewCache = {};
const previewUnavailableTabs = new Set();
let activePreviewTabId = null;
let previewRenderTimeout = null;
let optionsViewOpen = false;

const tabListScrollState = {
  lastKnownScrollTop: 0,
  shouldCenterActiveTab: true,
};

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function getTabListElement() {
  return document.getElementById(TAB_LIST_ID);
}

function updateStoredTabListScroll(list = getTabListElement()) {
  if (!list) {
    return;
  }
  const maxScrollTop = Math.max(list.scrollHeight - list.clientHeight, 0);
  const currentScrollTop = clamp(list.scrollTop, 0, maxScrollTop);
  tabListScrollState.lastKnownScrollTop = currentScrollTop;
}

function setupTabListScrollPersistence() {
  const list = getTabListElement();
  if (!list || list.__tabManagerScrollSetup) {
    return;
  }

  list.addEventListener(
    'scroll',
    () => {
      updateStoredTabListScroll(list);
    },
    { passive: true }
  );

  list.__tabManagerScrollSetup = true;
}

function restoreTabListScrollPosition({ activeTabId } = {}) {
  const list = getTabListElement();
  if (!list) {
    return;
  }

  const containerHeight = list.clientHeight;
  const maxScrollTop = Math.max(list.scrollHeight - containerHeight, 0);
  let targetScrollTop = tabListScrollState.lastKnownScrollTop;

  if (tabListScrollState.shouldCenterActiveTab && activeTabId != null) {
    const activeElement = list.querySelector(
      `.tab-item[data-tab-id="${activeTabId}"]`
    );
    if (activeElement && containerHeight > 0) {
      const containerRect = list.getBoundingClientRect();
      const elementRect = activeElement.getBoundingClientRect();
      const offsetWithinContainer =
        elementRect.top - containerRect.top + list.scrollTop;
      const centeredTop =
        offsetWithinContainer - containerHeight / 2 + elementRect.height / 2;
      targetScrollTop = centeredTop;
    }
  }

  const clampedScrollTop = clamp(targetScrollTop, 0, maxScrollTop);
  list.scrollTop = clampedScrollTop;
  tabListScrollState.lastKnownScrollTop = clampedScrollTop;
  tabListScrollState.shouldCenterActiveTab = false;
}

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

function renderPreviewPlaceholder(message) {
  postToParentMessage(PREVIEW_OVERLAY_UPDATE_MESSAGE, {
    state: 'placeholder',
    message: typeof message === 'string' ? message : '',
  });
}

function resolveGroupColor(colorName) {
  if (typeof colorName !== 'string') {
    return TAB_GROUP_COLORS.grey;
  }
  return TAB_GROUP_COLORS[colorName] || TAB_GROUP_COLORS.grey;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function estimateBase64Size(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) {
    return 0;
  }
  const commaIndex = base64.indexOf(',');
  const raw = commaIndex >= 0 ? base64.slice(commaIndex + 1) : base64;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  const length = trimmed.length;
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

function calculatePreviewCacheSizeBytes(cache = previewCache) {
  if (!cache || typeof cache !== 'object') {
    return 0;
  }
  let total = 0;
  for (const value of Object.values(cache)) {
    if (value && typeof value.image === 'string') {
      total += estimateBase64Size(value.image);
    }
  }
  return total;
}

function updatePreviewCacheSizeDisplay() {
  const sizeElement = document.getElementById(PREVIEW_CACHE_SIZE_ID);
  const button = document.getElementById(PREVIEW_CACHE_CLEAR_BUTTON_ID);
  if (!sizeElement) {
    return;
  }
  const bytes = calculatePreviewCacheSizeBytes();
  sizeElement.textContent = formatBytes(bytes);
  if (button) {
    button.disabled = bytes === 0;
  }
}

function createTabListItem(tab) {
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
    try {
      await chrome.tabs.update(tab.id, { active: true });
      if (typeof tab.windowId === 'number') {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (error) {
      console.error('Failed to activate tab:', error);
    }
  });

  return li;
}

function createGroupAccordion(groupId, groupInfo, tabs) {
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return null;
  }

  const listId = `tab-group-${groupId}`;
  const containsActiveTab = tabs.some((tab) => Boolean(tab.active));
  const expandedByDefault = containsActiveTab ? true : groupInfo?.collapsed ? false : true;
  const titleText = (groupInfo?.title || '').trim() || `グループ ${groupId}`;
  const color = resolveGroupColor(groupInfo?.color);

  const item = document.createElement('li');
  item.className = 'group-item';
  item.dataset.groupId = String(groupId);

  const tabList = document.createElement('ul');
  tabList.className = 'group-tab-list';
  tabList.id = listId;
  tabList.hidden = !expandedByDefault;

  for (const tab of tabs) {
    tabList.appendChild(createTabListItem(tab));
  }

  const headerButton = document.createElement('button');
  headerButton.type = 'button';
  headerButton.className = 'group-header';
  headerButton.setAttribute('aria-expanded', expandedByDefault ? 'true' : 'false');
  headerButton.setAttribute('aria-controls', listId);

  const colorIndicator = document.createElement('span');
  colorIndicator.className = 'group-color-indicator';
  colorIndicator.style.backgroundColor = color;

  const title = document.createElement('span');
  title.className = 'group-title';
  title.textContent = titleText;

  const count = document.createElement('span');
  count.className = 'group-count';
  count.textContent = `(${tabs.length})`;

  headerButton.appendChild(colorIndicator);
  headerButton.appendChild(title);
  headerButton.appendChild(count);

  headerButton.addEventListener('click', () => {
    const expanded = headerButton.getAttribute('aria-expanded') === 'true';
    const nextExpanded = !expanded;
    headerButton.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
    tabList.hidden = !nextExpanded;
  });

  item.appendChild(headerButton);
  item.appendChild(tabList);
  return item;
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
    updatePreviewCacheSizeDisplay();
    return;
  }
  previewCache = { ...storageValue };
  previewUnavailableTabs.clear();
  updatePreviewCacheSizeDisplay();
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
    renderPreviewPlaceholder(PREVIEW_UNAVAILABLE_MESSAGE);
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
    updatePreviewCacheSizeDisplay();
    schedulePreviewRender(response.preview, tab);
    return;
  }

  if (response.status === 'unavailable') {
    previewUnavailableTabs.add(tabId);
    renderPreviewPlaceholder(PREVIEW_UNAVAILABLE_MESSAGE);
    return;
  }

  if (response.status === 'queued') {
    renderPreviewPlaceholder(PREVIEW_UNAVAILABLE_MESSAGE);
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
      renderPreviewPlaceholder(PREVIEW_UNAVAILABLE_MESSAGE);
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

  renderPreviewPlaceholder(PREVIEW_UNAVAILABLE_MESSAGE);
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

async function handlePreviewCacheClear(event) {
  const button = event?.currentTarget;
  if (!button || typeof button.disabled !== 'boolean') {
    return;
  }
  if (button.disabled) {
    return;
  }
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: PREVIEW_CLEAR_CACHE_MESSAGE });
    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to clear preview cache');
    }
  } catch (error) {
    console.error('Failed to clear preview cache:', error);
  } finally {
    updatePreviewCacheSizeDisplay();
  }
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

  const clearButton = document.getElementById(PREVIEW_CACHE_CLEAR_BUTTON_ID);
  if (clearButton) {
    clearButton.addEventListener('click', handlePreviewCacheClear);
    clearButton.disabled = calculatePreviewCacheSizeBytes() === 0;
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
    updatePreviewCacheSizeDisplay();
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

  const list = getTabListElement();
  if (!list) {
    return;
  }
  setupTabListScrollPersistence();
  updateStoredTabListScroll(list);
  list.innerHTML = '';

  const tabIdsForQueue = [];

  const groupMap = new Map();
  const structure = [];
  let activeTabId = null;

  for (const tab of tabs) {
    if (typeof tab.id === 'number') {
      tabIdsForQueue.push(tab.id);
      if (tab.active) {
        activeTabId = tab.id;
      }
    }

    if (typeof tab.groupId === 'number' && tab.groupId >= 0) {
      let groupEntry = groupMap.get(tab.groupId);
      if (!groupEntry) {
        groupEntry = { tabs: [], info: null };
        groupMap.set(tab.groupId, groupEntry);
        structure.push({ type: 'group', groupId: tab.groupId });
      }
      groupEntry.tabs.push(tab);
    } else {
      structure.push({ type: 'tab', tab });
    }
  }

  if (groupMap.size > 0 && chrome?.tabGroups?.get) {
    await Promise.all(
      Array.from(groupMap.entries()).map(async ([groupId, entry]) => {
        try {
          entry.info = await chrome.tabGroups.get(groupId);
        } catch (error) {
          console.debug('Failed to retrieve tab group info:', error);
          entry.info = null;
        }
      })
    );
  }

  for (const item of structure) {
    if (item.type === 'tab') {
      list.appendChild(createTabListItem(item.tab));
      continue;
    }

    if (item.type === 'group') {
      const entry = groupMap.get(item.groupId);
      if (!entry || entry.tabs.length === 0) {
        continue;
      }
      const groupElement = createGroupAccordion(item.groupId, entry.info, entry.tabs);
      if (groupElement) {
        list.appendChild(groupElement);
      } else {
        entry.tabs.forEach((tab) => {
          list.appendChild(createTabListItem(tab));
        });
      }
    }
  }

  syncPreviewQueue(tabIdsForQueue);

  requestAnimationFrame(() => {
    restoreTabListScrollPosition({ activeTabId });
  });
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
  setupTabListScrollPersistence();
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
    updatePreviewCacheSizeDisplay();
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
    updatePreviewCacheSizeDisplay();

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
