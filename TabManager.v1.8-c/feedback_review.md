# フィードバック統合レビュー：タブグループ D&D 不具合分析

Gemini・GPT によるフィードバックを Claude の既存分析にマージし、  
各指摘の採用判断と理由を記述する。

---

## フィードバック項目一覧と判定

| # | 指摘者 | 指摘内容 | 判定 |
|---|--------|----------|------|
| 1 | Gemini | `windowId` 検証の削除は危険（マルチウィンドウ） | **採用** |
| 2 | Gemini | `windowId` 検証はスナップショットでなくAPIで最新値を取得すべき | **部分採用** |
| 3 | Gemini | ドラッグ中のタブ変動に対する競合状態（Race Condition）への配慮 | **要検討課題** |
| 4 | Gemini | `sourceCount` の算出は「前方にある自タブ数」で正確にカウントすべき | **採用** |
| 5 | GPT | `tab.windowId` は API 仕様上 必ず存在する（`undefined` の原因は配列が空） | **採用** |
| 6 | GPT | `windowId` 検証は `drop` 時に再取得した tabs で行うべき | **部分採用** |
| 7 | GPT | `ungrouped tab` 混在時の `targetIndex` ズレへの配慮 | **採用** |
| 8 | GPT | `dragover` で `pendingDropTarget` に `targetIndex` まで計算して保持すべき | **不採用** |
| 9 | GPT | `dragover` で `preventDefault()` を呼ばないと `drop` が発火しない点の注意 | **採用（現状維持確認）** |

---

## 各判定の詳細

---

### 1. `windowId` 検証の削除は危険 ―― **採用**

**Gemini / GPT 共通指摘：**  
`windowId` 検証を削除するという Claude の修正方針は、`expandedView`（全ウィンドウ表示）モードで
ウィンドウをまたいだグループ移動を許してしまう危険がある。  
`chrome.tabGroups.move()` はウィンドウ間移動をサポートしないためエラーになるか、意図しない挙動になる。

**コードでの裏付け：**  
`setupTabGroupDragAndDrop` は通常モードと `expandedView` の両方で呼ばれている（panel.js L4520）。  
`expandedView` では複数ウィンドウのグループが同一 DOM ツリーに混在するため、
`windowId` 検証は安全装置として機能している。削除は不適切。

**採用する修正方針：**  
削除ではなく「スナップショット依存を排除した上で検証を維持する」。

---

### 2. `windowId` 検証にはAPIの最新値を使うべき ―― **部分採用**

**Gemini の指摘：**  
ドラッグ開始時に `sourceWindowId` を固定値として保持するか、API で最新値を取得すべき。

**GPT の指摘：**  
`drop` 時に `chrome.tabs.query()` で再取得した tabs から検証すべき。

**判断：**

- `dragover` は毎フレーム発火するため、その都度 API を叩くのはパフォーマンス上許容できない。  
- `drop` 時に `moveTabGroupByDragAndDrop` 内で `sourceTabs` と `targetTabs` を両方 API 取得する設計（Gemini の逆提案・GPT 推奨）は合理的であり、その中で `windowId` 比較を行えば十分。
- `dragover` では `dragging.metadata.tabs` のスナップショットではなく、**ドラッグ開始時に `sourceWindowId` を `tabPanelDraggingGroupState` に固定値として記録**して使う方式を採用する。これにより dragover は API を叩かず、かつスナップショットの経年劣化にも依存しない。

**採用する修正方針：**
- `dragstart` 時に `sourceWindowId = sourceTabs[0]?.windowId` を状態に保存
- `dragover` はその固定値 vs `targetMeta.tabs[0]?.windowId` で比較
- `moveTabGroupByDragAndDrop` 内では API 取得後に再確認

---

### 3. Race Condition への配慮 ―― **要検討課題**

**Gemini の指摘：**  
ドラッグ中に別タブが閉じられたり自動グループ化が走った場合、`targetIndex` が古くなる。  
`chrome.tabGroups.move` 直前に最新インデックスを確認すべき。

**判断：**  
指摘は原理的に正しい。ただし以下の理由から今回のスコープでは対応を保留する。

- `chrome.tabGroups.move()` の `index` は「移動先の絶対インデックス指定」であり、
  もしインデックスが古くてもブラウザが範囲クランプ処理をするため、クラッシュはしない。
- 対応するにはドラッグ中のタブイベントをすべて監視してインデックスを再計算する仕組みが必要であり、
  現在の設計範囲を大幅に超える。
- ドラッグ操作は数秒以内に完結する操作であり、その間に別タブが閉じられる競合が
  ユーザー体験に影響する確率は低い。

**要検討課題として記録：**  
将来的には `refreshTabs()` による再描画をドラッグ中は抑制し、
`drop` 後に一括更新する設計にすることで副作用を軽減できる。

---

### 4. `sourceCount` は「前方にある自タブ数」で正確にカウントすべき ―― **採用**

**Gemini の指摘：**  
`targetIndex -= sourceCount`（グループ内タブ数を単純減算）ではなく、
`targetIndex より前にある 移動対象タブの数` を正確にカウントして差し引くべき。

**判断：**  
これは正しい。通常グループ内タブは連続しているため単純減算は機能するが、
他拡張機能の干渉やAPIバグでインデックスが不連続になった場合に補正が過剰・過少になり得る。  
「前方にある自タブを数える」方式は同じ結果になりつつ、不連続ケースにも安全。

**採用する実装：**
```js
// 単純減算（旧）
targetIndex -= sourceCount;

// 正確なカウント（新）
const sourceTabsBeforeTarget = sourceTabs.filter(t => t.index < targetIndex).length;
targetIndex -= sourceTabsBeforeTarget;
```

---

### 5. `tab.windowId` の `undefined` 原因は配列が空 ―― **採用**

**GPT の指摘：**  
Chrome Tabs API 仕様上 `tab.windowId` は必ず存在する整数値。  
`undefined` になる場合は `sourceTabs[0]` が `undefined`、すなわち配列が空であることが主因。

**判断：**  
正確な指摘。Claude の原因①（「スナップショットの `windowId` が不正値」）は正しい現象を捉えているが、
「`windowId` が `undefined`」ではなく「配列が空のため `sourceTabs[0]` が `undefined`」が正確な説明。  
これにより修正方針が微妙に変わる。検証すべきは `windowId` の値そのものより、
**配列が空でないこと・`sourceWindowId` が有限値であること** であり、現在のガード条件
`!Number.isFinite(sourceWindowId)` は正しく機能している。

---

### 6. `windowId` 検証を `drop` 時に API 取得 tabs で行うべき ―― **部分採用**

**GPT の指摘：**  
`dragover` では `windowId` 判定せず、`drop` 時に API 取得した tabs で検証すべき。

**判断：**  
`moveTabGroupByDragAndDrop` 内で `sourceTabs` と `targetTabs` を API から取得し、
その時点で `windowId` を比較するアプローチは採用する（判定2と重複）。  
ただし `dragover` 側の検証も残す。理由は、`dragover` でウィンドウ間ドロップを許可しない視覚フィードバック
（インジケーターを出さない・`dropEffect` を `none` にする）を正しく機能させるため。
`drop` 側だけにガードを置くと、ユーザーにはドロップ可能に見えて操作後に何も起きないという UX の劣化が生じる。

---

### 7. `ungrouped tab` 混在時の `targetIndex` ズレ ―― **採用**

**GPT の指摘：**  
グループとグループの間に ungrouped tab が存在する場合、
`targetSorted[last].index + 1` がその ungrouped tab のインデックスを指すことがあり、
グループの直後ではなく間に挿入される可能性がある。

**判断：**  
`chrome.tabGroups.move()` は `index` で指定した位置にグループを移動するが、
グループ間に ungrouped tab が存在すると「グループの直後」の意図が `+1` では表現できない場合がある。  
最も安全なアプローチは Gemini の逆提案にある `Math.max(...targetGroupTabs.map(t => t.index)) + 1` と
`filter(t => t.index < targetIndex).length` の組み合わせで、`allTabs` から一括取得して計算する。

---

### 8. `dragover` で `targetIndex` まで計算して保持すべき ―― **不採用**

**GPT の指摘：**  
`pendingDropTarget` に `targetIndex` まで事前計算して保存すべき。

**判断：**  
不採用。理由は以下。

- `targetIndex` の計算には API 取得（`chrome.tabs.query`）が必要であり、
  `dragover` が毎フレーム発火する中で非同期 API を呼ぶことは設計上禁忌。
- `pendingDropTarget` に保存すべき情報は「どのグループのどちら側か（意図）」であり、
  `targetIndex`（絶対値）は実行直前に最新状態から計算するのが正しい。  
  `dragover` 時点で計算したインデックスは `drop` 時にはすでに古い可能性がある（Gemini の Race Condition 指摘と同様の問題をむしろ引き込む）。

---

### 9. `dragover` で `preventDefault()` を呼ばないと `drop` が発火しない ―― **採用（現状維持確認）**

**GPT の指摘：**  
`pendingDropTarget = null` のケースでも `preventDefault()` の扱いに注意。

**判断：**  
現在の実装では `event.preventDefault()` はウィンドウID検証が通過した後に呼ばれており、
「ドロップ不可」判定時には意図的に `preventDefault()` を呼ばないことで `drop` を発火させない設計になっている。  
これは正しく、変更不要。ただし明示的なコメントを追記して設計意図を記録する価値はある。

---

## 統合後の修正方針まとめ

### `moveTabGroupByDragAndDrop` の再実装

```js
async function moveTabGroupByDragAndDrop(sourceMeta, targetMeta, dropBefore) {
  if (!chrome?.tabGroups?.move) return;

  const sourceGroupId = sourceMeta?.groupId;
  const targetGroupId = targetMeta?.groupId;
  if (!Number.isFinite(sourceGroupId) || !Number.isFinite(targetGroupId) || sourceGroupId === targetGroupId) return;

  // 実行直前に最新のタブ状態を API から取得（スナップショット非依存）
  let sourceTabs, targetTabs;
  try {
    [sourceTabs, targetTabs] = await Promise.all([
      chrome.tabs.query({ groupId: sourceGroupId }),
      chrome.tabs.query({ groupId: targetGroupId }),
    ]);
  } catch (e) {
    console.error('Failed to query tabs for group move:', e);
    return;
  }

  sourceTabs = sourceTabs.filter(t => Number.isFinite(t?.index));
  targetTabs = targetTabs.filter(t => Number.isFinite(t?.index));
  if (sourceTabs.length === 0 || targetTabs.length === 0) return;

  // windowId 再確認（drop 実行直前の最終安全チェック）
  if (sourceTabs[0].windowId !== targetTabs[0].windowId) return;

  const targetSorted = targetTabs.slice().sort((a, b) => a.index - b.index);

  let targetIndex = dropBefore
    ? targetSorted[0].index
    : targetSorted[targetSorted.length - 1].index + 1;

  // 【補正】ソースが前方にある場合、取り除き後の前詰め分を正確にカウントして補正
  // sourceCount の単純減算ではなく、targetIndex より前にある自タブ数を数える
  const sourceTabsBeforeTarget = sourceTabs.filter(t => t.index < targetIndex).length;
  targetIndex -= sourceTabsBeforeTarget;

  if (targetIndex < 0 || targetIndex === sourceTabs.sort((a, b) => a.index - b.index)[0].index) return;

  await chrome.tabGroups.move(sourceGroupId, { index: targetIndex });
}
```

### `dragstart` の状態保存に `sourceWindowId` を追加

```js
// dragstart 時
tabPanelDraggingGroupState = {
  source: groupItem,
  metadata,
  sourceWindowId: dragging.metadata.tabs[0]?.windowId ?? null, // 固定値として記録
  moved: false,
};
```

### `dragover` の `windowId` 検証をスナップショット依存から固定値依存に変更

```js
// 修正前
const sourceTabs = Array.isArray(dragging.metadata?.tabs) ? dragging.metadata.tabs : [];
const sourceWindowId = sourceTabs[0]?.windowId;

// 修正後
const sourceWindowId = dragging.sourceWindowId; // dragstart 時に記録した固定値
```

---

## 変更サマリー（最終版）

| 変更箇所 | 内容 | 根拠 |
|----------|------|------|
| `dragstart` | `sourceWindowId` を状態に保存 | Gemini案・GPT案の折衷。スナップショット依存を排除しつつ API コストなし |
| `dragover` の windowId 検証 | スナップショット参照 → `dragging.sourceWindowId` 固定値参照 | 上に同じ |
| `moveTabGroupByDragAndDrop` | `sourceTabs` / `targetTabs` を API 取得後に `windowId` 再確認 | GPT 推奨。drop 直前の最終安全チェック |
| `moveTabGroupByDragAndDrop` | `sourceTabsBeforeTarget` による正確な前方補正 | Gemini の逆提案を採用 |
| `moveTabGroupByDragAndDrop` | `sourceCount` 単純減算を廃止 | Gemini 指摘④を採用 |
| `windowId` 検証の削除方針 | 不採用・検証を維持 | Gemini 指摘①・GPT 指摘を採用 |
| `dragover` での `targetIndex` 事前計算 | 不採用 | GPT 提案⑧：dragover での非同期API呼び出しは禁忌 |
| Race Condition 対応 | 今回スコープ外。要検討課題として記録 | Gemini 指摘③：対応コスト大・緊急度低 |
