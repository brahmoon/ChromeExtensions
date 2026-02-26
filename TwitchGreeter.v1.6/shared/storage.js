// shared/storage.js

/** syncSettings を読み込む */
function loadSyncSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEYS.SYNC_SETTINGS, result => {
      resolve({ ...DEFAULT_SYNC_SETTINGS, ...(result[STORAGE_KEYS.SYNC_SETTINGS] ?? {}) });
    });
  });
}

/** syncSettings を保存する */
function saveSyncSettings(settings) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_KEYS.SYNC_SETTINGS]: settings }, resolve);
  });
}

/** trackedEntities:index を読み込む */
function loadIndex() {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEYS.ENTITIES_INDEX, result => {
      resolve(result[STORAGE_KEYS.ENTITIES_INDEX] ?? { ids: [] });
    });
  });
}

/**
 * trackedEntities:index を「取得→マージ→保存」で更新する（冪等）
 * 重複する id を追加しても壊れない
 */
async function addEntityToIndex(entityId) {
  const current = await loadIndex();
  const merged = { ids: [...new Set([...current.ids, entityId])] };
  return new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_KEYS.ENTITIES_INDEX]: merged }, resolve);
  });
}

/**
 * trackedEntities:index から id を除去する（冪等）
 * 存在しない id を削除しても壊れない
 */
async function removeEntityFromIndex(entityId) {
  const current = await loadIndex();
  const merged = { ids: current.ids.filter(id => id !== entityId) };
  return new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_KEYS.ENTITIES_INDEX]: merged }, resolve);
  });
}

/** 個別 Entity を保存する */
function saveEntity(entityId, data) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [`${STORAGE_KEYS.ENTITY_PREFIX}${entityId}`]: data }, resolve);
  });
}

/** 個別 Entity を読み込む */
function loadEntity(entityId) {
  const key = `${STORAGE_KEYS.ENTITY_PREFIX}${entityId}`;
  return new Promise(resolve => {
    chrome.storage.local.get(key, result => resolve(result[key] ?? null));
  });
}

/** index に含まれる全 Entity を一括読み込みする */
async function loadAllEntities() {
  const index = await loadIndex();
  if (index.ids.length === 0) return {};

  const keys = index.ids.map(id => `${STORAGE_KEYS.ENTITY_PREFIX}${id}`);
  return new Promise(resolve => {
    chrome.storage.local.get(keys, result => {
      const entities = {};
      for (const id of index.ids) {
        const key = `${STORAGE_KEYS.ENTITY_PREFIX}${id}`;
        if (result[key] !== undefined) {
          entities[id] = result[key];
        }
      }
      resolve(entities);
    });
  });
}

/**
 * Entity を新規追加する
 * 書き込み順序: 個別キー保存 → index 更新（仕様必須順序）
 */
async function addEntity(entityId, data) {
  await saveEntity(entityId, data);
  await addEntityToIndex(entityId);
}

/** リセット：index を空にする（entity個別キーは孤立データとして残す） */
function resetIndex() {
  return new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_KEYS.ENTITIES_INDEX]: { ids: [] } }, resolve);
  });
}

/**
 * 孤立 entity キーをクリーンアップする
 * 起動時または onChanged での index 更新時に呼び出すことを推奨
 */
async function cleanupOrphanedEntityKeys(previousIds, currentIds) {
  const removed = (previousIds ?? []).filter(id => !currentIds.includes(id));
  const orphanKeys = removed.map(id => `${STORAGE_KEYS.ENTITY_PREFIX}${id}`);
  if (orphanKeys.length > 0) {
    await chrome.storage.local.remove(orphanKeys);
  }
}
