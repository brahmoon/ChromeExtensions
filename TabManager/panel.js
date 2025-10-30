const ALPHA = 0.3;
const list = document.getElementById('tab-list');
const closeButton = document.getElementById('close-btn');

closeButton.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'closePanel' });
});

function effectiveEma(stat, currentSequence) {
  if (!stat) {
    return 0;
  }
  const lastSequence = stat.lastSequence || currentSequence;
  const steps = Math.max(0, currentSequence - lastSequence);
  if (steps === 0) {
    return stat.ema;
  }
  return stat.ema * Math.pow(1 - ALPHA, steps);
}

async function fetchState() {
  const stored = await chrome.storage.local.get('accessState');
  return stored.accessState || { sequence: 0, history: [], ema: {} };
}

function buildCounts(history) {
  const counts = new Map();
  for (const id of history || []) {
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function getStatusClass(tab, emaScore, baseline) {
  if (tab.active) {
    return 'status-active';
  }
  if (emaScore >= baseline) {
    return 'status-average';
  }
  if (emaScore >= baseline * 0.4) {
    return 'status-low';
  }
  return 'status-inactive';
}

function formatTooltip(count, emaScore) {
  const emaDisplay = emaScore.toFixed(2);
  return `Recent views: ${count}\nEMA score: ${emaDisplay}`;
}

async function refreshTabs() {
  try {
    const [tabs, state] = await Promise.all([
      chrome.tabs.query({ currentWindow: true }),
      fetchState()
    ]);

    const counts = buildCounts(state.history);
    const sequence = state.sequence || 0;

    const tabStats = tabs.map((tab) => {
      const stat = state.ema?.[tab.id];
      const emaScore = effectiveEma(stat, sequence);
      const count = counts.get(tab.id) || 0;
      return { tab, emaScore, count };
    });

    const nonActive = tabStats.filter((item) => !item.tab.active);
    const averageScore = nonActive.length
      ? nonActive.reduce((sum, item) => sum + item.emaScore, 0) / nonActive.length
      : 0;
    const baseline = Math.max(averageScore, 0.1);

    list.innerHTML = '';

    for (const { tab, emaScore, count } of tabStats) {
      const li = document.createElement('li');
      li.className = 'tab-item';
      li.title = tab.title || '(no title)';

      const icon = document.createElement('span');
      icon.className = `tab-status-icon ${getStatusClass(tab, emaScore, baseline)}`;
      icon.title = formatTooltip(count, emaScore);

      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tab.title || '(no title)';

      const meta = document.createElement('span');
      meta.className = 'tab-meta';
      meta.textContent = `${count}`;
      meta.title = formatTooltip(count, emaScore);

      li.appendChild(icon);
      li.appendChild(title);
      li.appendChild(meta);

      if (tab.active) {
        li.classList.add('is-active');
      }

      li.addEventListener('click', () => {
        chrome.tabs.update(tab.id, { active: true });
      });

      list.appendChild(li);
    }
  } catch (error) {
    console.error('Failed to refresh tabs', error);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.accessState) {
    refreshTabs();
  }
});

chrome.tabs.onActivated.addListener(() => refreshTabs());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.title) {
    refreshTabs();
  }
});
chrome.tabs.onRemoved.addListener(() => refreshTabs());

refreshTabs();
