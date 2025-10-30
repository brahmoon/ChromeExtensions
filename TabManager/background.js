const PANEL_STATE_KEY = 'tabManagerPanelState';

const panelStorageArea = chrome.storage.session ?? chrome.storage.local;

const PREVIEW_ENABLED_KEY = 'tabManagerPreviewEnabled';
const PREVIEW_DATA_KEY = 'tabManagerPreviewData';
const PREVIEW_MIN_CAPTURE_INTERVAL_MS = 5000;
const PREVIEW_QUEUE_DELAY_MS = 350;
const PREVIEW_CAPTURE_OPTIONS = { format: 'jpeg', quality: 50 };

let panelState = {
  isOpen: false,
  tabId: null,
};

let panelStateReadyPromise = loadPanelState();
let previewEnabled = false;
let previewData = new Map();
let previewQueue = [];
let previewProcessing = false;
let previewCaptureTimestamps = new Map();
let previewStateReadyPromise = loadPreviewState();

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

async function loadPreviewState() {
  try {
    const stored = await chrome.storage.local.get({
      [PREVIEW_ENABLED_KEY]: false,
      [PREVIEW_DATA_KEY]: {},
    });

    previewEnabled = Boolean(stored[PREVIEW_ENABLED_KEY]);

    const data = stored[PREVIEW_DATA_KEY];
    previewData = new Map();

    if (data && typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        const tabId = Number(key);
        if (!Number.isFinite(tabId)) {
          continue;
        }
        if (typeof value === 'string' && value.startsWith('data:image')) {
          previewData.set(tabId, value);
        }
      }
    }
  } catch (error) {
    console.error('Failed to load preview state:', error);
    previewEnabled = false;
    previewData = new Map();
  } finally {
    previewQueue = [];
    previewProcessing = false;
    previewCaptureTimestamps = new Map();
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

async function ensurePreviewStateReady() {
  try {
    await previewStateReadyPromise;
  } catch (error) {
    console.error('Preview state initialization failed, retrying:', error);
    previewStateReadyPromise = loadPreviewState();
    await previewStateReadyPromise;
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

async function setPreviewEnabled(enabled) {
  const nextValue = Boolean(enabled);
  if (previewEnabled === nextValue) {
    return previewEnabled;
  }

  previewEnabled = nextValue;

  try {
    await chrome.storage.local.set({ [PREVIEW_ENABLED_KEY]: previewEnabled });
  } catch (error) {
    console.error('Failed to persist preview enabled state:', error);
  }

  if (!previewEnabled) {
    await clearAllPreviews();
  }

  return previewEnabled;
}

async function persistPreviewData() {
  try {
    if (previewData.size === 0) {
      await chrome.storage.local.remove(PREVIEW_DATA_KEY);
      return;
    }

    const payload = {};
    for (const [tabId, dataUrl] of previewData.entries()) {
      payload[tabId] = dataUrl;
    }

    await chrome.storage.local.set({ [PREVIEW_DATA_KEY]: payload });
  } catch (error) {
    console.error('Failed to persist preview data:', error);
  }
}

async function clearPreviewForTab(tabId) {
  previewQueue = previewQueue.filter((entry) => entry.tabId !== tabId);
  previewCaptureTimestamps.delete(tabId);

  const removed = previewData.delete(tabId);
  if (!removed) {
    return;
  }

  await persistPreviewData();

  chrome.runtime
    .sendMessage({ type: 'TabManagerPreviewCleared', tabId })
    .catch(() => {});
}

async function clearAllPreviews() {
  const hadPreviews = previewData.size > 0;
  previewQueue = [];
  previewCaptureTimestamps.clear();
  previewProcessing = false;
  previewData.clear();

  try {
    await chrome.storage.local.remove(PREVIEW_DATA_KEY);
  } catch (error) {
    console.error('Failed to clear preview storage:', error);
  }

  if (hadPreviews) {
    chrome.runtime
      .sendMessage({ type: 'TabManagerPreviewsCleared' })
      .catch(() => {});
  }
}

function notifyPreviewReady(tabId, dataUrl) {
  chrome.runtime
    .sendMessage({ type: 'TabManagerPreviewReady', tabId, dataUrl })
    .catch(() => {});
}

function enqueuePreview(tabId, { priority = 'normal', force = false } = {}) {
  if (!previewEnabled || typeof tabId !== 'number') {
    return;
  }

  previewQueue = previewQueue.filter((entry) => entry.tabId !== tabId);

  const entry = { tabId, force: Boolean(force), priority };
  if (priority === 'high') {
    previewQueue.unshift(entry);
  } else {
    previewQueue.push(entry);
  }

  processPreviewQueue();
}

function processPreviewQueue() {
  if (previewProcessing || !previewEnabled) {
    return;
  }

  const next = previewQueue.shift();
  if (!next) {
    return;
  }

  if (previewData.has(next.tabId) && !next.force) {
    setTimeout(processPreviewQueue, 0);
    return;
  }

  previewProcessing = true;

  generatePreviewForTab(next.tabId, { force: next.force })
    .catch((error) => {
      console.error('Failed to capture tab preview:', error);
    })
    .finally(() => {
      previewProcessing = false;
      if (previewQueue.length > 0 && previewEnabled) {
        setTimeout(processPreviewQueue, PREVIEW_QUEUE_DELAY_MS);
      }
    });
}

async function generatePreviewForTab(tabId, { force = false } = {}) {
  if (!previewEnabled) {
    return;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    await clearPreviewForTab(tabId);
    return;
  }

  if (!tab) {
    await clearPreviewForTab(tabId);
    return;
  }

  const now = Date.now();
  const lastCapture = previewCaptureTimestamps.get(tabId) ?? 0;
  if (!force && now - lastCapture < PREVIEW_MIN_CAPTURE_INTERVAL_MS) {
    const delay = Math.max(PREVIEW_MIN_CAPTURE_INTERVAL_MS - (now - lastCapture) + 50, 0);
    setTimeout(() => {
      enqueuePreview(tabId, { priority: 'normal' });
    }, delay);
    return;
  }

  previewCaptureTimestamps.set(tabId, now);

  try {
    const dataUrl = await chrome.tabs.captureTab(tabId, PREVIEW_CAPTURE_OPTIONS);
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image')) {
      previewData.set(tabId, dataUrl);
      await persistPreviewData();
      notifyPreviewReady(tabId, dataUrl);
    }
  } catch (error) {
    console.error('Failed to capture preview for tab', tabId, error);
  }
}

function setPreviewOrder(tabIds) {
  if (!previewEnabled || !Array.isArray(tabIds)) {
    return;
  }

  const normalQueue = previewQueue.filter((entry) => entry.priority !== 'high');
  const highPriorityQueue = previewQueue.filter((entry) => entry.priority === 'high');

  const seen = new Set(highPriorityQueue.map((entry) => entry.tabId));
  const reordered = [];

  for (const id of tabIds) {
    if (typeof id !== 'number' || seen.has(id)) {
      continue;
    }
    seen.add(id);

    if (previewData.has(id)) {
      continue;
    }

    const existing = normalQueue.find((entry) => entry.tabId === id);
    if (existing) {
      reordered.push(existing);
    } else {
      reordered.push({ tabId: id, force: false, priority: 'normal' });
    }
  }

  const remaining = normalQueue.filter((entry) => !seen.has(entry.tabId));

  previewQueue = [...highPriorityQueue, ...reordered, ...remaining];

  processPreviewQueue();
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
  await ensurePanelStateReady();

  if (!panelState.isOpen) {
    await ensurePreviewStateReady();
    if (previewEnabled) {
      enqueuePreview(tabId, { priority: 'normal' });
    }
    return;
  }

  const opened = await openPanelOnTab(tabId);
  if (!opened) {
    updatePanelState({ tabId: null, isOpen: false });
  }

  await ensurePreviewStateReady();
  if (previewEnabled) {
    enqueuePreview(tabId, { priority: 'normal' });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensurePanelStateReady();

  if (panelState.tabId === tabId) {
    updatePanelState({ tabId: null });
  }

  await ensurePreviewStateReady();
  if (previewEnabled) {
    await clearPreviewForTab(tabId);
  } else {
    previewQueue = previewQueue.filter((entry) => entry.tabId !== tabId);
    previewCaptureTimestamps.delete(tabId);
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo) {
    return;
  }

  const shouldQueue = changeInfo.status === 'complete' || Boolean(changeInfo.title) || Boolean(changeInfo.url);
  if (!shouldQueue) {
    return;
  }

  ensurePreviewStateReady()
    .then(() => {
      if (previewEnabled && typeof tabId === 'number') {
        enqueuePreview(tabId, { priority: 'normal' });
      }
    })
    .catch((error) => {
      console.error('Failed to schedule preview after update:', error);
    });
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

  if (message.type === 'TabManagerGetPreviewState') {
    ensurePreviewStateReady()
      .then(() => {
        sendResponse({ enabled: previewEnabled });
      })
      .catch((error) => {
        console.error('Failed to provide preview state:', error);
        sendResponse({ enabled: false });
      });
    return true;
  }

  if (message.type === 'TabManagerSetPreviewEnabled') {
    ensurePreviewStateReady()
      .then(() => setPreviewEnabled(message.enabled))
      .then((enabled) => {
        sendResponse({ enabled });
      })
      .catch((error) => {
        console.error('Failed to update preview enabled state:', error);
        sendResponse({ enabled: previewEnabled });
      });
    return true;
  }

  if (message.type === 'TabManagerRequestPreview') {
    ensurePreviewStateReady()
      .then(() => {
        const tabId = message.tabId;
        if (!previewEnabled) {
          sendResponse({ status: 'disabled' });
          return;
        }

        if (typeof tabId !== 'number') {
          sendResponse({ status: 'error' });
          return;
        }

        const existing = previewData.get(tabId);
        if (existing) {
          sendResponse({ status: 'ready', dataUrl: existing });
          if (message.expedite) {
            enqueuePreview(tabId, { priority: 'high', force: true });
          }
          return;
        }

        enqueuePreview(tabId, {
          priority: message.expedite ? 'high' : 'normal',
          force: Boolean(message.expedite),
        });
        sendResponse({ status: 'queued' });
      })
      .catch((error) => {
        console.error('Failed to handle preview request:', error);
        sendResponse({ status: 'error' });
      });
    return true;
  }

  if (message.type === 'TabManagerSetPreviewOrder') {
    ensurePreviewStateReady()
      .then(() => {
        setPreviewOrder(Array.isArray(message.tabIds) ? message.tabIds : []);
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('Failed to apply preview order:', error);
        sendResponse({ success: false });
      });
    return true;
  }
});

