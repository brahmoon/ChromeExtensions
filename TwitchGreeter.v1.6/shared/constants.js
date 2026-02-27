// shared/constants.js

/** storage キー */
const STORAGE_KEYS = {
  SYNC_SETTINGS: 'syncSettings',
  ENTITIES_INDEX: 'trackedEntities:index',
  ENTITY_PREFIX: 'trackedEntity:',
};

/** message action 名 */
const ACTIONS = {
  OPEN_POPUP_WINDOW: 'openPopupWindow',
  ENTITY_DELTA: 'entityDelta',
};

/** syncSettings のデフォルト値 */
const DEFAULT_SYNC_SETTINGS = {
  featureEnabled: true,
  scopeMode: 'specific',
  scopeTargetId: '',
  themeToken: '#6441a5',
};
