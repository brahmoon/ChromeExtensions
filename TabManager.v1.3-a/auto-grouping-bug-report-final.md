# 自働ドメイングループ化 停止バグ 最終修正方針書

## 対象ファイル
- `background.js`

## 前提・注意事項

本方針書は複数AIによる静的コード解析と相互レビューを経て統合した内容です。
実際の停止経路は実機ログによる実証を経ていないため、修正適用後に再発がないことをもって確認とします。
本修正は「設計的に停止経路を塞ぐ」防衛的設計であり、修正の3点セットはすべて適用してください。

---

## 停止バグの全体像

| 分類 | 原因 | 発生タイミング | 影響範囲 | 優先度 |
|------|------|---------------|---------|--------|
| 🔴 主因 | 原因B：リトライ責務の二重実装によるロック残留 | タブドラッグ中（日常操作） | 特定タブから蓄積的に停止 | 必須 |
| 🟡 伏兵 | 原因A：並列初期化レースによる `false` 焼き付き | SW再起動時（MV3環境） | 全ウィンドウが同時停止 | 必須 |
| 🔵 補強 | 原因C：`finally` 保証の不明確さによる潜在ロック残留 | 想定外例外・API変更時 | 原因Bと同様 | 必須 |

「しばらく使うと止まる・トグルで復帰する」という症状は、原因Bと原因Cが蓄積型として主に一致する。
原因Aは発生すると全体が止まるため視認性が高い。

---

## 修正1：初期化の直列化（原因A の対策）

### 問題箇所（138〜140行）

```js
// 現在：3つが並列実行される
loadAutoDomainGroupingPreference().catch(() => {});
warmWindowAutoGroupingStateCache().catch(() => {});
warmTabGroupIdCache().catch(() => {});
```

### 問題のメカニズム

`autoDomainGroupingEnabled` のグローバル初期値は `false`。
`loadAutoDomainGroupingPreference()` の完了を待たずに `warmWindowAutoGroupingStateCache()` が走ると、
全ウィンドウに `false` が書き込まれて固定される。

```js
// warmWindowAutoGroupingStateCache 内部
for (const win of windows) {
  setWindowAutoGroupingState(win.id, autoDomainGroupingEnabled); // まだ false のまま焼き付く
}
```

`getWindowAutoGroupingState()` はウィンドウエントリが存在する場合グローバル値を無視するため、
その後 `autoDomainGroupingEnabled` が `true` になっても全ウィンドウで `false` を返し続ける。

```js
function getWindowAutoGroupingState(windowId) {
  if (windowAutoDomainGroupingState.has(windowId)) {
    return Boolean(windowAutoDomainGroupingState.get(windowId)); // false を返し続ける
  }
  return autoDomainGroupingEnabled;
}
```

結果として `autoGroupTabByDomainCore` の冒頭ガードで常に `return` される。

### 修正内容

138〜140行を削除し、以下の直列初期化に置き換える。

```js
// 修正後：設定読み込みを最初に完了させてからウィンドウ状態を初期化する
async function initializeAutoGroupingRuntimeState() {
  await loadAutoDomainGroupingPreference();   // 1. 必ず最初：正しい設定値を確定する
  await warmWindowAutoGroupingStateCache();    // 2. 確定した値でウィンドウ状態を初期化する
  await warmTabGroupIdCache();                // 3. タブグループキャッシュを初期化する
}

initializeAutoGroupingRuntimeState().catch((error) => {
  console.error('Failed to initialize auto grouping runtime state:', error);
});
```

---

## 修正2：リトライ責務の一本化（原因B の対策）

### 問題箇所

**`autoGroupTabByDomainCore` の catch ブロック（1682〜1694行）：**

```js
// 現在：catch 内から autoGroupTabByDomain を直接再呼び出ししている
} catch (error) {
  if (isTransientTabEditError(error) && Number.isFinite(tab?.id)) {
    autoGroupingPendingTabIds.add(tab.id);
    setTimeout(() => {                    // ← 問題：外側 while ループと二重にリトライを担う
      chrome.tabs.get(tab.id)
        .then((freshTab) => {
          if (freshTab) {
            autoGroupTabByDomain(freshTab, { requireActiveContext: false }).catch(() => {});
          }
        })
        .catch(() => {});
    }, 180);
    return;
  }
  console.debug('Failed to auto group tab by domain:', error);
}
```

**`autoGroupTabByDomain` の while ループ（1715〜1731行）：**

```js
// 現在：遅延なしで即座に再試行する
while (true) {
  autoGroupingPendingTabIds.delete(tabId);
  await autoGroupTabByDomainCore(currentTab, options); // ← core のエラーが素通りする

  if (!autoGroupingPendingTabIds.has(tabId)) {
    break;
  }
  // ← 遅延なし：ドラッグ中に即再試行して再びエラーになる
  try {
    const refreshed = await chrome.tabs.get(tabId);
    if (refreshed) currentTab = refreshed;
  } catch (error) {
    break;
  }
}
```

### 問題のメカニズム

`autoGroupTabByDomain`（外側）と `autoGroupTabByDomainCore`（内側）の両方がリトライ責務を持ち、互いに干渉する。

競合の発生シナリオ：
1. `autoGroupingInFlightTabIds.add(tabId)` でロック取得
2. `core` 内でドラッグ中エラー → catch で `pending.add` + `setTimeout` セット + `return`
3. 外側 `while` が `pending` を検知して即座に再ループ → ドラッグ中なので再びエラー
4. 180ms後、`setTimeout` から `autoGroupTabByDomain` が呼ばれる
   - `while` がまだ動いていれば → `inFlight` ブロックで `pending.add` だけして `return` → 握り潰し
   - `while` が終了していれば → 二重実行で `chrome.tabs.group` 競合
5. 最悪ケースで `pending` フラグ残留 or ロック残留が発生する

### 修正内容

**`autoGroupTabByDomainCore` の catch ブロック（1682〜1694行）：`setTimeout` ブロック全体を削除する**

```js
// 修正後：pending フラグを立てるだけ。再実行は外側 while ループが一元的に担う
} catch (error) {
  if (isTransientTabEditError(error) && Number.isFinite(tab?.id)) {
    autoGroupingPendingTabIds.add(tab.id); // フラグのみ。setTimeout による再呼び出しは削除
    return;
  }
  throw error; // transient 以外は握り潰さず外へ伝播させる（修正3と連動）
}
```

> ⚠️ `console.debug` での握り潰しも削除し `throw error` に変更する。これにより `finally` でのロック解除が保証される（修正3と連動）。

**`autoGroupTabByDomain` の while ループに遅延を追加：**

```js
// 修正後：pending フラグが立っている場合は遅延を挟んでから再試行する
while (true) {
  autoGroupingPendingTabIds.delete(tabId);

  try {
    await autoGroupTabByDomainCore(currentTab, options);
  } catch (error) {
    if (isTransientTabEditError(error)) {
      autoGroupingPendingTabIds.add(tabId); // pending を立てて再試行へ
    } else {
      throw error; // 致命的エラーは外へ伝播させ finally でロック解除を保証
    }
  }

  if (!autoGroupingPendingTabIds.has(tabId)) {
    break;
  }

  // ドラッグ終了を待ってから再試行する
  await new Promise((resolve) => setTimeout(resolve, 200));

  try {
    const refreshed = await chrome.tabs.get(tabId);
    if (refreshed) currentTab = refreshed;
  } catch {
    break; // タブが閉じられた場合は明示的にループ終了
  }
}
```

---

## 修正3：`finally` によるロック解除の絶対保証（原因C の対策）

### 問題箇所

現行コードにも `finally` は存在するが、`autoGroupTabByDomainCore` 内でエラーが `console.debug` で握り潰されて `return` されるため、外側の `finally` に到達する経路が不明確だった。

修正2で `throw error` を導入することにより `finally` への到達が確実になるが、
`autoGroupTabByDomain` 全体の構造を以下の形に明示的に整理する。

### 修正内容

`autoGroupTabByDomain` 関数全体を以下の構造に置き換える（1700〜1736行）：

```js
async function autoGroupTabByDomain(tab, options = {}) {
  if (!tab || !Number.isFinite(tab.id)) {
    return;
  }

  const tabId = tab.id;

  if (autoGroupingInFlightTabIds.has(tabId)) {
    autoGroupingPendingTabIds.add(tabId);
    return;
  }

  autoGroupingInFlightTabIds.add(tabId);
  let currentTab = tab;

  try {
    while (true) {
      autoGroupingPendingTabIds.delete(tabId);

      try {
        await autoGroupTabByDomainCore(currentTab, options);
      } catch (error) {
        if (isTransientTabEditError(error)) {
          autoGroupingPendingTabIds.add(tabId); // pending を立てて再試行へ
        } else {
          throw error; // 致命的エラーは外へ伝播させ finally でロック解除を保証
        }
      }

      if (!autoGroupingPendingTabIds.has(tabId)) {
        break;
      }

      // ドラッグ終了を待ってから再試行する
      await new Promise((resolve) => setTimeout(resolve, 200));

      try {
        const refreshed = await chrome.tabs.get(tabId);
        if (refreshed) currentTab = refreshed;
      } catch {
        break; // タブが閉じられた場合は明示的にループ終了
      }
    }
  } finally {
    // ★ 何が起きても必ずロックを解除する
    // 例外・競合・想定外エラー・API変更のいずれの経路でも保証される
    autoGroupingPendingTabIds.delete(tabId);
    autoGroupingInFlightTabIds.delete(tabId);
  }
}
```

### この構造が保証すること

| 経路 | 旧実装 | 新実装 |
|------|--------|--------|
| 正常完了 | ロック解除される | ロック解除される |
| transient エラー | pending 残留の可能性あり | 再試行後に必ず解除される |
| 致命的エラー | `console.debug` で握り潰し・ロック残留 | `throw` → `finally` で必ず解除される |
| Chrome API 変更等の想定外 | ロック残留の可能性あり | `finally` で必ず解除される |

---

## `autoGroupTabByDomainCore` の catch ブロック修正（再掲・整合確認用）

修正2・3と連動して、`autoGroupTabByDomainCore` の catch ブロック（1682〜1698行付近）を以下に変更する。

```js
// 修正後の autoGroupTabByDomainCore の末尾 catch ブロック
  } catch (error) {
    if (isTransientTabEditError(error) && Number.isFinite(tab?.id)) {
      // pending フラグのみ立てる。setTimeout による再呼び出しは削除。
      // 再試行は呼び出し元 autoGroupTabByDomain の while ループが一元的に担う。
      autoGroupingPendingTabIds.add(tab.id);
      return;
    }
    // transient 以外は throw して呼び出し元の finally でロック解除を保証する
    throw error;
  }
```

---

## 修正箇所サマリー

| 修正 | 対象 | 変更内容 | 行番号（参考） |
|------|------|---------|--------------|
| 1 | 初期化の直列化 | 3行の並列呼び出しを `initializeAutoGroupingRuntimeState()` に集約 | 138〜140行 |
| 2a | `autoGroupTabByDomainCore` の catch | `setTimeout` ブロック全体を削除。`console.debug` を `throw error` に変更 | 1682〜1694行 |
| 2b | `autoGroupTabByDomain` の while ループ | `core` 呼び出しを内側 `try...catch` でラップ。`await delay(200)` を追加 | 1715〜1731行 |
| 3 | `autoGroupTabByDomain` 全体構造 | 外側 `try...finally` を明確化し、`finally` でのロック解除を絶対保証 | 1700〜1736行 |

---

## 修正適用上の注意点

- 修正1・2・3はセットで適用すること。個別適用では設計の整合性が崩れる。
- `autoGroupTabByDomain` の `while` ループに追加する遅延値は `200` ms とする。既存の `setTimeout(..., 180)` より若干長めにしてドラッグ操作の完了を確実に待つ。
- `autoGroupTabByDomainCore` から `throw error` する際、呼び出し元の `autoGroupTabByDomain` が `finally` を持っているため、`inFlight` のロック解除は必ず実行される。
- `chrome.tabs.get` の失敗（タブが閉じられた場合）は `break` で明示的にループを終了させ、`finally` でロックを解除する。これは `throw` ではなく `break` が正しい（タブの消滅は異常ではなく想定内の終了条件）。
- 修正後も「停止が再発した場合」に備え、`autoGroupingInFlightTabIds.size` と `autoGroupingPendingTabIds.size` をログ出力できるデバッグコードを一時的に仕込んで確認することを推奨する。
