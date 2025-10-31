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
const GROUP_TABS_BY_DOMAIN_MESSAGE = 'TabManagerGroupTabsByDomain';
const PREVIEW_TOGGLE_ID = 'preview-toggle';
const PROPERTY_BUTTON_ID = 'property-btn';
const DOMAIN_GROUP_BUTTON_ID = 'domain-group-btn';
const DOMAIN_GROUP_MENU_ID = 'domain-group-menu';
const DOMAIN_GROUP_CONTAINER_ID = 'domain-group-container';
const DOMAIN_GROUP_SCOPE_CURRENT = 'current';
const DOMAIN_GROUP_SCOPE_ALL = 'all';
const TAB_VIEW_ID = 'tab-view';
const OPTIONS_VIEW_ID = 'options-view';
const PREVIEW_CACHE_CLEAR_BUTTON_ID = 'preview-cache-clear-btn';
const PREVIEW_CACHE_SIZE_ID = 'preview-cache-size';
const THEME_STORAGE_KEY = 'tabManagerTheme';
const THEME_SELECT_ID = 'theme-select';
const DEFAULT_THEME_ID = 'slate';
const GROUP_LABELS_STORAGE_KEY = 'tabManagerGroupLabels';
const SCROLL_POSITION_STORAGE_KEY = 'tabManagerScrollPosition';
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

const THEMES = {
  slate: {
    label: 'スレート',
    colorScheme: 'dark',
    properties: {
      '--tm-bg': '#202124',
      '--tm-header-bg': '#303134',
      '--tm-border': '#444',
      '--tm-divider': '#333',
      '--tm-hover-bg': '#3c4043',
      '--tm-active-bg': 'rgba(138, 180, 248, 0.18)',
      '--tm-text-primary': '#e8eaed',
      '--tm-text-muted': '#bdc1c6',
      '--tm-button-bg': '#3c4043',
      '--tm-button-border': '#5f6368',
      '--tm-button-hover-bg': '#4a4f54',
      '--tm-button-hover-border': '#8ab4f8',
      '--tm-icon-muted': '#a9a9a9',
      '--tm-overlay': 'rgba(255, 255, 255, 0.12)',
      '--tm-soft-overlay': 'rgba(255, 255, 255, 0.08)',
      '--tm-strong-overlay': 'rgba(255, 255, 255, 0.18)',
      '--tm-indicator-border': 'rgba(255, 255, 255, 0.15)',
      '--tm-accent': '#8ab4f8',
    },
  },
  ocean: {
    label: 'オーシャン',
    colorScheme: 'dark',
    properties: {
      '--tm-bg': '#16222b',
      '--tm-header-bg': '#1d2d38',
      '--tm-border': '#27465a',
      '--tm-divider': '#203648',
      '--tm-hover-bg': '#233848',
      '--tm-active-bg': 'rgba(94, 177, 255, 0.22)',
      '--tm-text-primary': '#f1f7ff',
      '--tm-text-muted': '#9fb6c8',
      '--tm-button-bg': '#22384a',
      '--tm-button-border': '#36566d',
      '--tm-button-hover-bg': '#29445a',
      '--tm-button-hover-border': '#5eb1ff',
      '--tm-icon-muted': '#9fb6c8',
      '--tm-overlay': 'rgba(94, 177, 255, 0.16)',
      '--tm-soft-overlay': 'rgba(94, 177, 255, 0.12)',
      '--tm-strong-overlay': 'rgba(94, 177, 255, 0.25)',
      '--tm-indicator-border': 'rgba(94, 177, 255, 0.35)',
      '--tm-accent': '#5eb1ff',
    },
  },
  rose: {
    label: 'ローズ',
    colorScheme: 'dark',
    properties: {
      '--tm-bg': '#2b1d27',
      '--tm-header-bg': '#3a2635',
      '--tm-border': '#523545',
      '--tm-divider': '#412d3b',
      '--tm-hover-bg': '#3b2838',
      '--tm-active-bg': 'rgba(255, 140, 188, 0.22)',
      '--tm-text-primary': '#f8e9f1',
      '--tm-text-muted': '#d9b7c9',
      '--tm-button-bg': '#3d2a3a',
      '--tm-button-border': '#63455a',
      '--tm-button-hover-bg': '#4a3347',
      '--tm-button-hover-border': '#ff8cbc',
      '--tm-icon-muted': '#cfa2b6',
      '--tm-overlay': 'rgba(255, 140, 188, 0.14)',
      '--tm-soft-overlay': 'rgba(255, 140, 188, 0.1)',
      '--tm-strong-overlay': 'rgba(255, 140, 188, 0.24)',
      '--tm-indicator-border': 'rgba(255, 140, 188, 0.28)',
      '--tm-accent': '#ff8cbc',
    },
  },
};

let previewEnabled = false;
let previewCache = {};
const previewUnavailableTabs = new Set();
let activePreviewTabId = null;
let previewRenderTimeout = null;
let optionsViewOpen = false;
let domainGroupingMenuOpen = false;
let currentThemeId = DEFAULT_THEME_ID;
let groupLabels = loadGroupLabelsFromStorage();
let storedScrollPosition = loadScrollPositionFromStorage();
let hasRestoredScrollPosition = false;
let pendingScrollSaveFrameId = null;

function notifyPanelClosed() {
  window.parent.postMessage({ type: 'TabManagerClosePanel' }, '*');
  chrome.runtime
    .sendMessage({ type: 'TabManagerPanelClosedByUser' })
    .catch((error) => {
      console.error('Failed to notify background about panel close:', error);
    });
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

function loadGroupLabelsFromStorage() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {};
  }

  try {
    const stored = window.localStorage.getItem(GROUP_LABELS_STORAGE_KEY);
    if (!stored) {
      return {};
    }
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const result = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        result[key] = value;
      }
    }
    return result;
  } catch (error) {
    console.error('Failed to load stored group labels:', error);
    return {};
  }
}

function persistGroupLabelsToStorage() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(
      GROUP_LABELS_STORAGE_KEY,
      JSON.stringify(groupLabels ?? {})
    );
  } catch (error) {
    console.error('Failed to persist group labels:', error);
  }
}

function getStoredGroupLabel(groupId) {
  if (!groupLabels || typeof groupLabels !== 'object') {
    return null;
  }
  const key = String(groupId);
  if (!Object.prototype.hasOwnProperty.call(groupLabels, key)) {
    return null;
  }
  return typeof groupLabels[key] === 'string' ? groupLabels[key] : null;
}

function setStoredGroupLabel(groupId, label) {
  const key = String(groupId);
  if (!groupLabels || typeof groupLabels !== 'object') {
    groupLabels = {};
  }

  groupLabels[key] = label;
  persistGroupLabelsToStorage();
}

function removeStoredGroupLabel(groupId) {
  if (!groupLabels || typeof groupLabels !== 'object') {
    return;
  }

  const key = String(groupId);
  if (Object.prototype.hasOwnProperty.call(groupLabels, key)) {
    delete groupLabels[key];
    persistGroupLabelsToStorage();
  }
}

function loadScrollPositionFromStorage() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return 0;
  }

  try {
    const stored = window.localStorage.getItem(SCROLL_POSITION_STORAGE_KEY);
    if (!stored) {
      return 0;
    }
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch (error) {
    console.error('Failed to load stored scroll position:', error);
    return 0;
  }
}

function persistScrollPositionToStorage(scrollTop) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  const normalized = Number.isFinite(scrollTop)
    ? Math.max(0, Math.round(scrollTop))
    : 0;

  try {
    window.localStorage.setItem(
      SCROLL_POSITION_STORAGE_KEY,
      String(normalized)
    );
    storedScrollPosition = normalized;
  } catch (error) {
    console.error('Failed to persist scroll position:', error);
  }
}

function getCurrentPanelScrollPosition() {
  if (typeof window === 'undefined') {
    return 0;
  }

  const doc = document.documentElement;
  const body = document.body;
  return (
    window.scrollY ||
    (doc && typeof doc.scrollTop === 'number' ? doc.scrollTop : 0) ||
    (body && typeof body.scrollTop === 'number' ? body.scrollTop : 0) ||
    0
  );
}

function scheduleScrollPositionSave() {
  if (pendingScrollSaveFrameId !== null) {
    return;
  }

  pendingScrollSaveFrameId = requestAnimationFrame(() => {
    pendingScrollSaveFrameId = null;
    persistScrollPositionToStorage(getCurrentPanelScrollPosition());
  });
}

function handlePanelScroll() {
  scheduleScrollPositionSave();
}

function restoreScrollPositionFromStorage() {
  if (hasRestoredScrollPosition) {
    return;
  }

  hasRestoredScrollPosition = true;
  const target = Number.isFinite(storedScrollPosition)
    ? Math.max(0, storedScrollPosition)
    : 0;

  requestAnimationFrame(() => {
    window.scrollTo({ top: target, behavior: 'auto' });
  });
}

function setupScrollPersistence() {
  if (typeof window === 'undefined') {
    return;
  }

  window.addEventListener('scroll', handlePanelScroll, { passive: true });
  window.addEventListener('beforeunload', () => {
    if (pendingScrollSaveFrameId !== null) {
      cancelAnimationFrame(pendingScrollSaveFrameId);
      pendingScrollSaveFrameId = null;
    }
    persistScrollPositionToStorage(getCurrentPanelScrollPosition());
  });
}

function extractDomainForGrouping(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(url);
    const protocol = (parsed.protocol || '').toLowerCase();

    if (!parsed.hostname) {
      return null;
    }

    if (
      protocol.startsWith('chrome') ||
      protocol.startsWith('edge') ||
      protocol.startsWith('about') ||
      protocol.startsWith('view-source') ||
      protocol.startsWith('devtools') ||
      protocol.startsWith('chrome-extension') ||
      protocol.startsWith('moz-extension') ||
      protocol.startsWith('file') ||
      protocol.startsWith('data')
    ) {
      return null;
    }

    return parsed.hostname.toLowerCase();
  } catch (error) {
    return null;
  }
}

function computeDefaultGroupLabel(groupId, groupInfo, tabs) {
  const infoTitle = (groupInfo?.title || '').trim();
  if (infoTitle) {
    return infoTitle;
  }

  if (Array.isArray(tabs) && tabs.length > 0) {
    const domainCounts = new Map();
    let hasDomainless = false;

    for (const tab of tabs) {
      const domain = extractDomainForGrouping(tab?.url);
      if (domain) {
        const nextCount = (domainCounts.get(domain) || 0) + 1;
        domainCounts.set(domain, nextCount);
      } else {
        hasDomainless = true;
      }
    }

    if (domainCounts.size === 1) {
      const [onlyDomain, count] = domainCounts.entries().next().value;
      if (count >= 2 && !hasDomainless) {
        return onlyDomain;
      }
    }

    return 'その他';
  }

  return `グループ ${groupId}`;
}

function resolveGroupDisplayLabel(groupId, groupInfo, tabs) {
  const storedLabel = getStoredGroupLabel(groupId);
  const defaultLabel = computeDefaultGroupLabel(groupId, groupInfo, tabs);
  const displayLabel = storedLabel != null ? storedLabel : defaultLabel;
  return { storedLabel, defaultLabel, displayLabel };
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

function updateAudioButtonState(button, { audible, muted }) {
  if (!button) {
    return;
  }

  const show = Boolean(audible || muted);
  if (!show) {
    button.hidden = true;
    button.dataset.muted = 'false';
    button.dataset.audible = 'false';
    return;
  }

  const nextMuted = Boolean(muted);
  const nextAudible = Boolean(audible);
  button.hidden = false;
  button.dataset.muted = nextMuted ? 'true' : 'false';
  button.dataset.audible = nextAudible ? 'true' : 'false';

  const label = nextMuted ? 'タブのミュートを解除' : 'タブをミュート';
  button.textContent = nextMuted ? '🔇' : '🔊';
  button.title = label;
  button.setAttribute('aria-label', label);
}

function createAudioButton(tab) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tab-audio-btn';

  updateAudioButtonState(button, {
    audible: Boolean(tab?.audible),
    muted: Boolean(tab?.mutedInfo?.muted),
  });

  if (typeof tab?.id === 'number') {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const currentMuted = button.dataset.muted === 'true';
      const currentAudible = button.dataset.audible === 'true';
      try {
        await chrome.tabs.update(tab.id, { muted: !currentMuted });
        updateAudioButtonState(button, { audible: currentAudible, muted: !currentMuted });
        refreshTabs();
      } catch (error) {
        console.error('Failed to toggle tab mute:', error);
      }
    });
  }

  return button;
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

function getResolvedTheme(themeId) {
  if (typeof themeId === 'string' && THEMES[themeId]) {
    return { id: themeId, definition: THEMES[themeId] };
  }
  return { id: DEFAULT_THEME_ID, definition: THEMES[DEFAULT_THEME_ID] };
}

function applyThemeStyles(themeId) {
  const { id, definition } = getResolvedTheme(themeId);
  const root = document.documentElement;
  if (!root || !definition) {
    return;
  }

  const properties = definition.properties || {};
  for (const [name, value] of Object.entries(properties)) {
    try {
      root.style.setProperty(name, value);
    } catch (error) {
      // ignore style assignment failures
    }
  }

  const scheme = definition.colorScheme || 'dark';
  try {
    root.style.setProperty('--tm-color-scheme', scheme);
    root.style.colorScheme = scheme;
  } catch (error) {
    // ignore color scheme assignment failures
  }

  root.setAttribute('data-tab-manager-theme', id);
  if (document.body) {
    document.body.setAttribute('data-tab-manager-theme', id);
  }
}

function getThemeSelect() {
  return document.getElementById(THEME_SELECT_ID);
}

function populateThemeSelectOptions(select) {
  if (!select) {
    return;
  }

  const options = Object.entries(THEMES);
  select.textContent = '';
  for (const [themeId, theme] of options) {
    const option = document.createElement('option');
    option.value = themeId;
    option.textContent = theme?.label || themeId;
    select.appendChild(option);
  }

  select.value = currentThemeId;
}

function updateThemeSelectUI() {
  const select = getThemeSelect();
  if (!select) {
    return;
  }
  if (select.value !== currentThemeId) {
    select.value = currentThemeId;
  }
}

function setTheme(themeId, { persist = true } = {}) {
  const { id } = getResolvedTheme(themeId);
  currentThemeId = id;
  applyThemeStyles(id);
  updateThemeSelectUI();

  if (!persist) {
    return;
  }

  try {
    if (chrome?.storage?.local?.set) {
      const result = chrome.storage.local.set({ [THEME_STORAGE_KEY]: id });
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    }
  } catch (error) {
    // ignore storage persistence failures
  }
}

function handleThemeSelectChange(event) {
  const nextThemeId = event?.target?.value;
  setTheme(nextThemeId);
}

async function initializeTheme() {
  if (!chrome?.storage?.local?.get) {
    setTheme(DEFAULT_THEME_ID, { persist: false });
    return;
  }

  try {
    const stored = await chrome.storage.local.get({
      [THEME_STORAGE_KEY]: DEFAULT_THEME_ID,
    });
    const storedId = stored?.[THEME_STORAGE_KEY];
    setTheme(typeof storedId === 'string' ? storedId : DEFAULT_THEME_ID, {
      persist: false,
    });
  } catch (error) {
    setTheme(DEFAULT_THEME_ID, { persist: false });
  }
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

  const audioButton = createAudioButton(tab);

  li.appendChild(favicon);
  li.appendChild(content);
  li.appendChild(audioButton);
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

function attachGroupTitleEditing(titleElement, { item, groupId, groupInfo, tabs }) {
  if (!titleElement) {
    return;
  }

  titleElement.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    beginGroupTitleEditing({
      item,
      groupId,
      groupInfo,
      tabs,
      currentElement: titleElement,
    });
  });
}

function finalizeGroupTitleEditing({
  item,
  groupId,
  groupInfo,
  tabs,
  input,
  commit,
  previousText,
}) {
  let nextLabel = previousText;

  if (commit) {
    const trimmed = input.value.trim();
    if (trimmed.length > 0) {
      setStoredGroupLabel(groupId, trimmed);
      nextLabel = trimmed;
    } else {
      removeStoredGroupLabel(groupId);
      nextLabel = computeDefaultGroupLabel(groupId, groupInfo, tabs) || '';
    }
  }

  const defaultLabel = computeDefaultGroupLabel(groupId, groupInfo, tabs) || '';
  item.dataset.defaultLabel = defaultLabel;

  const replacement = document.createElement('span');
  replacement.className = 'group-title';
  replacement.textContent = nextLabel;
  replacement.title = nextLabel;

  attachGroupTitleEditing(replacement, { item, groupId, groupInfo, tabs });

  input.replaceWith(replacement);
  item.classList.remove('group-item--editing');
}

function beginGroupTitleEditing({ item, groupId, groupInfo, tabs, currentElement }) {
  if (!item || !currentElement) {
    return;
  }

  const currentText = currentElement.textContent || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'group-title-input';
  input.value = currentText;
  input.setAttribute('aria-label', 'グループ名を編集');

  item.classList.add('group-item--editing');
  currentElement.replaceWith(input);

  let finished = false;
  const finalize = (commit) => {
    if (finished) {
      return;
    }
    finished = true;
    finalizeGroupTitleEditing({
      item,
      groupId,
      groupInfo,
      tabs,
      input,
      commit,
      previousText: currentText,
    });
  };

  input.addEventListener('blur', () => finalize(true));
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finalize(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finalize(false);
    }
  });

  input.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });

  input.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function createGroupAccordion(groupId, groupInfo, tabs) {
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return null;
  }

  const listId = `tab-group-${groupId}`;
  const expandedByDefault = groupInfo?.collapsed ? false : true;
  const { defaultLabel, displayLabel } = resolveGroupDisplayLabel(
    groupId,
    groupInfo,
    tabs
  );
  const color = resolveGroupColor(groupInfo?.color);

  const item = document.createElement('li');
  item.className = 'group-item';
  item.dataset.groupId = String(groupId);
  item.dataset.defaultLabel = defaultLabel || '';

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
  title.textContent = displayLabel;
  title.title = displayLabel;
  attachGroupTitleEditing(title, { item, groupId, groupInfo, tabs });

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

function getDomainGroupingButton() {
  return document.getElementById(DOMAIN_GROUP_BUTTON_ID);
}

function getDomainGroupingMenu() {
  return document.getElementById(DOMAIN_GROUP_MENU_ID);
}

function getDomainGroupingContainer() {
  return document.getElementById(DOMAIN_GROUP_CONTAINER_ID);
}

function positionDomainGroupingMenu() {
  const menu = getDomainGroupingMenu();
  const container = getDomainGroupingContainer();
  const panelShell = document.querySelector('.panel-shell');

  if (!menu || !container || !panelShell) {
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const panelRect = panelShell.getBoundingClientRect();

  menu.style.left = '50%';
  menu.style.right = 'auto';
  menu.style.transform = 'translateX(-50%)';
  menu.style.bottom = '';
  menu.style.top = `${container.offsetHeight + 4}px`;

  const menuRect = menu.getBoundingClientRect();

  let correction = 0;
  if (menuRect.left < panelRect.left) {
    correction = panelRect.left - menuRect.left;
  } else if (menuRect.right > panelRect.right) {
    correction = panelRect.right - menuRect.right;
  }

  if (correction !== 0) {
    menu.style.transform = `translateX(calc(-50% + ${correction}px))`;
  }

  if (menuRect.bottom > panelRect.bottom) {
    const spaceAbove = containerRect.top - panelRect.top;
    const spaceBelow = panelRect.bottom - containerRect.bottom;
    if (spaceAbove > spaceBelow) {
      menu.style.top = '';
      menu.style.bottom = `${container.offsetHeight + 4}px`;
    }
  }
}

function setDomainGroupingMenuOpen(open, { focusButton = false } = {}) {
  domainGroupingMenuOpen = Boolean(open);
  const button = getDomainGroupingButton();
  const menu = getDomainGroupingMenu();

  if (button) {
    button.setAttribute('aria-expanded', domainGroupingMenuOpen ? 'true' : 'false');
  }

  if (menu) {
    menu.hidden = !domainGroupingMenuOpen;
    if (domainGroupingMenuOpen) {
      requestAnimationFrame(() => {
        positionDomainGroupingMenu();
        const firstItem = menu.querySelector('.header-dropdown__item');
        if (firstItem) {
          firstItem.focus();
        }
      });
    } else if (focusButton && button) {
      requestAnimationFrame(() => {
        button.focus();
      });
    }
  }
}

function toggleDomainGroupingMenu(forceState, options = {}) {
  const nextState =
    typeof forceState === 'boolean' ? forceState : !domainGroupingMenuOpen;
  if (nextState === domainGroupingMenuOpen) {
    if (!nextState && options.focusButton) {
      const button = getDomainGroupingButton();
      if (button) {
        requestAnimationFrame(() => {
          button.focus();
        });
      }
    }
    return;
  }

  setDomainGroupingMenuOpen(nextState, options);
}

async function handleDomainGroupingOptionSelect(scope) {
  const normalizedScope =
    scope === DOMAIN_GROUP_SCOPE_CURRENT
      ? DOMAIN_GROUP_SCOPE_CURRENT
      : scope === DOMAIN_GROUP_SCOPE_ALL
      ? DOMAIN_GROUP_SCOPE_ALL
      : null;

  toggleDomainGroupingMenu(false, { focusButton: true });

  if (!normalizedScope) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: GROUP_TABS_BY_DOMAIN_MESSAGE,
      scope: normalizedScope,
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Grouping failed');
    }
  } catch (error) {
    console.error('Failed to group tabs by domain:', error);
  }
}

function setupDomainGroupingControls() {
  const container = getDomainGroupingContainer();
  const button = getDomainGroupingButton();
  const menu = getDomainGroupingMenu();

  if (!container || !button || !menu) {
    return;
  }

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const shouldOpen = !domainGroupingMenuOpen;
    toggleDomainGroupingMenu(shouldOpen, { focusButton: !shouldOpen });
  });

  document.addEventListener('click', (event) => {
    if (!domainGroupingMenuOpen) {
      return;
    }

    const containerElement = getDomainGroupingContainer();
    if (!containerElement) {
      toggleDomainGroupingMenu(false);
      return;
    }

    const target = event.target;
    if (!(target instanceof Node) || !containerElement.contains(target)) {
      toggleDomainGroupingMenu(false);
    }
  });

  menu.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const item = target.closest('.header-dropdown__item');
    if (!item) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const scope = item.dataset.scope;
    handleDomainGroupingOptionSelect(scope);
  });

  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && domainGroupingMenuOpen) {
      event.preventDefault();
      toggleDomainGroupingMenu(false, { focusButton: true });
    }
  });

  window.addEventListener('resize', () => {
    if (!domainGroupingMenuOpen) {
      return;
    }
    requestAnimationFrame(() => {
      positionDomainGroupingMenu();
    });
  });
}

function handleKeydown(event) {
  if (event.key !== 'Escape') {
    return;
  }

  if (domainGroupingMenuOpen) {
    toggleDomainGroupingMenu(false, { focusButton: true });
    event.stopPropagation();
    event.preventDefault();
    return;
  }

  if (optionsViewOpen) {
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
      if (domainGroupingMenuOpen) {
        toggleDomainGroupingMenu(false);
      }
      toggleOptionsView();
    });
  }

  const toggle = document.getElementById(PREVIEW_TOGGLE_ID);
  if (toggle) {
    toggle.addEventListener('change', handlePreviewToggleChange);
  }

  const themeSelect = getThemeSelect();
  if (themeSelect) {
    populateThemeSelectOptions(themeSelect);
    themeSelect.addEventListener('change', handleThemeSelectChange);
    updateThemeSelectUI();
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

  const list = document.getElementById('tab-list');
  if (!list) {
    return;
  }
  list.innerHTML = '';

  const tabIdsForQueue = [];

  const groupMap = new Map();
  const structure = [];

  for (const tab of tabs) {
    if (typeof tab.id === 'number') {
      tabIdsForQueue.push(tab.id);
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

  if (!hasRestoredScrollPosition) {
    restoreScrollPositionFromStorage();
  }
}

function attachEventListeners() {
  const closeButton = document.getElementById('close-btn');

  if (closeButton) {
    closeButton.addEventListener('click', notifyPanelClosed);
  }

  chrome.tabs.onActivated.addListener(refreshTabs);
  chrome.tabs.onCreated.addListener(refreshTabs);
  chrome.tabs.onRemoved.addListener(refreshTabs);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (
      changeInfo.status === 'complete' ||
      changeInfo.title ||
      changeInfo.url ||
      typeof changeInfo.audible === 'boolean' ||
      (changeInfo.mutedInfo && typeof changeInfo.mutedInfo.muted === 'boolean')
    ) {
      refreshTabs();
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await initializeTheme();
  setupDomainGroupingControls();
  setupOptionsControls();
  setupScrollPersistence();
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
