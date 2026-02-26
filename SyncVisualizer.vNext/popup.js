(function () {
  const el = {
    featureEnabled: document.getElementById('featureEnabled'),
    scopeMode: document.getElementById('scopeMode'),
    scopeTargetId: document.getElementById('scopeTargetId'),
    themeToken: document.getElementById('themeToken'),
    saveSettings: document.getElementById('saveSettings'),
    entityId: document.getElementById('entityId'),
    addEntity: document.getElementById('addEntity'),
    removeEntityId: document.getElementById('removeEntityId'),
    removeEntity: document.getElementById('removeEntity'),
    resetAll: document.getElementById('resetAll'),
    openRuntime: document.getElementById('openRuntime'),
    entityState: document.getElementById('entityState'),
    log: document.getElementById('log')
  };

  function writeLog(message) {
    el.log.textContent = new Date().toLocaleTimeString() + ' ' + message + '\n' + el.log.textContent;
  }

  async function loadSettings() {
    const result = await chrome.storage.local.get(STORAGE_KEYS.syncSettings);
    const settings = Object.assign({}, DEFAULT_SETTINGS, result[STORAGE_KEYS.syncSettings] || {});
    el.featureEnabled.checked = !!settings.featureEnabled;
    el.scopeMode.value = settings.scopeMode;
    el.scopeTargetId.value = settings.scopeTargetId;
    el.themeToken.value = settings.themeToken;
  }

  async function readIndex() {
    const result = await chrome.storage.local.get(STORAGE_KEYS.trackedIndex);
    return result[STORAGE_KEYS.trackedIndex] || { ids: [] };
  }

  async function renderEntityState() {
    const index = await readIndex();
    const keys = index.ids.map(entityKey);
    const entities = keys.length ? await chrome.storage.local.get(keys) : {};
    const mapped = {};
    index.ids.forEach(function (id) {
      mapped[id] = entities[entityKey(id)] || null;
    });
    el.entityState.textContent = JSON.stringify({ index: index, entities: mapped }, null, 2);
  }

  async function saveSettings() {
    const settings = {
      featureEnabled: el.featureEnabled.checked,
      scopeMode: el.scopeMode.value,
      scopeTargetId: el.scopeTargetId.value.trim(),
      themeToken: el.themeToken.value
    };

    await chrome.storage.local.set({ syncSettings: settings });
    chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.settingsUpdated, payload: settings }).catch(function () {
      writeLog('NO_RECEIVER: settings message は未受信（storageで最終整合）');
    });
    writeLog('settings saved');
  }

  async function addOrUpdateEntity() {
    const id = el.entityId.value.trim();
    if (!id) {
      return;
    }

    const payload = { checked: true, timestamp: Date.now() };
    const key = entityKey(id);

    await chrome.storage.local.set({ [key]: payload });

    const currentIndex = await readIndex();
    const merged = { ids: Array.from(new Set(currentIndex.ids.concat(id))) };
    await chrome.storage.local.set({ 'trackedEntities:index': merged });

    chrome.runtime.sendMessage({
      action: MESSAGE_ACTIONS.entityDelta,
      payload: { entityId: id, value: payload }
    }).catch(function () {
      writeLog('NO_RECEIVER: entityDelta message は未受信（storageで最終整合）');
    });

    writeLog('entity upsert: ' + id);
    await renderEntityState();
    el.entityId.value = '';
  }

  async function removeEntity() {
    const id = el.removeEntityId.value.trim();
    if (!id) {
      return;
    }

    const currentIndex = await readIndex();
    const merged = {
      ids: currentIndex.ids.filter(function (entityId) { return entityId !== id; })
    };
    await chrome.storage.local.set({ 'trackedEntities:index': merged });
    await chrome.storage.local.remove(entityKey(id));

    chrome.runtime.sendMessage({
      action: MESSAGE_ACTIONS.entityDelta,
      payload: { entityId: id, value: null }
    }).catch(function () {
      writeLog('NO_RECEIVER: remove entity message は未受信（storageで最終整合）');
    });

    writeLog('entity removed: ' + id);
    await renderEntityState();
    el.removeEntityId.value = '';
  }

  async function resetAll() {
    await chrome.storage.local.set({ 'trackedEntities:index': { ids: [] } });
    chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.resetAll }).catch(function () {
      writeLog('NO_RECEIVER: reset message は未受信（storageで最終整合）');
    });
    writeLog('reset completed (index only)');
    await renderEntityState();
  }

  el.saveSettings.addEventListener('click', saveSettings);
  el.addEntity.addEventListener('click', addOrUpdateEntity);
  el.removeEntity.addEventListener('click', removeEntity);
  el.resetAll.addEventListener('click', resetAll);
  el.openRuntime.addEventListener('click', function () {
    chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.openRuntime });
  });

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local') {
      return;
    }

    if (changes['trackedEntities:index'] || changes.syncSettings) {
      renderEntityState();
      loadSettings();
    }
  });

  loadSettings();
  renderEntityState();
})();
