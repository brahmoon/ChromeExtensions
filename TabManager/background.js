const PANEL_STATE_KEY = 'tabManagerPanelState';
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
const PREVIEW_MAX_CACHE_ENTRIES = 40;
const PREVIEW_PROTOCOL_DENYLIST = [/^chrome:/i, /^edge:/i, /^about:/i, /^view-source:/i, /^devtools:/i];
const EXTENSION_ELEMENT_ATTRIBUTE = 'data-tab-manager-element';
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
let previewEnabled = false;
const previewData = new Map();
const unavailablePreviews = new Set();
let previewQueue = [];
const previewQueueSet = new Set();
let previewProcessing = false;
const previewRetryTimeouts = new Map();
let previewStateReadyPromise = initializePreviewState();

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
    await panelStorageArea.set({
      [PANEL_STATE_KEY]: {
        isOpen: panelState.isOpen,
        tabId: panelState.tabId,
      },
    });
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

async function toggleTabManagerVisibility(tabId, hidden) {
  if (typeof tabId !== 'number') {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (shouldHide, attributeName) => {
        if (typeof attributeName !== 'string' || attributeName.length === 0) {
          return;
        }

        const selector = `[${attributeName}]`;
        const elements = Array.from(document.querySelectorAll(selector));

        for (const element of elements) {
          if (!element) {
            continue;
          }

          if (shouldHide) {
            const previousStyle = element.getAttribute('style');
            if (previousStyle != null) {
              element.setAttribute('data-tab-manager-capture-style', previousStyle);
            } else {
              element.removeAttribute('data-tab-manager-capture-style');
            }
            element.setAttribute('data-tab-manager-capture-hidden', '1');
            element.style.transition = 'none';
            element.style.opacity = '0';
            element.style.pointerEvents = 'none';
          } else {
            const storedStyle = element.getAttribute('data-tab-manager-capture-style');
            if (storedStyle != null) {
              if (storedStyle === '') {
                element.removeAttribute('style');
              } else {
                element.setAttribute('style', storedStyle);
              }
              element.removeAttribute('data-tab-manager-capture-style');
            } else if (element.hasAttribute('data-tab-manager-capture-hidden')) {
              element.style.removeProperty('opacity');
              element.style.removeProperty('pointer-events');
              element.style.removeProperty('transition');
            }
            element.removeAttribute('data-tab-manager-capture-hidden');
          }
        }
      },
      args: [Boolean(hidden), EXTENSION_ELEMENT_ATTRIBUTE],
    });
  } catch (error) {
    const message = error?.message || '';
    if (!message.includes('No tab with id') && !message.includes('The tab was closed')) {
      console.debug('Failed to toggle TabManager visibility for capture:', error);
    }
  }
}

async function prepareTabForCapture(tabId) {
  await toggleTabManagerVisibility(tabId, true);
  await delay(60);
}

async function restoreTabAfterCapture(tabId) {
  await toggleTabManagerVisibility(tabId, false);
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
      await prepareTabForCapture(tabId);
      image = await chrome.tabs.captureVisibleTab(tab.windowId, PREVIEW_CAPTURE_OPTIONS);
    } catch (error) {
      captureError = error;
    } finally {
      await restoreTabAfterCapture(tabId);
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

    if (!tab.active || previewData.has(tab.id)) {
      continue;
    }

    const priority = prioritizeActive && Boolean(tab.active);
    enqueuePreview(tab.id, { priority });
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

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await Promise.all([ensurePanelStateReady(), ensurePreviewStateReady()]);

  if (previewEnabled && !previewData.has(tabId)) {
    enqueuePreview(tabId, { priority: true });
  }

  if (!panelState.isOpen) {
    return;
  }

  const opened = await openPanelOnTab(tabId);
  if (!opened) {
    updatePanelState({ tabId: null, isOpen: false });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await Promise.all([ensurePanelStateReady(), ensurePreviewStateReady()]);

  if (panelState.tabId === tabId) {
    updatePanelState({ tabId: null });
  }

  await removePreview(tabId, { reason: PREVIEW_REMOVAL_REASON_CLOSED });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ensurePreviewStateReady();

  if (!previewEnabled) {
    return;
  }

  if (changeInfo.url) {
    await removePreview(tabId, { reason: PREVIEW_REMOVAL_REASON_REFRESHED });
  }

  if ((changeInfo.status === 'complete' || changeInfo.url) && tab && tab.active && !previewData.has(tabId)) {
    enqueuePreview(tabId, { priority: true });
  }
});

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

