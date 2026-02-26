(function () {
  const badge = document.createElement('div');
  badge.style.position = 'fixed';
  badge.style.right = '12px';
  badge.style.bottom = '12px';
  badge.style.zIndex = '2147483647';
  badge.style.padding = '8px 10px';
  badge.style.fontSize = '12px';
  badge.style.borderRadius = '8px';
  badge.style.color = '#ffffff';
  badge.style.background = '#334155';
  badge.style.boxShadow = '0 2px 8px rgba(0,0,0,.35)';
  badge.textContent = 'Sync Demo: loading...';
  document.documentElement.appendChild(badge);

  function setBadge(settings, index) {
    badge.style.background = settings.featureEnabled ? settings.themeToken : '#64748b';
    badge.textContent = 'Sync Demo [' + (settings.featureEnabled ? 'ON' : 'OFF') + '] entities=' + index.ids.length;
  }

  async function refresh() {
    const keys = await chrome.storage.local.get([STORAGE_KEYS.syncSettings, STORAGE_KEYS.trackedIndex]);
    const settings = Object.assign({}, DEFAULT_SETTINGS, keys[STORAGE_KEYS.syncSettings] || {});
    const index = keys[STORAGE_KEYS.trackedIndex] || { ids: [] };
    setBadge(settings, index);
  }

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName === 'local' && (changes.syncSettings || changes['trackedEntities:index'])) {
      refresh();
    }
  });

  refresh();
})();
