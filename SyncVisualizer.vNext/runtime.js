(function () {
  const state = {
    localCache: new Map(),
    settings: Object.assign({}, DEFAULT_SETTINGS),
    isBootstrapped: false,
    pendingMessageQueue: []
  };

  const el = {
    statusBar: document.getElementById('statusBar'),
    settingsView: document.getElementById('settingsView'),
    entityList: document.getElementById('entityList'),
    runtimeLog: document.getElementById('runtimeLog')
  };

  function log(message) {
    el.runtimeLog.textContent = new Date().toLocaleTimeString() + ' ' + message + '\n' + el.runtimeLog.textContent;
  }

  function renderSettings() {
    el.settingsView.innerHTML = [
      '<h2>Current Settings</h2>',
      '<div>featureEnabled: ' + state.settings.featureEnabled + '</div>',
      '<div>scopeMode: ' + state.settings.scopeMode + '</div>',
      '<div>scopeTargetId: ' + (state.settings.scopeTargetId || '-') + '</div>',
      '<div>themeToken: ' + state.settings.themeToken + '</div>'
    ].join('');
    document.documentElement.style.setProperty('--theme', state.settings.themeToken);
  }

  function updateDom(entityId, value) {
    const current = el.entityList.querySelector('li[data-id="' + CSS.escape(entityId) + '"]');

    if (!value) {
      if (current) {
        current.remove();
      }
      return;
    }

    const content = '<strong>' + entityId + '</strong><br/>checked=' + value.checked + '<br/>timestamp=' + new Date(value.timestamp).toLocaleString();

    if (current) {
      current.innerHTML = content;
      return;
    }

    const item = document.createElement('li');
    item.setAttribute('data-id', entityId);
    item.innerHTML = content;
    el.entityList.appendChild(item);
  }

  function applyEntityState(entityId, newValue) {
    const cached = state.localCache.has(entityId) ? state.localCache.get(entityId) : null;
    if (deepEqual(cached, newValue)) {
      return;
    }

    if (newValue) {
      state.localCache.set(entityId, newValue);
    } else {
      state.localCache.delete(entityId);
    }

    updateDom(entityId, newValue);
  }

  function applyIndex(index) {
    const validIds = new Set(index.ids || []);

    Array.from(state.localCache.keys()).forEach(function (entityId) {
      if (!validIds.has(entityId)) {
        applyEntityState(entityId, null);
      }
    });
  }

  async function applySettings(settings) {
    if (deepEqual(state.settings, settings)) {
      return;
    }
    state.settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    renderSettings();
    log('settings applied');
  }

  async function bootstrap() {
    el.statusBar.textContent = 'bootstrapping...';

    const settingsResult = await chrome.storage.local.get(STORAGE_KEYS.syncSettings);
    await applySettings(settingsResult[STORAGE_KEYS.syncSettings] || DEFAULT_SETTINGS);

    const indexResult = await chrome.storage.local.get(STORAGE_KEYS.trackedIndex);
    const index = indexResult[STORAGE_KEYS.trackedIndex] || { ids: [] };

    const keys = index.ids.map(entityKey);
    const entities = keys.length ? await chrome.storage.local.get(keys) : {};

    applyIndex(index);
    index.ids.forEach(function (id) {
      applyEntityState(id, entities[entityKey(id)] || null);
    });

    state.isBootstrapped = true;
    el.statusBar.textContent = 'bootstrapped: pendingQueue=' + state.pendingMessageQueue.length;
    flushPendingMessages();
    log('bootstrap complete');
  }

  function flushPendingMessages() {
    while (state.pendingMessageQueue.length > 0) {
      const message = state.pendingMessageQueue.shift();
      processMessage(message, true);
    }
  }

  function processMessage(message, fromQueue) {
    if (!state.isBootstrapped && !fromQueue) {
      state.pendingMessageQueue.push(message);
      log('message queued before bootstrap: ' + message.action);
      return;
    }

    if (message.action === MESSAGE_ACTIONS.settingsUpdated) {
      applySettings(message.payload);
      return;
    }

    if (message.action === MESSAGE_ACTIONS.entityDelta) {
      applyEntityState(message.payload.entityId, message.payload.value);
      return;
    }

    if (message.action === MESSAGE_ACTIONS.resetAll) {
      applyIndex({ ids: [] });
    }
  }

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || !message.action) {
      return;
    }
    processMessage(message, false);
  });

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local') {
      return;
    }

    if (changes.syncSettings) {
      applySettings(changes.syncSettings.newValue || DEFAULT_SETTINGS);
    }

    if (changes['trackedEntities:index']) {
      const next = changes['trackedEntities:index'].newValue || { ids: [] };
      applyIndex(next);

      const oldIds = (changes['trackedEntities:index'].oldValue && changes['trackedEntities:index'].oldValue.ids) || [];
      const removed = oldIds.filter(function (id) { return next.ids.indexOf(id) === -1; });
      if (removed.length > 0) {
        chrome.storage.local.remove(removed.map(entityKey));
      }

      next.ids.forEach(async function (id) {
        const result = await chrome.storage.local.get(entityKey(id));
        applyEntityState(id, result[entityKey(id)] || null);
      });
    }

    Object.keys(changes).forEach(function (key) {
      if (key.indexOf('trackedEntity:') !== 0) {
        return;
      }
      const entityId = key.replace('trackedEntity:', '');
      applyEntityState(entityId, changes[key].newValue || null);
    });
  });

  bootstrap();
})();
