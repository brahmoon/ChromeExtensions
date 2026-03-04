# タブグループ ドラッグ＆ドロップ 不具合分析レポート

---

## 1. 問題の概要

Chrome拡張機能「TabManager」のサイドパネル上で、タブグループを縦方向にドラッグして並び替える機能において、**上から下方向への移動が正常に動作しない**。また、一度下から上に動かしたグループに限り下方向への移動が可能になるが、**挿入位置が意図より1つ下にずれる**。

---

## 2. 発生している問題

| # | 事象 | 条件 |
|---|------|------|
| A | ドラッグしても**ブラウザのタブバーに反映されない** | 上→下方向の移動すべて |
| B | ドロップしたのに**挿入位置が1つ下にずれる** | 下→上に移動済みのグループを再び下に移動するとき |

---

## 3. 実装構造の整理

関係するコードは `panel.js` 内の2関数に集約されている。

### `setupTabGroupDragAndDrop(root)`

ドラッグ操作のイベントハンドラ群。前回の再設計で以下のアーキテクチャに刷新済み：

- `dragover` → DOM操作なし。カーソル位置・対象グループを `pendingDropTarget` に記録するだけ
- `drop` → `pendingDropTarget` を読んで `moveTabGroupByDragAndDrop()` を呼ぶ
- 視覚フィードバック → CSSクラス `group-item--drop-before/after` によるインジケーター

### `moveTabGroupByDragAndDrop(sourceMeta, targetMeta, dropBefore)`

Chrome API を呼んで実際にグループを移動する関数。  
`chrome.tabGroups.move(sourceGroupId, { index: targetIndex })` を使用。

```js
// 現在の実装（問題あり）
const targetIndex = dropBefore
  ? targetSorted[0].index          // ターゲット先頭タブのindex
  : targetSorted[last].index + 1;  // ターゲット末尾タブの次のindex

await chrome.tabGroups.move(sourceGroupId, { index: targetIndex });
```

---

## 4. 原因の分析

### 問題A：上→下移動が反映されない

#### 原因①：`dragover` のウィンドウID検証がスナップショットの古いデータに依存している

```js
// dragover 内の検証コード（現在）
const sourceTabs = Array.isArray(dragging.metadata?.tabs) ? dragging.metadata.tabs : [];
const sourceWindowId = sourceTabs[0]?.windowId;
const targetWindowId = targetMeta.tabs[0]?.windowId;

if (!Number.isFinite(sourceWindowId) || ...) {
  clearGroupDropIndicators(root);
  pendingDropTarget = null;  // ← 記録されない
  return;
}
```

`dragging.metadata.tabs` は `refreshTabs()` 実行時点の**スナップショット**である。  
上→下への移動では、特定の状況下でこのスナップショットの `windowId` が `undefined` や不正値になっている場合、**ウィンドウID検証が `false` を返して `pendingDropTarget` が一切記録されない**。

結果として `drop` ハンドラは `pending === null` を検出して即 `return` し、  
`moveTabGroupByDragAndDrop()` が呼ばれないままになる。

#### 原因②：`chrome.tabGroups.move()` の `index` 仕様と補正漏れ（下→上移動後の上→下でも発現）

`chrome.tabGroups.move(groupId, { index })` の `index` は**「現在の全タブ配列における絶対位置」**を意味する。APIは内部で「ソースグループを取り除いてから指定インデックスに挿入する」という処理をする。

**上→下移動の具体例：**

```
移動前の状態：
  グループA: タブindex 0, 1  （ソース）
  グループB: タブindex 2, 3
  グループC: タブindex 4, 5  （ターゲット、Aをここの後ろへ）

計算式（現在）：
  targetIndex = 5 + 1 = 6

chrome.tabGroups.move(A.id, { index: 6 })
  → APIはAを取り除く → B:0,1 / C:2,3 （配列が縮む）
  → index=6 は配列末尾を超えているため、末尾に配置される
```

期待通りに動く場合もあるが、ソースが**ターゲットより前（indexが小さい）** にある上→下移動では、**ソースを取り除いた後に配列全体が前詰めされる**ため、補正なしの `targetIndex` は常に1グループ分（タブ数分）大きすぎる値になる。

---

### 問題B：挿入位置が1つ下にずれる

**下→上に移動済みのグループを再び下に移動するケース：**

```
移動前（Bが上に移動済み）：
  グループB: タブindex 0, 1  （ソース）
  グループA: タブindex 2, 3  （ターゲット、Bをここの後ろへ）

計算式（現在）：
  targetIndex = 3 + 1 = 4

chrome.tabGroups.move(B.id, { index: 4 })
  → APIはBを取り除く → A:0,1 （配列が2つ縮む）
  → index=4 は配列末尾を超え、末尾（index=2の次）に配置される
  → 期待： A の直後 → 実際：同じだが補正がない場合は…

```

この方向では偶然近い位置になるが、グループ間にグループ以外の要素（ungroupedタブ）が混在しているときに **ターゲットグループの末尾タブの次のインデックス** を指定しても、ソースを取り除いた後の前詰めによってズレが生じる。

**本質は同じ：ソースがターゲットより前にあるとき `targetIndex` を `sourceTabsCount` だけ小さく補正していない。**

---

## 5. 修正方針

### 方針①：`dragover` のウィンドウID検証からスナップショット依存を除去する

`dragging.metadata.tabs` のスナップショットを使ったウィンドウID検証を廃止し、  
`targetMeta.tabs[0]?.windowId` だけで判定できるように変更する。  
同一パネル内に表示されているグループはすべて同一ウィンドウのタブであることが保証されており、  
異なるウィンドウのグループはパネルの通常表示モード（expandedViewEnabled=false）では混在しない。

```js
// 修正後
const targetMeta = groupMetadataMap.get(targetGroup);
if (!targetMeta || !Array.isArray(targetMeta.tabs) || targetMeta.tabs.length === 0) {
  // targetMeta が取れればウィンドウID検証は不要
  clearGroupDropIndicators(root);
  pendingDropTarget = null;
  return;
}
// sourceWindowId / targetWindowId の比較ブロックを削除
```

### 方針②：`moveTabGroupByDragAndDrop` に前方補正を追加する

`chrome.tabGroups.move()` はソースを取り除いてから挿入するため、  
ソースグループが**ターゲットグループより前（indexが小さい）** にある場合、  
`targetIndex` からソースグループのタブ数（`sourceCount`）を引く補正が必要。

```
補正ルール：
  if (sourceStart < targetIndex) {
    targetIndex -= sourceCount;
  }
```

これにより、APIがソースを取り除いた後の前詰め分を事前に打ち消せる。

---

## 6. 具体的な実装ロジック

### `moveTabGroupByDragAndDrop` の修正

```js
async function moveTabGroupByDragAndDrop(sourceMeta, targetMeta, dropBefore) {
  if (!chrome?.tabGroups?.move) {
    console.warn('chrome.tabGroups.move is not available');
    return;
  }

  const sourceGroupId = Number.isFinite(sourceMeta?.groupId) ? sourceMeta.groupId : null;
  const targetGroupId = Number.isFinite(targetMeta?.groupId) ? targetMeta.groupId : null;
  if (!Number.isFinite(sourceGroupId) || !Number.isFinite(targetGroupId) || sourceGroupId === targetGroupId) {
    return;
  }

  // ソースグループのタブ数（スパン）を知るために sourceTabs も取得する
  let sourceTabs = [];
  let targetTabs = [];
  try {
    [sourceTabs, targetTabs] = await Promise.all([
      chrome.tabs.query({ groupId: sourceGroupId }),
      chrome.tabs.query({ groupId: targetGroupId }),
    ]);
  } catch (error) {
    console.error('Failed to query tabs for group drag and drop:', error);
    return;
  }

  sourceTabs = Array.isArray(sourceTabs)
    ? sourceTabs.filter((t) => Number.isFinite(t?.index))
    : [];
  targetTabs = Array.isArray(targetTabs)
    ? targetTabs.filter((t) => Number.isFinite(t?.index))
    : [];

  if (sourceTabs.length === 0 || targetTabs.length === 0) {
    return;
  }

  const sourceSorted = sourceTabs.slice().sort((a, b) => a.index - b.index);
  const targetSorted = targetTabs.slice().sort((a, b) => a.index - b.index);

  const sourceStart = sourceSorted[0].index;
  const sourceCount = sourceSorted.length;

  // 移動先インデックスを計算（現在の絶対インデックス）
  let targetIndex = dropBefore
    ? targetSorted[0].index
    : targetSorted[targetSorted.length - 1].index + 1;

  if (!Number.isFinite(targetIndex) || targetIndex < 0) {
    return;
  }

  // ソースがターゲットより前にある場合、ソース取り除き後の前詰め分を補正する
  if (sourceStart < targetIndex) {
    targetIndex -= sourceCount;
  }

  // 補正後も移動不要（同位置）ならスキップ
  if (targetIndex < 0 || targetIndex === sourceStart) {
    return;
  }

  await chrome.tabGroups.move(sourceGroupId, { index: targetIndex });
}
```

### `dragover` ハンドラのウィンドウID検証削除（`setupTabGroupDragAndDrop` 内）

```js
// 修正前
const sourceTabs = Array.isArray(dragging.metadata?.tabs) ? dragging.metadata.tabs : [];
const targetMeta = groupMetadataMap.get(targetGroup);
if (!targetMeta || ...) { ... }
const sourceWindowId = sourceTabs[0]?.windowId;
const targetWindowId = targetMeta.tabs[0]?.windowId;
if (!Number.isFinite(sourceWindowId) || !Number.isFinite(targetWindowId) || sourceWindowId !== targetWindowId) {
  clearGroupDropIndicators(root);
  pendingDropTarget = null;
  return;
}

// 修正後（スナップショット依存の windowId 比較を削除）
const targetMeta = groupMetadataMap.get(targetGroup);
if (!targetMeta || !Array.isArray(targetMeta.tabs) || targetMeta.tabs.length === 0) {
  clearGroupDropIndicators(root);
  pendingDropTarget = null;
  return;
}
// windowId の比較ブロックをここから削除
```

---

## 7. 変更サマリー

| 変更箇所 | 変更内容 | 解決する問題 |
|----------|----------|-------------|
| `moveTabGroupByDragAndDrop` | `sourceTabs` を追加取得し、`sourceStart < targetIndex` の場合に `targetIndex -= sourceCount` で前方補正 | 問題A（上→下反映されない）・問題B（1つ下にずれる）の両方 |
| `dragover` ハンドラ内 | `dragging.metadata.tabs` スナップショットを使ったウィンドウID比較ブロックを削除 | 問題A（上→下で `pendingDropTarget` が記録されない） |

変更対象は `panel.js` のみ。`background.js`・`content.js`・`manifest.json` への変更は不要。
