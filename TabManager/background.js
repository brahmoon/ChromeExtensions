const PANEL_STATE_KEY = 'tabManagerPanelState';

const panelStorageArea = chrome.storage.session ?? chrome.storage.local;

let panelState = {
  isOpen: false,
  tabId: null,
};

let panelStateReadyPromise = loadPanelState();

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
    return;
  }

  const opened = await openPanelOnTab(tabId);
  if (!opened) {
    updatePanelState({ tabId: null, isOpen: false });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
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

