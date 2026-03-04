# YouTube 埋め込み機能 実装設計書 v2

> GPT・Gemini両フィードバックを受けて改訂。v1からの変更点は末尾の差分表に記載。

---

## フィードバック振り分け表

| 項目 | 出典 | 判定 | 理由 |
|---|---|---|---|
| URL パーサーのバリデーション強化 | Gemini | **採用** | `t=` パラメータ混入リスクは実在する |
| パネルクローズ時の音残り対策 | Gemini | **採用** | 既存の closePanel フックへの追記で低コストに対応可能 |
| youtube-nocookie.com の使用 | Gemini・GPT | **部分採用** | CSP の準備だけ v1 でやり、実際の切り替えは Phase 2 |
| sandbox 方針の明文化 | GPT | **採用** | 現状では理由の記述が設計書にあるだけで不十分。実装コメントと設計書の両方に明示する |
| Esc キー・フォーカス制御 | GPT | **採用** | closeBtn は実装済みだが Esc 対応が抜けていた |
| データ層の拡張余地（meta フィールド） | GPT | **採用** | Phase 2 への移行コストを下げるため `meta` フィールドを設計に明記する |
| autoplay ブロック時のフォールバック | Gemini | **部分採用** | `&mute=1` の付与は採用しない（音のない動画は「再生できない」と誤認される）。代わりにブロック時はサムネイルに戻す処理を追加 |
| PiP ボタンの明示的な配置 | Gemini | **不採用** | YouTube iframe 標準の PiP は既に `allow="picture-in-picture"` で有効。ボタンを追加する UI コストと得られる価値が見合わない |
| 再生位置の保存（レジューム機能） | Gemini | **不採用** | 保存元の `currentTime` は別タブの DOM にアクセスしなければ取得できない。content.js 経由でも取得可能だが、「YouTube ページで右クリック保存」という操作フローで再生中であることは稀であり、実装コストに対してユーザーへの恩恵が小さい |
| 「整理体験」vs「視聴体験」の優先順位 | GPT | **採用（方針として）** | 「タブを閉じるための動線として動画を確認できる」に留め、フル視聴のための機能追加はしない |
| 文中 URL 抽出モードのオプション化 | GPT | **課題として記録** | v1 では安全寄りで「テキスト全体が URL のみ」を維持。ニーズが出てきたら再検討 |
| expanded-view との z-index 干渉確認 | GPT | **採用（確認事項として）** | 実装前に既存の z-index 体系を確認する必要がある |

---

## 採用・不採用の詳細判断

### 不採用：PiP ボタンの明示的な配置

YouTube プレイヤーの右クリックメニューと `allow="picture-in-picture"` の組み合わせで  
PiP は既に使用可能。カードに専用ボタンを追加しても、  
ユーザーが PiP を使いたいのはプレイヤーを展開してから操作するシナリオであり、  
カード UI 上にボタンを並べる必然性がない。  
UI が増えるほど「整理ツール」としての使いやすさが下がるリスクもある。

### 不採用：再生位置の保存（レジューム機能）

技術的には `chrome.tabs.executeScript` で再生中タブの `video.currentTime` を取得し  
`?t={seconds}` として URL に付与することは可能。  
ただし前提として「保存操作のタイミングで動画が再生中である」必要があり、  
右クリックによるテキスト選択保存フローでは動画が止まる（またはそもそも動画ページではない場合が多い）。  
実装コスト・適用範囲・得られるメリットの比を考えると Phase 1 には不釣り合い。

### 部分採用：`youtube-nocookie.com`

プライバシー保護の観点として指摘は正しい。  
ただし `www.youtube-nocookie.com` に切り替えるには CSP の `frame-src` ドメインを変更するだけでなく、  
サムネイル URL（`img.youtube.com`）の扱い・oEmbed URL の変更も伴う。  
v1 では **CSP に両ドメインを記載しておき、iframe の src だけを設定で切り替えられる準備**をする。  
実際の切り替えはプライバシー設定として Phase 2 でユーザーが選べるようにする。

### 部分採用：autoplay ブロック時のフォールバック

`&mute=1` を付与すると「再生されているが聞こえない」状態になり  
ユーザーが「再生できていない」と誤認するリスクがある。  
代わりに iframe の `load` イベント後に短いタイムアウトで再生状態を確認し、  
ブロックされていた場合はサムネイルに戻す処理を追加する。  
（YouTube の postMessage API で再生状態を検知することは cross-origin の制約上不可能なため、  
タイムアウト方式が実質的な上限）

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
  通常テキストカード  →  YouTube URL を検出  →  サムネイル + タイトル + 再生ボタン
  クリック時:
    サムネイルが iframe に差し替わり動画がインライン再生される
```

### この機能の位置づけ

「後でこの動画を見たい」というニーズに応えるが、  
**目的は「タブを閉じるための動線として動画を確認できること」**であって、  
フル視聴のための快適なプレイヤー体験の提供ではない。  
この優先順位は設計判断の全体に影響する。

---

## 2. 実装技術の方針

### 2.1 YouTube URL の判定と動画 ID 抽出（バリデーション強化）

`?t=` パラメータやプレイリスト情報が含まれる URL でも  
正確に 11 文字の動画 ID のみを抽出するよう、検証ロジックを明示する。

```
対応パターン:
  https://www.youtube.com/watch?v=XXXXXXXXXXX              ← 通常
  https://www.youtube.com/watch?v=XXXXXXXXXXX&t=120        ← タイムスタンプ付き（IDのみ抽出）
  https://www.youtube.com/watch?v=XXXXXXXXXXX&list=PLxxxx  ← プレイリスト付き（IDのみ抽出）
  https://youtu.be/XXXXXXXXXXX                             ← 短縮
  https://youtu.be/XXXXXXXXXXX?t=60                       ← 短縮+タイムスタンプ（IDのみ抽出）
  https://www.youtube.com/embed/XXXXXXXXXXX               ← 埋め込み済み URL
  https://www.youtube.com/shorts/XXXXXXXXXXX              ← Shorts
  https://m.youtube.com/watch?v=XXXXXXXXXXX               ← モバイル版
```

```js
// YouTube 動画 ID の形式チェック（11文字の英数字・ハイフン・アンダースコア）
const YT_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

function extractYoutubeVideoId(text) {
  if (!text) return null;
  const trimmed = text.trim();

  // スペースや改行が含まれる（= URL 以外のテキストが混在する）場合はスキップ
  if (/\s/.test(trimmed)) return null;

  try {
    const u    = new URL(trimmed);
    const host = u.hostname.replace(/^m\./, '').replace(/^www\./, '');

    if (host === 'youtube.com') {
      if (u.pathname === '/watch') {
        // URLSearchParams で確実に v パラメータのみを取得
        const v = u.searchParams.get('v');
        return (v && YT_ID_REGEX.test(v)) ? v : null;
      }
      // Shorts: pathname の 2 番目のセグメントのみを取得
      const shortsMatch = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})(?:\/|$|\?)/);
      if (shortsMatch && YT_ID_REGEX.test(shortsMatch[1])) return shortsMatch[1];
      // 埋め込み URL
      const embedMatch  = u.pathname.match(/^\/embed\/([a-zA-Z0-9_-]{11})(?:\/|$|\?)/);
      if (embedMatch && YT_ID_REGEX.test(embedMatch[1]))  return embedMatch[1];
    }

    if (host === 'youtu.be') {
      // pathname の最初のセグメントのみ。t= など後続パラメータは URLSearchParams が処理済み
      const id = u.pathname.slice(1).split('/')[0];
      return YT_ID_REGEX.test(id) ? id : null;
    }
  } catch {
    // URL パース失敗 = 通常テキスト
  }
  return null;
}
```

**v1 では「テキスト全体が URL のみ」を維持する。**  
混在テキスト（例："おすすめ動画 https://youtu.be/..."）への対応は  
需要が確認されてから v1.1 でオプションとして追加する。

### 2.2 表示方式：クリック展開（Lazy iframe）

`<iframe>` を初期表示から生成する方式は採用しない。  
**サムネイル画像を表示し、クリックしたときに初めて `<iframe>` を生成する**方式を採る。

```
初期状態:
  [サムネイル img]          ← https://img.youtube.com/vi/{ID}/mqdefault.jpg
  [再生ボタン SVG オーバーレイ]

クリック後:
  [YouTube <iframe>]        ← autoplay=1 で即再生開始
  [✕ 閉じるボタン]
```

### 2.3 同時展開の制限

**展開は常に 1 件のみ**。別のカードで再生ボタンをクリックすると、  
現在展開中の iframe をサムネイル状態に戻してから新しいものを展開する。

### 2.4 閉じる導線：✕ ボタン + Esc キー対応

iframe 展開時に複数の閉じる手段を提供する。

```js
// Esc キーでアクティブな埋め込みを閉じる
// setupWorkspaceControls() の中で登録する
function handleYoutubeEmbedKeydown(event) {
  if (event.key !== 'Escape' || !activeYoutubeCardEl) return;
  const wrapper = activeYoutubeCardEl.querySelector('.workspace-card__youtube');
  if (!wrapper) return;
  renderYoutubeThumbnail(wrapper, wrapper.dataset.videoId, wrapper.dataset.title);
  activeYoutubeCardEl = null;
}
// DOMContentLoaded 後に window.addEventListener('keydown', handleYoutubeEmbedKeydown) で登録
```

### 2.5 パネルクローズ時の音残り対策（ライフサイクル管理）

ユーザーが再生中にパネルを閉じると、親 iframe が破棄されるため  
通常は YouTube プレイヤーも同時に破棄される。  
ただし親 iframe の `beforeunload` が発火しない場合や、  
`panel.js` の `closePanel` が呼ばれた際に明示的に後処理する実装が安全。

既存の `notifyPanelClosed` または `closePanel` メッセージ受信時に  
YouTube iframe を確実に破棄する処理を追加する。

```js
// panel.js の既存 closePanel 処理（TabManagerClosePanel メッセージ受信時など）の末尾に追加
function cleanupYoutubeEmbed() {
  if (!activeYoutubeCardEl) return;
  const wrapper = activeYoutubeCardEl.querySelector('.workspace-card__youtube');
  if (wrapper) {
    // iframe を src="" にして YouTube への通信を即座に切断
    const frame = wrapper.querySelector('.workspace-card__youtube-frame');
    if (frame) frame.src = '';
    wrapper.innerHTML = '';
  }
  activeYoutubeCardEl = null;
}

// beforeunload でも保険として実行
window.addEventListener('beforeunload', cleanupYoutubeEmbed);
```

### 2.6 manifest.json の CSP 修正

`frame-src` に YouTube の 2 ドメインを記載する。  
`www.youtube-nocookie.com` は Phase 2 で切り替え可能にするための準備として今から含める。  
実際の iframe src は現時点では `www.youtube.com` を使用する。

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com"
}
```

### 2.7 sandbox を付与しない理由（明文化）

```
設計判断の記録:

YouTube プレイヤーは JavaScript を必要とするため iframe に sandbox を付与する場合
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

### 2.8 データ層の拡張余地

現在の `WorkspaceItem` に `meta` フィールドを追加し、  
将来の YouTube 固有情報（videoId, duration 等）を格納できる余地を持たせる。  
v1 時点では保存側の変更は行わず、**表示時に URL を解析して自動判定**する方針を維持する。

```js
// WorkspaceItem の型定義（将来の拡張を見越した記述）
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

グループ機能・検索機能を実装する段階で `meta.kind === 'youtube'` を使った  
IndexedDB フィルタリングへの移行を検討する。

---

## 3. 性能と技術的制約の考慮点

### 3.1 iframe のメモリコスト

| 状態 | コスト |
|---|---|
| サムネイル表示（img） | 約 10〜20 KB（サムネイル画像 1 枚）|
| iframe 展開後（再生中） | 約 50〜150 MB（YouTube JS エンジン含む） |
| 同時展開 3 件 | 150〜450 MB、パネルが重くなる可能性大 |

クリック展開 + 同時展開 1 件制限で実質的に無害化できる。

### 3.2 パネルの入れ子 iframe 構造

```
[Webページ]
  └─ <iframe id="tmx-tab-manager-panel">   ← content.js が生成
       └─ panel.html（拡張機能ページ）
            └─ workspace-view
                 └─ <iframe src="youtube.com/embed/...">   ← 今回追加
```

`frame-src` CSP は panel.html（拡張機能ページ）に対して適用されるため、  
manifest.json の修正で完結する。Web ページの CSP は影響しない。

z-index の干渉：  
workspace-view は通常フロー内にあり、既存の previewOverlay（z-index: 999998）や  
パネル本体（z-index: 999999）とは独立したスタッキングコンテキストにある。  
**ただし展開ビューと workspace-view が同時に表示されることは設計上ないため、  
実際の干渉リスクは低い。**

### 3.3 パネル幅（400px）の制約

デフォルトの 400px は YouTube プレイヤーの最小推奨幅（480px）を下回る。  
カード内の `aspect-ratio: 16/9` で高さは自動調整されるため表示は崩れないが、  
プレイヤー操作 UI が小さくなる。

Phase 1 での方針：400px 内で表示を許容する（「整理体験」優先のため視聴快適性は二次的）  
Phase 2 での検討：展開ビュー時のみ埋め込みを有効化し、通常幅では「YouTube で開く」リンクのみ

### 3.4 autoplay ポリシー

ユーザーのクリック直後に `iframe.src` を設定すれば autoplay は許可される。  
ブロックされた場合の検知は cross-origin 制約上不可能なため、  
タイムアウト（3 秒）でサムネイルへのフォールバックボタンを表示する。  
`&mute=1` は採用しない（音のない動画が再生されることでユーザーが誤解するリスクがある）。

### 3.5 Shorts のアスペクト比問題

Shorts は縦長（9:16）だが、URL のみからは判別不可能。  
v1 では `aspect-ratio: 16/9` で横長表示（画面端がクロップ）を許容する。  
oEmbed API を使えばサムネイルの縦横比から Shorts を判別できるため、  
Phase 2 での対応とする。

---

## 4. さらに検討の余地がある課題

### 4.1 文中 URL 抽出モードのオプション化

現在の判定: テキスト全体が YouTube URL のみの場合のみ埋め込み対象  
将来の選択肢:

```
「おすすめ動画 https://youtu.be/xxxxx」のようなテキストから
URL 部分だけを抽出して埋め込みカードを表示するモード
```

ニーズが確認されてから v1.1 でオプション追加を検討する。  
安全寄りの現設計を壊さないよう、デフォルトは「URL のみモード」を維持する。

### 4.2 oEmbed API による動画タイトルの遅延取得

YouTube ページから保存した場合は `pageTitle` に動画タイトルが入るが、  
URL だけをテキストとして保存した場合はタイトルが空になる。  
oEmbed API（認証不要）で取得可能：

```
GET https://www.youtube.com/oembed?url={encodedUrl}&format=json
```

ユーザーが展開ボタンをクリックしたタイミングで初めて取得する遅延フェッチが  
「保存の摩擦を増やさない」観点から優れている。  
取得後は `wrapper.dataset.title` を更新し、将来的には IndexedDB のアイテムにも書き戻す。

### 4.3 youtube-nocookie.com への切り替え（Phase 2）

Phase 2 でユーザーが設定画面から切り替え可能にする案：

```js
// 設定に基づいて iframe src を切り替える
const YT_BASE = privacyMode
  ? 'https://www.youtube-nocookie.com/embed'
  : 'https://www.youtube.com/embed';
iframe.src = `${YT_BASE}/${videoId}?autoplay=1&rel=0`;
```

CSP は v1 で両ドメインを既に含めているため、実装は設定の追加のみ。

### 4.4 `meta` フィールドへの移行タイミング

グループ機能・テキスト検索を実装する段階で  
`type: 'youtube'` + `meta.videoId` への保存方式への移行を検討する。  
移行時は既存の `type: 'text'` アイテムを IndexedDB マイグレーションで変換するか、  
`onupgradeneeded` でバージョンアップ時に一括更新する。

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
  if (/\s/.test(trimmed)) return null; // 混在テキストはスキップ

  try {
    const u    = new URL(trimmed);
    const host = u.hostname.replace(/^m\./, '').replace(/^www\./, '');

    if (host === 'youtube.com') {
      if (u.pathname === '/watch') {
        const v = u.searchParams.get('v');
        return (v && YT_ID_REGEX.test(v)) ? v : null;
      }
      // Shorts・embed は pathname の正確なセグメントのみ取得
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
  // サムネイル取得失敗時は低解像度版にフォールバック
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

  // 「閉じる」ボタン（✕）
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

  const iframe           = document.createElement('iframe');
  iframe.className       = 'workspace-card__youtube-frame';
  iframe.src             = `${YOUTUBE_EMBED_BASE}/${videoId}?autoplay=1&rel=0`;
  iframe.title           = title || 'YouTube';
  // 最小権限: autoplay・暗号化メディア・PiP のみ
  // camera, microphone, geolocation 等は意図的に含めない
  // sandbox は付与しない（設計判断: 2.7 節を参照）
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
  const wrapper     = document.createElement('div');
  wrapper.className = 'workspace-card__youtube';
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

  // Esc キー・クローズ処理を登録
  window.addEventListener('keydown', handleYoutubeEmbedKeydown);
  window.addEventListener('beforeunload', cleanupYoutubeEmbed);
}
```

`createWorkspaceCard` 内での利用箇所：

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

### 5.3 styles.css — YouTube カード用スタイル追加

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
}

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

## 6. v1 実装スコープの整理（v2 更新版）

| 項目 | Phase 1（今回） | Phase 2（将来） |
|---|---|---|
| URL 判定 | 表示時にテキストをパース（`YT_ID_REGEX` で検証） | 保存時に `meta.kind: 'youtube'` で保存 |
| サムネイル | YouTube サムネイル URL から `<img>` で表示 | oEmbed で高解像度取得・タイトル補完 |
| 再生 | クリックで iframe 展開・同時 1 件制限 | Shorts 縦長対応・展開ビュー対応 |
| 閉じる導線 | ✕ ボタン + Esc キー | — |
| パネルクローズ時 | `frame.src = ''` で通信切断 | — |
| プライバシー | CSP に nocookie ドメイン記載済み | 設定画面で nocookie 切り替え可能に |
| 文中 URL 抽出 | 対応しない（全体が URL のみ） | オプション化 |
| 拡張データ構造 | `meta: null` フィールドを型定義に記述 | `meta.videoId` への移行 |

---

## 7. v1 → v2 の主要変更点

| 変更内容 | 変更前（v1） | 変更後（v2） |
|---|---|---|
| URL パーサーの検証 | `id.length === 11` のみ | `YT_ID_REGEX` で形式を厳密に検証。`split('?')[0]` を `split('/')[0]` に修正（youtu.be のパス末尾対応） |
| パネルクローズ時の処理 | なし | `cleanupYoutubeEmbed` + `beforeunload` で iframe 通信を切断 |
| Esc キー対応 | なし | `handleYoutubeEmbedKeydown` を追加 |
| CSP のドメイン | `youtube.com` のみ | `youtube.com` + `youtube-nocookie.com` |
| sandbox 方針 | 設計書にのみ記載 | 実装コメントと設計書の両方に明示 |
| データ層の拡張余地 | 記述なし | `meta` フィールドを型定義に追加 |
| allow 属性の方針 | 記載なし | 最小権限（3 種のみ）を明示 |
