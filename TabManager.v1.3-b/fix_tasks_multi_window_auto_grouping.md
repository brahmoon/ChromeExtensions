# 不具合修正タスク：複数ウィンドウ時の自動グループ化が機能しない問題

## 概要

複数ウィンドウが開いている状態で、サブウィンドウのタブに対してドメイン自動グループ化が機能しない・効いたり効かなかったりする不具合。

**分析元：** Codex による調査 + Claude / Gemini による検証（いずれも `background.js` のコードと一致することを確認済み）

---

## タスク 1：`lastFocusedWindow` 厳格ゲートによる取りこぼしを緩和する

### 優先度：高（最優先）

### 原因

`autoGroupTabByDomain`（L1301〜1431）の `requireActiveContext` ブロックで、以下の2条件を **AND** で評価している：

```js
if (requireActiveContext) {
  if (!tab.active) return;  // 条件A: タブがアクティブでなければスキップ
  const activeWindowId = await resolveLastFocusedWindowId();
  if (activeWindowId !== tab.windowId) return;  // 条件B: フォーカス中ウィンドウと不一致ならスキップ
}
```

`onUpdated` ハンドラ（L1060〜1065）はバックグラウンド新規タブを除いて `requireActiveContext: true` で呼び出すため、**サブウィンドウでURLが変わった瞬間にメインウィンドウへフォーカスが移っていると、条件Bに引っかかり処理がスキップされる。**

`resolveLastFocusedWindowId` 自体は `chrome.tabs.query({ lastFocusedWindow: true })` を使っており、OS レベルのウィンドウフォーカスに依存するため競合が起きやすい。

### 修正方針

- `requireActiveContext` の条件Bを **廃止または緩和** し、`tab.windowId` を直接 `autoGroupTabByDomain` に渡してフォーカス状態を問わずグループ化判定を実行するよう変更する。
- 条件Aの `!tab.active` チェックについても、`onUpdated` で URL 変化を検知した場合は **非アクティブタブでも対象に含める** よう変更する（バックグラウンドで開いたタブへの対応）。

### 変更対象

| ファイル | 箇所 |
|---|---|
| `background.js` | `autoGroupTabByDomain` L1310〜1318 |
| `background.js` | `onUpdated` リスナー L1060〜1065（`requireActiveContext` の渡し方） |

### 注意事項

- `requireActiveContext: false` で呼び出す `onCreated`（L1041）はすでに正常に動作しており、変更不要。
- 緩和によりグループ化の実行頻度が上がるため、後述のデバウンス対応（タスク4）と合わせて実施することを推奨。

---

## タスク 2：自動化 ON 時の初回グループ化対象を全ウィンドウに拡張する

### 優先度：高（最優先）

### 原因

`chrome.storage.onChanged` のリスナー（L1607〜1635）で、設定が OFF→ON に切り替わった際の初回処理が以下になっている：

```js
resolveLastFocusedWindowId().then((windowId) => {
  return groupTabsByDomain({ scope: GROUP_SCOPE_CURRENT, windowId });  // ← 1ウィンドウのみ
});
```

`GROUP_SCOPE_CURRENT` かつ `lastFocusedWindow` のみを対象とするため、**設定 ON 時にフォーカスされていないウィンドウは初回グループ化から除外される。** その後のグループ化は `onUpdated` の URL 変化イベントに依存するため、既存タブを多数持つサブウィンドウは「ずっと効いていない」状態になり得る。

### 修正方針

- `autoDomainGroupingEnabled` が `false → true` に変化した時点で、**`GROUP_SCOPE_ALL`（全ウィンドウ）を対象に `groupTabsByDomain` を実行する** よう変更する。

```js
// 修正後イメージ
if (!wasEnabled && autoDomainGroupingEnabled) {
  groupTabsByDomain({ scope: GROUP_SCOPE_ALL })
    .then((hasChanges) => {
      if (hasChanges) return persistTabListSyncEntity('auto-domain-grouping-enabled');
    })
    .catch(...);
}
```

### 変更対象

| ファイル | 箇所 |
|---|---|
| `background.js` | `chrome.storage.onChanged` リスナー L1616〜1633 |

### 注意事項

- タブ数が多い環境では初回処理が重くなる可能性があるため、バックグラウンド処理として非同期実行する現在の構造（`.then` チェーン）は維持する。

---

## タスク 3：URL 変化以外のイベントでもグループ判定を補完する

### 優先度：中

### 原因

自動グループ化の `onUpdated` トリガーは `changeInfo.url` が存在する場合のみ（L1061）：

```js
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab) {  // ← URL変化のみ
    autoGroupTabByDomain(...)
  }
});
```

SPA（React/Vue 等）や History API を使うサービスでは `pushState` による遷移で `changeInfo.url` が発火しない場合があり、特にサブウィンドウで開いたダッシュボード・チャット・SNS 系サービスで「まったく効かない」ケースが生じる。

なお現状では `onMoved`（L1045）と `onAttached`（L1050）は `persistTabListSyncEntity` のみを呼んでおり、**グループ化判定は一切行っていない。**

### 修正方針

#### 3-a：`onAttached` でグループ化判定を追加

タブをウィンドウ間でドラッグ移動した後、アタッチ先ウィンドウでグループ化判定を実行する：

```js
chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  syncTabGroupIdCacheForTabId(tabId).catch(() => {});
  persistTabListSyncEntity('attached').catch(() => {});

  // 追加: アタッチ後にグループ化判定
  try {
    const tab = await chrome.tabs.get(tabId);
    autoGroupTabByDomain(tab, { requireActiveContext: false }).catch(() => {});
  } catch {}
});
```

#### 3-b：SPA 遷移への対応（`changeInfo.status === 'complete'` の活用）

`changeInfo.url` が来なくても `status === 'complete'` は発火するケースがあるため、タスク1の修正と合わせて `status` 変化時にも軽量なグループ化判定を走らせることを検討する（実行コスト増に注意）。

### 変更対象

| ファイル | 箇所 |
|---|---|
| `background.js` | `onAttached` リスナー L1050〜1053 |
| `background.js` | `onUpdated` リスナー L1060〜1065（条件追加） |

---

## タスク 4：セッション復元・連続イベント時のデバウンス対応を確認・強化する

### 優先度：低〜中（堅牢性向上）

### 現状評価

`persistTabListSyncEntity`（L173〜192）は `syncSequence` によるシーケンス番号方式で**最後の呼び出しのみ書き込みを完遂する**（中間の呼び出しは `return` で打ち切られる）。これはタブリストの**同期処理**に対しては有効なデバウンスとして機能している。

しかし `autoGroupTabByDomain` 自体には同様の抑制機構がないため、**ブラウザ再起動・セッション復元時に大量の `onUpdated` が同時発火すると、グループ化 API が連続して呼ばれ、レースコンディションや Chrome API のレート制限に抵触する可能性がある。**

### 修正方針

- `autoGroupTabByDomain` の呼び出しに対して、ウィンドウ単位のデバウンス（例：200〜500ms）を導入する。
- タスク1・2 の修正後に実行頻度が上がることを踏まえ、このタスクはタスク1・2 と **同時または直後** に対応することを推奨する。

### 変更対象

| ファイル | 箇所 |
|---|---|
| `background.js` | `autoGroupTabByDomain` の呼び出し箇所全般、またはデバウンス用ラッパー関数の新設 |

---

## 修正優先順位まとめ

| # | タスク | 優先度 | 効果 | 工数感 |
|---|---|---|---|---|
| 2 | 初回グループ化を全ウィンドウ対象に拡張 | 🔴 最優先 | 大（既存タブへの即時効果） | 小 |
| 1 | `lastFocusedWindow` ゲートの緩和 | 🔴 最優先 | 大（「たまに効かない」の主因） | 小〜中 |
| 3 | URL変化以外のトリガー補完 | 🟡 中 | 中（SPA系サービスへの対応） | 中 |
| 4 | デバウンス強化 | 🟢 低〜中 | 中（堅牢性・安定性向上） | 中 |

**推奨着手順序：タスク2 → タスク1 → タスク4（タスク1と同時推奨）→ タスク3**
