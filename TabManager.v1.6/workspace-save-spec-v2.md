# Workspace Save 機能 実装設計書 v2

> **対象拡張**: TabManager.v1.3-a（Manifest V3）  
> GPTフィードバック（pendingCapture脆弱性・CORS制約・storage再描画・保存フィードバック）を反映した改訂版。

---

## 1. 機能概要

Webページ上で選択したテキスト・画像を右クリックから「ワークスペース」に保存する。  
**情報の断片（テキスト/画像）が主役**であり、URLはその出典メタデータとして付与される。

```
保存されるもの:
  {
    選択テキスト または 画像URL,
    出典ページURL,
    出典ページタイトル（取得できた場合）,
    保存日時,
    ウィンドウID,
    グループ（任意・後から設定可）
  }
```

---

## 2. システム全体像

### アーキテクチャ図

```
┌──────────────────────────────────────────────────────────────┐
│  Webページ（任意のサイト）                                      │
│                                                              │
│  ① ユーザーがテキスト選択 or 画像を右クリック                    │
│  ② contextmenu イベント発火                                   │
│     → content.js が pageTitle 等の補完情報をキャプチャ         │
│        ※ capture は補完データ。失敗しても保存を止めない          │
└──────────────────┬───────────────────────────────────────────┘
                   │ chrome.tabs.sendMessage（失敗許容）
┌──────────────────▼───────────────────────────────────────────┐
│  background.js（Service Worker）                              │
│                                                              │
│  ③ chrome.contextMenus.onClicked が発火                      │
│  ④ info オブジェクト（Chrome直接提供）をメイン情報源として確定   │
│  ⑤ content.js から capture を取得（TTL検証付き・失敗しても続行） │
│  ⑥ WorkspaceItem を構築し IndexedDB に保存                   │
│  ⑦ chrome.tabs.sendMessage で content.js にトースト指示       │
│  ⑧ chrome.storage.local に更新シグナルを書き込み              │
└──────────┬──────────────────────────┬────────────────────────┘
           │ sendMessage              │ storage.onChanged
           ▼ WorkspaceShowToast       ▼ WORKSPACE_UPDATED_KEY
┌──────────────────────┐  ┌──────────────────────────────────┐
│  content.js          │  │  panel.js                        │
│  Shadow DOM トースト  │  │  workspaceViewOpen 時のみ再描画   │
│  を2秒表示して消去    │  └──────────────────────────────────┘
└──────────────────────┘
```

### 情報ソースの責務分担

Chrome が直接提供する `info` をメイン情報源とし、  
`capture` は `pageTitle` の補完にのみ実質的に使用する。

```
フィールド       メイン情報源           補完情報源           失敗時の挙動
─────────────────────────────────────────────────────────────────────
selectionText    info.selectionText     capture.selectedText  空なら保存中断
imageUrl         info.srcUrl            capture.imageUrl      null なら保存中断
pageUrl          info.pageUrl           capture.pageUrl       tab.url（必ず取れる）
pageTitle        なし                   capture.pageTitle     tab.title で代替
```

---

## 3. 変更・追加ファイル一覧

| ファイル | 変更種別 | 主な内容 |
|---|---|---|
| `manifest.json` | 変更 | `contextMenus` 権限を追加 |
| `content.js` | 変更 | キャプチャ（TTL付き）＋Shadow DOM トースト追加 |
| `background.js` | 変更 | contextMenus 登録・onClicked・トースト指示追加 |
| `workspace-db.js` | **新規** | IndexedDB の CRUD（background.js にインライン展開推奨） |
| `panel.html` | 変更 | ワークスペースビュー section・フッターボタン追加 |
| `panel.js` | 変更 | ワークスペースビューのレンダリング・storage 監視追加 |
| `styles.css` | 変更 | ワークスペースUI用スタイル追加 |

---

## 4. 実装技術の詳細と設計判断

### 4.1 pendingCapture：補完専用・TTL検証で stale を排除

v1 では capture の内容を積極的に使用していたが、  
`contextmenu` が発火しないケース（キーボード右クリック等）や  
別タブへのフォーカス移動による stale capture が問題になりうる。

**v2 の対策：**

- `info`（Chrome直接提供）をメイン情報源として先に確定する
- capture は `pageTitle` 補完の用途のみに絞る
- TTL（3秒）と pageUrl の一致チェックで stale capture を自動破棄する

```
capture が有効な条件:
  AND  capturedAt が onClicked 発火の 3 秒以内
  AND  capture.pageUrl が info.pageUrl と一致

どちらかを満たさない場合 → capture を null として扱い info のみで保存
```

### 4.2 画像 URL 保存の CORS 制約（Phase 1 許容・Phase 2 対応）

Phase 1 では `imageUrl`（文字列）をそのまま保存する。  
これは最もシンプルな実装だが、以下のケースで `<img>` が表示できない場合がある。

| ケース | 発生頻度 | Phase 1 の対応 |
|---|---|---|
| 認証付き URL | 中 | `img.onerror` でフォールバック表示 |
| 期限付き URL（CDN署名付き等） | 中 | 同上 |
| CORS ブロック | 低〜中 | 同上 |
| 通常の公開画像 | 高 | 正常表示 |

Phase 2 以降の対応として、`fetch + response.blob()` で画像データを取得し  
IndexedDB に Blob として直接保存する方式を検討する。  
IndexedDB は Blob を natively サポートするため追加ライブラリは不要。

### 4.3 保存成功フィードバック：Shadow DOM トースト

保存元ページに Shadow DOM を使った軽量トーストを注入する。  
これは既存の `previewOverlay`（`ensurePreviewOverlayElements`）が  
採用しているパターンと完全に一致し、設計の一貫性を保てる。

```
トーストのライフサイクル:
  background.js が保存成功
    → chrome.tabs.sendMessage(tab.id, { type: 'WorkspaceShowToast', text })
    → content.js が Shadow DOM 要素を body に追加
    → requestAnimationFrame で is-visible クラスを付与（CSS transition）
    → 2 秒後に is-visible を除去（フェードアウト）
    → transitionend で DOM から削除

失敗時:
  sendMessage が失敗（chrome:// 等）→ 握り潰す（保存自体は成功）
  DB 保存失敗 → 「保存に失敗しました」トーストを表示
```

### 4.4 storage 更新シグナルと再描画の制御

`WORKSPACE_UPDATED_KEY` への書き込みで panel.js に更新を通知する方式は  
実装が軽量で現状の件数には問題ない。  
ただし**ワークスペースビューが閉じている時は再描画をスキップ**することで  
頻繁な保存操作がパフォーマンスに影響するのを防ぐ。

```js
// panel.js の storage.onChanged 内
const workspaceChange = changes[WORKSPACE_UPDATED_KEY];
if (workspaceChange && workspaceViewOpen) {   // 開いている時のみ
  renderWorkspaceView();
}
```

### 4.5 MV3 Service Worker：contextMenus の再登録

MV3 の Service Worker は起動のたびにメモリが初期化されるため、  
`onInstalled` だけでなく `onStartup` でも contextMenus を再登録する必要がある。  
`removeAll()` で重複登録を防ぐのが定石パターン。

---

## 5. サンプルコード

### 5.1 manifest.json

```json
{
  "manifest_version": 3,
  "name": "TabManager.v1.3-a",
  "version": "1.3",
  "action": { "default_title": "TabManager" },
  "permissions": [
    "tabs",
    "activeTab",
    "scripting",
    "storage",
    "tabGroups",
    "bookmarks",
    "contextMenus"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js"
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
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

> `workspace-db.js` は background.js に**インライン展開**を推奨する。  
> `type: "module"` で import も可能だが、既存コードとの整合性を優先する。

---

### 5.2 content.js（追加部分）

```js
// ── ワークスペース：定数 ──────────────────────────────────────────

const WORKSPACE_FLUSH_CAPTURE_MSG = 'WorkspaceFlushPendingCapture';
const WORKSPACE_SHOW_TOAST_MSG    = 'WorkspaceShowToast';
const WORKSPACE_CAPTURE_TTL_MS    = 3000; // stale 判定の閾値（3秒）

// ── 補完情報のキャプチャ ──────────────────────────────────────────
//
// capture は pageTitle の補完が主目的。
// contextmenu が発火しないケース（キーボード右クリック等）は
// capture が null のまま onClicked が呼ばれるが、
// background.js 側が info をメイン情報源として処理するため問題ない。

let pendingWorkspaceCapture = null;

document.addEventListener('contextmenu', (event) => {
  const target = event.target;

  const sel          = window.getSelection();
  const selectedText = sel ? sel.toString().trim() : '';

  // IMG 要素または最近傍の IMG から画像 URL を取得
  const imgEl   = target.tagName === 'IMG' ? target : target.closest('img');
  const imageUrl = imgEl?.src || null;

  // テキストも画像もない右クリックは capture 不要
  if (!selectedText && !imageUrl) {
    pendingWorkspaceCapture = null;
    return;
  }

  pendingWorkspaceCapture = {
    selectedText: selectedText || null,
    imageUrl:     imageUrl,
    pageUrl:      location.href,
    pageTitle:    document.title,
    capturedAt:   Date.now(),
  };
});

// ── background.js からのメッセージ応答 ───────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // --- capture の flush ---
  if (message.type === WORKSPACE_FLUSH_CAPTURE_MSG) {
    const capture = pendingWorkspaceCapture;
    pendingWorkspaceCapture = null; // 取得後は即クリア（次の操作と混在しない）

    // TTL チェック：古い capture または pageUrl 不一致は null として返す
    const now     = Date.now();
    const isFresh =
      capture !== null &&
      now - capture.capturedAt <= WORKSPACE_CAPTURE_TTL_MS;

    sendResponse({ capture: isFresh ? capture : null });
    return true; // 非同期応答を示す必須フラグ
  }

  // --- トースト表示 ---
  if (message.type === WORKSPACE_SHOW_TOAST_MSG) {
    showWorkspaceToast(message.text ?? 'ワークスペースに保存しました');
    // sendResponse 不要（fire-and-forget）
  }
});

// ── Shadow DOM トースト ───────────────────────────────────────────
//
// previewOverlay と同じ Shadow DOM パターンを採用。
// サイトの CSS と完全に分離されるため、どのページでも安定して表示できる。

let _toastContainer = null;
let _toastTimer     = null;

function showWorkspaceToast(text) {
  // Shadow DOM コンテナの初回生成
  if (!_toastContainer) {
    _toastContainer = document.createElement('div');
    _toastContainer.setAttribute(EXTENSION_ELEMENT_ATTRIBUTE, '');
    _toastContainer.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1000000;
      pointer-events: none;
    `;

    const shadow = _toastContainer.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .toast {
        background: rgba(32, 33, 36, 0.95);
        color: #e8eaed;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 13px;
        padding: 9px 16px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
        white-space: nowrap;
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 0.18s ease, transform 0.18s ease;
      }
      .toast.is-visible {
        opacity: 1;
        transform: translateY(0);
      }
    `;

    const toastEl = document.createElement('div');
    toastEl.className = 'toast';

    shadow.appendChild(style);
    shadow.appendChild(toastEl);
    (document.body || document.documentElement).appendChild(_toastContainer);
  }

  const toastEl = _toastContainer.shadowRoot.querySelector('.toast');
  toastEl.textContent = text;

  // フレームを跨いで class を付与することで CSS transition を発火させる
  requestAnimationFrame(() => toastEl.classList.add('is-visible'));

  // 前のタイマーをリセットして 2 秒後に消去
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    toastEl.classList.remove('is-visible');
    _toastTimer = null;
  }, 2000);
}
```

---

### 5.3 workspace-db.js（新規・background.js へのインライン展開推奨）

```js
// ── IndexedDB（ワークスペース） ───────────────────────────────────
//
// Service Worker は kill されると _wsDb キャッシュが消えるが、
// openWorkspaceDB() が毎回 null チェックして再接続するため問題ない。

const WS_DB_NAME    = 'TabManagerWorkspace';
const WS_DB_VERSION = 1;
const WS_STORE_NAME = 'items';

let _wsDb = null;

function openWorkspaceDB() {
  if (_wsDb) return Promise.resolve(_wsDb);

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

    req.onsuccess = (e) => { _wsDb = e.target.result; resolve(_wsDb); };
    req.onerror   = ()  => reject(req.error);
  });
}

async function saveWorkspaceItem(item) {
  const db = await openWorkspaceDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WS_STORE_NAME, 'readwrite');
    tx.objectStore(WS_STORE_NAME).put(item);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function getAllWorkspaceItems({ groupId } = {}) {
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

async function deleteWorkspaceItem(id) {
  const db = await openWorkspaceDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WS_STORE_NAME, 'readwrite');
    tx.objectStore(WS_STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}
```

---

### 5.4 background.js（追加部分）

```js
// ── 定数追加 ─────────────────────────────────────────────────────

const WORKSPACE_SAVE_TEXT_MENU_ID  = 'workspace-save-text';
const WORKSPACE_SAVE_IMAGE_MENU_ID = 'workspace-save-image';
const WORKSPACE_FLUSH_CAPTURE_MSG  = 'WorkspaceFlushPendingCapture';
const WORKSPACE_SHOW_TOAST_MSG     = 'WorkspaceShowToast';
const WORKSPACE_UPDATED_KEY        = 'tabManagerWorkspaceUpdated';

// ── contextMenus 登録 ─────────────────────────────────────────────
// MV3 の SW は起動のたびに初期化されるため onStartup でも再登録する。
// removeAll() で重複登録を防ぐのが MV3 の定石パターン。

function registerWorkspaceContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id:       WORKSPACE_SAVE_TEXT_MENU_ID,
      title:    'ワークスペースにテキストを保存',
      contexts: ['selection'],  // テキスト選択時のみ表示
    });
    chrome.contextMenus.create({
      id:       WORKSPACE_SAVE_IMAGE_MENU_ID,
      title:    'ワークスペースに画像を保存',
      contexts: ['image'],      // 画像右クリック時のみ表示
    });
  });
}

chrome.runtime.onInstalled.addListener(registerWorkspaceContextMenus);
chrome.runtime.onStartup.addListener(registerWorkspaceContextMenus);

// ── クリック時の保存処理 ─────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuId = info.menuItemId;
  if (
    menuId !== WORKSPACE_SAVE_TEXT_MENU_ID &&
    menuId !== WORKSPACE_SAVE_IMAGE_MENU_ID
  ) {
    return;
  }

  if (!tab?.id) return;

  const isImage = menuId === WORKSPACE_SAVE_IMAGE_MENU_ID;

  // ── Step 1: info（Chrome提供）でメイン情報を確定 ─────────────
  // info は contextmenu 非発火のケースでも Chrome が必ず提供する。

  const mainText     = isImage ? null : (info.selectionText?.trim() || null);
  const mainImageUrl = isImage ? (info.srcUrl || null) : null;
  const mainPageUrl  = info.pageUrl || tab.url || '';

  // 保存対象が存在しない場合は中断
  if (isImage && !mainImageUrl) return;
  if (!isImage && !mainText)    return;

  // ── Step 2: capture から pageTitle を補完（失敗しても続行） ──
  // capture は pageTitle の取得のみが実質的な用途。
  // TTL 検証は content.js 側で実施済み（古い capture は null で返る）。

  let pageTitle = tab.title || '';
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: WORKSPACE_FLUSH_CAPTURE_MSG,
    });
    if (response?.capture?.pageTitle) {
      pageTitle = response.capture.pageTitle;
    }
  } catch {
    // chrome:// 等で content.js が動作しないページでは失敗する
    // → tab.title をそのまま使用（許容範囲）
  }

  // ── Step 3: WorkspaceItem を構築 ─────────────────────────────

  /** @type {WorkspaceItem} */
  const item = {
    id:        crypto.randomUUID(),
    type:      isImage ? 'image' : 'text',
    text:      mainText,
    imageUrl:  mainImageUrl,
    pageUrl:   mainPageUrl,
    pageTitle: pageTitle,
    groupId:   null,              // 後からユーザーが分類する
    createdAt: Date.now(),
    windowId:  tab.windowId ?? null,
  };

  // ── Step 4: IndexedDB に保存 ─────────────────────────────────

  try {
    await saveWorkspaceItem(item);
  } catch (error) {
    console.error('Workspace save: IndexedDB write failed', error);
    // 保存失敗もトーストでフィードバック
    chrome.tabs.sendMessage(tab.id, {
      type: WORKSPACE_SHOW_TOAST_MSG,
      text: '保存に失敗しました',
    }).catch(() => {});
    return;
  }

  // ── Step 5: 保存成功フィードバック（トースト） ───────────────
  // sendMessage 失敗（chrome:// 等）は握り潰す（保存は成功済み）

  chrome.tabs.sendMessage(tab.id, {
    type: WORKSPACE_SHOW_TOAST_MSG,
    text: isImage
      ? '画像をワークスペースに保存しました'
      : 'テキストをワークスペースに保存しました',
  }).catch(() => {});

  // ── Step 6: パネルへの更新通知 ───────────────────────────────

  chrome.storage.local.set({
    [WORKSPACE_UPDATED_KEY]: { updatedAt: Date.now(), lastItemId: item.id },
  }).catch(() => {});
});

// ── onMessage ハンドラ内に追加 ────────────────────────────────────

// panel.js → 全件取得
if (message.type === 'WorkspaceFetchItems') {
  getAllWorkspaceItems()
    .then((items)  => sendResponse({ ok: true, items }))
    .catch((error) => {
      console.error('WorkspaceFetchItems failed:', error);
      sendResponse({ ok: false, items: [] });
    });
  return true;
}

// panel.js → 単件削除
if (message.type === 'WorkspaceDeleteItem') {
  const id = typeof message.id === 'string' ? message.id : null;
  if (!id) { sendResponse({ ok: false }); return; }
  deleteWorkspaceItem(id)
    .then(()      => sendResponse({ ok: true }))
    .catch((error) => {
      console.error('WorkspaceDeleteItem failed:', error);
      sendResponse({ ok: false });
    });
  return true;
}
```

---

### 5.5 panel.js（追加部分）

#### 定数・状態変数

```js
// 定数
const WORKSPACE_UPDATED_KEY = 'tabManagerWorkspaceUpdated';
const WORKSPACE_VIEW_ID     = 'workspace-view';
const WORKSPACE_GRID_ID     = 'workspace-grid';
const WORKSPACE_BTN_ID      = 'workspace-view-btn';

// 状態変数（既存の optionsViewOpen と同じパターン）
let workspaceViewOpen = false;
```

#### ビュー切り替え（既存の toggleOptionsView パターンに倣う）

```js
function applyWorkspaceViewState() {
  const tabView  = document.getElementById(TAB_VIEW_ID);
  const wsView   = document.getElementById(WORKSPACE_VIEW_ID);

  if (tabView) {
    tabView.hidden = workspaceViewOpen;
    tabView.setAttribute('aria-hidden', workspaceViewOpen ? 'true' : 'false');
  }
  if (wsView) {
    wsView.hidden = !workspaceViewOpen;
    wsView.setAttribute('aria-hidden', workspaceViewOpen ? 'false' : 'true');
  }

  const btn = document.getElementById(WORKSPACE_BTN_ID);
  if (btn) btn.setAttribute('aria-pressed', workspaceViewOpen ? 'true' : 'false');
}

function toggleWorkspaceView(forceState) {
  const next = typeof forceState === 'boolean' ? forceState : !workspaceViewOpen;
  if (next === workspaceViewOpen) return;
  workspaceViewOpen = next;
  applyWorkspaceViewState();
  if (workspaceViewOpen) renderWorkspaceView();
}

function setupWorkspaceViewControls() {
  const btn = document.getElementById(WORKSPACE_BTN_ID);
  if (!btn) return;
  btn.addEventListener('click', () => {
    // optionsView が開いていれば閉じる（既存パターンと同様）
    if (optionsViewOpen) toggleOptionsView(false);
    toggleWorkspaceView();
  });
}
```

#### storage 監視（既存の `chrome.storage.onChanged` に追記）

```js
const workspaceChange = changes[WORKSPACE_UPDATED_KEY];
if (workspaceChange && workspaceViewOpen) {
  // ワークスペースビューが開いている時のみ再描画
  renderWorkspaceView();
}
```

#### レンダリング

```js
async function renderWorkspaceView() {
  const grid = document.getElementById(WORKSPACE_GRID_ID);
  if (!grid) return;

  let items = [];
  try {
    const res = await chrome.runtime.sendMessage({ type: 'WorkspaceFetchItems' });
    items = res?.items ?? [];
  } catch (err) {
    console.error('Failed to fetch workspace items:', err);
    return;
  }

  // 保存日時の降順
  items.sort((a, b) => b.createdAt - a.createdAt);

  const fragment = document.createDocumentFragment();
  for (const item of items) fragment.appendChild(createWorkspaceCard(item));
  grid.replaceChildren(fragment);
}

function createWorkspaceCard(item) {
  const card = document.createElement('div');
  card.className     = 'workspace-card';
  card.dataset.itemId = item.id;

  // ─ コンテンツ ─────────────────────────────────────────────────

  if (item.type === 'text' && item.text) {
    const textEl = document.createElement('p');
    textEl.className   = 'workspace-card__text';
    textEl.textContent = item.text;
    card.appendChild(textEl);
  }

  if (item.type === 'image' && item.imageUrl) {
    const img  = document.createElement('img');
    img.className = 'workspace-card__image';
    img.src       = item.imageUrl;
    img.alt       = item.pageTitle || '';
    img.loading   = 'lazy';

    // CORS ブロック・認証付き URL・期限切れ URL のフォールバック
    img.onerror = () => {
      img.style.display = 'none';
      const fb = document.createElement('div');
      fb.className   = 'workspace-card__image-fallback';
      fb.textContent = '画像を読み込めませんでした';
      card.insertBefore(fb, img.nextSibling);
    };
    card.appendChild(img);
  }

  // ─ 出典メタ ───────────────────────────────────────────────────

  const meta   = document.createElement('div');
  meta.className = 'workspace-card__meta';

  const source = document.createElement('span');
  source.className   = 'workspace-card__source';
  source.textContent = item.pageTitle || item.pageUrl;
  source.title       = item.pageUrl;
  source.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ url: item.pageUrl });
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { active: true });
        if (tabs[0].windowId) {
          await chrome.windows.update(tabs[0].windowId, { focused: true });
        }
      } else {
        await chrome.tabs.create({ url: item.pageUrl });
      }
    } catch (err) {
      console.error('Failed to navigate to source:', err);
    }
  });

  const date   = document.createElement('span');
  date.className  = 'workspace-card__date';
  date.textContent = new Date(item.createdAt).toLocaleDateString('ja-JP', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  meta.appendChild(source);
  meta.appendChild(date);
  card.appendChild(meta);

  // ─ 削除ボタン ────────────────────────────────────────────────

  const del  = document.createElement('button');
  del.className = 'workspace-card__delete';
  del.type      = 'button';
  del.title     = '削除';
  del.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"
    viewBox="0 0 24 24"><path fill="currentColor"
    d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59
       L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12z"/></svg>`;
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await chrome.runtime.sendMessage({ type: 'WorkspaceDeleteItem', id: item.id });
    card.remove();
  });
  card.appendChild(del);

  return card;
}
```

#### DOMContentLoaded への登録

```js
// 既存の setupHeaderBehavior(); の後に追加
setupWorkspaceViewControls();
```

---

### 5.6 panel.html（追加部分）

`#panel-content` 内の `#options-view` の直後に追加：

```html
<section
  id="workspace-view"
  class="panel-view"
  aria-labelledby="workspace-heading"
  hidden
>
  <div class="options-header">
    <h3 id="workspace-heading">ワークスペース</h3>
  </div>
  <div id="workspace-grid" class="workspace-grid"></div>
</section>
```

フッターボタン（`panel-footer` 内に追加）：

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

### 5.7 styles.css（追加部分）

```css
/* ═══════════════════════════════════════════
   ワークスペースビュー
   ═══════════════════════════════════════════ */

/* グリッドコンテナ */
.workspace-grid {
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
  padding: 10px 32px 10px 12px; /* 右端に削除ボタン分の余白 */
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
  -webkit-line-clamp: 4;          /* 最大4行で省略 */
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

/* 画像フォールバック（CORS・認証・期限切れ URL） */
.workspace-card__image-fallback {
  padding: 12px 0 6px;
  font-size: 12px;
  color: var(--tm-text-muted);
  text-align: center;
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
  cursor: pointer;
}

.workspace-card__source:hover {
  color: var(--tm-accent);
  text-decoration: underline;
}

.workspace-card__date {
  flex-shrink: 0;
}

/* 削除ボタン（ホバー時のみ表示） */
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

## 6. データ構造

```js
/**
 * @typedef {Object} WorkspaceItem
 * @property {string}           id          - crypto.randomUUID()
 * @property {'text'|'image'}   type        - アイテム種別
 * @property {string|null}      text        - 選択テキスト（type=text）
 * @property {string|null}      imageUrl    - 画像URL（type=image）
 * @property {string}           pageUrl     - 出典ページURL
 * @property {string}           pageTitle   - 出典ページタイトル
 * @property {string|null}      groupId     - グループID（null=未分類）
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
        ├── createdAt  (non-unique) → 日付降順ソート
        ├── groupId    (non-unique) → グループフィルタ
        └── pageUrl    (non-unique) → 同一ページのアイテム集約
```

---

## 7. 既知の制約

| 項目 | Phase 1 の対応 | Phase 2 以降 |
|---|---|---|
| 画像の CORS ブロック・認証付き URL | `img.onerror` でフォールバック表示 | `fetch + Blob` でローカル保存 |
| 期限付き URL（CDN署名付き等） | 同上 | 同上 |
| chrome:// 等でのトースト失敗 | 握り潰す（DB保存は成功） | 対応不要 |
| contextmenu 非発火（キーボード等） | info のみで保存・tab.title で代替 | 現設計で許容 |
| SW kill による `_wsDb` 消滅 | `openWorkspaceDB()` が毎回再接続 | 現設計で問題なし |

---

## 8. v1 からの主要変更点

| 項目 | v1 | v2 |
|---|---|---|
| capture の位置づけ | 積極利用 | **補完専用**（pageTitle のみ）に格下げ |
| stale capture への対策 | なし | **TTL 3秒チェック**を content.js 側で実施 |
| 保存成功フィードバック | なし | **Shadow DOM トースト**をページに表示 |
| 保存失敗フィードバック | なし | **失敗トースト**も表示 |
| 画像表示失敗時の対応 | 記述なし | `img.onerror` で **フォールバック UI** を表示 |
| パネル再描画条件 | 常に実行 | `workspaceViewOpen === true` 時のみ |
| ビュー切り替えパターン | 独自実装 | 既存の `toggleOptionsView` パターンに統一 |

---

## 9. 今後の拡張候補

**グループ機能（Phase 2）**  
`groupId` フィールドはすでにデータに存在する。保存後の分類 UI を追加するだけでよい。

**画像の Blob 保存（Phase 2）**  
`fetch + response.blob()` で取得した画像データを IndexedDB に直接保存する。  
CORS・認証・期限切れ URL の問題を根本解決できるが、ストレージ使用量の管理が必要。

**テキスト検索（Phase 2）**  
`items` 配列を `Array.filter` で絞り込む。数百件程度なら追加ライブラリ不要で十分な速度。

**展開ビューとの統合（Phase 3）**  
`windowId` がすでにデータに含まれているため、  
展開ビューの各ウィンドウ列下部にそのウィンドウからの保存アイテムを表示できる。
