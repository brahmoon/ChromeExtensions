const ACCESS_DATA_KEY = 'tabManagerAccessData';
const LEGACY_HISTORY_KEY = 'tabAccessHistory';
const LEGACY_EMA_KEY = 'tabAccessEma';
const MAX_HISTORY = 100;
const EMA_ALPHA = 0.3;
const PANEL_STATE_KEY = 'tabManagerPanelOpen';

let panelOpen = false;

initializePanelState();

async function initializePanelState() {
  try {
    const stored = await chrome.storage.local.get(PANEL_STATE_KEY);
    if (typeof stored[PANEL_STATE_KEY] === 'boolean') {
      panelOpen = stored[PANEL_STATE_KEY];
    }
  } catch (error) {
    console.error('Failed to restore panel state:', error);
  }
}

async function readAccessData() {
  const stored = await chrome.storage.local.get([
    ACCESS_DATA_KEY,
    LEGACY_HISTORY_KEY,
    LEGACY_EMA_KEY
  ]);

  let data = stored[ACCESS_DATA_KEY];
  if (!data || typeof data !== 'object') {
    const history = Array.isArray(stored[LEGACY_HISTORY_KEY]) ? stored[LEGACY_HISTORY_KEY] : [];
    const ema = stored[LEGACY_EMA_KEY] && typeof stored[LEGACY_EMA_KEY] === 'object'
      ? stored[LEGACY_EMA_KEY]
      : {};
    data = { history, ema };
  }

  return {
    history: Array.isArray(data.history) ? [...data.history] : [],
    ema: data.ema && typeof data.ema === 'object' ? { ...data.ema } : {}
  };
}

async function writeAccessData(data) {
  await chrome.storage.local.set({
    [ACCESS_DATA_KEY]: {
      history: Array.isArray(data.history) ? data.history : [],
      ema: data.ema && typeof data.ema === 'object' ? data.ema : {}
    }
  });

  try {
    await chrome.storage.local.remove([LEGACY_HISTORY_KEY, LEGACY_EMA_KEY]);
  } catch (error) {
    console.debug('TabManager: unable to remove legacy access data keys', error);
  }
}

async function updateAccessMetrics(tabId) {
  const tabKey = String(tabId);
  const data = await readAccessData();

  data.history.push(tabId);
  if (data.history.length > MAX_HISTORY) {
    data.history.splice(0, data.history.length - MAX_HISTORY);
  }

  const decayedEma = {};
  for (const [key, value] of Object.entries(data.ema)) {
    const decayedValue = (1 - EMA_ALPHA) * value;
    if (decayedValue > 0.001) {
      decayedEma[key] = decayedValue;
    }
  }
  decayedEma[tabKey] = (decayedEma[tabKey] || 0) + EMA_ALPHA;

  await writeAccessData({
    history: data.history,
    ema: decayedEma
  });
}

async function pruneTabMetrics(tabId) {
  const data = await readAccessData();

  const history = data.history.filter((id) => id !== tabId);
  const ema = { ...data.ema };
  delete ema[String(tabId)];

  await writeAccessData({ history, ema });
}

async function sendPanelMessage(tabId, payload, attempt = 0) {
  if (!tabId) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    const message = error?.message || '';
    if (message.includes('Receiving end does not exist') && attempt < 2) {
      const retryDelay = 250 * (attempt + 1);
      setTimeout(() => {
        sendPanelMessage(tabId, payload, attempt + 1);
      }, retryDelay);
      return;
    }

    if (!message.includes('Missing host permission')) {
      console.debug('Failed to deliver panel message', error);
    }
  }
}

async function openPanelInTab(tabId) {
  await sendPanelMessage(tabId, { type: 'setPanelState', open: true });
}

async function closePanelInTab(tabId) {
  await sendPanelMessage(tabId, { type: 'setPanelState', open: false });
}

async function closePanelInAllTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map((tab) => closePanelInTab(tab.id)));
}

async function getActiveTabId() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return activeTab?.id ?? null;
}

async function setPanelOpenState(shouldOpen, options = {}) {
  if (panelOpen === shouldOpen) {
    return panelOpen;
  }

  panelOpen = shouldOpen;
  try {
    await chrome.storage.local.set({ [PANEL_STATE_KEY]: panelOpen });
  } catch (error) {
    console.error('Failed to persist panel state:', error);
  }

  if (panelOpen) {
    const targetTabId = options.tabId ?? (await getActiveTabId());
    if (targetTabId) {
      await openPanelInTab(targetTabId);
    }
  } else {
    await closePanelInAllTabs();
  }

  return panelOpen;
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    await updateAccessMetrics(tabId);
  } catch (error) {
    console.error('Failed to update tab metrics on activation:', error);
  }

  if (panelOpen) {
    await openPanelInTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    await pruneTabMetrics(tabId);
  } catch (error) {
    console.error('Failed to prune tab metrics on removal:', error);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab?.id;
  try {
    await setPanelOpenState(!panelOpen, { tabId });
  } catch (error) {
    console.error('Unable to toggle panel from action click:', error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'TabManagerQueryPanelState') {
    sendResponse({ open: panelOpen });
    return;
  }

  if (message.type === 'TabManagerPanelClosedByUser') {
    setPanelOpenState(false).then(() => sendResponse({ ok: true })).catch((error) => {
      console.error('Failed to handle panel close notification:', error);
      sendResponse({ ok: false });
    });
    return true;
  }

  if (message.type === 'TabManagerSyncPanelState') {
    const desiredState = Boolean(message.open);
    const tabId = sender?.tab?.id;
    setPanelOpenState(desiredState, { tabId })
      .then(() => sendResponse({ open: panelOpen }))
      .catch((error) => {
        console.error('Failed to sync panel state from content script:', error);
        sendResponse({ ok: false });
      });
    return true;
  }
});

