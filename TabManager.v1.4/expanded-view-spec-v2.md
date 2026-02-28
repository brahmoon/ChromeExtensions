# 全ウィンドウ展開ビュー 実装仕様書 v2

> GPT フィードバックを踏まえた再設計版。
> 各指摘の採否と理由、具体的な修正方針を記述する。

---

## フィードバック採否まとめ

| # | GPT指摘 | 採否 | 理由 |
|---|---------|------|------|
| 1 | iframe問題：expanded-viewは画面左まで届かない | **採用** | 構造上の致命的な誤りであり修正必須 |
| 2 | プレビュー誤発火：data属性でガードを追加 | **採用** | mouseenterハンドラはcreateTabListItem内に直接埋め込まれており、展開ビューでも必ず発火する |
| 3 | パフォーマンス：chrome.tabGroups.get の多重呼び出し | **一部採用** | tabGroups.getのPromise.allはそのまま維持。ただしrefreshTabs連動時の再描画をrequestIdパターンで制御する |
| 4 | WeakMap二重登録問題 | **不採用** | WeakMapはキーが同一DOMノードに対して重複しない。展開ビューは別コンテナの別ノードであり、競合は構造上発生しない |
| 5 | ウィンドウ順序が未定義 | **一部採用** | プロトタイプでは最終アクティブ順の実装コストが高いため、現在ウィンドウを右端に固定する要件のみ担保する |
| 6 | refreshTabs連動の無制限再描画 | **採用** | requestIdパターンをrendered-view用に流用してキャンセル制御を追加する |

---

## 1. 最重要修正：iframe問題（v1の致命的誤り）

### 問題の正確な理解

現在のアーキテクチャ：

```
[Web Page 全体]
  ├── [Web Page コンテンツ]
  ├── [preview overlay div]  ← content.js が直接 body に挿入、position:fixed, right:400px
  └── [panel iframe]         ← content.js が直接 body に挿入、position:fixed, right:0, width:400px
        └── panel.html の viewport = 幅400px のみ
              └── expanded-view を position:fixed で描くと...
                    left:0 = iframeの左端 = 画面右から400pxの位置
                    → 画面左まで届かない ✗
```

`panel.html` 内の `position: fixed` の基準はiframeのviewport（幅400px）であり、Webページのviewportではない。

### 採用する修正方針：iframe幅を動的に変更する

展開時に `content.js` がiframeの幅を `100vw` に拡張し、折りたたみ時に `400px` に戻す。
`expanded-view` は `panel.html` 内の `position: fixed` 要素として描画されるが、iframe自体が全幅になるため「画面左まで展開」を実現できる。

```
展開時:
[Web Page 全体]
  └── [panel iframe]  ← width:100vw, right:0 に変更
        └── panel.html viewport = 画面全幅
              ├── .panel-shell（右端400px相当に固定）
              └── .expanded-view（残りの左側全体）
```

### 通常パネルを右端に固定する方法

`panel.html` 内で `.panel-shell` を `position: fixed; right: 0; width: 400px` に変更するのではなく、
`.panel-shell` を通常フローに保ちつつ、`.expanded-view` を `position: fixed` で覆う。

具体的には `body` に `.is-expanded` クラスを付与し、CSS で制御する：

```css
/* 展開時：panel-shellを右端400pxに押し込む */
body.is-expanded .panel-shell {
  position: fixed;
  top: 0;
  right: 0;
  width: 400px;
  height: 100%;
  z-index: 2;
}

/* 展開ビューは iframe全幅を使って左側全体を覆う */
body.is-expanded .expanded-view {
  position: fixed;
  top: 0;
  left: 0;
  right: 400px;
  bottom: 0;
  z-index: 1;
}
```

---

## 2. 採用：プレビュー誤発火の防止

### 問題の正確な理解

`createTabListItem` の内部で `favicon` 要素に `mouseenter` / `mouseleave` ハンドラが無条件に登録されている（panel.js 1937〜1944行）。
展開ビューがこの関数を再利用すると、展開ビュー内のタブホバーが `postToParentMessage(PREVIEW_OVERLAY_VISIBILITY_MESSAGE, { visible: true })` を発火させる。

### 修正方針

`createTabListItem` にオプション引数 `{ disablePreview: false }` を追加し、展開ビューから呼ぶ際は `true` を渡す。

```js
// 変更前
function createTabListItem(tab) { ... }

// 変更後
function createTabListItem(tab, { disablePreview = false } = {}) {
  // ... 既存処理 ...
  
  favicon.addEventListener('mouseenter', () => {
    if (!disablePreview) handleTabHover(tab);   // ← ガード追加
  });
  favicon.addEventListener('mouseleave', () => {
    if (!disablePreview && typeof tab.id === 'number') handleTabLeave(tab.id);  // ← ガード追加
  });
}
```

`createGroupAccordion` も同様に `{ disablePreview }` を受け取り、内部の `createTabListItem` 呼び出しに伝播させる。

---

## 3. 採用：renderExpandedView の再描画制御

### 問題の正確な理解

`refreshTabs()` は毎秒複数回呼ばれる可能性がある（タブ更新、グループ変更等）。
現仕様では `if (expandedViewOpen) renderExpandedView()` と書くだけだが、
`renderExpandedView` は非同期で `chrome.tabs.query({})` + `chrome.tabGroups.get` の多重 API 呼び出しを行うため、並列実行が積み重なる。

`refreshTabs` 自体は `requestId` パターン（`let refreshTabsRequestId = 0`）で前回のレンダリングをキャンセルしているが、`renderExpandedView` には同等の制御がない。

### 修正方針

同じ `requestId` パターンを導入する：

```js
let expandedViewRenderRequestId = 0;  // 状態変数として追加

async function renderExpandedView() {
  const requestId = ++expandedViewRenderRequestId;
  const columnsContainer = document.getElementById(EXPANDED_VIEW_COLUMNS_ID);
  if (!columnsContainer) return;

  let allTabs;
  try {
    allTabs = await chrome.tabs.query({});
  } catch (e) {
    return;
  }

  if (requestId !== expandedViewRenderRequestId) return;  // ← キャンセル確認

  // グループ情報取得後にも確認
  // ... Promise.all for tabGroups.get ...

  if (requestId !== expandedViewRenderRequestId) return;  // ← キャンセル確認

  columnsContainer.replaceChildren(/* 構築済みfragment */);
}
```

---

## 4. 不採用：WeakMap二重登録問題

### 不採用の理由

`WeakMap` のキーは **DOMノードそのもの**（オブジェクト参照）であり、値の重複ではなくキーの同一性で管理される。

展開ビューの `createTabListItem` は通常パネルとは **別の `<li>` ノード** を生成するため、`tabMetadataMap.set(li, { tab })` は異なるキーに対する操作となり、既存エントリを上書きしない。

```
通常パネル  tabMetadataMap: { liNode_A → {tab} }
展開ビュー  tabMetadataMap: { liNode_B → {tab} }  ← 別ノード、競合なし
```

`WeakMap` は `Map` と異なり `.get` 失敗時も `undefined` を返すだけで例外を投げない。
ContextMenuのlookup処理も `.closest('.group-item')` / `.closest('.tab-item')` から取得するため、展開ビューのノードと通常パネルのノードが混在しても問題は生じない。

---

## 5. 一部採用：ウィンドウ順序

### 採用する範囲

**現在のウィンドウを右端に固定する**（要件の本質）のみ実装する。
`getPanelWindowId()` で取得した `currentWindowId` を先頭に置き、`flex-direction: row-reverse` で右端に表示するv1の方針を維持する。

### 不採用の範囲

「最終アクティブ順での並び替え」は不採用とする。
`chrome.windows.getAll()` にはウィンドウの最終フォーカス時刻を返すAPIがなく、別途 `chrome.windows.onFocusChanged` での時刻追跡が必要になる。プロトタイプの範囲を超えるため見送る。

---

## 6. 変更ファイルと変更箇所の全量

### 6-1. `content.js`

**追加する定数：**
```js
const PANEL_EXPAND_MESSAGE = 'TabManagerPanelExpand';
const PANEL_WIDTH_EXPANDED = '100vw';
const PANEL_WIDTH_DEFAULT  = `${PANEL_WIDTH}px`;  // 既存定数を参照
```

**`window.addEventListener('message', messageHandler)` に分岐追加：**
```js
if (event.data?.type === PANEL_EXPAND_MESSAGE) {
  const expanded = Boolean(event.data?.detail?.expanded);
  const panel = getPanel();
  if (!panel) return;

  panel.style.width = expanded ? PANEL_WIDTH_EXPANDED : PANEL_WIDTH_DEFAULT;

  // previewOverlay も幅を追従させる
  if (previewOverlayElements) {
    previewOverlayElements.container.style.right = expanded ? '400px' : `${PANEL_WIDTH}px`;
  }
  return;
}
```

> **注記**：展開時にプレビューオーバーレイは右400pxを維持する。
> これにより展開ビュー上にプレビューが重ならない。

---

### 6-2. `panel.html`

`#panel-content` の閉じタグ直後（`.panel-shell` 閉じタグの直前）に追加：

```html
<div id="expanded-view" class="expanded-view" hidden aria-label="全ウィンドウビュー">
  <div id="expanded-view-columns" class="expanded-view__columns"></div>
</div>

<footer class="panel-footer">
  <button
    id="expanded-view-btn"
    class="panel-footer__icon-btn"
    type="button"
    title="全ウィンドウを展開表示"
    aria-pressed="false"
    aria-label="全ウィンドウを展開表示"
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z"/>
    </svg>
  </button>
</footer>
```

---

### 6-3. `styles.css`

末尾に追記（既存への変更なし）：

```css
/* ─── パネルフッター ─── */
.panel-footer {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  border-top: 1px solid var(--tm-border);
  background-color: var(--tm-header-bg);
  flex-shrink: 0;
}

.panel-footer__icon-btn {
  background: none;
  border: none;
  color: var(--tm-text-muted);
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s ease, color 0.2s ease;
}

.panel-footer__icon-btn:hover,
.panel-footer__icon-btn:focus-visible {
  background-color: var(--tm-overlay);
  color: var(--tm-text-primary);
  outline: none;
}

.panel-footer__icon-btn[aria-pressed='true'] {
  background-color: var(--tm-strong-overlay);
  color: var(--tm-accent);
}

/* ─── 展開ビュー（通常時は非表示） ─── */
.expanded-view {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background-color: var(--tm-bg);
  border-right: 1px solid var(--tm-border);
}

.expanded-view[hidden] {
  display: none;
}

/* ─── 展開時のレイアウト ─── */
body.is-expanded .panel-shell {
  position: fixed;
  top: 0;
  right: 0;
  width: 400px;
  height: 100%;
  z-index: 2;
  border-left: 1px solid var(--tm-border);
  box-shadow: -4px 0 12px rgba(0, 0, 0, 0.4);
}

body.is-expanded .expanded-view {
  position: fixed;
  top: 0;
  left: 0;
  right: 400px;
  bottom: 0;
  z-index: 1;
  display: flex;
}

/* ─── 列コンテナ ─── */
.expanded-view__columns {
  display: flex;
  flex-direction: row-reverse; /* DOM先頭 = 現在ウィンドウ = 視覚上右端 */
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
}

.expanded-view__column {
  display: flex;
  flex-direction: column;
  min-width: 240px;
  max-width: 320px;
  flex: 1 1 260px;
  border-left: 1px solid var(--tm-divider);
  overflow-y: auto;
  overflow-x: hidden;
}

/* 一番右の列（現在のウィンドウ）の左ボーダーはpanel-shellとの境界 */
.expanded-view__column:last-child {
  border-left: none;
}

.expanded-view__column-header {
  padding: 8px 12px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--tm-text-muted);
  border-bottom: 1px solid var(--tm-divider);
  flex-shrink: 0;
  background-color: var(--tm-header-bg);
  position: sticky;
  top: 0;
  z-index: 1;
}

.expanded-view__column-header--current {
  color: var(--tm-accent);
}

.expanded-view__tab-list {
  list-style: none;
  margin: 0;
  padding: 6px 0;
  flex: 1;
}
```

---

### 6-4. `panel.js`

#### 追加する定数（冒頭定数ブロック）
```js
const EXPANDED_VIEW_BTN_ID     = 'expanded-view-btn';
const EXPANDED_VIEW_ID         = 'expanded-view';
const EXPANDED_VIEW_COLUMNS_ID = 'expanded-view-columns';
const PANEL_EXPAND_MESSAGE     = 'TabManagerPanelExpand';
```

#### 追加する状態変数
```js
let expandedViewOpen = false;
let expandedViewRenderRequestId = 0;
```

#### `createTabListItem` の変更（既存関数、シグネチャのみ拡張）

```js
// 変更前
function createTabListItem(tab) {

// 変更後
function createTabListItem(tab, { disablePreview = false } = {}) {
```

mouseenterとmouseleaveのハンドラに `if (!disablePreview)` ガードを追加：

```js
favicon.addEventListener('mouseenter', () => {
  if (!disablePreview) handleTabHover(tab);
});
favicon.addEventListener('mouseleave', () => {
  if (!disablePreview && typeof tab.id === 'number') handleTabLeave(tab.id);
});
```

#### `createGroupAccordion` の変更（既存関数、シグネチャのみ拡張）

```js
// 変更前
function createGroupAccordion(groupId, groupInfo, tabs) {

// 変更後
function createGroupAccordion(groupId, groupInfo, tabs, { disablePreview = false } = {}) {
```

内部の `createTabListItem(tab)` を `createTabListItem(tab, { disablePreview })` に変更。

#### 新規追加：`setupExpandedViewControls`

```js
function setupExpandedViewControls() {
  const btn = document.getElementById(EXPANDED_VIEW_BTN_ID);
  if (!btn) return;

  btn.addEventListener('click', () => {
    expandedViewOpen = !expandedViewOpen;
    btn.setAttribute('aria-pressed', expandedViewOpen ? 'true' : 'false');

    document.body.classList.toggle('is-expanded', expandedViewOpen);

    const view = document.getElementById(EXPANDED_VIEW_ID);
    if (view) view.hidden = !expandedViewOpen;

    postToParentMessage(PANEL_EXPAND_MESSAGE, { expanded: expandedViewOpen });

    if (expandedViewOpen) {
      renderExpandedView();
    }
  });
}
```

#### 新規追加：`renderExpandedView`

```js
async function renderExpandedView() {
  const requestId = ++expandedViewRenderRequestId;
  const columnsContainer = document.getElementById(EXPANDED_VIEW_COLUMNS_ID);
  if (!columnsContainer) return;

  let allTabs;
  try {
    allTabs = await chrome.tabs.query({});
  } catch (e) {
    console.error('Failed to query tabs for expanded view:', e);
    return;
  }

  if (requestId !== expandedViewRenderRequestId) return;

  const currentWindowId = await getPanelWindowId();

  if (requestId !== expandedViewRenderRequestId) return;

  // ウィンドウ別にタブを振り分け
  const windowMap = new Map();
  for (const tab of allTabs) {
    if (!Number.isFinite(tab?.windowId)) continue;
    if (!windowMap.has(tab.windowId)) windowMap.set(tab.windowId, []);
    windowMap.get(tab.windowId).push(tab);
  }

  // 現在ウィンドウを先頭に（row-reverseで右端に表示される）
  const windowIds = [
    ...(currentWindowId != null ? [currentWindowId] : []),
    ...Array.from(windowMap.keys()).filter(id => id !== currentWindowId),
  ];

  // グループ情報を一括取得
  const allGroupIds = new Set();
  for (const tabs of windowMap.values()) {
    for (const tab of tabs) {
      if (Number.isFinite(tab?.groupId) && tab.groupId >= 0) {
        allGroupIds.add(tab.groupId);
      }
    }
  }

  const groupInfoMap = new Map();
  if (allGroupIds.size > 0 && chrome?.tabGroups?.get) {
    await Promise.all(
      Array.from(allGroupIds).map(async (groupId) => {
        try {
          groupInfoMap.set(groupId, await chrome.tabGroups.get(groupId));
        } catch {
          groupInfoMap.set(groupId, null);
        }
      })
    );
  }

  if (requestId !== expandedViewRenderRequestId) return;

  const fragment = document.createDocumentFragment();

  for (const windowId of windowIds) {
    const tabs = windowMap.get(windowId) ?? [];
    const column = buildWindowColumn(windowId, tabs, windowId === currentWindowId, groupInfoMap);
    fragment.appendChild(column);
  }

  columnsContainer.replaceChildren(fragment);
}
```

#### 新規追加：`buildWindowColumn`

```js
function buildWindowColumn(windowId, tabs, isCurrent, groupInfoMap) {
  const column = document.createElement('div');
  column.className = 'expanded-view__column';
  column.dataset.windowId = String(windowId);

  const header = document.createElement('div');
  header.className = 'expanded-view__column-header'
    + (isCurrent ? ' expanded-view__column-header--current' : '');
  header.textContent = isCurrent ? '現在のウィンドウ' : `ウィンドウ ${windowId}`;
  column.appendChild(header);

  const tabList = document.createElement('ul');
  tabList.className = 'expanded-view__tab-list';

  const groupMap = new Map();
  const structure = [];

  for (const tab of tabs) {
    if (Number.isFinite(tab?.groupId) && tab.groupId >= 0) {
      if (!groupMap.has(tab.groupId)) {
        groupMap.set(tab.groupId, { tabs: [], info: groupInfoMap.get(tab.groupId) ?? null });
        structure.push({ type: 'group', groupId: tab.groupId });
      }
      groupMap.get(tab.groupId).tabs.push(tab);
    } else {
      structure.push({ type: 'tab', tab });
    }
  }

  for (const item of structure) {
    if (item.type === 'tab') {
      tabList.appendChild(createTabListItem(item.tab, { disablePreview: true }));
    } else {
      const entry = groupMap.get(item.groupId);
      if (!entry || entry.tabs.length === 0) continue;
      const groupEl = createGroupAccordion(
        item.groupId, entry.info, entry.tabs, { disablePreview: true }
      );
      if (groupEl) {
        tabList.appendChild(groupEl);
      } else {
        entry.tabs.forEach(tab =>
          tabList.appendChild(createTabListItem(tab, { disablePreview: true }))
        );
      }
    }
  }

  column.appendChild(tabList);
  return column;
}
```

> `buildWindowColumn` は同期関数に変更した。
> グループ情報は `renderExpandedView` 内で事前一括取得した `groupInfoMap` を引数で受け取るため、内部での非同期API呼び出しが不要になる。

#### `refreshTabs` 末尾への追記

```js
// 既存の末尾処理の後に追加
if (expandedViewOpen) {
  renderExpandedView();  // requestIdパターンで自動的にキャンセル制御される
}
```

#### `DOMContentLoaded` への登録

```js
setupHeaderBehavior();
setupExpandedViewControls();  // ← 追加
```

---

## 7. v1からの主要変更点サマリー

| 項目 | v1 | v2 |
|------|----|----|
| 展開の実現方法 | iframeの内部fixed（画面左まで届かない） | content.jsがiframe幅を100vwに拡張 |
| プレビュー誤発火 | 「推奨」として記述のみ | `disablePreview`オプションとして実装に明記 |
| グループ情報取得 | buildWindowColumnが非同期で個別取得 | renderExpandedViewで事前一括取得しMapを渡す |
| buildWindowColumn | async関数 | 同期関数（グループ情報は引数で受取） |
| 再描画制御 | 記述なし | requestIdパターンで明示的にキャンセル |
| WeakMap問題 | 軽視できないと指摘 | 構造上競合しないと結論し不採用 |
