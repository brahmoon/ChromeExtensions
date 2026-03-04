# YouTube 埋め込み機能 実装設計書 v3

> GPT・Gemini による第2ラウンドフィードバックを反映した最終版。  
> v2からの変更点は末尾の差分表に記載。

---

## フィードバック振り分け表（第2ラウンド）

| 項目 | 出典 | 判定 | 理由 |
|---|---|---|---|
| `youtube.com` を今使う理由の明文化 | GPT | **採用** | 「なぜ nocookie に今切り替えないか」の根拠が設計書に欠けていた |
| autoplay フォールバック（タイムアウト方式）の削除 | GPT | **採用** | クリックトリガー起点では autoplay ブロックはほぼ起きない。実装コストに対して恩恵が薄い |
| z-index のスタッキングコンテキストを数値で明示 | GPT | **採用** | 「干渉リスクは低い」では設計書として不十分。既存の z-index 体系と照合して明示する |
| `meta` フィールドの DB マイグレーション戦略 | GPT | **採用** | 「将来使う」で止まっていた。最低限の移行方針を記述する |
| 400px でのプレイヤー表示可否の哲学判断 | GPT | **採用（方針を確定）** | 「許容」ではなく「整理体験優先ゆえ埋め込みは400pxでも提供するが、視聴快適性の改善はしない」と明確化 |
| closeBtn の視認性・コントラスト担保 | Gemini | **採用** | iframe 内がエラー画面になった場合でも常に閉じられること。z-index と背景コントラストを設計書に明記 |
| oEmbed/サムネイル品質化の優先度引き上げ示唆 | GPT | **課題として昇格** | 「整理体験」観点では埋め込みプレイヤーより「何の動画か即座にわかる」の方が価値が高い可能性。Phase 2 の優先度を再考する |
| iframe load 失敗検知の限界を明記 | Gemini | **採用（制約として明記）** | cross-origin 制約上、削除・埋め込み禁止動画のエラーを JS から検知できない事実を設計書に残す |

---

## 採用・不採用の詳細判断

### 採用：autoplay タイムアウトフォールバックの削除

v2 では「3 秒タイムアウトでサムネイルに戻す」と書いていたが、GPT の指摘の通り  
**クリック操作を起点に `iframe.src` を設定する場合、Chrome の autoplay ポリシーは  
ほぼ確実に再生を許可する。** ブロックされるケースは以下のような限定的なシナリオのみ。

```
ブロックされる主なケース:
  - ブラウザ設定で特定サイトの自動再生を明示的に拒否している場合
  - 企業管理ポリシーで拡張機能の autoplay を制限している場合
```

これらは拡張機能レベルで対処できる問題ではないため、対応コードを入れても意味がない。  
タイムアウトロジックは v1 スコープから削除する。  
**残す対応**: ✕ボタンと Esc キーによる明示的なクローズ手段は引き続き実装する。  
（再生できなかった場合もユーザーが自分で閉じれば済む）

### 採用：400px での方針を確定

「許容」という曖昧な記述を以下に置き換える。

**確定方針：400px でも埋め込みを提供する。視聴快適性の改善は行わない。**

根拠：  
この拡張のコアは「整理」であり、400px での YouTube 表示は  
「この動画を見るかどうかの判断材料を提供する」用途として十分に機能する。  
GPT の指摘する「100vw 時のみ有効化」も一つの哲学的に一貫した選択肢だが、  
それは逆に「展開ビューを開かないとYouTubeカードが全く機能しない」という  
導線の断絶を生む。サムネイルと再生ができれば最低限の価値は提供できる。  
プレイヤー操作UIの小ささは許容コストとして受け入れる。

### 採用：z-index の明示

既存コード（styles.css、content.js）の z-index 体系を調査し、数値で明確化する。

```
既存の z-index 体系（panel.html 内）:
  header（panel-shell 内のスタッキング）: z-index: 1
  panel-shell:                             z-index: 99
  context-menu:                            z-index: 2000

既存の z-index 体系（content.js 生成要素）:
  previewOverlay コンテナ:                 z-index: 999998
  panelIframe 本体:                        z-index: 999999
  Shadow DOM トースト（workspace）:        z-index: 1000000
```

YouTube カードは panel.html 内の通常フロー（workspace-view）の中に存在するため、  
panel.html 自体の stacking context の外には影響しない。  
`workspace-card__youtube` は `overflow: hidden` を持ち、独立した stacking context を形成しない。  
閉じるボタン（`workspace-card__youtube-close`）は `z-index: 10` で  
コンテナ内の `position: absolute` 要素として機能する。これは `workspace-card__youtube-frame` の上に必ず乗る。

### 採用：`meta` マイグレーション戦略の明記

「将来使う」から「どう移行するか」を記述する（下記4.4節）。

---

## 1. 実装の概要と目的

### 何を実現するか

ワークスペースに保存したテキストが YouTube URL だった場合、  
サムネイル付きのプレビューカードとして表示し、クリックすることで  
パネル内で動画を再生できる。

```
保存操作:
  YouTube の動画ページで URL を選択 → 右クリック → 「ワークスペースにテキストを保存」

表示結果:
  通常テキストカード  →  YouTube URL を検出  →  サムネイル + 再生ボタン
  クリック時:
    サムネイルが iframe に差し替わり動画がインライン再生
```

### この機能の位置づけ

「後でこの動画を見たい」というニーズに応えるが、  
**目的は「タブを閉じるための動線として動画を確認できること」**であって、  
フル視聴のための快適なプレイヤー体験の提供ではない。

埋め込みプレイヤー自体は手段であり、本質は  
**「これ何の動画だったっけ？」を即座に思い出せること**にある。  
この観点では oEmbed によるタイトル補完・高品質サムネイルの方が  
プレイヤーの視聴快適性改善より優先度が高い可能性がある（Phase 2 の優先議題として記録）。

---

## 2. 実装技術の方針

### 2.1 YouTube URL の判定と動画 ID 抽出

```
対応パターン:
  https://www.youtube.com/watch?v=XXXXXXXXXXX              ← 通常
  https://www.youtube.com/watch?v=XXXXXXXXXXX&t=120        ← タイムスタンプ付き（IDのみ抽出）
  https://www.youtube.com/watch?v=XXXXXXXXXXX&list=PLxxxx  ← プレイリスト付き（IDのみ抽出）
  https://youtu.be/XXXXXXXXXXX                             ← 短縮
  https://youtu.be/XXXXXXXXXXX?t=60                        ← 短縮+タイムスタンプ（IDのみ抽出）
  https://www.youtube.com/embed/XXXXXXXXXXX               ← 埋め込み済み URL
  https://www.youtube.com/shorts/XXXXXXXXXXX              ← Shorts
  https://m.youtube.com/watch?v=XXXXXXXXXXX               ← モバイル版
```

`YT_ID_REGEX`（11文字の形式チェック）を全パターンに適用し、  
`URLSearchParams` で `v` パラメータを安全に取得することで  
タイムスタンプ・プレイリスト等の付随パラメータによる ID 混入を防ぐ。

**v1 では「テキスト全体が URL のみ」を維持する。**  
混在テキストへの対応は需要確認後に v1.1 でオプション化する。

### 2.2 表示方式：クリック展開（Lazy iframe）

サムネイル画像を表示し、クリックしたときに初めて `<iframe>` を生成する。  
初期表示から全件 iframe を生成する方式は採用しない（件数 × 50〜150 MB のメモリコスト）。

### 2.3 同時展開の制限

**展開は常に 1 件のみ。** 別のカードをクリックすると  
現在展開中の iframe をサムネイルに戻してから新しいものを展開する。

### 2.4 閉じる導線：✕ ボタン + Esc キー

iframe 展開中は常に以下の 2 つの手段でサムネイルに戻せる。

- **✕ ボタン**（`workspace-card__youtube-close`）: iframe の右上に常時表示
- **Esc キー**: `window.addEventListener('keydown', ...)` で `activeYoutubeCardEl` をリセット

autoplay ブロック時専用のフォールバック処理は実装しない（理由: 上記「採用」欄を参照）。  
再生できなかった場合はユーザーが ✕ または Esc で閉じれば済む。

### 2.5 closeBtn の視認性・コントラスト担保

iframe の中身が YouTube 側のエラー画面（動画削除・埋め込み禁止等）になった場合も、  
JS 側から検知することは cross-origin 制約上不可能。  
閉じるボタンは常にユーザーが操作できる状態でなければならない。

実装上の保証事項：
- `workspace-card__youtube-close` は `position: absolute; z-index: 10` で  
  iframe の上に必ず表示される（iframe は `z-index` 指定なし、通常フロー）
- 背景色は `rgba(0, 0, 0, 0.7)` で固定しており、YouTube の赤・白・灰色どの背景色でも  
  白いアイコンのコントラスト比が確保される
- `width: 24px; height: 24px` の固定サイズで、小さいパネル幅でも押しやすい

### 2.6 パネルクローズ時の音残り対策（ライフサイクル管理）

ユーザーが再生中にパネルを閉じた場合に備え、  
`cleanupYoutubeEmbed` を `beforeunload` と既存の `closePanel` ハンドラ両方に登録する。  
`frame.src = ''` で YouTube への通信を即座に切断する。

### 2.7 manifest.json の CSP 修正

Phase 1 では `www.youtube.com` を使用する。  
**`www.youtube-nocookie.com` を今使わない理由：**  
nocookie ドメインは広告・クロスサイトトラッキングを除去するが、  
動作の互換性・再生品質・埋め込み制限の扱いについて youtube.com との差異を  
未検証のまま Phase 1 に投入するリスクを避ける。  
CSP には両ドメインを今から記載しておき、Phase 2 で動作検証後に切り替える。

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com"
}
```

### 2.8 sandbox を付与しない理由（明文化）

```
設計判断の記録:

YouTube プレイヤーは JavaScript を必要とするため、sandbox を付与する場合
allow-scripts が必須になる。

しかし allow-scripts と allow-same-origin を同時に指定すると、
sandbox 内のスクリプトが iframe 自身の sandbox を解除できるため
セキュリティ上の意味が実質的になくなる（WHATWG 仕様上の既知の問題）。

代わりに:
  - CSP の frame-src で許可ドメインを YouTube に限定する（ドメインレベルの制限）
  - allow 属性は最小限（autoplay, encrypted-media, picture-in-picture）のみ指定する
  - allowFullscreen は明示的に true に設定する
  - 不要な allow 属性（camera, microphone, geolocation 等）は付与しない

この組み合わせが「sandbox なし」でも取り得る最小権限設計となる。
```

### 2.9 データ層の拡張余地

`WorkspaceItem` に `meta` フィールドを追加する。  
v1 時点では保存側の変更は行わず、表示時の URL 解析で YouTube を判定する方針を維持する。

```js
/**
 * @typedef {Object} WorkspaceItem
 * @property {string}             id
 * @property {'text'|'image'}     type        - v1 では 'youtube' 型は追加しない
 * @property {string|null}        text
 * @property {string|null}        imageUrl
 * @property {string}             pageUrl
 * @property {string}             pageTitle
 * @property {string|null}        groupId
 * @property {number}             createdAt
 * @property {number|null}        windowId
 * @property {Object|null}        meta        - 拡張用（v1 では常に null）
 *   将来: { kind: 'youtube', videoId: 'XXXXXXXXXXX', ... }
 */
```

---

## 3. 性能と技術的制約の考慮点

### 3.1 iframe のメモリコスト

| 状態 | コスト |
|---|---|
| サムネイル表示（img） | 約 10〜20 KB（サムネイル 1 枚）|
| iframe 展開後（再生中） | 約 50〜150 MB（YouTube JS エンジン含む）|
| 同時展開 3 件 | 150〜450 MB。パネルが重くなる可能性大 |

クリック展開 + 同時展開 1 件制限で実質的に無害化できる。

### 3.2 パネルの入れ子 iframe 構造と z-index 体系

```
[Webページ]
  └─ <iframe id="tmx-tab-manager-panel">    z-index: 999999（content.js が生成）
       └─ panel.html（拡張機能ページ）
            ├─ header                        z-index: 1（panel.html 内）
            ├─ panel-shell                   z-index: 99（panel.html 内）
            ├─ context-menu                  z-index: 2000（panel.html 内）
            └─ workspace-view > workspace-card > workspace-card__youtube
                 ├─ <img>（サムネイル）      通常フロー
                 ├─ <iframe>（YouTube）      通常フロー、z-index なし
                 └─ <button.close>           position: absolute; z-index: 10
```

`workspace-card__youtube` は `overflow: hidden` を持つが、  
`position: static` のためスタッキングコンテキストを形成しない。  
`workspace-card__youtube-close`（`z-index: 10`）は `position: absolute` であり、  
`workspace-card`（`position: relative`）を containing block として  
youtube iframe の上に確実に描画される。  

**panel.html 外の要素（previewOverlay, panelIframe）との干渉はない。**  
panel.html は独立した iframe ドキュメントであり、別の stacking context。

### 3.3 パネル幅（400px）の制約と確定方針

デフォルトの 400px は YouTube プレイヤーの最小推奨幅（480px）を下回る。  
`aspect-ratio: 16/9` で高さは自動調整されるため表示は崩れないが、  
プレイヤー操作 UI が小さくなる。

**確定方針：400px でも埋め込みを提供する。視聴快適性の追加改善は行わない。**  
「整理」用途では、動画を認識してタブを閉じる判断ができれば十分。  
展開ビューへの誘導や 100vw 時限定化は Phase 2 の検討事項とする。

### 3.4 autoplay ポリシー

ユーザーのクリック直後に `iframe.src` を設定すれば autoplay は許可される。  
タイムアウトフォールバック処理は実装しない（v2 からの削除）。  
ブラウザ設定・管理ポリシーによるブロックはユーザーが ✕/Esc で対処できる。

### 3.5 iframe 読み込み失敗の検知限界

YouTube 側の理由（動画削除・埋め込み禁止設定等）により  
iframe の中身が YouTube のエラー画面になった場合、  
JavaScript 側から検知することは **cross-origin 制約上不可能**。  
この状態への対処は ✕ ボタンと Esc キーによるユーザー操作に委ねる。  
設計上の責務はここで終わり。

### 3.6 Shorts のアスペクト比問題

Shorts は縦長（9:16）だが URL のみからは判別不可能。  
v1 では `aspect-ratio: 16/9` で横長表示（画面端がクロップ）を許容する。  
Phase 2 では oEmbed API のサムネイル比率から判定する。

---

## 4. さらに検討の余地がある課題

### 4.1 文中 URL 抽出モードのオプション化

現在: テキスト全体が YouTube URL のみの場合のみ埋め込み対象。  
ニーズ確認後に v1.1 でオプション化する。デフォルトは「URL のみモード」を維持。

### 4.2 oEmbed タイトル補完・サムネイル品質化（Phase 2 優先議題）

GPT の指摘：「埋め込みで視聴させることよりも、サムネイルとタイトルの品質向上の方が  
整理体験の観点で価値が高い可能性がある」

URL だけをテキストとして保存した場合はタイトルが空になる。  
oEmbed API（認証不要）でタイトル・高解像度サムネイルを取得可能：

```
GET https://www.youtube.com/oembed?url={encodedUrl}&format=json
```

**Phase 2 の優先度を「埋め込みプレイヤーの快適性改善」より上位に置くことを検討する。**  
取得タイミングは「展開ボタンクリック時」の遅延フェッチとし、  
保存時の追加フェッチは行わない（保存の摩擦を増やさないため）。

### 4.3 youtube-nocookie.com への切り替え（Phase 2）

v1 で CSP に両ドメインを含めているため、実装は設定の追加のみ。

```js
const YT_BASE = privacyMode
  ? 'https://www.youtube-nocookie.com/embed'
  : 'https://www.youtube.com/embed';
iframe.src = `${YT_BASE}/${videoId}?autoplay=1&rel=0`;
```

Phase 2 の動作検証内容：nocookie での埋め込み制限・再生品質・互換性を確認してから有効化。

### 4.4 `meta` フィールドへの移行戦略

グループ機能・テキスト検索を実装する段階で `meta.kind === 'youtube'` への移行を行う。

**DB マイグレーション方針：**

```
移行タイミング:
  グループ機能 or 検索機能の実装時に IndexedDB を WS_DB_VERSION 2 にアップグレードする。

onupgradeneeded（v1 → v2）での処理:
  1. items ObjectStore の全件を読み込む
  2. text が YouTube URL として判定できるアイテムに
     meta: { kind: 'youtube', videoId: extractYoutubeVideoId(item.text) } を付与
  3. 判定できないアイテムは meta: null のまま
  4. type フィールドは変更しない（'text' のまま。将来の 'youtube' 型は v3 以降に検討）

ロールバック考慮:
  meta フィールドの追加のみであり、既存データ構造を破壊しないため
  旧バージョンの拡張でも既存 items は正常に読み込める。
```

---

## 5. 具体的な実装スクリプト例

### 5.1 manifest.json — CSP 修正

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com"
}
```

---

### 5.2 panel.js — YouTube 判定・埋め込み生成関数群

```js
// ── YouTube 埋め込み：定数 ──────────────────────────────────────────
const YOUTUBE_THUMB_BASE = 'https://img.youtube.com/vi';
const YOUTUBE_EMBED_BASE = 'https://www.youtube.com/embed';
const YT_ID_REGEX        = /^[a-zA-Z0-9_-]{11}$/;

// 現在展開中のカード要素への参照（同時展開 1 件制限）
let activeYoutubeCardEl = null;

// ── YouTube URL から動画 ID を抽出 ────────────────────────────────
function extractYoutubeVideoId(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (/\s/.test(trimmed)) return null;

  try {
    const u    = new URL(trimmed);
    const host = u.hostname.replace(/^m\./, '').replace(/^www\./, '');

    if (host === 'youtube.com') {
      if (u.pathname === '/watch') {
        const v = u.searchParams.get('v');
        return (v && YT_ID_REGEX.test(v)) ? v : null;
      }
      const shortsMatch = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})(?:\/|$|\?)/);
      if (shortsMatch && YT_ID_REGEX.test(shortsMatch[1])) return shortsMatch[1];
      const embedMatch  = u.pathname.match(/^\/embed\/([a-zA-Z0-9_-]{11})(?:\/|$|\?)/);
      if (embedMatch  && YT_ID_REGEX.test(embedMatch[1]))  return embedMatch[1];
    }

    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return YT_ID_REGEX.test(id) ? id : null;
    }
  } catch {
    // URL パース失敗 = 通常テキスト
  }
  return null;
}

// ── サムネイル状態に描画する ─────────────────────────────────────
function renderYoutubeThumbnail(wrapper, videoId, title) {
  wrapper.innerHTML = '';

  const thumb     = document.createElement('img');
  thumb.className = 'workspace-card__youtube-thumb';
  thumb.src       = `${YOUTUBE_THUMB_BASE}/${videoId}/mqdefault.jpg`;
  thumb.alt       = title || 'YouTube';
  thumb.loading   = 'lazy';
  thumb.onerror   = () => { thumb.src = `${YOUTUBE_THUMB_BASE}/${videoId}/default.jpg`; };

  const overlay     = document.createElement('div');
  overlay.className = 'workspace-card__youtube-overlay';
  const playBtn     = document.createElement('div');
  playBtn.className = 'workspace-card__youtube-play';
  playBtn.innerHTML = `
    <svg viewBox="0 0 68 48" width="68" height="48" xmlns="http://www.w3.org/2000/svg">
      <path d="M66.52 7.74C65.7 4.56 63.2 2.06 60.02 1.24 54.8 0 34 0 34 0S13.2 0 7.98 1.24C4.8 2.06 2.3 4.56 1.48 7.74 0 13.24 0 24 0 24s0 10.76 1.48 16.26C2.3 43.44 4.8 45.94 7.98 46.76 13.2 48 34 48 34 48s20.8 0 26.02-1.24c3.18-.82 5.68-3.32 6.5-6.5C68 34.76 68 24 68 24s0-10.76-1.48-16.26z" fill="#ff0000"/>
      <path d="M27 34.5l18-10.5-18-10.5z" fill="#fff"/>
    </svg>`;
  overlay.appendChild(playBtn);
  wrapper.appendChild(thumb);
  wrapper.appendChild(overlay);

  wrapper.addEventListener('click', () => activateYoutubeEmbed(wrapper, videoId, title), { once: true });
}

// ── iframe 展開状態に切り替える ──────────────────────────────────
function activateYoutubeEmbed(wrapper, videoId, title) {
  // 既に展開中の別カードをサムネイルに戻す
  if (activeYoutubeCardEl && activeYoutubeCardEl !== wrapper.closest('.workspace-card')) {
    const prevWrapper = activeYoutubeCardEl.querySelector('.workspace-card__youtube');
    if (prevWrapper) {
      renderYoutubeThumbnail(prevWrapper, prevWrapper.dataset.videoId, prevWrapper.dataset.title);
    }
  }

  wrapper.innerHTML = '';

  // 「閉じる」ボタン
  // - position: absolute; z-index: 10 で iframe の上に必ず描画される
  // - 背景 rgba(0,0,0,0.7) で YouTube エラー画面でも視認性を確保
  const closeBtn     = document.createElement('button');
  closeBtn.className = 'workspace-card__youtube-close';
  closeBtn.type      = 'button';
  closeBtn.title     = 'サムネイルに戻す（Esc でも閉じられます）';
  closeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
    <path fill="currentColor" d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12z"/>
  </svg>`;
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    renderYoutubeThumbnail(wrapper, videoId, title);
    activeYoutubeCardEl = null;
  });

  const iframe = document.createElement('iframe');
  iframe.className       = 'workspace-card__youtube-frame';
  iframe.src             = `${YOUTUBE_EMBED_BASE}/${videoId}?autoplay=1&rel=0`;
  iframe.title           = title || 'YouTube';
  // 最小権限: autoplay・暗号化メディア・PiP のみ
  // camera, microphone, geolocation 等は意図的に含めない
  // sandbox は付与しない（設計判断: 2.8 節を参照）
  iframe.allow           = 'autoplay; encrypted-media; picture-in-picture';
  iframe.allowFullscreen = true;

  wrapper.appendChild(closeBtn);
  wrapper.appendChild(iframe);

  activeYoutubeCardEl = wrapper.closest('.workspace-card');
}

// ── パネルクローズ時の後処理 ──────────────────────────────────────
function cleanupYoutubeEmbed() {
  if (!activeYoutubeCardEl) return;
  const wrapper = activeYoutubeCardEl.querySelector('.workspace-card__youtube');
  if (wrapper) {
    const frame = wrapper.querySelector('.workspace-card__youtube-frame');
    if (frame) frame.src = ''; // YouTube への通信を即座に切断
    wrapper.innerHTML = '';
  }
  activeYoutubeCardEl = null;
}

// Esc キーで展開中の埋め込みを閉じる
function handleYoutubeEmbedKeydown(event) {
  if (event.key !== 'Escape' || !activeYoutubeCardEl) return;
  const wrapper = activeYoutubeCardEl.querySelector('.workspace-card__youtube');
  if (!wrapper) return;
  renderYoutubeThumbnail(wrapper, wrapper.dataset.videoId, wrapper.dataset.title);
  activeYoutubeCardEl = null;
}

// ── YouTube カードの wrapper を生成 ──────────────────────────────
function createYoutubeEmbed(videoId, title) {
  const wrapper         = document.createElement('div');
  wrapper.className     = 'workspace-card__youtube';
  wrapper.dataset.videoId = videoId;
  wrapper.dataset.title   = title || '';
  renderYoutubeThumbnail(wrapper, videoId, title);
  return wrapper;
}
```

`setupWorkspaceControls()` への追記：

```js
function setupWorkspaceControls() {
  // ...既存の実装...
  window.addEventListener('keydown', handleYoutubeEmbedKeydown);
  window.addEventListener('beforeunload', cleanupYoutubeEmbed);
}
```

`createWorkspaceCard` 内での利用：

```js
if (item.type === 'text' && item.text) {
  const videoId = extractYoutubeVideoId(item.text);
  if (videoId) {
    card.appendChild(createYoutubeEmbed(videoId, item.pageTitle));
  } else {
    const textEl       = document.createElement('p');
    textEl.className   = 'workspace-card__text';
    textEl.textContent = item.text;
    card.appendChild(textEl);
  }
}
```

---

### 5.3 styles.css — YouTube カード用スタイル

```css
/* ── YouTube 埋め込みカード ─────────────────────────────────────── */

.workspace-card__youtube {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 6px;
  overflow: hidden;
  background: #000;
  margin-bottom: 6px;
  cursor: pointer;
  /* position: relative かつ overflow: hidden。
     z-index を持たないため panel.html 内のスタッキングコンテキストを形成しない。
     closeBtn（z-index: 10）は workspace-card（position: relative）を基準に配置される。 */
}

.workspace-card__youtube-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: opacity 0.2s ease;
}

.workspace-card__youtube:hover .workspace-card__youtube-thumb {
  opacity: 0.85;
}

.workspace-card__youtube-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.workspace-card__youtube-play {
  opacity: 0.9;
  transition: opacity 0.2s ease, transform 0.15s ease;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.6));
}

.workspace-card__youtube:hover .workspace-card__youtube-play {
  opacity: 1;
  transform: scale(1.08);
}

.workspace-card__youtube-frame {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
  /* z-index は指定しない。closeBtn（z-index: 10）が必ず上に来る。 */
}

/* 「閉じる」ボタン
   - z-index: 10 で iframe の上に必ず表示（iframe は z-index なし）
   - rgba(0,0,0,0.7) 背景で YouTube エラー画面でも視認性を確保
   - 固定サイズ 24×24px で 400px パネル幅でも操作可能 */
.workspace-card__youtube-close {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 10;
  background: rgba(0, 0, 0, 0.7);
  border: none;
  color: #fff;
  cursor: pointer;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s ease;
}

.workspace-card__youtube-close:hover {
  background: rgba(0, 0, 0, 0.9);
}
```

---

## 6. v1 実装スコープの整理（v3 更新版）

| 項目 | Phase 1（今回） | Phase 2（将来） |
|---|---|---|
| URL 判定 | 表示時パース・`YT_ID_REGEX` 検証 | `meta.kind: 'youtube'` 保存方式へ移行 |
| サムネイル | `img.youtube.com` から `<img>` で表示 | oEmbed で高解像度取得・タイトル補完（**優先**） |
| 再生 | クリック展開・同時 1 件制限 | Shorts 縦長対応 |
| 閉じる導線 | ✕ ボタン + Esc キー | — |
| autoplay フォールバック | 実装しない | — |
| iframe 読み込み失敗 | ✕ ボタン/Esc でユーザー対処 | — |
| パネルクローズ時 | `frame.src = ''` で通信切断 | — |
| 400px での表示 | 提供する・快適性改善はしない | 展開ビュー連携を検討 |
| プライバシー | CSP に nocookie 記載済み | 動作検証後に設定から切り替え可能に |
| データ構造 | `meta: null` フィールドを型定義に記述 | `meta.videoId` への DB マイグレーション |

---

## 7. v2 → v3 の主要変更点

| 変更内容 | 変更前（v2） | 変更後（v3） |
|---|---|---|
| autoplay フォールバック | タイムアウト方式を記述（コードなし） | 削除。✕/Esc による対処のみ |
| youtube.com を今使う理由 | 記述なし | 互換性・動作検証優先を明記 |
| z-index 体系 | 「干渉リスクは低い」のみ | 数値付きの体系図と closeBtn の確実性を明記 |
| closeBtn の視認性 | z-index: 10 のみ記述 | 背景色コントラスト・サイズの根拠を CSS コメントで明示 |
| iframe 読み込み失敗 | 記述なし | cross-origin 検知不可であることを制約として明記 |
| meta 移行戦略 | 「移行を検討する」のみ | DB バージョンアップ方針・onupgradeneeded 処理内容を記述 |
| 400px 方針 | 「許容」 | 「提供する・快適性改善はしない」に確定 |
| oEmbed 優先度 | Phase 2 の一項目 | Phase 2 優先議題として位置づけを引き上げ |
