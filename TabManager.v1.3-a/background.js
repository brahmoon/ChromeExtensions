const PANEL_STATE_KEY = 'tabManagerPanelState';
const PANEL_SYNC_INDEX_KEY = 'tabManagerSync:index';
const PANEL_SYNC_ENTITY_PREFIX = 'tabManagerSyncEntity:';
const PANEL_SYNC_PANEL_STATE_ENTITY_ID = 'panelState';
const PANEL_SYNC_ACTIVE_TAB_ENTITY_ID = 'activeTab';
const PANEL_SYNC_TAB_LIST_ENTITY_ID = 'tabList';
const PREVIEW_ENABLED_STORAGE_KEY = 'tabManagerPreviewEnabled';
const PREVIEW_DATA_STORAGE_KEY = 'tabManagerPreviewData';
const PREVIEW_REQUEST_MESSAGE = 'TabManagerRequestPreview';
const PREVIEW_SYNC_MESSAGE = 'TabManagerSyncPreviewOrder';
const PREVIEW_SET_ENABLED_MESSAGE = 'TabManagerSetPreviewEnabled';
const PREVIEW_UPDATED_MESSAGE = 'TabManagerPreviewUpdated';
const PREVIEW_REMOVED_MESSAGE = 'TabManagerPreviewRemoved';
const PREVIEW_CLEAR_CACHE_MESSAGE = 'TabManagerClearPreviewCache';
const PREVIEW_CAPTURE_OPTIONS = { format: 'jpeg', quality: 45 };
const PREVIEW_QUEUE_DELAY_MS = 800;
const PREVIEW_RETRY_DELAY_MS = 4000;
const PREVIEW_POST_LOAD_CAPTURE_DELAY_MS = 350;
const PREVIEW_MAX_CACHE_ENTRIES = 40;
const PREVIEW_PROTOCOL_DENYLIST = [/^chrome:/i, /^edge:/i, /^about:/i, /^view-source:/i, /^devtools:/i];
const GROUP_TABS_BY_DOMAIN_MESSAGE = 'TabManagerGroupTabsByDomain';
const GROUP_SCOPE_CURRENT = 'current';
const GROUP_SCOPE_ALL = 'all';
const AUTO_DOMAIN_GROUP_STORAGE_KEY = 'tabManagerAutoDomainGrouping';
const PREVIEW_REMOVAL_REASON_UNSUPPORTED = 'unsupported';
const PREVIEW_REMOVAL_REASON_CLOSED = 'closed';
const PREVIEW_REMOVAL_REASON_REFRESHED = 'refreshed';
const PREVIEW_REMOVAL_REASON_CLEARED = 'cleared';

const panelStorageArea = chrome.storage.session ?? chrome.storage.local;

let panelState = {
  isOpen: false,
  tabId: null,
};

let panelStateReadyPromise = loadPanelState();
let panelSyncReadyPromise = initializePanelSyncState();
let previewEnabled = false;
const previewData = new Map();
const unavailablePreviews = new Set();
let previewQueue = [];
const previewQueueSet = new Set();
let previewProcessing = false;
const previewRetryTimeouts = new Map();
const activationCaptureTimeouts = new Map();
let previewStateReadyPromise = initializePreviewState();
let autoDomainGroupingEnabled = false;
const tabGroupIdCache = new Map();
const windowAutoDomainGroupingState = new Map();
const detachedTabSourceWindowState = new Map();
let tabListSyncSequence = 0;

async function warmTabGroupIdCache() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab || !Number.isFinite(tab.id)) {
        continue;
      }
      const groupId = Number.isFinite(tab.groupId) ? tab.groupId : -1;
      tabGroupIdCache.set(tab.id, groupId);
    }

  } catch (error) {
    console.debug('Failed to warm tab group cache:', error);
  }
}

async function syncTabGroupIdCacheForTabId(tabId) {
  if (!Number.isFinite(tabId)) {
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    const groupId = Number.isFinite(tab?.groupId) ? tab.groupId : -1;
    tabGroupIdCache.set(tabId, groupId);
  } catch (error) {
    tabGroupIdCache.delete(tabId);
  }
}

async function loadAutoDomainGroupingPreference() {
  try {
    const stored = await chrome.storage.local.get({
      [AUTO_DOMAIN_GROUP_STORAGE_KEY]: false,
    });
    autoDomainGroupingEnabled = Boolean(stored[AUTO_DOMAIN_GROUP_STORAGE_KEY]);
  } catch (error) {
    autoDomainGroupingEnabled = false;
  }
}

function setWindowAutoGroupingState(windowId, enabled) {
  if (!Number.isFinite(windowId)) {
    return;
  }
  windowAutoDomainGroupingState.set(windowId, Boolean(enabled));
}

function getWindowAutoGroupingState(windowId) {
  if (!Number.isFinite(windowId)) {
    return autoDomainGroupingEnabled;
  }
  if (windowAutoDomainGroupingState.has(windowId)) {
    return Boolean(windowAutoDomainGroupingState.get(windowId));
  }
  return autoDomainGroupingEnabled;
}

async function warmWindowAutoGroupingStateCache() {
  if (!chrome.windows?.getAll) {
    return;
  }

  try {
    const windows = await chrome.windows.getAll({ populate: false });
    if (!Array.isArray(windows)) {
      return;
    }

    for (const win of windows) {
      if (!Number.isFinite(win?.id)) {
        continue;
      }
      setWindowAutoGroupingState(win.id, autoDomainGroupingEnabled);
    }
  } catch (error) {
    console.debug('Failed to warm auto grouping window session cache:', error);
  }
}

loadAutoDomainGroupingPreference().catch(() => {});
warmWindowAutoGroupingStateCache().catch(() => {});
warmTabGroupIdCache().catch(() => {});

function getPanelSyncEntityKey(entityId) {
  return `${PANEL_SYNC_ENTITY_PREFIX}${entityId}`;
}

async function initializePanelSyncState() {
  try {
    const stored = await chrome.storage.local.get({
      [PANEL_SYNC_INDEX_KEY]: { ids: [] },
    });
    const current = stored[PANEL_SYNC_INDEX_KEY];
    const ids = Array.isArray(current?.ids) ? current.ids.filter((id) => typeof id === 'string' && id.length > 0) : [];
    const nextIds = [
      PANEL_SYNC_PANEL_STATE_ENTITY_ID,
      PANEL_SYNC_ACTIVE_TAB_ENTITY_ID,
      PANEL_SYNC_TAB_LIST_ENTITY_ID,
    ];

    const merged = { ids: [...new Set([...ids, ...nextIds])] };
    const hasDiff = merged.ids.length !== ids.length || merged.ids.some((id, index) => ids[index] !== id);
    if (hasDiff) {
      await chrome.storage.local.set({
        [PANEL_SYNC_INDEX_KEY]: merged,
      });
    }
  } catch (error) {
    console.error('Failed to initialise panel sync index:', error);
  }
}

async function ensurePanelSyncReady() {
  try {
    await panelSyncReadyPromise;
  } catch (error) {
    console.error('Panel sync initialization failed, retrying:', error);
    panelSyncReadyPromise = initializePanelSyncState();
    await panelSyncReadyPromise;
  }
}

async function persistSyncEntity(entityId, value) {
  await ensurePanelSyncReady();
  await chrome.storage.local.set({
    [getPanelSyncEntityKey(entityId)]: value,
  });
}

function toSyncTabInfo(tab) {
  if (!tab || !Number.isFinite(tab.id)) {
    return null;
  }

  return {
    id: tab.id,
    windowId: Number.isFinite(tab.windowId) ? tab.windowId : null,
    active: Boolean(tab.active),
    title: typeof tab.title === 'string' ? tab.title : '',
    url: typeof tab.url === 'string' ? tab.url : '',
    pinned: Boolean(tab.pinned),
    groupId: Number.isFinite(tab.groupId) ? tab.groupId : -1,
    audible: Boolean(tab.audible),
    muted: Boolean(tab.mutedInfo?.muted),
    discarded: Boolean(tab.discarded),
    status: typeof tab.status === 'string' ? tab.status : 'unknown',
    favIconUrl: typeof tab.favIconUrl === 'string' ? tab.favIconUrl : '',
  };
}

async function persistActiveTabSyncEntity(tabId, reason) {
  const payload = {
    tabId: Number.isFinite(tabId) ? tabId : null,
    reason: typeof reason === 'string' ? reason : 'unknown',
    updatedAt: Date.now(),
  };
  await persistSyncEntity(PANEL_SYNC_ACTIVE_TAB_ENTITY_ID, payload);
}

async function persistTabListSyncEntity(reason) {
  const syncSequence = ++tabListSyncSequence;

  try {
    const tabs = await chrome.tabs.query({});
    if (syncSequence !== tabListSyncSequence) {
      return;
    }

    const syncTabs = tabs.map(toSyncTabInfo).filter(Boolean);
    await persistSyncEntity(PANEL_SYNC_TAB_LIST_ENTITY_ID, {
      tabs: syncTabs,
      reason: typeof reason === 'string' ? reason : 'unknown',
      updatedAt: Date.now(),
      sequence: syncSequence,
    });
  } catch (error) {
    console.error('Failed to persist synchronized tab list:', error);
  }
}

async function loadPanelState() {
  try {
    const stored = await panelStorageArea.get({
      [PANEL_STATE_KEY]: {
        isOpen: false,
        tabId: null,
      },
    });

    const value = stored[PANEL_STATE_KEY];
    if (value && typeof value === 'object') {
      panelState = {
        isOpen: Boolean(value.isOpen),
        tabId: typeof value.tabId === 'number' ? value.tabId : null,
      };
    } else {
      panelState = { isOpen: false, tabId: null };
    }
  } catch (error) {
    console.error('Failed to load panel state:', error);
    panelState = { isOpen: false, tabId: null };
  }
}

async function ensurePanelStateReady() {
  try {
    await panelStateReadyPromise;
  } catch (error) {
    console.error('Panel state initialization failed, retrying:', error);
    panelStateReadyPromise = loadPanelState();
    await panelStateReadyPromise;
  }
}

async function persistPanelState() {
  try {
    const payload = {
      isOpen: panelState.isOpen,
      tabId: panelState.tabId,
      updatedAt: Date.now(),
    };

    await panelStorageArea.set({
      [PANEL_STATE_KEY]: {
        isOpen: payload.isOpen,
        tabId: payload.tabId,
      },
    });

    await persistSyncEntity(PANEL_SYNC_PANEL_STATE_ENTITY_ID, payload);
  } catch (error) {
    console.error('Failed to persist panel state:', error);
  }
}

function updatePanelState(partial) {
  panelState = {
    ...panelState,
    ...partial,
  };

  persistPanelState().catch((error) => {
    console.error('Unexpected error while saving panel state:', error);
  });
}

async function initializePreviewState() {
  try {
    const stored = await chrome.storage.local.get({
      [PREVIEW_ENABLED_STORAGE_KEY]: true,
      [PREVIEW_DATA_STORAGE_KEY]: {},
    });

    previewEnabled = Boolean(stored[PREVIEW_ENABLED_STORAGE_KEY]);

    previewData.clear();
    unavailablePreviews.clear();
    const storedData = stored[PREVIEW_DATA_STORAGE_KEY];
    if (storedData && typeof storedData === 'object') {
      for (const [key, value] of Object.entries(storedData)) {
        const tabId = Number(key);
        if (!Number.isFinite(tabId)) {
          continue;
        }
        if (!value || typeof value !== 'object' || typeof value.image !== 'string') {
          continue;
        }
        previewData.set(tabId, {
          image: value.image,
          url: typeof value.url === 'string' ? value.url : '',
          title: typeof value.title === 'string' ? value.title : '',
          capturedAt: Number.isFinite(value.capturedAt) ? Number(value.capturedAt) : Date.now(),
        });
      }
    }

    if (previewEnabled) {
      queueAllOpenTabs({ prioritizeActive: true }).catch((error) => {
        console.error('Failed to enqueue initial previews:', error);
      });
    }
  } catch (error) {
    console.error('Failed to initialise preview state:', error);
    previewEnabled = true;
    previewData.clear();
    queueAllOpenTabs({ prioritizeActive: true }).catch((queueError) => {
      console.error('Failed to enqueue previews after state fallback:', queueError);
    });
  }
}

async function ensurePreviewStateReady() {
  try {
    await previewStateReadyPromise;
  } catch (error) {
    console.error('Preview state initialisation failed, retrying:', error);
    previewStateReadyPromise = initializePreviewState();
    await previewStateReadyPromise;
  }
}

async function persistPreviewEnabled() {
  try {
    await chrome.storage.local.set({
      [PREVIEW_ENABLED_STORAGE_KEY]: previewEnabled,
    });
  } catch (error) {
    console.error('Failed to persist preview preference:', error);
  }
}

function getPreviewStorageObject() {
  const result = {};
  for (const [tabId, data] of previewData.entries()) {
    if (!data || typeof data !== 'object' || typeof data.image !== 'string') {
      continue;
    }
    result[String(tabId)] = {
      image: data.image,
      url: typeof data.url === 'string' ? data.url : '',
      title: typeof data.title === 'string' ? data.title : '',
      capturedAt: Number.isFinite(data.capturedAt) ? Number(data.capturedAt) : Date.now(),
    };
  }
  return result;
}

async function persistPreviewData() {
  try {
    await chrome.storage.local.set({
      [PREVIEW_DATA_STORAGE_KEY]: getPreviewStorageObject(),
    });
  } catch (error) {
    console.error('Failed to persist preview data:', error);
  }
}

function clearPreviewRetry(tabId) {
  const timeout = previewRetryTimeouts.get(tabId);
  if (timeout) {
    clearTimeout(timeout);
    previewRetryTimeouts.delete(tabId);
  }
}

function clearActivationCaptureTimeout(tabId) {
  const timeout = activationCaptureTimeouts.get(tabId);
  if (!timeout) {
    return;
  }
  clearTimeout(timeout);
  activationCaptureTimeouts.delete(tabId);
}

function clearAllActivationCaptureTimeouts() {
  activationCaptureTimeouts.forEach((timeout) => clearTimeout(timeout));
  activationCaptureTimeouts.clear();
}

function scheduleActivationCapture(tabId, { delay = PREVIEW_POST_LOAD_CAPTURE_DELAY_MS } = {}) {
  if (!previewEnabled || typeof tabId !== 'number') {
    return;
  }

  clearActivationCaptureTimeout(tabId);

  const timeout = setTimeout(async () => {
    activationCaptureTimeouts.delete(tabId);
    if (!previewEnabled) {
      return;
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      if (
        !tab ||
        !tab.active ||
        tab.status !== 'complete' ||
        shouldSkipPreviewForUrl(tab.url) ||
        tab.discarded
      ) {
        return;
      }
    } catch (error) {
      const message = error?.message || '';
      if (!message.includes('No tab with id') && !message.includes('The tab was closed')) {
        console.debug('Failed to confirm tab before activation capture:', error);
      }
      return;
    }

    enqueuePreview(tabId, { priority: true });
  }, Math.max(0, Number.isFinite(delay) ? delay : 0));

  activationCaptureTimeouts.set(tabId, timeout);
}

async function handleActiveTabPreviewOnActivation(tabId) {
  if (!previewEnabled || typeof tabId !== 'number') {
    return;
  }

  clearActivationCaptureTimeout(tabId);

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    const message = error?.message || '';
    if (!message.includes('No tab with id') && !message.includes('The tab was closed')) {
      console.debug('Failed to retrieve tab for activation preview:', error);
    }
    return;
  }

  if (!tab || tab.id !== tabId || shouldSkipPreviewForUrl(tab.url) || tab.discarded) {
    return;
  }

  if (tab.status === 'complete') {
    scheduleActivationCapture(tabId);
  }
}

function notifyPreviewUpdated(tabId, preview, tab) {
  if (!preview || typeof preview.image !== 'string') {
    return;
  }

  chrome.runtime
    .sendMessage({
      type: PREVIEW_UPDATED_MESSAGE,
      tabId,
      preview,
      tabInfo: {
        title: tab?.title || '',
        url: tab?.url || '',
      },
    })
    .catch(() => {});
}

function notifyPreviewRemoved(tabId, reason) {
  chrome.runtime
    .sendMessage({
      type: PREVIEW_REMOVED_MESSAGE,
      tabId,
      reason: typeof reason === 'string' ? reason : undefined,
    })
    .catch(() => {});
}

function trimPreviewCache(limit = PREVIEW_MAX_CACHE_ENTRIES) {
  if (previewData.size <= limit) {
    return [];
  }

  const entries = Array.from(previewData.entries()).sort((a, b) => {
    const aTime = Number.isFinite(a[1]?.capturedAt) ? Number(a[1].capturedAt) : 0;
    const bTime = Number.isFinite(b[1]?.capturedAt) ? Number(b[1].capturedAt) : 0;
    return aTime - bTime;
  });

  const removed = [];
  while (entries.length > limit) {
    const [tabId] = entries.shift();
    if (previewData.delete(tabId)) {
      unavailablePreviews.delete(tabId);
      removed.push(tabId);
    }
  }

  return removed;
}

async function recordPreview(tabId, tab, image) {
  unavailablePreviews.delete(tabId);
  const preview = {
    image,
    url: tab?.url || '',
    title: tab?.title || '',
    capturedAt: Date.now(),
  };

  previewData.set(tabId, preview);
  const removed = trimPreviewCache();
  if (removed.length > 0) {
    removed.forEach((id) => {
      clearPreviewRetry(id);
      notifyPreviewRemoved(id);
    });
  }

  await persistPreviewData();
  notifyPreviewUpdated(tabId, preview, tab);
}

async function removePreview(tabId, { reason } = {}) {
  clearActivationCaptureTimeout(tabId);
  const hadPreview = previewData.delete(tabId);
  if (reason === PREVIEW_REMOVAL_REASON_UNSUPPORTED) {
    unavailablePreviews.add(tabId);
  } else if (reason) {
    unavailablePreviews.delete(tabId);
  }

  clearPreviewRetry(tabId);
  previewQueue = previewQueue.filter((id) => id !== tabId);
  previewQueueSet.delete(tabId);

  if (hadPreview) {
    await persistPreviewData();
  }

  if (hadPreview || reason) {
    notifyPreviewRemoved(tabId, reason);
  }
}

async function clearPreviewCache() {
  if (previewData.size === 0) {
    return { cleared: 0 };
  }

  const removedTabIds = Array.from(previewData.keys());
  previewQueue = [];
  previewQueueSet.clear();
  previewRetryTimeouts.forEach((timeout) => clearTimeout(timeout));
  previewRetryTimeouts.clear();
  unavailablePreviews.clear();
  previewData.clear();
  await persistPreviewData();

  removedTabIds.forEach((tabId) => {
    notifyPreviewRemoved(tabId, PREVIEW_REMOVAL_REASON_CLEARED);
  });

  if (previewEnabled) {
    queueAllOpenTabs({ prioritizeActive: true }).catch((error) => {
      console.error('Failed to enqueue previews after cache clear:', error);
    });
    processPreviewQueue().catch((error) => {
      console.error('Failed to restart preview queue after cache clear:', error);
    });
  }

  return { cleared: removedTabIds.length };
}

function shouldSkipPreviewForUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return true;
  }
  return PREVIEW_PROTOCOL_DENYLIST.some((pattern) => pattern.test(url));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cropPreviewImageToViewportLeftArea(imageDataUrl) {
  if (typeof imageDataUrl !== 'string' || imageDataUrl.length === 0) {
    return imageDataUrl;
  }

  const panelWidth = 400;

  try {
    const response = await fetch(imageDataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    const cropWidth = Math.max(1, bitmap.width - panelWidth);
    if (cropWidth >= bitmap.width) {
      bitmap.close();
      return imageDataUrl;
    }

    const canvas = new OffscreenCanvas(cropWidth, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return imageDataUrl;
    }

    ctx.drawImage(bitmap, 0, 0, cropWidth, bitmap.height, 0, 0, cropWidth, bitmap.height);
    bitmap.close();
    const croppedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : imageDataUrl);
      reader.onerror = () => reject(reader.error || new Error('Failed to read preview blob.'));
      reader.readAsDataURL(croppedBlob);
    });

    return typeof dataUrl === 'string' && dataUrl.length > 0 ? dataUrl : imageDataUrl;
  } catch (error) {
    console.debug('Failed to crop preview image:', error);
    return imageDataUrl;
  }
}

function moveTabToQueueFront(tabId) {
  const index = previewQueue.indexOf(tabId);
  if (index > 0) {
    previewQueue.splice(index, 1);
    previewQueue.unshift(tabId);
  }
}

function schedulePreviewRetry(tabId) {
  if (previewRetryTimeouts.has(tabId) || !previewEnabled) {
    return;
  }

  const timeout = setTimeout(() => {
    previewRetryTimeouts.delete(tabId);
    if (!previewEnabled) {
      return;
    }
    enqueuePreview(tabId);
  }, PREVIEW_RETRY_DELAY_MS);

  previewRetryTimeouts.set(tabId, timeout);
}

async function capturePreviewForTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) {
      await removePreview(tabId, { reason: PREVIEW_REMOVAL_REASON_CLOSED });
      return 'removed';
    }

    if (shouldSkipPreviewForUrl(tab.url) || tab.discarded) {
      await removePreview(tabId, { reason: PREVIEW_REMOVAL_REASON_UNSUPPORTED });
      return 'removed';
    }

    if (tab.status === 'loading') {
      return 'retry';
    }

    if (!tab.active) {
      return 'inactive';
    }

    let image;
    let captureError = null;
    try {
      image = await chrome.tabs.captureVisibleTab(tab.windowId, PREVIEW_CAPTURE_OPTIONS);
      image = await cropPreviewImageToViewportLeftArea(image);
    } catch (error) {
      captureError = error;
    }

    if (captureError) {
      const captureMessage = String(captureError?.message || '');
      if (!captureMessage.includes('No active tab')) {
        console.error('Failed to capture preview:', captureError);
      }
      const lowerMessage = captureMessage.toLowerCase();
      if (
        lowerMessage.includes('permission') &&
        (lowerMessage.includes('required') || lowerMessage.includes('activetab'))
      ) {
        await removePreview(tabId, { reason: PREVIEW_REMOVAL_REASON_UNSUPPORTED });
        return 'removed';
      }
      return 'retry';
    }

    if (typeof image !== 'string' || image.length === 0) {
      return 'retry';
    }

    await recordPreview(tabId, tab, image);
    return 'success';
  } catch (error) {
    const message = error?.message || '';
    if (message.includes('No tab with id') || message.includes('The tab was closed')) {
      await removePreview(tabId, { reason: PREVIEW_REMOVAL_REASON_CLOSED });
      return 'removed';
    }
    console.error('Unexpected error during preview capture:', error);
    return 'retry';
  }
}

function enqueuePreview(tabId, { priority = false } = {}) {
  if (!previewEnabled || typeof tabId !== 'number') {
    return;
  }

  clearPreviewRetry(tabId);

  if (previewQueueSet.has(tabId)) {
    if (priority) {
      moveTabToQueueFront(tabId);
    }
    processPreviewQueue().catch((error) => {
      console.error('Failed to process preview queue:', error);
    });
    return;
  }

  if (priority) {
    previewQueue.unshift(tabId);
  } else {
    previewQueue.push(tabId);
  }
  previewQueueSet.add(tabId);

  processPreviewQueue().catch((error) => {
    console.error('Failed to start preview queue:', error);
  });
}

async function processPreviewQueue() {
  await ensurePreviewStateReady();
  if (!previewEnabled || previewProcessing) {
    return;
  }

  previewProcessing = true;

  try {
    while (previewEnabled && previewQueue.length > 0) {
      const tabId = previewQueue.shift();
      previewQueueSet.delete(tabId);

      const result = await capturePreviewForTab(tabId);
      if (previewEnabled && result === 'retry') {
        schedulePreviewRetry(tabId);
      }

      if (previewQueue.length > 0) {
        await delay(PREVIEW_QUEUE_DELAY_MS);
      }
    }
  } catch (error) {
    console.error('Preview queue processing error:', error);
  } finally {
    previewProcessing = false;
    if (previewEnabled && previewQueue.length > 0) {
      setTimeout(() => {
        processPreviewQueue().catch((queueError) => {
          console.error('Failed to resume preview queue:', queueError);
        });
      }, PREVIEW_QUEUE_DELAY_MS);
    }
  }
}

async function queueAllOpenTabs({ prioritizeActive = false } = {}) {
  if (!previewEnabled) {
    return;
  }

  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (error) {
    console.error('Failed to query tabs for preview queue:', error);
    return;
  }

  for (const tab of tabs) {
    if (typeof tab?.id !== 'number') {
      continue;
    }

    if (shouldSkipPreviewForUrl(tab.url)) {
      await removePreview(tab.id, { reason: PREVIEW_REMOVAL_REASON_UNSUPPORTED });
      continue;
    }

    if (!tab.active) {
      continue;
    }

    if (tab.status === 'complete') {
      scheduleActivationCapture(tab.id);
    }
  }
}

function syncPreviewOrder(tabIds) {
  if (!previewEnabled || !Array.isArray(tabIds)) {
    return;
  }

  const normalised = tabIds.filter((id) => typeof id === 'number');
  if (normalised.length === 0) {
    return;
  }

  const existingQueue = previewQueue.slice();
  const existingQueueSet = new Set(existingQueue);
  previewQueue = [];
  previewQueueSet.clear();

  for (const tabId of normalised) {
    if (!existingQueueSet.has(tabId)) {
      continue;
    }
    if (!previewQueueSet.has(tabId)) {
      previewQueue.push(tabId);
      previewQueueSet.add(tabId);
    }
  }

  for (const tabId of existingQueue) {
    if (!previewQueueSet.has(tabId)) {
      previewQueue.push(tabId);
      previewQueueSet.add(tabId);
    }
  }

  processPreviewQueue().catch((error) => {
    console.error('Failed to process preview queue after sync:', error);
  });
}

async function setPreviewEnabled(enabled) {
  await ensurePreviewStateReady();
  const nextValue = Boolean(enabled);
  if (previewEnabled === nextValue) {
    return;
  }
  previewEnabled = nextValue;
  await persistPreviewEnabled();
  if (!previewEnabled) {
    previewQueue = [];
    previewQueueSet.clear();
    previewProcessing = false;
    previewRetryTimeouts.forEach((timeout) => clearTimeout(timeout));
    previewRetryTimeouts.clear();
    clearAllActivationCaptureTimeouts();
    unavailablePreviews.clear();
    return;
  }

  queueAllOpenTabs({ prioritizeActive: true }).catch((error) => {
    console.error('Failed to enqueue previews after enabling:', error);
  });
  processPreviewQueue().catch((error) => {
    console.error('Failed to start preview queue after enabling:', error);
  });
}

async function sendPanelCommand(tabId, type) {
  if (typeof tabId !== 'number') {
    return false;
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type });
    return true;
  } catch (error) {
    const message = error?.message || '';
    if (message.includes('Could not establish connection')) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js'],
        });
        await chrome.tabs.sendMessage(tabId, { type });
        return true;
      } catch (injectError) {
        console.error('Failed to inject content script for panel command:', injectError);
      }
      return false;
    }

    if (!message.includes('No tab with id') && !message.includes('The tab was closed')) {
      console.error('Failed to deliver panel command:', error);
    }

    return false;
  }
}

async function closePanelOnTab(tabId, updateState = true) {
  await ensurePanelStateReady();
  const success = await sendPanelCommand(tabId, 'closePanel');
  if (success && updateState && panelState.tabId === tabId) {
    updatePanelState({ isOpen: false, tabId: null });
  }
  return success;
}

async function openPanelOnTab(tabId) {
  await ensurePanelStateReady();
  if (panelState.tabId && panelState.tabId !== tabId) {
    await closePanelOnTab(panelState.tabId, false);
  }

  const success = await sendPanelCommand(tabId, 'openPanel');
  if (success) {
    updatePanelState({ isOpen: true, tabId });
  }

  return success;
}

async function syncPanelRuntimeState(reason) {
  await Promise.all([ensurePanelSyncReady(), ensurePanelStateReady()]);

  await persistSyncEntity(PANEL_SYNC_PANEL_STATE_ENTITY_ID, {
    isOpen: panelState.isOpen,
    tabId: panelState.tabId,
    reason: typeof reason === 'string' ? reason : 'unknown',
    updatedAt: Date.now(),
  });

  await persistTabListSyncEntity(reason);
}

async function handoffPanelToTab(nextTabId) {
  if (!panelState.isOpen || !Number.isFinite(nextTabId)) {
    return;
  }

  if (panelState.tabId === nextTabId) {
    return;
  }

  const opened = await openPanelOnTab(nextTabId);
  if (!opened) {
    return;
  }

  await syncPanelRuntimeState('activeTabHandoff');
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await Promise.all([ensurePreviewStateReady(), ensurePanelStateReady()]);

  if (previewEnabled) {
    await handleActiveTabPreviewOnActivation(tabId);
  }

  await persistActiveTabSyncEntity(tabId, 'activated');
  await syncTabGroupIdCacheForTabId(tabId);
  await handoffPanelToTab(tabId);
  await persistTabListSyncEntity('activated');
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  tabGroupIdCache.delete(tabId);

  await Promise.all([ensurePanelStateReady(), ensurePreviewStateReady()]);

  if (panelState.tabId === tabId) {
    updatePanelState({ tabId: null });
  }

  if (removeInfo && Number.isFinite(removeInfo.windowId) && !removeInfo.isWindowClosing) {
    await rebalanceSingletonDomainGroupsInWindow(removeInfo.windowId);
  }

  await removePreview(tabId, { reason: PREVIEW_REMOVAL_REASON_CLOSED });
  await syncPanelRuntimeState('removed');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ensurePreviewStateReady();

  if (changeInfo.url || changeInfo.status || changeInfo.audible != null || changeInfo.pinned != null || changeInfo.title) {
    persistTabListSyncEntity('updated').catch(() => {});
  }

  if (tab && Number.isFinite(tab.id)) {
    tabGroupIdCache.set(tab.id, Number.isFinite(tab.groupId) ? tab.groupId : -1);
  }

  if (!previewEnabled) {
    return;
  }

  if (changeInfo.url) {
    await removePreview(tabId, { reason: PREVIEW_REMOVAL_REASON_REFRESHED });
  }

  if (changeInfo.status === 'loading') {
    clearActivationCaptureTimeout(tabId);
  }

  if (tab && tab.active && changeInfo.status === 'complete') {
    scheduleActivationCapture(tabId);
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab && Number.isFinite(tab.id)) {
    tabGroupIdCache.set(tab.id, Number.isFinite(tab.groupId) ? tab.groupId : -1);
  }

  if (tab && Number.isFinite(tab.windowId) && !windowAutoDomainGroupingState.has(tab.windowId)) {
    setWindowAutoGroupingState(tab.windowId, autoDomainGroupingEnabled);
  }

  autoGroupTabByDomain(tab, { requireActiveContext: false }).catch(() => {});
  persistTabListSyncEntity('created').catch(() => {});
});

chrome.tabs.onMoved.addListener((tabId) => {
  syncTabGroupIdCacheForTabId(tabId).catch(() => {});
  persistTabListSyncEntity('moved').catch(() => {});
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  syncTabGroupIdCacheForTabId(tabId).catch(() => {});

  (async () => {
    const newWindowId = Number.isFinite(attachInfo?.newWindowId) ? attachInfo.newWindowId : null;
    const sourceWindowState = detachedTabSourceWindowState.get(tabId);
    detachedTabSourceWindowState.delete(tabId);

    if (Number.isFinite(newWindowId)) {
      const inheritedState =
        typeof sourceWindowState === 'boolean'
          ? sourceWindowState
          : autoDomainGroupingEnabled;

      if (!windowAutoDomainGroupingState.has(newWindowId)) {
        setWindowAutoGroupingState(newWindowId, inheritedState);
      }

      if (getWindowAutoGroupingState(newWindowId)) {
        await groupTabsByDomain({
          scope: GROUP_SCOPE_CURRENT,
          windowId: newWindowId,
        });
        await rebalanceSingletonDomainGroupsInWindow(newWindowId);
      }
    }

    await persistTabListSyncEntity('attached');
  })().catch(() => {});
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  syncTabGroupIdCacheForTabId(tabId).catch(() => {});

  if (Number.isFinite(detachInfo?.oldWindowId)) {
    const oldWindowId = detachInfo.oldWindowId;
    detachedTabSourceWindowState.set(tabId, getWindowAutoGroupingState(oldWindowId));

    if (getWindowAutoGroupingState(oldWindowId)) {
      rebalanceSingletonDomainGroupsInWindow(oldWindowId).catch(() => {});
    }

    setTimeout(() => {
      detachedTabSourceWindowState.delete(tabId);
    }, 60000);
  }

  persistTabListSyncEntity('detached').catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab) {
    return;
  }

  const shouldEvaluateGrouping = Boolean(changeInfo.url) || changeInfo.status === 'complete';
  if (!shouldEvaluateGrouping) {
    return;
  }

  autoGroupTabByDomain(tab, { requireActiveContext: false }).catch(() => {});
});

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

    const hostname = parsed.hostname.toLowerCase();
    return hostname.replace(/^www\./, '');
  } catch (error) {
    return null;
  }
}

async function resolveLastFocusedWindowId() {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (activeTab && Number.isFinite(activeTab.windowId)) {
      return activeTab.windowId;
    }
  } catch (error) {
    console.debug('Failed to resolve last focused window:', error);
  }

  return null;
}

function isDedicatedDomainGroup(groupTabs, targetDomain) {
  if (!Array.isArray(groupTabs) || groupTabs.length < 1 || typeof targetDomain !== 'string' || targetDomain.length === 0) {
    return false;
  }

  for (const groupTab of groupTabs) {
    const groupDomain = extractDomainForGrouping(groupTab?.url || groupTab?.pendingUrl);
    if (groupDomain !== targetDomain) {
      return false;
    }
  }

  return true;
}

function findDomainGroupIdInWindow(tabsInWindow, targetDomain, { excludeGroupId } = {}) {
  if (!Array.isArray(tabsInWindow) || typeof targetDomain !== 'string' || targetDomain.length === 0) {
    return null;
  }

  const groupedTabs = new Map();
  for (const item of tabsInWindow) {
    if (!item || item.pinned || !Number.isFinite(item.id) || !Number.isFinite(item.groupId) || item.groupId < 0) {
      continue;
    }
    if (Number.isFinite(excludeGroupId) && item.groupId === excludeGroupId) {
      continue;
    }

    const existing = groupedTabs.get(item.groupId);
    if (existing) {
      existing.push(item);
    } else {
      groupedTabs.set(item.groupId, [item]);
    }
  }

  for (const [groupId, groupTabs] of groupedTabs.entries()) {
    if (isDedicatedDomainGroup(groupTabs, targetDomain)) {
      return groupId;
    }
  }

  return null;
}

function findMiscDomainGroupId(tabsInWindow, { excludeGroupId } = {}) {
  if (!Array.isArray(tabsInWindow) || tabsInWindow.length === 0) {
    return null;
  }

  const groupedTabs = new Map();
  for (const item of tabsInWindow) {
    if (!item || item.pinned || !Number.isFinite(item.id) || !Number.isFinite(item.groupId) || item.groupId < 0) {
      continue;
    }
    if (Number.isFinite(excludeGroupId) && item.groupId === excludeGroupId) {
      continue;
    }

    const existing = groupedTabs.get(item.groupId);
    if (existing) {
      existing.push(item);
    } else {
      groupedTabs.set(item.groupId, [item]);
    }
  }

  for (const [groupId, groupTabs] of groupedTabs.entries()) {
    const domains = new Set();
    let hasUnsortable = false;

    for (const groupTab of groupTabs) {
      const groupDomain = extractDomainForGrouping(groupTab.url || groupTab.pendingUrl);
      if (!groupDomain) {
        hasUnsortable = true;
      } else {
        domains.add(groupDomain);
      }
    }

    if (hasUnsortable || domains.size > 1) {
      return groupId;
    }
  }

  return null;
}

function collectGroupTabsById(tabsInWindow, { excludeGroupId } = {}) {
  const groupedTabs = new Map();

  if (!Array.isArray(tabsInWindow)) {
    return groupedTabs;
  }

  for (const item of tabsInWindow) {
    if (!item || item.pinned || !Number.isFinite(item.id) || !Number.isFinite(item.groupId) || item.groupId < 0) {
      continue;
    }
    if (Number.isFinite(excludeGroupId) && item.groupId === excludeGroupId) {
      continue;
    }

    const existing = groupedTabs.get(item.groupId);
    if (existing) {
      existing.push(item);
    } else {
      groupedTabs.set(item.groupId, [item]);
    }
  }

  return groupedTabs;
}

function collectSameDomainTabIdsInGroup(groupTabs, targetDomain, { excludeTabId } = {}) {
  if (!Array.isArray(groupTabs) || typeof targetDomain !== 'string' || targetDomain.length === 0) {
    return [];
  }

  const sameDomainIds = [];
  for (const groupTab of groupTabs) {
    if (!groupTab || !Number.isFinite(groupTab.id)) {
      continue;
    }
    if (Number.isFinite(excludeTabId) && groupTab.id === excludeTabId) {
      continue;
    }

    const groupDomain = extractDomainForGrouping(groupTab.url || groupTab.pendingUrl);
    if (groupDomain === targetDomain) {
      sameDomainIds.push(groupTab.id);
    }
  }

  return sameDomainIds;
}


async function normalizeSingletonDomainGroupsInWindow(windowId, tabsInWindow) {
  if (!Number.isFinite(windowId) || !Array.isArray(tabsInWindow) || !chrome.tabs?.ungroup) {
    return false;
  }

  const groupedTabs = new Map();
  for (const tab of tabsInWindow) {
    if (!tab || tab.pinned || !Number.isFinite(tab.id) || !Number.isFinite(tab.groupId) || tab.groupId < 0) {
      continue;
    }

    const existing = groupedTabs.get(tab.groupId);
    if (existing) {
      existing.push(tab);
    } else {
      groupedTabs.set(tab.groupId, [tab]);
    }
  }

  const singletonTabIds = [];
  for (const [, groupTabs] of groupedTabs.entries()) {
    if (!Array.isArray(groupTabs) || groupTabs.length !== 1) {
      continue;
    }

    const loneTab = groupTabs[0];
    const domain = extractDomainForGrouping(loneTab.url || loneTab.pendingUrl);
    if (!domain) {
      continue;
    }

    singletonTabIds.push(loneTab.id);
  }

  if (singletonTabIds.length === 0) {
    return false;
  }

  try {
    await chrome.tabs.ungroup(singletonTabIds);
    return true;
  } catch (error) {
    console.debug('Failed to normalize singleton domain groups:', error);
    return false;
  }
}

async function resolveGroupingDestination(windowId, tab, tabsInWindow) {
  if (!tab || !Number.isFinite(tab.id) || !Array.isArray(tabsInWindow)) {
    return null;
  }

  const tabDomain = extractDomainForGrouping(tab.url || tab.pendingUrl);
  if (!tabDomain) {
    return null;
  }

  const sourceGroupId = Number.isFinite(tab.groupId) && tab.groupId >= 0 ? tab.groupId : null;

  const sameDomainGroupId = findDomainGroupIdInWindow(tabsInWindow, tabDomain, {
    excludeGroupId: sourceGroupId,
  });
  if (Number.isFinite(sameDomainGroupId) && sameDomainGroupId >= 0) {
    return { groupId: sameDomainGroupId, kind: 'domain', seedTabIds: [] };
  }

  const miscGroupId = findMiscDomainGroupId(tabsInWindow, {
    excludeGroupId: sourceGroupId,
  });
  if (Number.isFinite(miscGroupId) && miscGroupId >= 0) {
    const groupedTabs = collectGroupTabsById(tabsInWindow, { excludeGroupId: sourceGroupId });
    const miscTabs = groupedTabs.get(miscGroupId) || [];
    const seedTabIds = collectSameDomainTabIdsInGroup(miscTabs, tabDomain, {
      excludeTabId: tab.id,
    });

    if (seedTabIds.length > 0) {
      return { groupId: null, kind: 'domain-from-misc', seedTabIds };
    }

    return { groupId: miscGroupId, kind: 'misc', seedTabIds: [] };
  }

  try {
    const createdGroupId = await chrome.tabs.group({ tabIds: [tab.id] });
    if (Number.isFinite(createdGroupId) && createdGroupId >= 0) {
      return { groupId: createdGroupId, kind: 'misc-created', seedTabIds: [] };
    }
  } catch (error) {
    console.debug('Failed to create misc group for tab:', error);
  }

  return null;
}

async function moveTabToGroupEnd(windowId, groupId, tabId) {
  if (!Number.isFinite(windowId) || !Number.isFinite(groupId) || groupId < 0 || !Number.isFinite(tabId)) {
    return;
  }

  if (!chrome.tabs?.query || !chrome.tabs?.move) {
    return;
  }

  try {
    const groupTabs = await chrome.tabs.query({ windowId, groupId });
    if (!Array.isArray(groupTabs) || groupTabs.length === 0) {
      return;
    }

    let maxIndex = -1;
    let targetTabFound = false;
    for (const item of groupTabs) {
      if (!item || !Number.isFinite(item.index) || !Number.isFinite(item.id)) {
        continue;
      }
      if (item.index > maxIndex) {
        maxIndex = item.index;
      }
      if (item.id === tabId) {
        targetTabFound = true;
      }
    }

    if (!targetTabFound || maxIndex < 0) {
      return;
    }

    await chrome.tabs.move(tabId, { index: maxIndex });
  } catch (error) {
    console.debug('Failed to move tab to group end:', error);
  }
}

async function rebalanceSingletonDomainGroupsInWindow(windowId) {
  if (!Number.isFinite(windowId)) {
    return;
  }

  let tabsInWindow;
  try {
    tabsInWindow = await chrome.tabs.query({ windowId });
  } catch (error) {
    return;
  }

  await normalizeSingletonDomainGroupsInWindow(windowId, tabsInWindow);
}

async function autoGroupTabByDomain(tab, { requireActiveContext } = {}) {
  if (!tab) {
    return;
  }

  if (!getWindowAutoGroupingState(tab.windowId)) {
    return;
  }

  if (tab.pinned || !Number.isFinite(tab.windowId) || !Number.isFinite(tab.id)) {
    return;
  }

  if (requireActiveContext) {
    if (!tab.active) {
      return;
    }

    const activeWindowId = await resolveLastFocusedWindowId();
    if (!Number.isFinite(activeWindowId) || activeWindowId !== tab.windowId) {
      return;
    }
  }

  const url = typeof tab.url === 'string' && tab.url.length > 0 ? tab.url : tab.pendingUrl;
  if (!extractDomainForGrouping(url)) {
    return;
  }

  if (!chrome.tabs?.query || !chrome.tabs?.group) {
    return;
  }

  try {
    let tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
    const normalized = await normalizeSingletonDomainGroupsInWindow(tab.windowId, tabsInWindow);
    if (normalized) {
      tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
      const refreshedTab = await chrome.tabs.get(tab.id);
      if (refreshedTab) {
        tab = refreshedTab;
      }
    }

    const destination = await resolveGroupingDestination(tab.windowId, tab, tabsInWindow);
    if (!destination) {
      return;
    }

    if (Number.isFinite(destination.groupId) && destination.groupId < 0) {
      return;
    }

    if (Number.isFinite(tab.groupId) && Number.isFinite(destination.groupId) && tab.groupId === destination.groupId) {
      if (normalized) {
        await persistTabListSyncEntity('auto-domain-grouping');
      }
      return;
    }

    const seedTabIds = Array.isArray(destination.seedTabIds)
      ? destination.seedTabIds.filter((id) => Number.isFinite(id))
      : [];

    let resolvedGroupId = Number.isFinite(destination.groupId) ? destination.groupId : null;
    if (destination.kind === 'domain-from-misc' && seedTabIds.length > 0) {
      const createTabIds = [...new Set([...seedTabIds, tab.id])];
      const createdDomainGroupId = await chrome.tabs.group({ tabIds: createTabIds });
      if (Number.isFinite(createdDomainGroupId)) {
        resolvedGroupId = createdDomainGroupId;
      }
    } else if (Number.isFinite(destination.groupId)) {
      const groupedId = await chrome.tabs.group({ tabIds: [tab.id], groupId: destination.groupId });
      resolvedGroupId = Number.isFinite(groupedId) ? groupedId : destination.groupId;
    }

    if (!Number.isFinite(resolvedGroupId) || resolvedGroupId < 0) {
      return;
    }

    await moveTabToGroupEnd(tab.windowId, resolvedGroupId, tab.id);
    await persistTabListSyncEntity('auto-domain-grouping');
  } catch (error) {
    console.debug('Failed to auto group tab by domain:', error);
  }
}

async function resolveWindowIdForGrouping(explicitWindowId, sender) {
  if (Number.isFinite(explicitWindowId)) {
    return explicitWindowId;
  }

  if (sender?.tab && Number.isFinite(sender.tab.windowId)) {
    return sender.tab.windowId;
  }

  try {
    await ensurePanelStateReady();
  } catch (error) {
    console.error('Failed to ensure panel state while resolving window:', error);
  }

  if (Number.isFinite(panelState?.tabId)) {
    try {
      const hostTab = await chrome.tabs.get(panelState.tabId);
      if (hostTab && Number.isFinite(hostTab.windowId)) {
        return hostTab.windowId;
      }
    } catch (error) {
      console.debug('Failed to resolve panel host window:', error);
    }
  }

  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (activeTab && Number.isFinite(activeTab.windowId)) {
      return activeTab.windowId;
    }
  } catch (error) {
    console.debug('Failed to resolve last focused window for grouping:', error);
  }

  return null;
}

async function createTabGroup(tabEntries, { title } = {}) {
  if (!Array.isArray(tabEntries) || tabEntries.length === 0) {
    return null;
  }

  const tabIds = [];
  for (const tab of tabEntries) {
    if (tab && Number.isFinite(tab.id)) {
      tabIds.push(tab.id);
    }
  }

  if (tabIds.length === 0) {
    return null;
  }

  try {
    const groupId = await chrome.tabs.group({ tabIds });
    if (title && typeof title === 'string' && title.trim().length > 0) {
      try {
        await chrome.tabGroups.update(groupId, { title: title.trim() });
      } catch (updateError) {
        console.debug('Failed to update tab group title:', updateError);
      }
    }
    return groupId;
  } catch (error) {
    console.error('Failed to create tab group:', error);
    return null;
  }
}

async function groupTabsByDomain({ scope, windowId }) {
  let hasGroupingChanges = false;
  const query = {};
  if (scope === GROUP_SCOPE_CURRENT && Number.isFinite(windowId)) {
    query.windowId = windowId;
  }

  const tabs = await chrome.tabs.query(query);
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return false;
  }

  const perWindow = new Map();

  for (const tab of tabs) {
    if (!tab || !Number.isFinite(tab.id) || !Number.isFinite(tab.windowId)) {
      continue;
    }

    if (tab.pinned) {
      continue;
    }

    let entry = perWindow.get(tab.windowId);
    if (!entry) {
      entry = { domains: new Map(), leftovers: [] };
      perWindow.set(tab.windowId, entry);
    }

    const domain = extractDomainForGrouping(tab.url);
    if (domain) {
      const domainTabs = entry.domains.get(domain);
      if (domainTabs) {
        domainTabs.push(tab);
      } else {
        entry.domains.set(domain, [tab]);
      }
    } else {
      entry.leftovers.push(tab);
    }
  }

  for (const entry of perWindow.values()) {
    const leftovers = entry.leftovers;

    for (const [domain, domainTabs] of entry.domains.entries()) {
      if (domainTabs.length > 1) {
        const createdGroupId = await createTabGroup(domainTabs);
        if (Number.isFinite(createdGroupId)) {
          hasGroupingChanges = true;
        }
      } else if (domainTabs.length === 1) {
        leftovers.push(domainTabs[0]);
      }
    }

    if (leftovers.length > 0) {
      const leftoversGroupId = await createTabGroup(leftovers);
      if (Number.isFinite(leftoversGroupId)) {
        hasGroupingChanges = true;
      }
    }
  }

  return hasGroupingChanges;
}

(async function bootstrapPanelSync() {
  try {
    await Promise.all([ensurePanelStateReady(), ensurePanelSyncReady()]);
    await syncPanelRuntimeState('bootstrap');

    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await persistActiveTabSyncEntity(activeTab?.id, 'bootstrap');
  } catch (error) {
    console.error('Failed to bootstrap panel sync state:', error);
  }
})();

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  if (typeof tabId !== 'number') {
    return;
  }

  await ensurePanelStateReady();

  if (panelState.isOpen && panelState.tabId === tabId) {
    const closed = await closePanelOnTab(tabId);
    if (!closed) {
      updatePanelState({ isOpen: false, tabId: null });
    }
    return;
  }

  const opened = await openPanelOnTab(tabId);
  if (!opened) {
    updatePanelState({ isOpen: false, tabId: null });
  }
});


if (chrome.windows?.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    if (!Number.isFinite(windowId)) {
      return;
    }
    windowAutoDomainGroupingState.delete(windowId);
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }
  const autoGroupChange = changes[AUTO_DOMAIN_GROUP_STORAGE_KEY];
  if (autoGroupChange) {
    const wasEnabled = autoDomainGroupingEnabled;
    autoDomainGroupingEnabled = Boolean(autoGroupChange.newValue);

    for (const windowId of Array.from(windowAutoDomainGroupingState.keys())) {
      setWindowAutoGroupingState(windowId, autoDomainGroupingEnabled);
    }

    if (!wasEnabled && autoDomainGroupingEnabled) {
      resolveLastFocusedWindowId()
        .then((focusedWindowId) => {
          if (!Number.isFinite(focusedWindowId)) {
            return null;
          }

          return groupTabsByDomain({
            scope: GROUP_SCOPE_CURRENT,
            windowId: focusedWindowId,
          }).then((hasGroupingChanges) => {
            if (hasGroupingChanges) {
              return persistTabListSyncEntity('auto-domain-grouping-enabled');
            }
            return null;
          });
        })
        .catch((error) => {
          console.debug('Failed to run initial auto domain grouping:', error);
        });
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    return;
  }

  if (message.type === 'TabManagerPanelClosedByUser') {
    ensurePanelStateReady()
      .then(() => {
        updatePanelState({ isOpen: false, tabId: null });
      })
      .catch((error) => {
        console.error('Failed to synchronise panel state after user close:', error);
      });
    return;
  }

  if (message.type === GROUP_TABS_BY_DOMAIN_MESSAGE) {
    (async () => {
      const scope =
        message.scope === GROUP_SCOPE_CURRENT
          ? GROUP_SCOPE_CURRENT
          : GROUP_SCOPE_ALL;

      let targetWindowId = null;
      if (scope === GROUP_SCOPE_CURRENT) {
        const explicitWindowId = Number.isFinite(message.windowId)
          ? message.windowId
          : null;
        targetWindowId = await resolveWindowIdForGrouping(explicitWindowId, sender);
        if (!Number.isFinite(targetWindowId)) {
          throw new Error('対象のウィンドウを特定できませんでした');
        }
      }

      const hasGroupingChanges = await groupTabsByDomain({ scope, windowId: targetWindowId });
      if (hasGroupingChanges) {
        await persistTabListSyncEntity('manual-domain-grouping');
      }
      sendResponse({ ok: true });
    })().catch((error) => {
      console.error('Failed to group tabs by domain:', error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    });
    return true;
  }

  if (message.type === PREVIEW_SET_ENABLED_MESSAGE) {
    ensurePreviewStateReady()
      .then(() => setPreviewEnabled(Boolean(message.enabled)))
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        console.error('Failed to update preview preference:', error);
        sendResponse({ ok: false, error: String(error?.message || error) });
      });
    return true;
  }

  if (message.type === PREVIEW_CLEAR_CACHE_MESSAGE) {
    ensurePreviewStateReady()
      .then(() => clearPreviewCache())
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => {
        console.error('Failed to clear preview cache:', error);
        sendResponse({ ok: false, error: String(error?.message || error) });
      });
    return true;
  }

  if (message.type === PREVIEW_REQUEST_MESSAGE) {
    (async () => {
      await ensurePreviewStateReady();

      const tabId = typeof message.tabId === 'number' ? message.tabId : null;
      if (!previewEnabled || tabId == null) {
        sendResponse({ status: 'queued' });
        return;
      }

      if (unavailablePreviews.has(tabId)) {
        sendResponse({ status: 'unavailable' });
        return;
      }

      const preview = previewData.get(tabId);
      if (preview && typeof preview.image === 'string') {
        unavailablePreviews.delete(tabId);
        sendResponse({ status: 'ready', preview });
        return;
      }

      sendResponse({ status: 'queued' });
    })().catch((error) => {
      console.error('Failed to handle preview request:', error);
      sendResponse({ status: 'queued' });
    });
    return true;
  }

  if (message.type === PREVIEW_SYNC_MESSAGE) {
    ensurePreviewStateReady()
      .then(() => {
        if (!previewEnabled) {
          return;
        }
        const tabIds = Array.isArray(message.tabIds) ? message.tabIds : [];
        syncPreviewOrder(tabIds);
      })
      .catch((error) => {
        console.error('Failed to sync preview order:', error);
      });
    return;
  }
});
