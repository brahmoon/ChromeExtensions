const HISTORY_LIMIT = 100;
const ALPHA = 0.3;

async function getAccessState() {
  const stored = await chrome.storage.local.get('accessState');
  const state = stored.accessState || {
    sequence: 0,
    history: [],
    ema: {}
  };
  state.sequence = state.sequence || 0;
  state.history = Array.isArray(state.history) ? state.history : [];
  state.ema = state.ema || {};
  return state;
}

async function saveAccessState(state) {
  await chrome.storage.local.set({ accessState: state });
}

function decayToCurrent(stat, sequence) {
  if (!stat) {
    return { ema: 0, lastSequence: sequence };
  }
  const lastSequence = stat.lastSequence || sequence;
  const steps = Math.max(0, sequence - lastSequence);
  if (steps > 0) {
    stat.ema *= Math.pow(1 - ALPHA, steps);
    stat.lastSequence = sequence;
  }
  return stat;
}

async function recordAccess(tabId) {
  const state = await getAccessState();
  state.sequence += 1;
  const sequence = state.sequence;

  const stats = state.ema[tabId] || { ema: 0, lastSequence: sequence };
  const updated = decayToCurrent(stats, sequence);
  updated.ema = ALPHA * 1 + (1 - ALPHA) * updated.ema;
  updated.lastSequence = sequence;
  state.ema[tabId] = updated;

  state.history.push(tabId);
  if (state.history.length > HISTORY_LIMIT) {
    state.history.shift();
  }

  await saveAccessState(state);
}

async function removeTabData(tabId) {
  const state = await getAccessState();
  state.history = state.history.filter((id) => id !== tabId);
  if (state.ema[tabId]) {
    delete state.ema[tabId];
  }
  await saveAccessState(state);
}

function handleClosePanelRequest(sender) {
  if (sender.tab?.id) {
    chrome.tabs.sendMessage(sender.tab.id, { type: 'closePanel' }).catch(() => {});
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const active = tabs[0];
    if (active?.id) {
      chrome.tabs.sendMessage(active.id, { type: 'closePanel' }).catch(() => {});
    }
  }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await getAccessState();
  await saveAccessState(state);
  chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    if (tabs[0]?.id) {
      recordAccess(tabs[0].id);
    }
  }).catch(() => {});
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (activeInfo.tabId >= 0) {
    void recordAccess(activeInfo.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeTabData(tabId);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message?.type) {
    return;
  }
  if (message.type === 'closePanel') {
    handleClosePanelRequest(sender);
  } else if (message.type === 'togglePanel' && sender.tab?.id) {
    chrome.tabs.sendMessage(sender.tab.id, { type: 'togglePanel' }).catch(() => {});
  }
});

chrome.action?.onClicked.addListener((tab) => {
  if (!tab.id) {
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'togglePanel' }).catch(() => {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  });
});
