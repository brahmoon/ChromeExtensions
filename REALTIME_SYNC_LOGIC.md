# TwitchGreeter v1.4 リアルタイム同期ロジック解説

このドキュメントは、`popup.html / popup.js`・`background.js`・Twitch タブの `content.js` が、
どのように**設定値・挨拶状態をリアルタイムに同期**しているかを整理したものです。

---

## 1. 役割分担（同期セッションの登場人物）

- **popup (`popup.html` + `popup.js`)**
  - 設定 UI（有効/無効、対象チャンネル、テーマ色）と挨拶済みユーザー一覧の管理画面。
  - ユーザー操作を `chrome.storage.local` に保存し、必要に応じて Twitch タブへ `chrome.tabs.sendMessage` で即時通知する。
- **content (`content.js`)**
  - Twitch チャット DOM にチェックボックスを注入し、挨拶済み状態を反映。
  - `chrome.storage.local` の変更監視 (`chrome.storage.onChanged`) と runtime メッセージ受信で即時追従する。
- **background (`background.js`)**
  - 拡張アイコン押下や content からの要求に応じて popup ウィンドウを開く/再利用する。
  - データ同期そのものは担わず、UI 起動のハブとして機能する。

---

## 2. 同期の中核：`chrome.storage.local` を単一の共有状態にする

この実装では、以下のキーを全コンポーネントで共有することで同期セッションを成立させています。

- `greetedUsers`: ユーザーごとの挨拶状態 (`greeted`, `timestamp`, `username`)
- `extensionEnabled`: 機能有効フラグ
- `channelScope`: 適用範囲 (`specific` / `all`)
- `targetChannelId`: `specific` 時の対象チャンネル ID
- `themeColor`: テーマ色

ポイントは次の 2 段構えです。

1. **永続化・正本は storage**
2. **即時性は message（tabs/runtime）で補助**

これにより、タブ間・popup 間での状態ずれを最小化しています。

---

## 3. popup → content へのリアルタイム伝搬

### 3.1 設定変更の流れ

popup で設定が変更されると、まず `chrome.storage.local.set(...)` で保存されます。
その後、`notifyFeatureStateChanged()` が呼ばれ、Twitch タブへ `{ action: 'settingsChanged' }` を送信します。

- 送信対象は `chrome.tabs.query({ url: ['*://*.twitch.tv/*'] })` で列挙。
- 各タブに `chrome.tabs.sendMessage`。
- content 未注入タブで起きる `Receiving end does not exist` は想定済みで、警告を抑制する設計。

結果として content 側は message 受信で `loadSettingsAndApply()` を実行し、
有効/無効、対象チャンネル一致、テーマ色を即座に再評価します。

### 3.2 特定チャンネル時の“即時反映最適化”

`targetChannelId` 入力時、popup はアクティブな Twitch タブ URL からチャンネル ID を取り出して比較します。

- 一致時: そのタブにのみ `settingsChanged` を直送（最短反映）
- 不一致時: 通常どおり全 Twitch タブ通知

これにより、ユーザーが今見ている対象チャンネルでの体感反映を速めています。

---

## 4. 挨拶状態の双方向同期（popup と content の相互更新）

### 4.1 content 起点（チャット上チェック操作）

1. content のチェックボックス change
2. `greetedUsers` を更新
3. `chrome.storage.local.set({ greetedUsers })`

これで popup は `chrome.storage.onChanged` により `greetedUsers` 変更を検知し、
`loadGreetedUsers()` を再実行して一覧 UI を再描画します。

### 4.2 popup 起点（一覧チェック操作）

1. popup の一覧チェック change
2. `chrome.storage.local` の `greetedUsers` を更新して保存
3. 追加で Twitch 全タブへ `{ action: 'updateGreetedStatus', userId, greeted }` を送信

content は message を受けて `updateUserCheckboxes(...)` を即実行し、
同一ユーザーの複数メッセージに置かれたチェックボックスを一斉同期します。

さらに storage 変更監視でも最終整合が取られるため、
メッセージ受信に失敗したケースでも次の onChanged で収束します。

---

## 5. 全リセット同期

### popup からの全リセット

- popup の「すべてリセット」
  - `chrome.storage.local.set({ greetedUsers: {} })`
  - Twitch 全タブへ `{ action: 'resetAllGreetings' }` を送信

content は受信時に DOM 上チェックを外し、内部 `greetedUsers` も false 化。
加えて storage 監視でも空オブジェクトへの更新が反映されるため、再整合されます。

### content 側パネルからのリセット

- content 内パネルのリセット処理でも `chrome.storage.local.set({ greetedUsers: {} })`
- popup は storage 監視で即更新

どちら起点でも同じ storage を更新するため、同期経路が一本化されています。

---

## 6. storage 監視が担う「同期セッションの保険」

`chrome.storage.onChanged` は popup/content の両方で使われています。

- **popup**: `changes.greetedUsers` を監視し、一覧 UI を再ロード
- **content**:
  - `changes.greetedUsers` → ローカルキャッシュ更新 + `applyGreetedStatus()`
  - 設定キー変更 (`themeColor`, `extensionEnabled`, `channelScope`, `targetChannelId`) → `loadSettingsAndApply()`

この監視があることで、

- message が届かない
- popup が閉じていた
- 別タブで先に更新された

といった状況でも、最終的に全コンポーネントが同一状態へ収束します。

---

## 7. background.js の位置づけ（同期経路にどう関わるか）

`background.js` は同期データを持ちません。
主な役割は以下です。

- 拡張アイコン押下時、既存 popup ウィンドウを探してフォーカス
- なければ新規 popup ウィンドウ作成
- content から `openPopupWindow` メッセージを受けても同様に開く/再利用

つまり **「同期状態を編集する UI へ到達するための導線管理」** が責務です。
同期ロジック本体は popup/content + storage に集約されています。

---

## 8. 実装の同期設計まとめ

この拡張のリアルタイム同期セッションは、次の設計で成り立っています。

- **単一ソース**: `chrome.storage.local`
- **即時通知**: `chrome.tabs.sendMessage` / `chrome.runtime.sendMessage`
- **最終整合**: `chrome.storage.onChanged`
- **起点の多重化**: popup 起点でも content 起点でも同じ storage を更新

その結果、

- UI 操作直後の見た目反映は速く
- 通信漏れがあっても storage 監視で復元でき
- 複数 Twitch タブ・popup ウィンドウ間の一貫性を維持できる

という、拡張機能として実用的な同期モデルになっています。
