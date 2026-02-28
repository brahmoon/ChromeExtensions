# 全ウィンドウ展開ビュー（プロトタイプ）実装仕様書

## 概要

管理パネル下部のフッターに配置したアイコンをクリックすると、パネルが画面左端まで横方向に拡大し、全ウィンドウのタブ一覧を列ごとに並べて表示するプロトタイプ機能。

---

## 完成イメージ

```
┌────────────────────────────────────────────────────────┬──────────────┐
│  展開ビュー（左方向に拡張）                              │ 通常パネル   │
│                                                        │              │
│  [Win B]          [Win C]      [現在のウィンドウ Win A] │  ヘッダー    │
│  ─────────────    ──────────   ──────────────────────  │  タブ一覧    │
│  ● グループX       Tab D        ● グループP             │  ...         │
│    Tab A          Tab E          Tab 1                 │              │
│    Tab B                         Tab 2                 │  ─────────── │
│  Tab C (ungr)                  Tab 3 (ungr)            │  [🗂] footer  │
└────────────────────────────────────────────────────────┴──────────────┘
```

- **一番右の列**：現在のウィンドウ（panel.js が属するウィンドウ）
- **左に向かう列**：他のウィンドウ（取得順に右→左へ配置）
- 各列は既存の `createGroupAccordion` / `createTabListItem` を再利用して描画

---

## 変更ファイルと役割分担

| ファイル | 変更内容 |
|---|---|
| `panel.html` | フッター要素・展開ビューコンテナを追加 |
| `styles.css` | フッター・展開ビュー・列レイアウトのスタイルを追加 |
| `panel.js` | フッターボタンのロジック・全ウィンドウ取得・列レンダリングを追加 |
| `content.js` | 展開時のパネル幅変更メッセージを受信してiframeを伸縮させる処理を追加 |

---

## 1. `panel.html` の変更

### 1-1. フッターの追加

`</div><!-- #panel-content -->` の直後、`</div><!-- .panel-shell -->` の直前に追加する。

```html
<footer class="panel-footer">
  <button
    id="expanded-view-btn"
    class="panel-footer__icon-btn"
    type="button"
    title="全ウィンドウを展開表示"
    aria-pressed="false"
    aria-label="全ウィンドウを展開表示"
  >
    <!-- 格子状のグリッドアイコン（仮） -->
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z"/>
    </svg>
  </button>
</footer>
```

### 1-2. 展開ビューコンテナの追加

`<footer>` の直前（`#panel-content` の外側、`.panel-shell` の内側）に追加する。

```html
<div id="expanded-view" class="expanded-view" hidden aria-label="全ウィンドウビュー">
  <div id="expanded-view-columns" class="expanded-view__columns"></div>
</div>
```

---

## 2. `styles.css` の変更

末尾に以下を追加する（既存スタイルへの変更なし）。

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

/* ─── 展開ビュー ─── */
.expanded-view {
  position: fixed;
  top: 0;
  /* right は JS が panel 幅 (400px) を動的にセットする */
  right: 400px;
  left: 0;
  bottom: 0;
  background-color: var(--tm-bg);
  border-right: 1px solid var(--tm-border);
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.35);
  z-index: 999998;
  display: flex;          /* hidden 属性で上書きされるので常に flex でよい */
  flex-direction: column;
  overflow: hidden;
}

.expanded-view[hidden] {
  display: none;
}

.expanded-view__columns {
  display: flex;
  flex-direction: row-reverse; /* 右端 = 現在ウィンドウ、左方向 = 他ウィンドウ */
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
}

/* 各ウィンドウ列 */
.expanded-view__column {
  display: flex;
  flex-direction: column;
  min-width: 260px;
  max-width: 320px;
  flex: 1 1 260px;
  border-left: 1px solid var(--tm-divider);
  overflow-y: auto;
  overflow-x: hidden;
}

.expanded-view__column:last-child {  /* 一番右 = 現在のウィンドウ */
  border-left: none;
  border-right: 1px solid var(--tm-divider);
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

## 3. `panel.js` の変更

### 3-1. 定数追加（冒頭定数ブロックに追記）

```js
const EXPANDED_VIEW_BTN_ID        = 'expanded-view-btn';
const EXPANDED_VIEW_ID            = 'expanded-view';
const EXPANDED_VIEW_COLUMNS_ID    = 'expanded-view-columns';
const PANEL_EXPAND_MESSAGE        = 'TabManagerPanelExpand';  // → content.js へ送信
```

### 3-2. 状態変数追加（グローバル変数ブロックに追記）

```js
let expandedViewOpen = false;
```

### 3-3. 展開ビューのセットアップ関数（新規追加）

既存の `setupHeaderBehavior()` の付近に追加する。

```js
function setupExpandedViewControls() {
  const btn = document.getElementById(EXPANDED_VIEW_BTN_ID);
  if (!btn) return;

  btn.addEventListener('click', () => {
    expandedViewOpen = !expandedViewOpen;
    btn.setAttribute('aria-pressed', expandedViewOpen ? 'true' : 'false');

    const view = document.getElementById(EXPANDED_VIEW_ID);
    if (view) {
      view.hidden = !expandedViewOpen;
    }

    // content.js 側のパネル幅を変更させる
    postToParentMessage(PANEL_EXPAND_MESSAGE, { expanded: expandedViewOpen });

    if (expandedViewOpen) {
      renderExpandedView();
    }
  });
}
```

### 3-4. 展開ビューのレンダリング関数（新規追加）

`createGroupAccordion` / `createTabListItem` を完全に再利用する。

```js
async function renderExpandedView() {
  const columnsContainer = document.getElementById(EXPANDED_VIEW_COLUMNS_ID);
  if (!columnsContainer) return;

  // ローディング表示（任意）
  columnsContainer.innerHTML = '';

  let allTabs;
  try {
    allTabs = await chrome.tabs.query({});          // 全ウィンドウの全タブ
  } catch (e) {
    console.error('Failed to query all tabs for expanded view:', e);
    return;
  }

  // 現在のウィンドウ ID を取得
  const currentWindowId = await getPanelWindowId(); // 既存関数を再利用

  // ウィンドウIDごとにタブをグルーピング
  const windowMap = new Map();   // windowId → Tab[]
  for (const tab of allTabs) {
    if (!Number.isFinite(tab?.windowId)) continue;
    if (!windowMap.has(tab.windowId)) windowMap.set(tab.windowId, []);
    windowMap.get(tab.windowId).push(tab);
  }

  // 現在ウィンドウを先頭、他ウィンドウを後続に並べる
  // columns は flex-direction: row-reverse なので、
  // DOM上で先頭に追加した要素が視覚的に一番右（現在ウィンドウ）になる
  const windowIds = [
    ...(currentWindowId != null ? [currentWindowId] : []),
    ...Array.from(windowMap.keys()).filter(id => id !== currentWindowId),
  ];

  for (const windowId of windowIds) {
    const tabs = windowMap.get(windowId) ?? [];
    const column = await buildWindowColumn(windowId, tabs, windowId === currentWindowId);
    columnsContainer.appendChild(column);
  }
}
```

### 3-5. 列（ウィンドウ単位）ビルダー（新規追加）

```js
async function buildWindowColumn(windowId, tabs, isCurrent) {
  const column = document.createElement('div');
  column.className = 'expanded-view__column';
  column.dataset.windowId = String(windowId);

  // ─── 列ヘッダー ───
  const header = document.createElement('div');
  header.className =
    'expanded-view__column-header' + (isCurrent ? ' expanded-view__column-header--current' : '');
  header.textContent = isCurrent ? '現在のウィンドウ' : `ウィンドウ ${windowId}`;
  column.appendChild(header);

  // ─── タブ一覧 ───
  const tabList = document.createElement('ul');
  tabList.className = 'expanded-view__tab-list';

  // グループ構造を構築（refreshTabs と同じロジック）
  const groupMap = new Map();
  const structure  = [];

  for (const tab of tabs) {
    if (Number.isFinite(tab?.groupId) && tab.groupId >= 0) {
      if (!groupMap.has(tab.groupId)) {
        groupMap.set(tab.groupId, { tabs: [], info: null });
        structure.push({ type: 'group', groupId: tab.groupId });
      }
      groupMap.get(tab.groupId).tabs.push(tab);
    } else {
      structure.push({ type: 'tab', tab });
    }
  }

  // グループ情報を取得
  if (groupMap.size > 0 && chrome?.tabGroups?.get) {
    await Promise.all(
      Array.from(groupMap.entries()).map(async ([groupId, entry]) => {
        try { entry.info = await chrome.tabGroups.get(groupId); }
        catch { entry.info = null; }
      })
    );
  }

  // DOM 構築：既存の createGroupAccordion / createTabListItem を再利用
  for (const item of structure) {
    if (item.type === 'tab') {
      tabList.appendChild(createTabListItem(item.tab));
    } else if (item.type === 'group') {
      const entry = groupMap.get(item.groupId);
      if (!entry || entry.tabs.length === 0) continue;
      const groupEl = createGroupAccordion(item.groupId, entry.info, entry.tabs);
      if (groupEl) {
        // group-item は <li> なので直接追加可
        tabList.appendChild(groupEl);
      } else {
        entry.tabs.forEach(tab => tabList.appendChild(createTabListItem(tab)));
      }
    }
  }

  column.appendChild(tabList);
  return column;
}
```

### 3-6. `DOMContentLoaded` ハンドラへの登録

既存の `setupHeaderBehavior()` の次行に追加する。

```js
setupExpandedViewControls();    // ← 追加
```

---

## 4. `content.js` の変更

### 4-1. 定数追加

```js
const PANEL_EXPAND_MESSAGE = 'TabManagerPanelExpand';
```

### 4-2. `window.addEventListener('message', messageHandler)` のハンドラに分岐を追加

既存の `TabManagerClosePanel` 分岐の直後に追加する。

```js
if (event.data?.type === PANEL_EXPAND_MESSAGE) {
  const expanded = Boolean(event.data?.detail?.expanded);
  const panel = getPanel();
  if (!panel) return;

  if (expanded) {
    // パネルを画面右端の400px幅に縮小して固定し、左側を展開ビューに明け渡す
    // ※ 展開ビュー自体は panel.html 内の fixed 要素として描画されるため、
    //   content.js 側では iframe 幅の調整は不要。
    //   ただし将来的に iframe 幅を変えたい場合はここで panel.style.width を変更する。
    //
    // 現実装では panel.html 側の .expanded-view が
    // position:fixed; right:400px; left:0 で自律的に展開するため変更不要。
  } else {
    // 折りたたみ時は同様に何もしない（expanded-view は hidden になる）
  }
  return;
}
```

> **注記**：現設計では `content.js` 側の iframe 幅変更は不要。`.expanded-view` が `position: fixed; right: 400px; left: 0` で panel.html の viewport 内に描画されるため、panel iframe（幅400px）の内側に展開ビューが重なって表示される。将来 iframe 幅を広げて展開ビューを独立させたい場合は、ここで `panel.style.width = '100vw'` 等に変更し、`.expanded-view` の `right` 値もそれに合わせて調整する。

---

## 5. 実装上の注意点

### 5-1. `createTabListItem` / `createGroupAccordion` の副作用

- どちらも `tabMetadataMap` / `groupMetadataMap` への WeakMap 登録を行う。展開ビュー用要素は通常のタブリストとは別コンテナに追加されるため、競合は生じない。
- クリックイベント（タブ選択・グループ展開）も既存ロジックがそのまま動作する。

### 5-2. 展開ビューのリフレッシュ

- タブが追加・削除・更新された際に展開ビューが開いている場合は再レンダリングが必要。
- `refreshTabs()` の末尾に以下を追加する：

```js
if (expandedViewOpen) {
  renderExpandedView();
}
```

### 5-3. グループアコーディオンの展開状態

- `createGroupAccordion` は `getStoredGroupExpansionState()` を参照するため、展開ビューのグループも通常パネルと同じ展開状態を共有する。プロトタイプ段階では許容範囲内。

### 5-4. プレビュー機能との干渉

- 展開ビュー内のタブをホバーしてもプレビューは表示しない（`postToParentMessage` は panel.js から送信されるが、`activePreviewTabId` は通常パネルのホバーでのみ更新される）。
- 展開ビュー内のタブアイテムは通常と同一の DOM 構造のため、既存のホバーハンドラが意図せず発火する可能性がある。プロトタイプでは許容するが、正式実装時は展開ビュー列に `data-no-preview` 属性を付け、プレビュー更新ロジック側でガードを追加することを推奨。

### 5-5. スクロール位置の保存

- 展開ビュー内のスクロールは `scrollPersistence` の対象外にする（別コンテナのため自動的に対象外）。

---

## 6. 将来の拡張候補

- 展開ビュー内でのタブのドラッグ＆ドロップによるウィンドウ間移動
- 展開ビュー上部にウィンドウ名の編集フォームを追加
- プレビューとの統合（展開ビュー内のタブをホバーでプレビュー表示）
- iframe 幅を 100vw に広げ、展開ビューを独立した全画面オーバーレイとして実装
