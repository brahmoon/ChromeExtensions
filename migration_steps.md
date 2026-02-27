# sync_spec_vNext 移行手順書

## 概要

本書は、Twitch Greeter 拡張機能の同期処理を `sync_spec_vNext` アーキテクチャへ移行するための実装手順をまとめたものです。

### 変更の方針

| 観点 | 現在 | 移行後 |
|---|---|---|
| ストレージキー（設定） | `extensionEnabled`, `channelScope`, `targetChannelId`, `themeColor`（個別） | `syncSettings`（1オブジェクト） |
| ストレージキー（ユーザ） | `greetedUsers`（1オブジェクト一括） | `trackedEntities:index` + `trackedEntity:<userId>` （Option B） |
| 設定変更通知 | `settingsChanged` メッセージを都度送信 | `storage.onChanged` による最終整合に一本化。メッセージ通知は廃止 |
| ユーザ状態変更通知 | `updateGreetedStatus` / `resetAllGreetings` メッセージ | `entityDelta` メッセージ（storage書き込み後に送信）|
| content.js 初期化 | 同期的に storage を読み、即反映 | ブートストラップ完了後に `pendingMessageQueue` を処理 |
| リセット処理 | `greetedUsers: {}` を一括上書き | `trackedEntities:index` を `{ ids: [] }` に更新（index先行） |

### ファイル構成の変更

```
追加: shared/constants.js   ← action名・storageキーの定数定義
追加: shared/storage.js     ← storage読み書きのユーティリティ
変更: background.js         ← 軽微（UI起動仲介のみ、状態保持なし）
変更: popup.js              ← Control Surface として再設計
変更: content.js            ← Runtime Surface として再設計
```

---

## Step 1 ｜ `shared/constants.js` を新規作成する

マジックストリング禁止のため、全 action 名・storage キーを定数化します。

**ファイル:** `shared/constants.js`

```js
// shared/constants.js

/** storage キー */
const STORAGE_KEYS = {
  SYNC_SETTINGS: 'syncSettings',
  ENTITIES_INDEX: 'trackedEntities:index',
  ENTITY_PREFIX: 'trackedEntity:',
};

/** message action 名 */
const ACTIONS = {
  OPEN_POPUP_WINDOW:  'openPopupWindow',
  ENTITY_DELTA:       'entityDelta',
};

/** syncSettings のデフォルト値 */
const DEFAULT_SYNC_SETTINGS = {
  featureEnabled: true,
  scopeMode: 'specific',
  scopeTargetId: '',
  themeToken: '#6441a5',
};
```

`manifest.json` の `content_scripts.js` および popup に読み込み順を追加します。

```json
// manifest.json（content_scripts）
"js": ["shared/constants.js", "content.js"]

// popup.html
<script src="shared/constants.js"></script>
<script src="popup.js"></script>
```

---

## Step 2 ｜ `shared/storage.js` を新規作成する

storage 操作のユーティリティを一元化します。Promise ベースの非同期 API にラップし、各コンポーネントが直接 `chrome.storage.local` を叩かないようにします。

**ファイル:** `shared/storage.js`

```js
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

/** trackedEntities:index を「取得→マージ→保存」で更新する（冪等） */
async function addEntityToIndex(entityId) {
  const current = await loadIndex();
  const merged = { ids: [...new Set([...current.ids, entityId])] };
  return new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_KEYS.ENTITIES_INDEX]: merged }, resolve);
  });
}

async function removeEntityFromIndex(entityId) {
  const current = await loadIndex();
  const merged = { ids: current.ids.filter(id => id !== entityId) };
  return new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_KEYS.ENTITIES_INDEX]: merged }, resolve);
  });
}

/** 個別 Entity を保存する（書き込み順序: entity先行） */
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

/** Entity を新規追加する（entity保存 → index更新の順序を保証） */
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

/** 起動時：孤立 entity キーをクリーンアップする（推奨） */
async function cleanupOrphanedEntityKeys(previousIds, currentIds) {
  const removed = previousIds.filter(id => !currentIds.includes(id));
  const orphanKeys = removed.map(id => `${STORAGE_KEYS.ENTITY_PREFIX}${id}`);
  if (orphanKeys.length > 0) {
    await chrome.storage.local.remove(orphanKeys);
  }
}
```

`manifest.json` の `content_scripts.js` と popup にも追加します。

```json
// manifest.json（content_scripts）
"js": ["shared/constants.js", "shared/storage.js", "content.js"]

// popup.html
<script src="shared/constants.js"></script>
<script src="shared/storage.js"></script>
<script src="popup.js"></script>
```

---

## Step 3 ｜ `popup.js`（Control Surface）を改修する

### 3-1. storage キーの変更

設定の読み書き先を `syncSettings` 単一オブジェクトに変更します。

**削除する処理:**

```js
// 削除: defaultSettings オブジェクト（個別キー定義）
const defaultSettings = {
  extensionEnabled: true,
  channelScope: 'specific',
  ...
};

// 削除: 個別キーでの storage 読み書き
chrome.storage.local.set({ channelScope: scope }, ...);
chrome.storage.local.set({ targetChannelId: channelId }, ...);
chrome.storage.local.set({ extensionEnabled: enabled }, ...);
chrome.storage.local.set({ themeColor: themeColor }, ...);
```

**追加する処理:**

```js
// 追加: loadSyncSettings() / saveSyncSettings() を使用する

async function loadSettings() {
  const settings = await loadSyncSettings(); // shared/storage.js

  applyEnabledState(settings.featureEnabled);
  channelScopeSelect.value = settings.scopeMode;
  channelIdInput.value = settings.scopeTargetId || '';
  updateChannelIdVisibility(settings.scopeMode);
  applyThemeInputs(settings.themeToken);
}

// 設定変更時はオブジェクト全体を読み込み→マージ→保存する
async function updateSetting(patch) {
  const current = await loadSyncSettings();
  await saveSyncSettings({ ...current, ...patch });
  // ※ 通知不要。storage.onChanged が content.js に届く
}
```

各 UI イベントハンドラを `updateSetting()` を使う形に書き換えます。

```js
channelScopeSelect.addEventListener('change', function() {
  updateChannelIdVisibility(this.value);
  updateSetting({ scopeMode: this.value });
});

channelIdInput.addEventListener('input', function() {
  updateSetting({ scopeTargetId: this.value.trim() });
});

enabledToggle.addEventListener('change', function() {
  applyEnabledState(this.checked);
  updateSetting({ featureEnabled: this.checked });
});

themeColorPicker.addEventListener('input', function() {
  const normalized = normalizeHexColor(this.value) || '#6441a5';
  applyThemeInputs(normalized);
  updateSetting({ themeToken: normalized });
});
```

### 3-2. ユーザ一覧の読み込みを Option B 形式に変更する

**削除する処理:**

```js
// 削除: greetedUsers 一括オブジェクトの読み書き
chrome.storage.local.get('greetedUsers', function(data) { ... });
chrome.storage.local.set({ greetedUsers: updatedUsers }, ...);
```

**追加する処理:**

```js
async function loadGreetedUsers() {
  const userListElement = document.getElementById('userList');
  userListElement.innerHTML = '';

  const index = await loadIndex();         // shared/storage.js
  const entities = await loadAllEntities(); // shared/storage.js

  if (index.ids.length === 0) {
    userListElement.innerHTML = '<div class="empty-message">まだ挨拶したユーザーはいません</div>';
    return;
  }

  // ソート・描画ロジックは現行のまま流用。
  // ただし entities[userId] = { greeted, timestamp, username } を参照する。
  const sortedUsers = Object.entries(entities).sort((a, b) => { /* 既存ロジック */ });

  for (const [userId, userData] of sortedUsers) {
    // チェックボックス変更時
    checkbox.addEventListener('change', async function() {
      const isChecked = this.checked;
      const uid = this.getAttribute('data-user-id');

      // entity 更新（個別キー保存のみ。index は変更不要）
      await saveEntity(uid, { ...userData, greeted: isChecked }); // shared/storage.js

      // entityDelta を送信（storage 書き込み完了後）
      sendMessageToTwitchTabs({
        action: ACTIONS.ENTITY_DELTA,
        delta: { [uid]: { greeted: isChecked } }
      });
    });
  }
}
```

### 3-3. リセット処理を変更する

**削除する処理:**

```js
chrome.storage.local.set({ greetedUsers: {} }, ...);
// 削除: resetAllGreetings メッセージ送信
sendMessageToTwitchTabs({ action: 'resetAllGreetings' });
```

**追加する処理:**

```js
document.getElementById('resetBtn').addEventListener('click', async function() {
  if (confirm('すべての挨拶履歴をリセットしますか？')) {
    await resetIndex(); // shared/storage.js（index を { ids: [] } に更新）
    // ※ content.js は storage.onChanged → applyIndex() → clearLocalCacheAndDom() で自動反映
    loadGreetedUsers();
  }
});
```

### 3-4. `notifyFeatureStateChanged` / `settingsChanged` の送信を削除する

設定変更通知は `storage.onChanged` による最終整合に委ねるため、以下を削除します。

```js
// 削除する関数・呼び出し
function notifyFeatureStateChanged() { ... }
function notifyImmediateActivationIfMatched() { ... }
sendMessageToTwitchTabs({ action: 'settingsChanged' });
```

### 3-5. `storage.onChanged` を Option B 形式のフィルタリングに変更する

```js
chrome.storage.onChanged.addListener(function(changes, areaName) {
  if (areaName !== 'local') return;

  for (const key in changes) {
    if (key === STORAGE_KEYS.ENTITIES_INDEX || key.startsWith(STORAGE_KEYS.ENTITY_PREFIX)) {
      loadGreetedUsers(); // ユーザ一覧を再描画
    }
    // syncSettings の変化は popup 自身が書き込んだ場合のみ発生するため無視でよい
  }
});
```

---

## Step 4 ｜ `content.js`（Runtime Surface）を改修する

### 4-1. ブートストラップ処理の実装

**削除する処理:**

```js
// 削除: 旧起動処理
chrome.storage.local.get('greetedUsers', function(data) {
  if (data.greetedUsers) { greetedUsers = data.greetedUsers; }
  loadSettingsAndApply();
});
```

**追加する処理:**

```js
// 追加: localCache とブートストラップ制御
const localCache = {
  settings: { ...DEFAULT_SYNC_SETTINGS },
  index: { ids: [] },
  entities: {},        // { [userId]: { greeted, timestamp, username } }
  getIndex() { return this.index; },
  get(id) { return this.entities[id] ?? null; },
  set(id, val) { this.entities[id] = val; },
  delete(id) { delete this.entities[id]; },
  clear() { this.entities = {}; this.index = { ids: [] }; }
};

let isBootstrapped = false;
const pendingMessageQueue = [];

async function bootstrap() {
  // Step 1: 設定を読み込む
  localCache.settings = await loadSyncSettings(); // shared/storage.js
  applyThemeColor(localCache.settings.themeToken);

  // Step 2: index を読み込み、entity を一括取得する
  localCache.index = await loadIndex();
  localCache.entities = await loadAllEntities();

  // Step 3: UI を反映する
  applyFeatureState();

  // Step 4: ブートストラップ完了
  isBootstrapped = true;

  // Step 5: キューに溜まったメッセージを処理する
  while (pendingMessageQueue.length > 0) {
    const msg = pendingMessageQueue.shift();
    handleMessage(msg);
  }
}

bootstrap();
```

### 4-2. `chrome.runtime.onMessage` を改修する

**削除する action:**

- `updateGreetedStatus`
- `resetAllGreetings`
- `settingsChanged`

**追加する処理:**

```js
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (!message || !message.action) return;

  if (!isBootstrapped) {
    pendingMessageQueue.push(message);
    sendResponse({ success: true });
    return true;
  }

  handleMessage(message);
  sendResponse({ success: true });
  return true;
});

function handleMessage(message) {
  if (message.action === ACTIONS.ENTITY_DELTA) {
    handleEntityDelta(message.delta);
  }
  // openPopupWindow は background.js で処理するため content.js では不要
}

function handleEntityDelta(delta) {
  const index = localCache.getIndex();

  for (const [entityId, newValue] of Object.entries(delta)) {
    // index 存在チェック（必須）
    if (newValue !== null && !index.ids.includes(entityId)) return;

    applyEntityState(entityId, newValue);
  }
}
```

### 4-3. `storage.onChanged` を Option B 形式に変更する

**削除する処理:**

```js
// 削除: 旧 onChanged ハンドラ
chrome.storage.onChanged.addListener(function(changes, areaName) {
  if (changes.greetedUsers) { ... }
  if (changes.themeColor || changes.extensionEnabled || ...) { loadSettingsAndApply(); }
});
```

**追加する処理:**

```js
chrome.storage.onChanged.addListener(function(changes, area) {
  if (area !== 'local') return;

  for (const key in changes) {
    if (key.startsWith(STORAGE_KEYS.ENTITY_PREFIX)) {
      const entityId = key.replace(STORAGE_KEYS.ENTITY_PREFIX, '');
      applyEntityState(entityId, changes[key].newValue);
    } else if (key === STORAGE_KEYS.ENTITIES_INDEX) {
      const newIndex = changes[key].newValue ?? { ids: [] };
      applyIndex(newIndex, changes[key].oldValue);
    } else if (key === STORAGE_KEYS.SYNC_SETTINGS) {
      applySettings(changes[key].newValue);
    }
  }
});
```

### 4-4. `applyEntityState` / `applyIndex` / `applySettings` を実装する（循環更新防止ガード付き）

```js
function applyEntityState(entityId, newValue) {
  // 削除（null）の場合
  if (newValue === null) {
    localCache.delete(entityId);
    updateUserCheckboxes(entityId, false);
    return;
  }

  const cached = localCache.get(entityId);
  // 値が同一なら何もしない（循環更新・重複処理の防止）
  if (JSON.stringify(cached) === JSON.stringify(newValue)) return;

  localCache.set(entityId, newValue);
  updateUserCheckboxes(entityId, newValue.greeted ?? false);
}

function applyIndex(newIndex, oldIndex) {
  const isDeepEqual = JSON.stringify(localCache.index) === JSON.stringify(newIndex);
  if (isDeepEqual) return;

  localCache.index = newIndex;

  // index が空 → 全リセット
  if (newIndex.ids.length === 0) {
    clearLocalCacheAndDom();
    return;
  }

  // 削除された id の entity を除去する
  const removedIds = (oldIndex?.ids ?? []).filter(id => !newIndex.ids.includes(id));
  for (const id of removedIds) {
    localCache.delete(id);
    updateUserCheckboxes(id, false);
  }

  // 孤立キーのクリーンアップ（推奨）
  cleanupOrphanedEntityKeys(oldIndex?.ids ?? [], newIndex.ids);
}

function applySettings(newSettings) {
  if (!newSettings) return;
  const merged = { ...DEFAULT_SYNC_SETTINGS, ...newSettings };
  if (JSON.stringify(localCache.settings) === JSON.stringify(merged)) return;

  localCache.settings = merged;
  applyThemeColor(merged.themeToken);
  applyFeatureState();
}

function clearLocalCacheAndDom() {
  localCache.clear();
  const allCheckboxes = document.querySelectorAll('.greeting-checkbox input');
  allCheckboxes.forEach(cb => { cb.checked = false; });
  // greetedUsers 変数は localCache.entities への参照に変更する（下記 Step 4-5 参照）
}
```

### 4-5. `greetedUsers` 変数を `localCache.entities` に置き換える

`content.js` 内で `greetedUsers` を直接参照している箇所を全て `localCache.entities` に置き換えます。主な対象は以下の通りです。

| 旧コード | 新コード |
|---|---|
| `greetedUsers[userId]` | `localCache.get(userId)` |
| `greetedUsers[userId] = { ... }` | `localCache.set(userId, { ... })` |
| `greetedUsers = {}` | `localCache.clear()` |
| `for (const userId in greetedUsers)` | `for (const userId of localCache.index.ids)` |

### 4-6. Entity 書き込みフローを Option B 形式に変更する

`ensureDetectedUserTracked`（新規ユーザ検出時）と、チェックボックス変更時の storage 書き込みを変更します。

**削除する処理:**

```js
// 削除: 一括上書き
chrome.storage.local.set({ greetedUsers: greetedUsers });
```

**追加する処理:**

```js
// 新規ユーザ検出時（entity先行 → index更新の順序を保証）
async function ensureDetectedUserTracked(messageElement, userId) {
  if (!userId || localCache.get(userId)) return;

  const resolvedUsername = resolveUsernameFromMessage(messageElement, userId);
  const newEntity = { greeted: false, timestamp: Date.now(), username: resolvedUsername };

  // 楽観的更新（UI即時反映）
  localCache.set(userId, newEntity);
  localCache.index.ids.push(userId);

  // storage への書き込み（entity先行 → index更新）
  await addEntity(userId, newEntity); // shared/storage.js
}

// チェックボックス変更時
inputElement.addEventListener('change', async function() {
  const userid = this.getAttribute('data-user-id');
  const isChecked = this.checked;

  // 楽観的更新
  updateUserCheckboxes(userid, isChecked);
  const current = localCache.get(userid);
  if (current) {
    const updated = { ...current, greeted: isChecked };
    localCache.set(userid, updated);

    // storage 更新（entity のみ。index は変更不要）
    await saveEntity(userid, updated); // shared/storage.js

    // entityDelta 送信（storage 書き込み完了後）
    chrome.runtime.sendMessage({
      action: ACTIONS.ENTITY_DELTA,
      delta: { [userid]: { greeted: isChecked } }
    });
  }
});
```

### 4-7. `isFeatureActiveOnCurrentPage` を `localCache.settings` 参照に変更する

```js
function isFeatureActiveOnCurrentPage() {
  const s = localCache.settings;
  if (!s.featureEnabled) return false;
  if (s.scopeMode === 'specific') {
    const target = (s.scopeTargetId || '').trim().toLowerCase();
    if (!target) return false;
    return getCurrentChannelId() === target;
  }
  return true;
}
```

### 4-8. `cleanupOldGreetings` を Option B 形式に変更する

```js
async function cleanupOldGreetings() {
  const now = Date.now();
  const oneDayInMs = 24 * 60 * 60 * 1000;
  const index = await loadIndex();

  for (const userId of index.ids) {
    const entity = localCache.get(userId);
    if (entity && entity.timestamp && (now - entity.timestamp > oneDayInMs) && entity.greeted) {
      const updated = { ...entity, greeted: false };
      localCache.set(userId, updated);
      await saveEntity(userId, updated); // shared/storage.js
      updateUserCheckboxes(userId, false);
    }
  }
}
```

---

## Step 5 ｜ `background.js` の確認（変更なし）

`background.js` は Coordinator として UI 起動のみを担います。現行実装はすでに「状態保持なし・UI起動仲介のみ」の設計になっているため、**変更は不要です**。

action 名の文字列 `'openPopupWindow'` のみ定数参照に変更します（任意）。

```js
// 変更前
if (!message || message.action !== 'openPopupWindow') { return; }

// 変更後（shared/constants.js を background.js でも import する場合）
if (!message || message.action !== ACTIONS.OPEN_POPUP_WINDOW) { return; }
```

> `background.js` は Service Worker のため `shared/constants.js` を `importScripts` で読み込みます。

```json
// manifest.json
"background": {
  "service_worker": "background.js",
  "scripts": ["shared/constants.js"]  // または background.js 先頭で importScripts
}
```

---

## Step 6 ｜ `manifest.json` を更新する

```json
{
  "content_scripts": [
    {
      "matches": ["*://*.twitch.tv/*"],
      "js": [
        "shared/constants.js",
        "shared/storage.js",
        "content.js"
      ],
      "css": ["style.css"]
    }
  ],
  "background": {
    "service_worker": "background.js"
  }
}
```

`popup.html` の `<script>` タグも順序通りに更新します。

```html
<script src="shared/constants.js"></script>
<script src="shared/storage.js"></script>
<script src="popup.js"></script>
```

---

## 移行チェックリスト

```
□ shared/constants.js を新規作成した
□ shared/storage.js を新規作成した
□ manifest.json の content_scripts に shared/*.js を追加した
□ popup.html の script タグを更新した
□ popup.js: 設定読み書きを syncSettings に変更した
□ popup.js: settingsChanged / notifyFeatureStateChanged の送信を削除した
□ popup.js: ユーザ一覧を Option B 形式（index + 個別entity）で読み込むよう変更した
□ popup.js: リセットを resetIndex() に変更した
□ content.js: bootstrap() によるブートストラップ処理を実装した
□ content.js: pendingMessageQueue を実装した
□ content.js: onMessage を entityDelta のみ受信するよう変更した
□ content.js: storage.onChanged を Option B フィルタリングに変更した
□ content.js: applyEntityState / applyIndex / applySettings の循環更新防止ガードを実装した
□ content.js: greetedUsers を localCache.entities に置き換えた
□ content.js: 新規ユーザ追加を addEntity()（entity先行→index更新）に変更した
□ content.js: チェックボックス変更後に entityDelta を送信するよう変更した
□ background.js: action 名を定数参照に変更した（任意）
□ 動作確認：設定変更がリアルタイムで content.js に反映されること
□ 動作確認：チェックボックス操作が popup.js のユーザ一覧に反映されること
□ 動作確認：リセット後に全チェックボックスが解除されること
□ 動作確認：拡張再起動後に状態が正しく復元されること
```

---

## 補足：メッセージフロー変更のまとめ

### 設定変更

```
旧: popup.js → storage.set（個別キー） → sendMessage(settingsChanged) → content.js
新: popup.js → storage.set(syncSettings) → [storage.onChanged] → content.js（applySettings）
```

### ユーザ状態変更（popup 起点）

```
旧: popup.js → storage.set(greetedUsers一括) → sendMessage(updateGreetedStatus) → content.js
新: popup.js → storage.set(trackedEntity:<id>) → [entityDelta メッセージ] → content.js（applyEntityState）
                                                  [storage.onChanged フォールバック] → content.js
```

### ユーザ状態変更（content.js 起点）

```
旧: content.js → storage.set(greetedUsers一括) → [storage.onChanged] → popup.js
新: content.js → storage.set(trackedEntity:<id>) + addEntityToIndex()
              → [entityDelta メッセージ送信（任意）]
              → [storage.onChanged] → popup.js（loadGreetedUsers 再実行）
```

### リセット

```
旧: popup.js → storage.set(greetedUsers:{}) → sendMessage(resetAllGreetings) → content.js
新: popup.js → storage.set(trackedEntities:index: {ids:[]})
             → [storage.onChanged → applyIndex(空) → clearLocalCacheAndDom()] → content.js
```
