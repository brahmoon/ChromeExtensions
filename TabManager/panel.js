const HISTORY_KEY = 'tabAccessHistory';
const EMA_KEY = 'tabAccessEma';

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

async function refreshTabs() {
  const [tabs, metrics] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get({
      [HISTORY_KEY]: [],
      [EMA_KEY]: {}
    })
  ]);

  const list = document.getElementById('tab-list');
  list.innerHTML = '';

  const historyCounts = {};
  for (const tabId of metrics[HISTORY_KEY]) {
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
    const emaValue = metrics[EMA_KEY]?.[String(tab.id)] || 0;
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
    if (areaName === 'local' && (changes[HISTORY_KEY] || changes[EMA_KEY])) {
      refreshTabs();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  attachEventListeners();
  refreshTabs();
});
