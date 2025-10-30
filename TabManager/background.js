const HISTORY_KEY = 'tabAccessHistory';
const EMA_KEY = 'tabAccessEma';
const MAX_HISTORY = 100;
const EMA_ALPHA = 0.3;

async function updateAccessMetrics(tabId) {
  const tabKey = String(tabId);
  const stored = await chrome.storage.local.get({
    [HISTORY_KEY]: [],
    [EMA_KEY]: {}
  });

  const history = Array.isArray(stored[HISTORY_KEY]) ? [...stored[HISTORY_KEY]] : [];
  history.push(tabId);
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  const previousEma = stored[EMA_KEY] && typeof stored[EMA_KEY] === 'object' ? stored[EMA_KEY] : {};
  const decayedEma = {};
  for (const [key, value] of Object.entries(previousEma)) {
    const decayedValue = (1 - EMA_ALPHA) * value;
    if (decayedValue > 0.001) {
      decayedEma[key] = decayedValue;
    }
  }
  decayedEma[tabKey] = (decayedEma[tabKey] || 0) + EMA_ALPHA;

  await chrome.storage.local.set({
    [HISTORY_KEY]: history,
    [EMA_KEY]: decayedEma
  });
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    await updateAccessMetrics(tabId);
  } catch (error) {
    console.error('Failed to update tab metrics on activation:', error);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const stored = await chrome.storage.local.get({
      [HISTORY_KEY]: [],
      [EMA_KEY]: {}
    });

    const history = (Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : []).filter((id) => id !== tabId);
    const ema = { ...(stored[EMA_KEY] || {}) };
    delete ema[String(tabId)];

    await chrome.storage.local.set({
      [HISTORY_KEY]: history,
      [EMA_KEY]: ema
    });
  } catch (error) {
    console.error('Failed to prune tab metrics on removal:', error);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'togglePanel' });
  } catch (error) {
    console.error('Unable to toggle panel from action click:', error);
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'closePanel' && sender.tab?.id) {
    chrome.tabs.sendMessage(sender.tab.id, { type: 'closePanel' }).catch((error) => {
      console.error('Unable to forward close panel request:', error);
    });
  }
});
