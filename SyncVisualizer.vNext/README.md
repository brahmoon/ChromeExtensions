# Sync Visualizer vNext Demo

`sync_spec_vNext.md` の方針（Option B: index + entity個別キー）を、複数コンテキストで可視化するサンプル拡張です。

## 構成
- **Control Surface**: `popup.html` / `popup.js`
- **Runtime Surface**: `runtime.html` / `runtime.js`
- **Coordinator**: `background.js`
- **実ページ可視化**: `content.js`

## 体験手順
1. Chrome の拡張機能ページでデベロッパーモードを ON。
2. `SyncVisualizer.vNext` フォルダを「パッケージ化されていない拡張機能を読み込む」で読み込む。
3. 拡張アイコンから popup を開き、`Runtime Surface を開く` を押す。
4. popup 側で設定変更・Entity追加/削除を行い、Runtime Surface とページ右下バッジの同期を確認する。

## 仕様上の要点
- `trackedEntities:index` を唯一の真実として扱う。
- Entity追加は `trackedEntity:<id>` 保存後に index を更新。
- Entity削除は index 更新後に `trackedEntity:<id>` を削除。
- `chrome.storage.local.clear()` は使用しない。
