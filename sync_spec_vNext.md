# Chrome拡張機能 リアルタイム同期 状態同期アーキテクチャ仕様書 vNext

| バージョン | vNext（2025年改訂版） | 分類 | 内部技術仕様書 |
|---|---|---|---|
| 対象読者 | フロントエンドエンジニア・拡張機能開発者 | ステータス | レビュー済・実装可 |

---

## 0. 文書概要と設計思想

本仕様書は、Chrome拡張機能またはマルチコンテキストWebアプリにおける「ローカル完結型リアルタイム状態同期」を、特定ドメインに依存せず再利用可能な形で定義する。

本仕様は以下の4原則を重視して設計されている。

| 原則 | 内容 |
|---|---|
| 現実的な競合戦略 | 過剰なロックを避け LWW で対処 |
| 小粒度更新 | Entity 単位の差分同期でスケール |
| 初期化レース対策 | ブートストラップ完了後にキュー処理 |
| 最終整合設計 | メッセージ失敗を想定した設計 |

---

## 1. 適用範囲

### 1.1 対象コンポーネント

| コンポーネント | 役割 | 主な責務 |
|---|---|---|
| Control Surface | 設定UI | 設定入力・検証、storage更新、状態一覧表示、message通知（任意） |
| Runtime Surface | 実行面 | 起動時storage読込、UI反映、操作時storage更新、message受信・onChanged受信 |
| Coordinator | UI起動仲介 | Control UI起動のみ。状態保持しない |

### 1.2 対象外

- サーバー同期
- 強整合分散アルゴリズム（CRDT等）

---

## 2. アーキテクチャ原則

| 原則 | 内容 |
|---|---|
| 単一ソース原則 | 共有状態の正本は `chrome.storage.local` に置く。他のコンテキストはこれを参照する |
| 即時反映 + 最終整合 | **即時反映：** message経由で高速に通知。**最終整合：** `storage.onChanged` 経由でフォールバック |
| 競合戦略（現実解） | 基本方針は Last Write Wins（LWW）。衝突範囲は Entity 単位の独立保存により最小化。強いロック機構は採用しない |

---

## 3. データモデル

### 3.1 SyncSettings

拡張全体の動作設定を保持するオブジェクト。storage キーは `syncSettings`。

```json
{
  "featureEnabled": true,       // 機能の有効/無効
  "scopeMode": "specific",      // "all" | "specific"
  "scopeTargetId": "string",    // scopeMode=specific のとき有効
  "themeToken": "#6441a5"       // UIカラーコード
}
```

### 3.2 TrackedEntity 保存方式

#### Option A（小規模向け）

単一キー保存：

```
trackedEntities
```

#### Option B ★推奨（中〜大規模向け）

**インデックスキー（唯一の真実）：**

```
trackedEntities:index
```

```json
{ "ids": ["entityA", "entityB"] }
```

**個別エンティティキー：**

```
trackedEntity:<entityId>
```

```json
{ "checked": true, "timestamp": 1730000000000 }
```

**設計原則：**

- `index` を唯一の真実とする
- `index` に含まれない Entity キーは無効扱い（孤立データ）
- 個別キーは `index` の従属データ

#### Entity 追加時の書き込み順序（必須）

Entity を新規追加する場合、書き込み順序を以下に固定すること。

1. **個別 Entity キー**（`trackedEntity:<entityId>`）を保存する
2. **`trackedEntities:index`** を取得→マージ→保存する

逆順（index 先行）で書いた場合、「index には存在するが実体キーがない」という一時的な不整合状態が発生し、Runtime が存在しないキーを読もうとして未定義動作や例外を引き起こす恐れがある。本仕様では **「個別保存 → index 更新」** を標準とする。

#### Entity 削除時の書き込み順序（推奨）

Entity を削除する場合、書き込み順序を以下とする。

1. **`trackedEntities:index`** を取得→マージ（対象 id を除去）→保存する
2. **個別 Entity キー**（`trackedEntity:<entityId>`）を削除する（任意・補助的扱い）

`index` が唯一の真実であるため、`index` から除去された時点で当該 Entity は無効となる。個別キーが残存しても孤立データとして扱われ Runtime に影響しない。追加とは逆順（index 先行）になる点に注意すること。

**⚠️ index 更新時の競合対策（必須）：**

`trackedEntities:index` は単一キーであり、Option B における唯一の競合集中ポイントになる。複数のコンテキスト（タブ等）が同時に id の追加・削除を行うと、LWW によって一方の変更が消失する恐れがある。

そのため、`index` を書き換える際は必ず **「取得→マージ→保存」** パターンを使用すること。

```js
// 追加の例
const result = await chrome.storage.local.get('trackedEntities:index');
const current = result['trackedEntities:index'] ?? { ids: [] };
const merged = { ids: [...new Set([...current.ids, newEntityId])] };
await chrome.storage.local.set({ 'trackedEntities:index': merged });

// 削除の例
const result = await chrome.storage.local.get('trackedEntities:index');
const current = result['trackedEntities:index'] ?? { ids: [] };
const merged = { ids: current.ids.filter(id => id !== removedEntityId) };
await chrome.storage.local.set({ 'trackedEntities:index': merged });
```

> 完全なロックは不要だが、**index のみ** はこの再取得マージを省略してはならない。書き込み直前に必ず最新値を取得すること。
>
> **index 更新の冪等性（必須）：** index 更新操作は冪等でなければならない。具体的には以下を満たすこと。
> - 重複する id を追加しても壊れないこと
> - 存在しない id を削除しても壊れないこと
>
> 上記コード例の `new Set(...)` および `filter(...)` はこの冪等性を保証するための実装である。冪等性が保たれていない実装は、`onChanged` の多重発火や `entityDelta` の再送によって index が破損するリスクがある。
>
> **理論的限界：** `chrome.storage` はトランザクションを提供しない。「A が get → B が get → A が set → B が set」の順で発生した場合、A の変更は B の上書きにより消失する。本方式は**楽観的並行制御**であり、完全な同時更新保護は行わない。最終的には LWW により収束することを設計上許容している。

---

## 4. メッセージ仕様

### 4.1 entityDelta（差分同期）

Entity の差分を通知するメッセージ。**`chrome.storage.local` の更新完了後にのみ送信すること。** メッセージを先に送ると受信側が古い storage を読む可能性があり整合が崩れる。

> **本仕様で定義する必須メッセージは `entityDelta` のみ。** 設定変更の通知は `chrome.storage.onChanged` による最終整合に委ねる設計とし、即時通知が必要な場合は実装側で追加メッセージ種別を定義してよい。

#### entityDelta と onChanged の到達順序

`entityDelta` メッセージと `storage.onChanged` の到達順序は保証されない。受信側は以下のどちらのケースでも正しく収束するよう設計しなければならない。

- `entityDelta` が先に届き、その後 `onChanged` が発火する
- `onChanged` が先に発火し、その後 `entityDelta` が届く（またはまったく届かない）

この順序不定性に対処するため、5.3節で定義した**循環更新防止ガード（冪等な apply 処理）が必須**となる。いずれの経路で何度処理が走っても、最終状態は storage の値に収束する。

#### entityDelta 受信時の index 存在チェック（必須）

`entityDelta` を受信した際、`delta` 内の `entityId` が現在の `trackedEntities:index` の `ids` に含まれていない場合、当該 Entity の更新処理を**破棄（無視）しなければならない**。

`index` が唯一の真実であるため、index に存在しない Entity は常に無効とする。これにより、ネットワーク遅延・再送などで古い `entityDelta` が遅れて届いた場合にキャッシュが一時的に復活するバグを防止できる。

```js
function handleEntityDelta(entityId, newValue) {
  const index = localCache.getIndex(); // 現在の ids 一覧
  if (!index.ids.includes(entityId)) return; // index に存在しなければ無視

  applyEntityState(entityId, newValue);
}
```

#### revision フィールドについて

`revision` は任意フィールドであり、主にデバッグ・ログ追跡・競合分析の用途で使用する。本仕様では `revision` による整合判定（古いメッセージの棄却等）は行わない。最終的な整合は storage 正本（LWW）により決定される。将来的に revision ベースの順序保証が必要になった場合は将来拡張ポイント（8節）として検討すること。

```json
{
  "action": "entityDelta",
  "revision": 42,
  "delta": {
    "entityA": { "checked": true }
  }
}
```

### 4.2 削除の表現

| 方式 | 表現 | 特徴 |
|---|---|---|
| 方式1（簡易） | `"entityA": null` | シンプル。null判定が必要 |
| 方式2（拡張） | `{ "action": "entityPatch", "ops": [{ "op": "remove", "entityId": "entityA" }] }` | 明示的な操作記録。バッチ処理に適する |

**削除受理時の必須挙動：**

`delta[entityId] = null` を受理した場合、受信側は以下をすべて行わなければならない。

1. `trackedEntities:index` の `ids` から当該 `entityId` を除去する（**削除の正とする**）
2. Runtimeの表示とローカルキャッシュから当該エンティティを除外する
3. 個別キー（`trackedEntity:<entityId>`）の削除は任意とする（補助的扱い）

> ⚠️ 上記1を省略すると「見た目だけ消える」状態になり、次回起動時に復活するバグが発生する。
>
> **message経路と onChanged経路の競合について：** 削除操作は message（`entityDelta`）と `onChanged`（`applyIndex` / `applyEntityState`）の両経路で処理が走る場合がある。どちらの経路で処理されても **index の更新を正** とし、個別 entity キーの削除は補助的扱いとすることで、経路の順序に依存しない一貫した挙動が実現できる。

### 4.3 ACKポリシー

| 項目 | 仕様 |
|---|---|
| タイムアウト | 推奨 150〜300ms |
| NO_RECEIVER | warning扱い（クラッシュ不可） |
| storage更新済の場合 | ACKなしでも成功扱い |
| 再送 | 最大N回（実装側で任意設定） |

---

## 5. 同期フロー

### 5.1 起動時ハンドシェイク（初期化レース対策）

| Step | 処理内容 |
|---|---|
| 1 | `chrome.storage.local` から `syncSettings` を読み込む |
| 2 | **（Option B）** `trackedEntities:index` を読み込み、`ids` に含まれる分だけ `trackedEntity:<id>` を取得する。エンティティ数が多い場合はバッチ取得・段階ロードしてもよい |
| 3 | `localCache` を構築する |
| 4 | `isBootstrapped = true` にセットする |
| 5 | `pendingMessageQueue` に溜まったメッセージを順次処理する |

> ⚠️ **重要：** 初期化完了前に受信したメッセージは `pendingMessageQueue` にエンキューする。`isBootstrapped` フラグが `true` になった後にのみデキューして処理する。

### 5.2 状態更新フロー（Runtime 起点）

| Step | 処理内容 |
|---|---|
| 1 | UIを即時反映する（楽観的更新） |
| 2 | Entity単位で `chrome.storage.local` を更新する |
| 3 | `chrome.storage.local` の更新完了を確認した後に `entityDelta` メッセージを送信する（任意） |

### 5.3 storage.onChanged フィルタリング（Option B）

キー単位で処理を分離する。無関係なキーでは処理せず、**全体再描画は禁止**。

```js
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  for (const key in changes) {
    if (key.startsWith('trackedEntity:')) {
      const entityId = key.replace('trackedEntity:', '');
      applyEntityState(entityId, changes[key].newValue);
    } else if (key === 'trackedEntities:index') {
      applyIndex(changes[key].newValue);
    } else if (key === 'syncSettings') {
      applySettings(changes[key].newValue);
    }
    // それ以外のキーは無視する
  }
});
```

> ⚠️ **`applyIndex()` の必須動作：** `ids.length === 0`（空配列）を受け取った場合、必ず `clearLocalCacheAndDom()` を呼び出す。これによりリセットフロー（5.4節）のトリガが `onChanged` に統一され、実装のブレを防ぐ。
>
> **`applyIndex()` の冪等性（必須）：** `applyIndex` は冪等でなければならない。同一 index が複数回渡されても副作用が発生しないこと。既に削除済みの Entity を再度削除しようとしても安全であること。`applyIndex` は常に渡された index の内容を正として `localCache` および DOM をその状態に収束させる実装とする。

#### 循環更新防止ガード（必須）

`chrome.storage.local.set` を実行したコンテキスト自身にも `storage.onChanged` は発火する。これにより、自分の書き込みを自分で再処理してしまう循環が発生する恐れがある。

Runtime は必ず以下を実装すること：

- `localCache` の値と `newValue` を比較し、変化がない場合は DOM 更新および後続処理をスキップする
- すべての `apply*` 関数は**冪等（idempotent）**であること（何度呼んでも同じ結果になること）

```js
function applyEntityState(entityId, newValue) {
  const cached = localCache.get(entityId);

  // 値が同一なら何もしない（循環更新・重複処理の防止）
  if (isDeepEqual(cached, newValue)) return;

  localCache.set(entityId, newValue);
  updateDom(entityId, newValue);
}
```

### 5.4 全リセットフロー

> 🚫 **禁止：** `chrome.storage.local.clear()` を使用してはならない。他のキーまで全消去され、意図しないデータ消失が発生する。

**Option B の推奨リセット手順：**

| Step | 処理内容 |
|---|---|
| 1 | `trackedEntities:index` を空にする：`{ "ids": [] }` |
| 2 | Runtime が index 空を検知する |
| 3 | ローカルキャッシュを全削除し、DOMを初期化する |
| 4 | `trackedEntity:*` キーは即時削除不要。孤立データとして扱い、以下のタイミングで整理する：拡張の再起動時、エンティティの上書き時、定期メンテナンス処理時 |

**孤立データ整理の参考実装：**

```js
// 起動時または任意のメンテナンスタイミングで実行
async function cleanupOrphanedEntityKeys() {
  const result = await chrome.storage.local.get('trackedEntities:index');
  const validIds = new Set(result['trackedEntities:index']?.ids ?? []);

  // ⚠️ get(null) は全キーを一括取得するため大規模用途ではコストが高い。
  // エンティティ数が多い場合は、下記の「indexベース削除」を優先すること。
  const allKeys = Object.keys(await chrome.storage.local.get(null));
  const orphanKeys = allKeys.filter(
    key => key.startsWith('trackedEntity:') &&
           !validIds.has(key.replace('trackedEntity:', ''))
  );

  if (orphanKeys.length > 0) {
    await chrome.storage.local.remove(orphanKeys);
  }
}

// 【推奨：大規模用途向け】indexベース削除
// 全キー取得を避け、以前の index との差分から孤立キーを特定する
// previousIds の取得元：
//   優先①: storage.onChanged の oldValue（trackedEntities:index 更新時）
//   優先②: Runtime が保持している localCache のキー一覧
// index が唯一の真実であるため、可能な限り oldValue を優先することを推奨する。
async function cleanupByIndexDiff(previousIds, currentIds) {
  const removed = previousIds.filter(id => !currentIds.includes(id));
  const orphanKeys = removed.map(id => `trackedEntity:${id}`);
  if (orphanKeys.length > 0) {
    await chrome.storage.local.remove(orphanKeys);
  }
}
```

> 長期運用では孤立キーが増殖し storage 容量を圧迫する可能性があるため、少なくとも拡張の再起動時には本処理を実行することを推奨する。

---

## 6. エラー処理と整合性保証

| シナリオ | 対処方針 |
|---|---|
| message 送信失敗 | クラッシュさせない。storage更新済であれば継続し、warning としてログ出力 |
| NO_RECEIVER | warning扱い。ACKなしでも storage 正本で最終整合 |
| LWW衝突 | 最新書込みが勝つ。Entity単位保存により衝突範囲を最小化 |
| 孤立データ（index外キー） | 無効扱い。上書き時またはメンテナンス処理で整理 |

---

## 7. 非機能要件

| 要件 | 目標値・方針 |
|---|---|
| UI反映レイテンシ | 200ms以内 |
| message失敗時の収束 | `storage.onChanged` による最終整合で補完 |
| action名の管理 | 定数化必須（マジックストリング禁止） |
| 保存方式 | Option B（インデックス+個別キー）を推奨 |

---

## 8. 将来拡張ポイント

| 拡張項目 | 概要 |
|---|---|
| schemaVersion マイグレーション | バージョン間のデータ形式移行機構の追加 |
| StorageAdapter 抽象化 | `chrome.storage` を抽象化し、テスト・他ストレージへの差し替えを容易にする |
| クラウド同期 | `chrome.storage.sync` または外部APIへのブリッジ |
| index の分割・shard化 | 超大規模用途向け。index を複数キーに分割するか append-only log 方式に移行することで、競合集中ポイントを解消できる（現仕様スコープ外） |

---

## 付録：用語集

| 用語 | 説明 |
|---|---|
| LWW（Last Write Wins） | 競合時に最後に書き込んだ値を採用する競合解決戦略 |
| 最終整合（Eventual Consistency） | 一時的に不整合が生じても最終的に整合状態に収束する設計 |
| isBootstrapped | 初期化完了フラグ。これが `true` になるまでメッセージ処理を保留する |
| pendingMessageQueue | 初期化前に受信したメッセージを一時保管するキュー |
| 孤立データ | index に含まれていない `trackedEntity:*` キーのこと。無効扱いとする |
| entityDelta | Entity の差分のみを伝える軽量メッセージ形式 |

---

*本仕様書は実装開始前のレビューを推奨します。質問・変更要望は仕様管理者まで。*
