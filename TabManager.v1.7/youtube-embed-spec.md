# YouTube 埋め込み機能 実装設計書

> **対象**: TabManager.v1.4 — ワークスペース機能への追加  
> 前提: ワークスペース保存機能（v2）が実装済みであること

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

### なぜこの機能が必要か

「後でこの動画を見たい」は「タブを開き続ける理由」の典型例の一つ。  
現状はブックマークか開いたままにしておくかしか手段がない。  
ワークスペースにサムネイル付きで保存できれば、タブを閉じてもリストに残り、  
見たいときにパネル内でその場再生できるため、タブ枚数削減に直結する。

---

## 2. 実装技術の方針

### 2.1 YouTube URL の判定と動画 ID 抽出

YouTube の URL 形式は複数あるため、すべてのパターンを `URL` オブジェクトでパースして対応する。

```
対応パターン:
  https://www.youtube.com/watch?v=XXXXXXXXXXX    ← 通常
  https://youtu.be/XXXXXXXXXXX                   ← 短縮
  https://www.youtube.com/embed/XXXXXXXXXXX      ← 埋め込み済み URL
  https://www.youtube.com/shorts/XXXXXXXXXXX     ← Shorts
  https://m.youtube.com/watch?v=XXXXXXXXXXX      ← モバイル版
```

```js
// panel.js に追加
function extractYoutubeVideoId(text) {
  if (!text) return null;
  // テキスト全体が URL のみの場合のみ埋め込み対象にする
  const trimmed = text.trim();
  try {
    const u = new URL(trimmed);
    const host = u.hostname.replace(/^m\./, '').replace(/^www\./, '');

    if (host === 'youtube.com') {
      // 通常 watch URL
      if (u.pathname === '/watch') {
        return u.searchParams.get('v') || null;
      }
      // Shorts
      const shortsMatch = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) return shortsMatch[1];
      // 既に埋め込み URL
      const embedMatch = u.pathname.match(/^\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embedMatch) return embedMatch[1];
    }

    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('?')[0];
      return id.length === 11 ? id : null;
    }
  } catch {
    // URL パース失敗は無視（通常テキストとして扱う）
  }
  return null;
}
```

### 2.2 表示方式：クリック展開（Lazy iframe）

`<iframe>` を初期表示から生成する方式は採用しない。  
**サムネイル画像を表示し、クリックしたときに初めて `<iframe>` を生成する**方式を採る。

```
初期状態:
  [サムネイル img]          ← https://img.youtube.com/vi/{ID}/mqdefault.jpg
  [再生ボタン SVG オーバーレイ]

クリック後:
  [YouTube <iframe>]        ← autoplay=1 で即再生開始
```

この方式を選ぶ理由:
- iframe はブラウザ内で独立したレンダリングコンテキストを持つ。  
  初期表示から全件生成すると件数 × 50〜150 MB のメモリを消費する
- サムネイルは `<img>` の `loading="lazy"` で画面外は読み込まない
- クリックという明示的な意図があって初めてリソースを消費する

### 2.3 同時展開の制限

複数の動画を同時に展開したままにすることを防ぐため、  
**展開は常に 1 件のみ** とする。別のカードで再生ボタンをクリックすると、  
現在展開中の iframe をサムネイル状態に戻してから新しいものを展開する。

```js
let activeYoutubeCardEl = null;   // 現在展開中のカード DOM 要素への参照

function deactivateCurrentYoutubeEmbed() {
  if (!activeYoutubeCardEl) return;
  const wrapper = activeYoutubeCardEl.querySelector('.workspace-card__youtube');
  if (!wrapper) return;
  const videoId = wrapper.dataset.videoId;
  const title   = wrapper.dataset.title;
  if (videoId) renderYoutubeThumbnail(wrapper, videoId, title);
  activeYoutubeCardEl = null;
}
```

### 2.4 manifest.json の CSP 修正

現在の CSP は `frame-src` の指定がなくデフォルトで `'self'` のみ許可されており、  
YouTube の iframe を表示できない。`frame-src` に YouTube ドメインを追加する。

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; frame-src https://www.youtube.com"
}
```

> **なぜ `sandbox` 属性を付与しないか**  
> 既存の previewOverlay の `<iframe>` は `allow-same-origin` のみの sandbox を付与しているが、  
> YouTube プレイヤーは JavaScript を必要とするため `allow-scripts` が必要。  
> しかし `allow-scripts` と `allow-same-origin` を同時に指定すると  
> サンドボックスを事実上無効にするリスクがある（セキュリティ上の既知の問題）。  
> YouTube のドメインは CSP の `frame-src` で制限できているため、  
> sandbox を付与せず `allow` 属性だけで制御する。

### 2.5 カード種別の追加

現在の `WorkspaceItem.type` は `'text' | 'image'` の 2 値。  
YouTube 埋め込みカードは `type === 'text'` のまま扱い、  
**表示時に URL を解析して自動判定**する方針とする。

これにより:
- 保存側（background.js）の変更が不要
- 将来の「保存時に type を判定して `'youtube'` として保存」への移行も容易

---

## 3. 性能と技術的制約の考慮点

### 3.1 iframe のメモリコスト

| 状態 | コスト |
|---|---|
| サムネイル表示（img） | 約 10〜20 KB（サムネイル画像 1 枚）|
| iframe 展開後（再生中） | 約 50〜150 MB（YouTube JS エンジン含む） |
| 同時展開 3 件 | 150〜450 MB、パネルが重くなる可能性大 |

**クリック展開 + 同時展開 1 件制限で実質的に無害化できる。**

### 3.2 パネルの入れ子 iframe 問題

現在のパネルは `content.js` が Web ページ上に生成した `<iframe>` の中に  
`panel.html` が読み込まれる構造になっている（`panel.html` 自体が iframe の中にいる）。

YouTube の `<iframe>` をその中にさらに生成すると入れ子が 2 段になる。

```
[Webページ]
  └─ <iframe id="tmx-tab-manager-panel">   ← content.js が生成
       └─ panel.html
            └─ workspace-view
                 └─ <iframe src="youtube.com/embed/...">   ← 今回追加
```

これ自体は Chrome の仕様上問題なく動作するが、  
`frame-src` CSP の制約が panel.html 単体（拡張機能ページ）に対して適用されることに注意する。  
Web ページの CSP ではなく、拡張機能の CSP が適用されるため、  
manifest.json の修正で完結する。

### 3.3 パネル幅（400px）の制約

デフォルトのパネル幅 400px では YouTube プレイヤーの最小推奨幅（480px）を下回る。  
実際には縮小されて表示されるが、操作性が低下する。

対策の選択肢:
- **展開ビュー（全画面）有効時のみ埋め込みを有効にする**（推奨）
- カード内でのみアスペクト比 16:9 を守った高さに自動調整する
- クリックで YouTube を別タブで開くリンクを表示する（埋め込みなし）

### 3.4 サムネイル取得と CORS

YouTube のサムネイル URL（`img.youtube.com`）は外部リソース。  
現在の CSP には `img-src` の指定がないが、  
拡張機能ページのデフォルトは `img-src 'self'` ではなく広範囲を許可するため、  
`<img>` での取得は追加設定なしで動作する。  
ただし将来 `img-src` を明示的に制限する場合は `img-src https://img.youtube.com` の追加が必要。

### 3.5 autoplay ポリシー

ユーザーがクリックした直後に `iframe.src` を設定すれば  
「ユーザーインタラクション起点」とブラウザが判定するため autoplay が許可される。  
`addEventListener('click', ...)` の直接ハンドラ内で iframe を生成する限り問題ない。

---

## 4. さらに検討の余地がある課題

### 4.1 URL の保存方法（type 判定のタイミング）

現状: 保存時は `type: 'text'` で保存、表示時に URL を解析して YouTube と判定する  
代替案: 保存時に `type: 'youtube'`・`videoId` フィールドを付与して IndexedDB に保存する

| 方式 | メリット | デメリット |
|---|---|---|
| 表示時判定（現状） | 保存側変更不要・型の追加なし | 毎回パースが走る（軽微） |
| 保存時判定 | IndexedDB でフィルタリング可能 | background.js に YouTube 判定ロジックが入る |

件数が数十件程度であれば表示時判定で問題ない。  
グループ機能や検索機能を実装する段階で保存時判定への移行を検討する。

### 4.2 Shorts への対応

YouTube Shorts は縦長（9:16）のアスペクト比であり、  
横長（16:9）のカード内に埋め込むと表示が崩れる。  
videoId から Shorts か通常動画かを URL のみで判別することはできないため、  
YouTube oEmbed API や Data API を使って動画メタデータを取得しない限り  
事前判別は困難。

Phase 1 での推奨: Shorts も通常通り 16:9 で表示（画面の端がクロップされる）  
Phase 2 での対応: oEmbed レスポンスから `type: 'video'` の `thumbnail_width/height` 比で判定

### 4.3 oEmbed API による動画タイトルの取得

現在の保存フローでは `pageTitle` にページのタイトルが入る。  
YouTube の動画ページであれば動画タイトルがそのまま入るが、  
URL だけをテキストとして保存した場合はタイトルが空になる。

YouTube oEmbed API（認証不要・無料）でタイトルとサムネイルを取得できる。

```
GET https://www.youtube.com/oembed?url={encodedUrl}&format=json

レスポンス例:
{
  "title": "動画タイトル",
  "thumbnail_url": "https://i.ytimg.com/vi/XXXX/hqdefault.jpg",
  "author_name": "チャンネル名",
  ...
}
```

**ただし background.js（Service Worker）からのフェッチは可能だが、  
保存時に毎回 oEmbed を叩く設計は「保存の摩擦を増やす」方向になる。**  
ユーザーが展開ボタンをクリックしたタイミングで初めて取得する  
遅延フェッチが UX 上は優れている。

### 4.4 展開ビュー（全画面）時の挙動

展開ビューでは各ウィンドウが横並びのカラム表示になり、  
カラム幅が 300〜380px に制限される。  
YouTube のカードが展開ビュー側にも表示される場合は、  
カラム幅に合わせてプレイヤー高さを計算する必要がある。

Phase 1 での推奨: 展開ビュー中は埋め込みを無効化し「YouTube で開く」リンクを表示する

### 4.5 再生終了後の状態管理

動画の再生が終わると YouTube プレイヤーは関連動画を表示する。  
iframe がそのまま残るため、再生後に「閉じる」操作をする手段が必要。

推奨する対応: カード右上の削除ボタンとは別に「✕ 閉じる（サムネイルに戻す）」ボタンを  
iframe 展開時のみ表示し、クリックでサムネイルに戻す。

---

## 5. 具体的な実装スクリプト例

### 5.1 manifest.json — CSP に frame-src を追加

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; frame-src https://www.youtube.com"
}
```

---

### 5.2 panel.js — YouTube 判定・埋め込み生成関数群

```js
// ── YouTube 埋め込み：定数 ──────────────────────────────────────────
const YOUTUBE_THUMB_BASE = 'https://img.youtube.com/vi';

// 現在展開中のカード要素への参照（同時展開 1 件制限）
let activeYoutubeCardEl = null;

// ── YouTube URL から動画 ID を抽出 ────────────────────────────────
// テキスト全体が URL 文字列のみの場合のみ対象にする。
// 混在テキスト（例："おすすめ動画 https://youtu.be/..."）は通常テキストとして扱う。
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
        return u.searchParams.get('v') || null;
      }
      const shortsMatch = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) return shortsMatch[1];
      const embedMatch  = u.pathname.match(/^\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embedMatch)  return embedMatch[1];
    }

    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('?')[0];
      return (id.length === 11) ? id : null;
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
  thumb.onerror   = () => {
    // サムネイル取得失敗時は低解像度版にフォールバック
    thumb.src = `${YOUTUBE_THUMB_BASE}/${videoId}/default.jpg`;
  };

  const overlay     = document.createElement('div');
  overlay.className = 'workspace-card__youtube-overlay';

  const playBtn     = document.createElement('div');
  playBtn.className = 'workspace-card__youtube-play';
  playBtn.innerHTML = `
    <svg viewBox="0 0 68 48" width="68" height="48" xmlns="http://www.w3.org/2000/svg">
      <path d="M66.52 7.74C65.7 4.56 63.2 2.06 60.02 1.24 54.8 0 34 0 34 0S13.2 0 7.98 1.24C4.8 2.06 2.3 4.56 1.48 7.74 0 13.24 0 24 0 24s0 10.76 1.48 16.26C2.3 43.44 4.8 45.94 7.98 46.76 13.2 48 34 48 34 48s20.8 0 26.02-1.24c3.18-.82 5.68-3.32 6.5-6.5C68 34.76 68 24 68 24s0-10.76-1.48-16.26z" fill="#ff0000"/>
      <path d="M27 34.5l18-10.5-18-10.5z" fill="#fff"/>
    </svg>
  `;

  overlay.appendChild(playBtn);
  wrapper.appendChild(thumb);
  wrapper.appendChild(overlay);

  // クリックで iframe 展開（{ once: true } で一度だけ発火）
  wrapper.addEventListener('click', () => activateYoutubeEmbed(wrapper, videoId, title), { once: true });
}

// ── iframe 展開状態に切り替える ──────────────────────────────────
function activateYoutubeEmbed(wrapper, videoId, title) {
  // 既に展開中の別カードをサムネイルに戻す
  if (activeYoutubeCardEl && activeYoutubeCardEl !== wrapper.closest('.workspace-card')) {
    const prevWrapper = activeYoutubeCardEl.querySelector('.workspace-card__youtube');
    if (prevWrapper) {
      const prevId    = prevWrapper.dataset.videoId;
      const prevTitle = prevWrapper.dataset.title;
      renderYoutubeThumbnail(prevWrapper, prevId, prevTitle);
    }
  }

  wrapper.innerHTML = '';

  // 「閉じる」ボタン
  const closeBtn     = document.createElement('button');
  closeBtn.className = 'workspace-card__youtube-close';
  closeBtn.type      = 'button';
  closeBtn.title     = 'サムネイルに戻す';
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
  // autoplay=1: ユーザーのクリック直後のため許可される
  iframe.src             = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`;
  iframe.title           = title || 'YouTube';
  iframe.allow           = 'autoplay; encrypted-media; picture-in-picture';
  iframe.allowFullscreen = true;
  // sandbox は意図的に付与しない（理由: 5.2 節の注釈参照）

  wrapper.appendChild(closeBtn);
  wrapper.appendChild(iframe);

  activeYoutubeCardEl = wrapper.closest('.workspace-card');
}

// ── YouTube カードの wrapper を生成 ──────────────────────────────
function createYoutubeEmbed(videoId, title) {
  const wrapper     = document.createElement('div');
  wrapper.className = 'workspace-card__youtube';
  // data 属性に videoId・title を保持（サムネイル再生成時に参照）
  wrapper.dataset.videoId = videoId;
  wrapper.dataset.title   = title || '';

  renderYoutubeThumbnail(wrapper, videoId, title);
  return wrapper;
}
```

`createWorkspaceCard` 内での利用箇所（変更部分のみ）:

```js
// type === 'text' の処理を差し替える
if (item.type === 'text' && item.text) {
  const videoId = extractYoutubeVideoId(item.text);

  if (videoId) {
    // YouTube URL → 埋め込みカード
    card.appendChild(createYoutubeEmbed(videoId, item.pageTitle));
  } else {
    // 通常テキスト → 既存の表示
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

/* サムネイル・iframe の共通コンテナ */
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

/* サムネイル画像 */
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

/* 再生ボタンオーバーレイ */
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

/* YouTube <iframe> */
.workspace-card__youtube-frame {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}

/* 「閉じる」ボタン（iframe 展開時のみ表示） */
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

## 6. v1 実装スコープの整理

| 項目 | Phase 1（今回） | Phase 2（将来） |
|---|---|---|
| URL 判定 | 表示時にテキストをパース | 保存時に `type: 'youtube'` で保存 |
| サムネイル | YouTube サムネイル URL から `<img>` で表示 | oEmbed で高解像度取得・タイトル補完 |
| 再生 | クリックで iframe 展開・同時 1 件制限 | 展開ビュー対応・Shorts 縦長対応 |
| パネル幅問題 | 400px 内で 16:9 表示（小さいが動作する） | 展開ビュー時のみ有効化 |
| Shorts | 16:9 でクロップ表示 | アスペクト比自動切り替え |
| エラー処理 | サムネイル失敗時に低解像度版にフォールバック | oEmbed 失敗時の通知 |

