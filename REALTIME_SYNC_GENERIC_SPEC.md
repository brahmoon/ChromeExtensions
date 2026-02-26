# リアルタイム同期セッション汎用仕様書（再利用可能アーキテクチャ）

## 0. 文書目的

本仕様書は、ブラウザ拡張またはマルチコンテキスト Web アプリにおける**リアルタイム状態同期**を、
特定ドメイン（例: 挨拶管理、Twitch 固有 UI）に依存せず再利用できる形で定義する。

この文書は次の用途を想定する。

- サンプルアプリケーション実装時の要件定義
- 詳細設計（イベントフロー、インタフェース、エラー処理）の基準
- 別ドメインへの転用時の設計テンプレート

---

## 1. 適用範囲

### 1.1 対象

以下の複数実行コンテキスト間で共有状態を扱うアプリケーション。

- **Control Surface**（設定/管理 UI）
  - 例: popup、options ページ、設定モーダル
- **Runtime Surface**（実際の処理を行う実行面）
  - 例: content script、埋め込みウィジェット、ページ内スクリプト
- **Coordinator**（UI 起動やルーティングを仲介）
  - 例: background service worker

### 1.2 非対象

- サーバー同期（本仕様はローカル同期を中心に定義）
- CRDT などの高度な分散整合アルゴリズム

---

## 2. アーキテクチャ原則

### 2.1 単一ソース原則（Single Source of Truth）

共有状態の正本は `chrome.storage.local`（または等価ストレージ）に置く。

- すべての更新は最終的にストレージへ書き込む
- 各コンテキストはストレージ変更監視で再同期可能にする

### 2.2 即時反映 + 最終整合の二層構成

- **即時反映層**: message 送受信で UI/実行状態を即時更新
- **最終整合層**: storage change 監視で取りこぼしを収束

### 2.3 責務分離

- Control Surface: 入力受付・設定保存・明示通知
- Runtime Surface: 実データ反映・画面注入・ローカルキャッシュ管理
- Coordinator: ウィンドウ起動、チャネル仲介（状態保持を極小化）

---

## 3. 論理コンポーネント定義

## 3.1 Control Surface（管理 UI）

責務:

1. 設定値の入力・検証
2. 共有ストレージへの保存
3. 必要な Runtime Surface への明示通知
4. 共有状態一覧の可視化

禁止事項:

- Runtime Surface 内部 DOM 構造への依存
- Coordinator を状態 DB として使用

## 3.2 Runtime Surface（実行面）

責務:

1. ストレージから初期状態をロード
2. 実行対象画面へ状態反映
3. ユーザー操作をストレージに反映
4. message / onChanged の両経路で更新を受理

禁止事項:

- 正本をローカル変数だけで保持し続ける実装

## 3.3 Coordinator（仲介）

責務:

1. 管理 UI の起動/再利用
2. 必要時のメッセージルーティング補助

原則:

- 共有業務データは保持しない（または短期メモリのみ）

---

## 4. データモデル要件

本章ではドメイン非依存の抽象モデルを定義する。

### 4.1 設定モデル `SyncSettings`

```json
{
  "featureEnabled": true,
  "scopeMode": "specific",
  "scopeTargetId": "string",
  "themeToken": "#6441a5"
}
```

- `featureEnabled`: 実行有効フラグ
- `scopeMode`: `specific | all | custom`（拡張可）
- `scopeTargetId`: 対象識別子（空許容）
- `themeToken`: UI テーマ情報（形式は実装で定義）

### 4.2 状態モデル `TrackedEntityMap`

```json
{
  "entityIdA": {
    "checked": false,
    "timestamp": 1730000000000,
    "label": "Entity A"
  }
}
```

- 任意エンティティ（ユーザー/タスク/通知など）の状態管理
- `entityId` を主キーとする辞書構造を推奨

### 4.3 ストレージキー定義

| Key | 型 | 説明 |
|---|---|---|
| `syncSettings` | `SyncSettings` | 実行制御設定 |
| `trackedEntities` | `TrackedEntityMap` | 管理対象の状態集合 |
| `schemaVersion` | number | マイグレーション用 |

> 補足: 既存実装との互換が必要な場合は個別キー分割（`featureEnabled` 等）でも可。

---

## 5. インタフェース仕様（情報接点）

## 5.1 メッセージチャネル定義

### 5.1.1 Control → Runtime

#### `settingsChanged`

目的: 設定変更の即時反映トリガー

```json
{
  "action": "settingsChanged",
  "changedKeys": ["featureEnabled", "scopeTargetId"],
  "revision": 42
}
```

#### `entityStatusChanged`

目的: 単一/少数エンティティの即時反映

```json
{
  "action": "entityStatusChanged",
  "entityId": "entityIdA",
  "checked": true,
  "revision": 43
}
```

#### `resetAllEntities`

目的: 一括リセットの即時反映

```json
{
  "action": "resetAllEntities",
  "reason": "manual",
  "revision": 44
}
```

### 5.1.2 Runtime → Coordinator

#### `openControlSurface`

目的: 実行面から設定 UI を開く

```json
{
  "action": "openControlSurface",
  "source": "runtime-panel"
}
```

### 5.1.3 応答フォーマット（推奨）

```json
{
  "ok": true,
  "code": "OK",
  "detail": "optional"
}
```

エラー時:

```json
{
  "ok": false,
  "code": "NO_RECEIVER | VALIDATION_ERROR | INTERNAL_ERROR",
  "detail": "human readable message"
}
```

---

## 6. 同期フロー仕様

## 6.1 起動時ハンドシェイク

1. Runtime Surface 起動
2. ストレージから `syncSettings`, `trackedEntities` を取得
3. ローカルキャッシュに反映
4. 表示/監視を開始

要件:

- 取得失敗時はデフォルト値で起動
- 読み込み完了前の UI 操作はキューイングまたは無効化

## 6.2 設定変更フロー（Control 起点）

1. 入力バリデーション
2. ストレージ更新（原子的に保存）
3. `settingsChanged` を Runtime 群へ通知
4. Runtime は即時適用
5. 同時に `storage.onChanged` でも再確認

要件:

- 通知失敗しても処理を失敗扱いにしない
- `onChanged` を最終整合として必須利用

## 6.3 状態更新フロー（Runtime 起点）

1. Runtime 内ユーザー操作発生
2. ローカル UI の即時反映
3. ストレージ更新
4. Control は `onChanged` で一覧更新
5. 必要に応じて Runtime 間 message で低遅延反映

要件:

- 同一 `entityId` の重複 UI 要素は一括更新
- 更新は冪等に処理可能であること

## 6.4 全リセットフロー

1. 実行主体（Control または Runtime）が確認 UI を提示
2. `trackedEntities` を初期状態へ書き戻し
3. `resetAllEntities` を即時通知
4. 全コンテキストは UI とキャッシュを初期化

## 6.5 スコープ判定フロー（汎用）

`scopeMode` に応じて、Runtime が「この画面で機能を有効化するか」を判定する。

疑似コード:

```text
if !featureEnabled => inactive
if scopeMode == specific => currentContextId == scopeTargetId
if scopeMode == all => active
if scopeMode == custom => customPredicate(context)
```

---

## 7. 整合性・競合制御

## 7.1 推奨戦略

- **Last Write Wins** を基本とする
- `revision`（単調増加）または `updatedAt` を併用しデバッグ容易化

## 7.2 競合ケース

- 複数 Runtime が同一 `entityId` を同時更新
- Control と Runtime が同時に設定変更

対策:

- 書込時に最新値再取得→マージ→保存
- 監査ログ（最低限 console）へ `source`, `revision` を残す

---

## 8. エラー処理仕様

## 8.1 メッセージ送信失敗

代表例: `Could not establish connection. Receiving end does not exist.`

要件:

- 既知エラーは warning/ debug 扱い（クラッシュさせない）
- ストレージ更新済みなら機能継続

## 8.2 ストレージ I/O 異常

要件:

- 失敗時リトライ（指数バックオフは任意）
- 失敗を UI に通知（必要最小限）

## 8.3 不正データ

要件:

- 型不一致時はデフォルトへフォールバック
- `schemaVersion` に基づくマイグレーションフックを設置

---

## 9. 非機能要件

- **応答性**: 主要操作の視覚反映を 200ms 以内（目標）
- **可用性**: message 経路が落ちても storage 経路で復旧
- **保守性**: action 名・payload を定数化
- **拡張性**: 新規 action を後方互換で追加可能

---

## 10. 実装テンプレート（擬似 API）

## 10.1 共通型

```ts
interface SyncEnvelope<T> {
  action: string;
  revision?: number;
  payload?: T;
}

interface EntityState {
  checked: boolean;
  timestamp: number;
  label?: string;
}
```

## 10.2 Control Surface

```ts
async function saveSettings(next: SyncSettings): Promise<void>
async function notifySettingsChanged(changedKeys: string[]): Promise<void>
async function setEntityStatus(entityId: string, checked: boolean): Promise<void>
async function resetAllEntities(reason: string): Promise<void>
```

## 10.3 Runtime Surface

```ts
async function bootstrapRuntime(): Promise<void>
function onRuntimeMessage(message: SyncEnvelope<any>): void
function onStorageChanged(changes: any): void
function applyFeatureState(): void
function applyEntityState(entityId: string, checked: boolean): void
```

## 10.4 Coordinator

```ts
function focusOrCreateControlSurface(): void
function onCoordinatorMessage(message: SyncEnvelope<any>): void
```

---

## 11. サンプルアプリ要件（この仕様から作る場合）

## 11.1 最小機能要件（MVP）

1. Control で設定編集し Runtime へ即時反映される
2. Runtime でエンティティ状態変更すると Control 一覧が自動更新される
3. 全リセットが全コンテキストに同期される
4. Coordinator 経由で Control を一意に開ける（再利用）

## 11.2 検証観点

- 通常系: 双方向更新が 1 秒以内に収束
- 例外系: message 失敗時も `onChanged` で収束
- 競合系: 同時更新時に一貫した最終値になる

## 11.3 受け入れ基準（例）

- 同一エンティティの複数表示要素が同期して同値になる
- 設定トグル OFF 時に Runtime 処理が停止し UI が隠れる
- Control 未起動状態でも Runtime 更新後、Control 起動時に最新値が表示される

---

## 12. 追補: ドメイン適用ガイド

本仕様を実ドメインへ適用する際は以下を置換する。

- `entityId` / `EntityState` → ドメイン実体（ユーザー、案件、通知など）
- `scopeTargetId` → URL パス、tenantId、workspaceId など
- `customPredicate(context)` → ドメイン固有有効化条件

これにより、

- チャット補助
- タスク管理
- 通知既読管理
- ページ注釈ツール

などへ同一同期モデルを転用可能である。
