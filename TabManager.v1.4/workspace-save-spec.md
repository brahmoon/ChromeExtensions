# Workspace Save 機能 実装設計書

> **対象拡張**: TabManager.v1.3-a（Manifest V3）  
> **機能概要**: ページ内で選択したテキスト・画像を、出典URL/タイトルとともにワークスペースに右クリック保存する

---

## 1. 機能概要

### 何ができるか

Webページ上でテキストを選択、または画像を右クリックすると、  
コンテキストメニューに「ワークスペースに保存」が出現する。  
選択した**情報（テキストまたは画像）が主役**であり、URLはその出典メタデータとして付与される。

```
ユーザー操作:
  テキストを選択 → 右クリック → 「ワークスペースにテキストを保存」
  画像を右クリック          → 「ワークスペースに画像を保存」

保存されるもの:
  {
    選択テキスト or 画像URL,
    出典ページURL,
    出典ページタイトル,
    保存日時,
    ウィンドウID,
    グループ（任意）
  }
```

### 既存機能との関係

| 既存機能 | 本機能 |
|---|---|
| ブックマーク（URL保存） | 情報の断片を保存 |
| プレビューキャッシュ（揮発性） | 永続保存（IndexedDB） |
| タブ管理（開いている状態管理） | タブを閉じた後も残る |

---

## 2. システム全体像

### アーキテクチャ図

```
┌──────────────────────────────────────────────────────────────┐
│  Webページ（任意のサイト）                                      │
│                                                              │
│  ① ユーザーがテキスト選択 or 画像を右クリック                    │
│  ② contextmenu イベントで選択内容を content.js がキャプチャ     │
│     └─ pendingCapture = { text, imageUrl, pageTitle, ... }  │
└──────────────────┬───────────────────────────────────────────┘
                   │ postMessage / chrome.runtime.sendMessage
┌──────────────────▼───────────────────────────────────────────┐
│  background.js（Service Worker）                              │
│                                                              │
│  ③ chrome.contextMenus.onClicked が発火                      │
│  ④ chrome.tabs.sendMessage で content.js から capture を取得  │
│  ⑤ info オブジェクト（Chrome提供）と capture をマージ          │
│  ⑥ workspace-db.js 経由で IndexedDB に保存                   │
│  ⑦ chrome.storage.local に更新シグナルを書き込み              │
└──────────────────┬───────────────────────────────────────────┘
                   │ chrome.storage.onChanged
┌──────────────────▼───────────────────────────────────────────┐
│  panel.js（拡張パネル）                                        │
│                                                              │
│  ⑧ storage変化を検知 → ワークスペースビューを更新              │
└──────────────────────────────────────────────────────────────┘
```

### データフロー詳細

```
[content.js]
  contextmenu イベント発火
    → selectedText = window.getSelection().toString()
    → imageUrl = event.target.src (IMG要素の場合)
    → pendingCapture に保存（メモリ上に一時保持）

[Chrome ブラウザ]
  contextMenus.onClicked
    → info.selectionText（選択テキスト）
    → info.srcUrl（画像URL）
    → info.pageUrl（ページURL）
    → tab オブジェクト（windowId, title等）
    ※ pageTitle は info に含まれないため content.js から補完

[background.js]
  content.js に WorkspaceFlushPendingCapture を送信
  → capture.pageTitle を取得
  → WorkspaceItem を構築
  → IndexedDB に保存
  → WORKSPACE_UPDATED_KEY を chrome.storage.local に書き込み

[panel.js]
  chrome.storage.onChanged で WORKSPACE_UPDATED_KEY を検知
  → renderWorkspaceView() を呼び出し
```

---

## 3. 変更・追加ファイル一覧

| ファイル | 変更種別 | 主な変更内容 |
|---|---|---|
| `manifest.json` | 変更 | `contextMenus` 権限追加、`workspace-db.js` を background に追加 |
| `content.js` | 変更 | contextmenu イベントで選択内容キャプチャ、メッセージ応答を追加 |
| `background.js` | 変更 | contextMenus 登録・onClicked ハンドラ追加、workspace-db.js import |
| `workspace-db.js` | **新規** | IndexedDB の CRUD 全操作を担当 |
| `panel.html` | 変更 | ワークスペースビューのコンテナ追加 |
| `panel.js` | 変更 | ワークスペースビューのレンダリング・storage 監視追加 |
| `styles.css` | 変更 | ワークスペースUI用スタイル追加 |

---

## 4. 実装技術の詳細

### 4.1 コンテキストメニューの登録（MV3 の注意点）

MV3 の Service Worker は**起動のたびにメモリが初期化される**ため、  
`onInstalled` だけでなく `onStartup` でも再登録が必要。  
また `removeAll()` で重複登録を防ぐ。

```js
// background.js

function registerWorkspaceContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'workspace-save-text',
      title: 'ワークスペースにテキストを保存',
      contexts: ['selection'],        // テキスト選択時のみ表示
    });
    chrome.contextMenus.create({
      id: 'workspace-save-image',
      title: 'ワークスペースに画像を保存',
      contexts: ['image'],            // 画像右クリック時のみ表示
    });
  });
}

// Service Worker 再起動のたびに登録
chrome.runtime.onInstalled.addListener(registerWorkspaceContextMenus);
chrome.runtime.onStartup.addListener(registerWorkspaceContextMenus);
```

### 4.2 選択内容のキャプチャ戦略

`chrome.contextMenus.onClicked` の `info` オブジェクトは  
`selectionText`・`srcUrl`・`pageUrl` を持つが、**`pageTitle` を含まない**。  
また `selectionText` は改行やホワイトスペースが崩れる場合がある。

そのため `contextmenu` イベント時点で content.js がキャプチャして保持し、  
background.js からの問い合わせに応答する設計を採用する。

```
情報ソースの優先順位:

テキスト:  info.selectionText（Chrome提供、確実）
           → 補完: capture.selectedText（content.js、詳細）

画像URL:   info.srcUrl（Chrome提供、IMG要素）
           → 補完: capture.imageUrl（content.js、リンク画像等も対応）

ページURL: info.pageUrl（Chrome提供、確実）

ページタイトル: capture.pageTitle（content.js 経由のみ取得可能）
```

### 4.3 IndexedDB の設計

`chrome.storage.local` は 10MB 制限のため、  
画像URLを多数保存する本機能には IndexedDB が適切。  
Service Worker 環境（MV3）は IndexedDB に直接アクセス可能。

```
DB: TabManagerWorkspace  v1
└── objectStore: items
    keyPath: id (UUID)
    indexes:
      - createdAt   → 日付順ソート
      - groupId     → グループフィルタ
      - pageUrl     → 同一ページのアイテム集約
```

### 4.4 ウィンドウをまたいだ動作

`chrome.contextMenus.onClicked` のコールバックは  
`tab` オブジェクト（`tab.windowId` を含む）を受け取るため、  
どのウィンドウからの保存かを自動的に記録できる。  
将来的に展開ビューのウィンドウ列と軸を合わせた表示も可能になる。

---

## 5. サンプルコード

### 5.1 manifest.json

```json
{
  "manifest_version": 3,
  "permissions": [
    "tabs",
    "activeTab",
    "scripting",
    "storage",
    "tabGroups",
    "bookmarks",
    "contextMenus"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "web_accessible_resources": [
    {
      "resources": ["panel.html", "styles.css", "panel.js"],
      "matches": ["<all_urls>"]
    }
  ],
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"]
    }
  ]
}
```

> `"type": "module"` にすることで background.js から workspace-db.js を  
> `import` できるようになる。既存コードが `import` を使っていない場合は  
> `workspace-db.js` の内容を background.js にインライン展開する方法もある。

---

### 5.2 content.js（追加部分）

```js
// ── ワークスペース保存：選択内容の事前キャプチャ ──────────────

let pendingWorkspaceCapture = null;

document.addEventListener('contextmenu', (event) => {
  const target = event.target;

  // テキスト選択を取得
  const selection = window.getSelection();
  const selectedText = selection ? selection.toString().trim() : '';

  // 画像URLを取得（IMG要素直接、またはobject-fit等でimgが子要素の場合も考慮）
  let imageUrl = null;
  if (target.tagName === 'IMG' && target.src) {
    imageUrl = target.src;
  } else if (target.closest('img')) {
    imageUrl = target.closest('img').src;
  }

  // 選択もなく画像でもない場合はクリア
  if (!selectedText && !imageUrl) {
    pendingWorkspaceCapture = null;
    return;
  }

  pendingWorkspaceCapture = {
    selectedText: selectedText || null,
    imageUrl: imageUrl || null,
    pageUrl: location.href,
    pageTitle: document.title,
    capturedAt: Date.now(),
  };
});

// background.js からの取得要求に応答
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'WorkspaceFlushPendingCapture') {
    sendResponse({ capture: pendingWorkspaceCapture });
    pendingWorkspaceCapture = null; // 取得後はクリア
    return true; // 非同期応答を示すフラグ
  }
});
```

---

### 5.3 workspace-db.js（新規ファイル）

```js
// workspace-db.js
// IndexedDB の CRUD を担当する。background.js から利用する。

const WS_DB_NAME    = 'TabManagerWorkspace';
const WS_DB_VERSION = 1;
const WS_STORE_NAME = 'items';

let _db = null;

/**
 * DB接続を返す（初回のみ openRequest を実行）
 */
function openWorkspaceDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WS_DB_NAME, WS_DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(WS_STORE_NAME)) {
        const store = db.createObjectStore(WS_STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('groupId',   'groupId',   { unique: false });
        store.createIndex('pageUrl',   'pageUrl',   { unique: false });
      }
    };

    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror   = ()  => reject(req.error);
  });
}

/**
 * アイテムを保存（上書き）
 * @param {WorkspaceItem} item
 */
export async function saveWorkspaceItem(item) {
  const db = await openWorkspaceDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WS_STORE_NAME, 'readwrite');
    tx.objectStore(WS_STORE_NAME).put(item);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

/**
 * 全アイテムを取得（groupId でフィルタ可能）
 * @param {{ groupId?: string }} options
 * @returns {Promise<WorkspaceItem[]>}
 */
export async function getAllWorkspaceItems({ groupId } = {}) {
  const db = await openWorkspaceDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(WS_STORE_NAME, 'readonly');
    const store = tx.objectStore(WS_STORE_NAME);
    const req   = groupId
      ? store.index('groupId').getAll(groupId)
      : store.getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * アイテムを削除
 * @param {string} id
 */
export async function deleteWorkspaceItem(id) {
  const db = await openWorkspaceDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WS_STORE_NAME, 'readwrite');
    tx.objectStore(WS_STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

/**
 * グループ一覧を取得（groupId の重複なしリスト）
 * @returns {Promise<string[]>}
 */
export async function getWorkspaceGroups() {
  const items = await getAllWorkspaceItems();
  const seen  = new Set();
  return items
    .map(item => item.groupId)
    .filter(g => g && !seen.has(g) && seen.add(g));
}

/*
 * WorkspaceItem の型定義（JSDoc）
 *
 * @typedef {Object} WorkspaceItem
 * @property {string}      id             - crypto.randomUUID()
 * @property {'text'|'image'} type        - アイテム種別
 * @property {string|null} text           - 選択テキスト（type=text の場合）
 * @property {string|null} imageUrl       - 画像URL（type=image の場合）
 * @property {string}      pageUrl        - 保存元ページのURL
 * @property {string}      pageTitle      - 保存元ページのタイトル
 * @property {string|null} groupId        - ワークスペースグループID（null = 未分類）
 * @property {number}      createdAt      - 保存日時（Unix ms）
 * @property {number}      windowId       - 保存元ウィンドウID
 */
```

---

### 5.4 background.js（追加部分）

```js
// ── 定数追加 ────────────────────────────────────────────────

const WORKSPACE_SAVE_TEXT_MENU_ID  = 'workspace-save-text';
const WORKSPACE_SAVE_IMAGE_MENU_ID = 'workspace-save-image';
const WORKSPACE_FLUSH_CAPTURE_MSG  = 'WorkspaceFlushPendingCapture';
const WORKSPACE_UPDATED_KEY        = 'tabManagerWorkspaceUpdated';

// ── コンテキストメニュー登録 ─────────────────────────────────

function registerWorkspaceContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: WORKSPACE_SAVE_TEXT_MENU_ID,
      title: 'ワークスペースにテキストを保存',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: WORKSPACE_SAVE_IMAGE_MENU_ID,
      title: 'ワークスペースに画像を保存',
      contexts: ['image'],
    });
  });
}

chrome.runtime.onInstalled.addListener(registerWorkspaceContextMenus);
chrome.runtime.onStartup.addListener(registerWorkspaceContextMenus);

// ── クリック時の保存処理 ─────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuId = info.menuItemId;
  if (
    menuId !== WORKSPACE_SAVE_TEXT_MENU_ID &&
    menuId !== WORKSPACE_SAVE_IMAGE_MENU_ID
  ) {
    return;
  }

  if (!tab?.id) {
    console.warn('Workspace save: tab ID is missing');
    return;
  }

  // content.js から pageTitle 等を取得（失敗しても続行）
  let capture = null;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: WORKSPACE_FLUSH_CAPTURE_MSG,
    });
    capture = response?.capture ?? null;
  } catch {
    // chrome:// 等、content_scripts が動作しないページでは失敗する
    console.debug('Workspace save: could not flush capture from content.js');
  }

  // info（Chrome提供）と capture（content.js提供）をマージ
  const isImage = menuId === WORKSPACE_SAVE_IMAGE_MENU_ID;

  /** @type {WorkspaceItem} */
  const item = {
    id:        crypto.randomUUID(),
    type:      isImage ? 'image' : 'text',
    text:      isImage ? null : (info.selectionText || capture?.selectedText || null),
    imageUrl:  isImage ? (info.srcUrl || capture?.imageUrl || null) : null,
    pageUrl:   info.pageUrl || capture?.pageUrl || tab.url || '',
    pageTitle: capture?.pageTitle || tab.title || '',
    groupId:   null,    // 保存後にユーザーが分類する
    createdAt: Date.now(),
    windowId:  tab.windowId ?? null,
  };

  try {
    await saveWorkspaceItem(item);
  } catch (error) {
    console.error('Workspace save: failed to save item', error);
    return;
  }

  // panel.js への更新通知（chrome.storage.onChanged 経由）
  await chrome.storage.local.set({
    [WORKSPACE_UPDATED_KEY]: { updatedAt: Date.now(), lastItemId: item.id },
  });
});
```

---

### 5.5 panel.js（追加部分）

#### 定数・状態変数

```js
// 定数追加
const WORKSPACE_UPDATED_KEY  = 'tabManagerWorkspaceUpdated';
const WORKSPACE_VIEW_BTN_ID  = 'workspace-view-btn';
const WORKSPACE_VIEW_ID      = 'workspace-view';

// 状態変数追加
let workspaceViewOpen = false;
```

#### storage 監視への追加（既存の chrome.storage.onChanged に追記）

```js
// chrome.storage.onChanged.addListener 内に追加
const workspaceChange = changes[WORKSPACE_UPDATED_KEY];
if (workspaceChange && workspaceViewOpen) {
  renderWorkspaceView();
}
```

#### ワークスペースビューのレンダリング

```js
async function renderWorkspaceView() {
  const container = document.getElementById(WORKSPACE_VIEW_ID);
  if (!container) return;

  // IndexedDB からデータを取得するため background.js 経由でメッセージ送信
  let items = [];
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'WorkspaceFetchItems',
    });
    items = response?.items ?? [];
  } catch (error) {
    console.error('Failed to fetch workspace items:', error);
    return;
  }

  // 日付降順ソート
  items.sort((a, b) => b.createdAt - a.createdAt);

  const fragment = document.createDocumentFragment();

  for (const item of items) {
    fragment.appendChild(createWorkspaceCard(item));
  }

  container.replaceChildren(fragment);
}

function createWorkspaceCard(item) {
  const card = document.createElement('div');
  card.className = 'workspace-card';
  card.dataset.itemId = item.id;

  // 種別に応じてコンテンツを表示
  if (item.type === 'text' && item.text) {
    const textEl = document.createElement('p');
    textEl.className = 'workspace-card__text';
    textEl.textContent = item.text;
    card.appendChild(textEl);
  }

  if (item.type === 'image' && item.imageUrl) {
    const img = document.createElement('img');
    img.className = 'workspace-card__image';
    img.src = item.imageUrl;
    img.alt = item.pageTitle || '';
    img.loading = 'lazy';
    card.appendChild(img);
  }

  // 出典情報
  const meta = document.createElement('div');
  meta.className = 'workspace-card__meta';

  const titleLink = document.createElement('a');
  titleLink.className = 'workspace-card__source';
  titleLink.textContent = item.pageTitle || item.pageUrl;
  titleLink.title = item.pageUrl;
  titleLink.addEventListener('click', async (e) => {
    e.preventDefault();
    // 既存タブがあれば移動、なければ新規タブで開く
    try {
      const tabs = await chrome.tabs.query({ url: item.pageUrl });
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { active: true });
        await chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: item.pageUrl });
      }
    } catch (err) {
      console.error('Failed to navigate to source:', err);
    }
  });

  const dateEl = document.createElement('span');
  dateEl.className = 'workspace-card__date';
  dateEl.textContent = new Date(item.createdAt).toLocaleDateString('ja-JP', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  meta.appendChild(titleLink);
  meta.appendChild(dateEl);
  card.appendChild(meta);

  // 削除ボタン
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'workspace-card__delete';
  deleteBtn.type = 'button';
  deleteBtn.title = '削除';
  deleteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"
    viewBox="0 0 24 24"><path fill="currentColor"
    d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41
    L17.59 19L19 17.59L13.41 12z"/></svg>`;
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await chrome.runtime.sendMessage({ type: 'WorkspaceDeleteItem', id: item.id });
    card.remove();
  });
  card.appendChild(deleteBtn);

  return card;
}
```

---

### 5.6 background.js（panel.js からの取得・削除リクエスト対応）

```js
// chrome.runtime.onMessage.addListener 内に追加

if (message.type === 'WorkspaceFetchItems') {
  getAllWorkspaceItems()
    .then((items) => sendResponse({ ok: true, items }))
    .catch((error) => {
      console.error('Failed to fetch workspace items:', error);
      sendResponse({ ok: false, items: [] });
    });
  return true; // 非同期応答
}

if (message.type === 'WorkspaceDeleteItem') {
  const id = typeof message.id === 'string' ? message.id : null;
  if (!id) {
    sendResponse({ ok: false });
    return;
  }
  deleteWorkspaceItem(id)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error('Failed to delete workspace item:', error);
      sendResponse({ ok: false });
    });
  return true;
}
```

---

### 5.7 panel.html（追加部分）

```html
<!-- #panel-content の直前に追加 -->
<section
  id="workspace-view"
  class="panel-view workspace-view"
  aria-labelledby="workspace-heading"
  hidden
>
  <div class="workspace-header">
    <h3 id="workspace-heading">ワークスペース</h3>
  </div>
  <div class="workspace-grid" id="workspace-grid"></div>
</section>
```

フッターボタン（既存フッターに追記）:

```html
<button
  id="workspace-view-btn"
  class="panel-footer__icon-btn"
  type="button"
  title="ワークスペース"
  aria-pressed="false"
  aria-label="ワークスペースを開く"
>
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"
    viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path fill="currentColor"
      d="M9 11H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2zm2-7h-1V2h-2v2H8V2H6v2H5
      c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0
      16H5V9h14v11z"/>
  </svg>
</button>
```

---

### 5.8 styles.css（追加部分）

```css
/* ─── ワークスペースビュー ─── */
.workspace-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.workspace-header {
  padding: 14px 14px 8px;
  flex-shrink: 0;
}

.workspace-header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

/* グリッドコンテナ */
#workspace-grid {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* カード */
.workspace-card {
  position: relative;
  background-color: var(--tm-header-bg);
  border: 1px solid var(--tm-border);
  border-radius: 8px;
  padding: 10px 32px 10px 12px; /* 右側に削除ボタン分の余白 */
  transition: border-color 0.15s ease;
}

.workspace-card:hover {
  border-color: var(--tm-accent);
}

/* テキストカード */
.workspace-card__text {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--tm-text-primary);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 4;      /* 最大4行で省略 */
  -webkit-box-orient: vertical;
}

/* 画像カード */
.workspace-card__image {
  display: block;
  width: 100%;
  max-height: 160px;
  object-fit: cover;
  border-radius: 4px;
  margin-bottom: 6px;
  background-color: var(--tm-hover-bg);
}

/* 出典メタ情報 */
.workspace-card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--tm-text-muted);
  overflow: hidden;
}

.workspace-card__source {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--tm-text-muted);
  text-decoration: none;
  cursor: pointer;
}

.workspace-card__source:hover {
  color: var(--tm-accent);
  text-decoration: underline;
}

.workspace-card__date {
  flex-shrink: 0;
}

/* 削除ボタン */
.workspace-card__delete {
  position: absolute;
  top: 8px;
  right: 8px;
  background: none;
  border: none;
  color: var(--tm-text-muted);
  cursor: pointer;
  padding: 3px;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease;
}

.workspace-card:hover .workspace-card__delete {
  opacity: 1;
}

.workspace-card__delete:hover {
  color: var(--tm-text-primary);
  background-color: var(--tm-overlay);
}
```

---

## 6. データ構造（完全版）

```js
/**
 * ワークスペースアイテム
 *
 * @typedef {Object} WorkspaceItem
 * @property {string}           id          - crypto.randomUUID() で生成
 * @property {'text'|'image'}   type        - アイテム種別
 * @property {string|null}      text        - 選択テキスト（type === 'text' の場合）
 * @property {string|null}      imageUrl    - 画像URL（type === 'image' の場合）
 * @property {string}           pageUrl     - 保存元ページURL
 * @property {string}           pageTitle   - 保存元ページタイトル
 * @property {string|null}      groupId     - グループID（null = 未分類）
 * @property {number}           createdAt   - 保存日時（Unix ms）
 * @property {number|null}      windowId    - 保存元ウィンドウID
 */
```

### IndexedDB スキーマ

```
Database:  TabManagerWorkspace  (version 1)
└── ObjectStore: items
    ├── keyPath: "id"
    └── indexes:
        ├── createdAt  (non-unique) → 日付降順ソート用
        ├── groupId    (non-unique) → グループフィルタ用
        └── pageUrl    (non-unique) → 同一ページのアイテム集約用
```

---

## 7. 既知の制約・注意点

| 項目 | 内容 |
|---|---|
| content.js が動作しないページ | `chrome://` 等では capture が null になるが、`info` オブジェクトで代替可能 |
| 画像の cross-origin 制限 | `imageUrl` として URL を保存するため、表示時に CORS で読み込めない画像がある。その場合は `img` の読み込みエラーをハンドリングし、faviconやプレースホルダーで代替する |
| Service Worker のライフサイクル | IndexedDB への接続（`_db`）はメモリ上のキャッシュであり、SW が kill されると消える。`openWorkspaceDB()` が毎回接続を確認する設計になっているため問題は生じない |
| `manifest.json` の `type: module` | 既存コードが CommonJS スタイルの場合、`import/export` への移行コストがある。その場合は `workspace-db.js` の内容を background.js にインライン展開する |

---

## 8. 今後の拡張候補

**グループ機能（Phase 2）**
保存時または保存後にグループを指定できるUI。  
`groupId` フィールドはすでに存在するため、UIを追加するだけでよい。

**テキスト検索（Phase 2）**
IndexedDB の `text` フィールドをフルテキスト検索する。  
件数が多くなければ `Array.filter` でも十分に動作する。

**消費状態管理（Phase 3）**
「未読 / 参照済み / 消化済み」状態を `WorkspaceItem` に追加。  
`state` フィールドと index を追加するだけで実現できる。

**展開ビューとの統合（Phase 3）**
展開ビューのウィンドウ列の下部にそのウィンドウから保存したアイテムを表示する。  
`windowId` がすでにデータに含まれているため、フィルタリングは即座に実装できる。
