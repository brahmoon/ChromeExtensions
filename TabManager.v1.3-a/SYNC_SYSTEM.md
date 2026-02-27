# TabManager v1.2 同期システム設計

このバージョンは `sync_spec_vNext.md` の Option B（index + entity）を採用し、`chrome.storage.local` を単一ソースとしてタブ間同期を行います。

## 同期キー

- `tabManagerSync:index`
  - `ids`: `panelState` / `activeTab` / `tabList`
- `tabManagerSyncEntity:panelState`
  - パネル開閉状態、ホストタブID、更新時刻
- `tabManagerSyncEntity:activeTab`
  - 現在アクティブなタブID、更新理由、更新時刻
- `tabManagerSyncEntity:tabList`
  - タブ一覧スナップショット、更新理由、更新時刻

## 同期フロー

1. 拡張起動時に index を初期化し、`panelState` / `activeTab` / `tabList` を storage にブートストラップ保存。
2. パネル状態更新時は `tabManagerPanelState` 保存後に `tabManagerSyncEntity:panelState` を更新。
3. タブアクティブ変更時は `activeTab` と `tabList` を更新し、パネル表示中なら新しいアクティブタブへ管理画面をハンドオフ。
4. タブの作成/削除/移動/更新時は `tabList` を更新し、全タブで同じ管理対象情報に収束。

## 競合戦略

- 書き込みは LWW（Last Write Wins）で収束。
- index は起動時に必ず get→merge→set で冪等更新。
- entity 更新は差分保存で、`tabList` を高頻度更新して最終整合を維持。
