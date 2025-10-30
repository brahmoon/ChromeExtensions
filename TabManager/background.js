const HISTORY_KEY = 'tabAccessHistory';
const EMA_KEY = 'tabAccessEma';
const PANEL_STATE_KEY = 'tabManagerPanelState';
const MAX_HISTORY = 100;
const EMA_ALPHA = 0.3;

const panelStorageArea = chrome.storage.session ?? chrome.storage.local;

let metricsState = {
  history: [],
  ema: {},
};

let metricsReadyPromise = loadMetricsState();

let panelState = {
  isOpen: false,
  tabId: null,
};

let panelStateReadyPromise = loadPanelState();

async function loadMetricsState() {
  const stored = await chrome.storage.local.get({
    [HISTORY_KEY]: [],
    [EMA_KEY]: {},
  });

  metricsState = {
    history: Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [],
    ema: stored[EMA_KEY] && typeof stored[EMA_KEY] === 'object' ? stored[EMA_KEY] : {},
  };
}

async function ensureMetricsState() {
  try {
    await metricsReadyPromise;
  } catch (error) {
    console.error('Failed to load metrics state:', error);
    metricsReadyPromise = loadMetricsState();
    await metricsReadyPromise;
  }
}

async function persistMetrics() {
  await chrome.storage.local.set({
    [HISTORY_KEY]: metricsState.history,
    [EMA_KEY]: metricsState.ema,
  });

  chrome.runtime
    .sendMessage({ type: 'TabManagerMetricsUpdated' })
    .catch(() => {
      // Ignore when no listeners are available.
    });
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

async function updateAccessMetrics(tabId) {
  await ensureMetricsState();

  const tabKey = String(tabId);
  const history = [...metricsState.history, tabId];
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  const decayedEma = {};
  for (const [key, value] of Object.entries(metricsState.ema)) {
    const decayedValue = (1 - EMA_ALPHA) * value;
    if (decayedValue > 0.001) {
      decayedEma[key] = decayedValue;
    }
  }
  decayedEma[tabKey] = (decayedEma[tabKey] || 0) + EMA_ALPHA;

  metricsState = {
    history,
    ema: decayedEma,
  };

  await persistMetrics();
}

async function pruneTabMetrics(tabId) {
  await ensureMetricsState();

  const tabKey = String(tabId);
  const filteredHistory = metricsState.history.filter((id) => id !== tabId);
  const updatedEma = { ...metricsState.ema };
  delete updatedEma[tabKey];

  metricsState = {
    history: filteredHistory,
    ema: updatedEma,
  };

  await persistMetrics();
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
  try {
    await updateAccessMetrics(tabId);
  } catch (error) {
    console.error('Failed to update tab metrics on activation:', error);
  }

  await ensurePanelStateReady();

  if (!panelState.isOpen) {
    return;
  }

  const opened = await openPanelOnTab(tabId);
  if (!opened) {
    updatePanelState({ tabId: null, isOpen: false });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    await pruneTabMetrics(tabId);
  } catch (error) {
    console.error('Failed to prune tab metrics on removal:', error);
  }

  await ensurePanelStateReady();

  if (panelState.tabId === tabId) {
    updatePanelState({ tabId: null });
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

  if (message.type === 'TabManagerGetUsageMetrics') {
    (async () => {
      try {
        await ensureMetricsState();
        sendResponse({
          history: metricsState.history,
          ema: metricsState.ema,
        });
      } catch (error) {
        console.error('Failed to respond with usage metrics:', error);
        sendResponse({ history: [], ema: {} });
      }
    })();
    return true;
  }

  if (message.type === 'TabManagerPanelClosedByUser') {
    ensurePanelStateReady()
      .then(() => {
        updatePanelState({ isOpen: false, tabId: null });
      })
      .catch((error) => {
        console.error('Failed to synchronise panel state after user close:', error);
      });
  }
});

