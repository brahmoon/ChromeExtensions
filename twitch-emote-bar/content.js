// content.js - Twitch Emote Bar

let emoteObserver = null;
let lastCollectedEmotes = [];
let collectDebounceTimer = null;

// ===== エモート収集 =====

function extractEmotesFromPicker() {
  const tabContent = document.querySelector('.emote-picker__tab-content');
  if (!tabContent) return [];

  const emotes = [];
  const seen = new Set();

  const images = tabContent.querySelectorAll('img.emote-picker__image');
  images.forEach(img => {
    const emoteId = (img.getAttribute('alt') || '').trim();
    if (!emoteId || seen.has(emoteId)) return;

    // srcsetから2.0xの画像URLを取得
    let imageUrl = '';
    const srcset = img.getAttribute('srcset') || '';
    const srcsetParts = srcset.split(',').map(s => s.trim());
    for (const part of srcsetParts) {
      if (part.includes('2.0')) {
        imageUrl = part.split(' ')[0];
        break;
      }
    }

    // fallback: srcから取得してパスを2.0に変換
    if (!imageUrl) {
      const src = img.getAttribute('src') || '';
      imageUrl = src.replace(/\/1\.0$/, '/2.0');
    }

    if (!imageUrl) return;

    seen.add(emoteId);
    emotes.push({ emoteId, imageUrl });
  });

  return emotes;
}

function collectAndSendEmotes() {
  const emotes = extractEmotesFromPicker();
  if (emotes.length === 0) return;

  // 前回と同じなら送らない
  const signature = emotes.map(e => e.emoteId).join(',');
  const lastSignature = lastCollectedEmotes.map(e => e.emoteId).join(',');
  if (signature === lastSignature) return;

  lastCollectedEmotes = emotes;

  chrome.runtime.sendMessage({ action: 'emotesCollected', emotes });
}

function scheduleCollect() {
  clearTimeout(collectDebounceTimer);
  collectDebounceTimer = setTimeout(collectAndSendEmotes, 300);
}

// エモートピッカーの出現を監視
function observeEmotePicker() {
  emoteObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // emote-picker__tab-content が追加 or その中に img が追加された
        if (
          node.classList && node.classList.contains('emote-picker__tab-content') ||
          node.querySelector && node.querySelector('.emote-picker__tab-content')
        ) {
          scheduleCollect();
        }
      }

      // 既存ノード内の変化（タブ切り替えなど）
      if (
        mutation.target &&
        mutation.target.closest &&
        mutation.target.closest('.emote-picker__tab-content')
      ) {
        scheduleCollect();
      }
    }
  });

  emoteObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// ===== チャット入力 =====

function dispatchKeyEvent(chatInput, key, code, keyCode) {
  ['keydown', 'keypress', 'keyup'].forEach(type => {
    chatInput.dispatchEvent(new KeyboardEvent(type, {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    }));
  });
}

function doInsert(chatInput, emoteId) {
  const text = `:${emoteId}`;

  // beforeinput → input の順でSlateに通知
  const beforeInput = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text,
  });
  chatInput.dispatchEvent(beforeInput);

  if (!beforeInput.defaultPrevented) {
    chatInput.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));
  }

  // オートコンプリート候補の出現を待ってからTabで確定する。
  // Twitchは候補を role="status" の子要素として非同期で描画するため、
  // その出現を MutationObserver で検知してからTabを発火する。
  const statusEl =
    chatInput.closest('.chat-input__textarea')
      ?.parentElement?.querySelector('[role="status"]') ??
    document.querySelector('[role="status"]');

  let tabFired = false;

  function fireTab() {
    if (tabFired) return;
    tabFired = true;
    dispatchKeyEvent(chatInput, 'Tab', 'Tab', 9);
  }

  if (statusEl) {
    const acObserver = new MutationObserver(() => {
      // emote-autocomplete-provider__image が出現したら候補が揃った合図
      if (statusEl.querySelector('.emote-autocomplete-provider__image')) {
        acObserver.disconnect();
        fireTab();
      }
    });
    acObserver.observe(statusEl, { childList: true, subtree: true });

    // 候補が来なくても最大500msでタイムアウト送信
    setTimeout(() => {
      acObserver.disconnect();
      fireTab();
    }, 500);
  } else {
    // statusEl が見つからない場合は固定遅延
    setTimeout(fireTab, 100);
  }
}

function insertEmoteToChat(emoteId) {
  const chatInput =
    document.querySelector('[data-slate-editor="true"][contenteditable="true"]') ||
    document.querySelector('.chat-wysiwyg-input__editor[contenteditable="true"]');

  if (!chatInput) {
    console.warn('[EmoteBar] Slate chat input not found');
    return;
  }

  // すでにSlateのフォーカス状態（focus-visible）があればそのまま挿入
  if (chatInput.classList.contains('focus-visible')) {
    doInsert(chatInput, emoteId);
    return;
  }

  // フォーカスがない場合：focusin → focus イベントを順に発火してSlateを起動する
  chatInput.dispatchEvent(new FocusEvent('focusin', { bubbles: true, cancelable: false }));
  chatInput.focus();
  chatInput.dispatchEvent(new FocusEvent('focus', { bubbles: false, cancelable: false }));

  // focus-visible クラスが付与されるのを待ってから挿入
  // Slateの内部処理完了を MutationObserver で検知する
  const observer = new MutationObserver((mutations, obs) => {
    for (const mutation of mutations) {
      if (
        mutation.type === 'attributes' &&
        mutation.attributeName === 'class' &&
        chatInput.classList.contains('focus-visible')
      ) {
        obs.disconnect();
        doInsert(chatInput, emoteId);
        return;
      }
    }
  });

  observer.observe(chatInput, { attributes: true, attributeFilter: ['class'] });

  // 最大200ms待ってもfocus-visibleが来なければタイムアウトして強制挿入
  setTimeout(() => {
    observer.disconnect();
    doInsert(chatInput, emoteId);
  }, 200);
}

// ===== メッセージリスナー =====

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'insertEmoteToChat') {
    insertEmoteToChat(message.emoteId);
    sendResponse({ ok: true });
  }

  if (message.action === 'requestEmotes') {
    const emotes = extractEmotesFromPicker();
    sendResponse({ emotes });
  }

  return true;
});

// ===== 初期化 =====
observeEmotePicker();

// ページロード後に既に開いているピッカーがあれば取得
setTimeout(collectAndSendEmotes, 1500);
