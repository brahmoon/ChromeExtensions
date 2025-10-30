const ACCESS_DATA_KEY = 'tabManagerAccessData';
const LEGACY_HISTORY_KEY = 'tabAccessHistory';
const LEGACY_EMA_KEY = 'tabAccessEma';

function getIndicatorClass(tab, emaValue) {
  if (tab.active) {
    return 'status-active';
  }

  if (emaValue >= 0.35) {
    return 'status-average';
  }

  if (emaValue >= 0.12) {
    return 'status-low';
  }

  return 'status-idle';
}

function normalizeAccessData(raw) {
  if (raw && typeof raw === 'object') {
    return {
      history: Array.isArray(raw.history) ? [...raw.history] : [],
      ema: raw.ema && typeof raw.ema === 'object' ? { ...raw.ema } : {}
    };
  }

  return { history: [], ema: {} };
}

async function refreshTabs() {
  const [tabs, storage] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get([
      ACCESS_DATA_KEY,
      LEGACY_HISTORY_KEY,
      LEGACY_EMA_KEY
    ])
  ]);

  const accessData = normalizeAccessData(storage[ACCESS_DATA_KEY]);
  if (!storage[ACCESS_DATA_KEY]) {
    accessData.history = Array.isArray(storage[LEGACY_HISTORY_KEY])
      ? [...storage[LEGACY_HISTORY_KEY]]
      : accessData.history;
    accessData.ema = storage[LEGACY_EMA_KEY] && typeof storage[LEGACY_EMA_KEY] === 'object'
      ? { ...storage[LEGACY_EMA_KEY] }
      : accessData.ema;
  }

  const list = document.getElementById('tab-list');
  list.innerHTML = '';

  const historyCounts = {};
  for (const tabId of accessData.history) {
    const key = String(tabId);
    historyCounts[key] = (historyCounts[key] || 0) + 1;
  }

  for (const tab of tabs) {
    const li = document.createElement('li');
    li.className = 'tab-item';
    if (tab.active) {
      li.classList.add('is-active');
    }

    const indicator = document.createElement('span');
    const emaValue = accessData.ema?.[String(tab.id)] || 0;
    indicator.className = `tab-indicator ${getIndicatorClass(tab, emaValue)}`;
    const viewCount = historyCounts[String(tab.id)] || 0;
    indicator.title = `表示回数: ${viewCount}\nEMA: ${emaValue.toFixed(2)}`;

    const content = document.createElement('div');
    content.className = 'tab-text';
    content.textContent = tab.title || '(no title)';

    const meta = document.createElement('span');
    meta.className = 'tab-meta';
    meta.textContent = viewCount ? `×${viewCount}` : '';

    li.appendChild(indicator);
    li.appendChild(content);
    li.appendChild(meta);

    li.addEventListener('click', async () => {
      await chrome.tabs.update(tab.id, { active: true });
      if (typeof tab.windowId === 'number') {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    });

    list.appendChild(li);
  }
}

function attachEventListeners() {
  document.getElementById('close-btn').addEventListener('click', () => {
    window.parent.postMessage({ type: 'TabManagerClosePanel' }, '*');
  });

  chrome.tabs.onActivated.addListener(refreshTabs);
  chrome.tabs.onCreated.addListener(refreshTabs);
  chrome.tabs.onRemoved.addListener(refreshTabs);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url) {
      refreshTabs();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }

    if (changes[ACCESS_DATA_KEY] || changes[LEGACY_HISTORY_KEY] || changes[LEGACY_EMA_KEY]) {
      refreshTabs();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  attachEventListeners();
  refreshTabs();
});
