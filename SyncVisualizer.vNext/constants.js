const STORAGE_KEYS = {
  syncSettings: 'syncSettings',
  trackedIndex: 'trackedEntities:index'
};

const MESSAGE_ACTIONS = {
  settingsUpdated: 'SYNC_SETTINGS_UPDATED',
  entityDelta: 'SYNC_ENTITY_DELTA',
  resetAll: 'SYNC_RESET_ALL',
  openRuntime: 'OPEN_RUNTIME_SURFACE'
};

const DEFAULT_SETTINGS = {
  featureEnabled: true,
  scopeMode: 'all',
  scopeTargetId: '',
  themeToken: '#6441a5'
};

function entityKey(entityId) {
  return 'trackedEntity:' + entityId;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
