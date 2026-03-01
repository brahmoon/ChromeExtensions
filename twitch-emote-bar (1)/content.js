// content.js - Twitch Emote Bar v2

let emoteObserver = null;
let collectDebounceTimer = null;
const lastSentSignatures = {};

// ===== エモート収集（チャンネル単位） =====

function extractEmotesByChannel() {
  const channelMap = {};

  // class="gnuxAP" を持つ <strong> をセクションヘッダーとして使用。
  // gnuxAP は動的クラスのため、より安定した CoreText クラスとの組み合わせで取得する。
  // フォールバックとして gnuxAP 単体も試みる。
  const headerEls = document.querySelectorAll(
    'strong.gnuxAP, strong[class*="gnuxAP"]'
  );

  headerEls.forEach(headerEl => {
    const sectionName = (headerEl.textContent || '').trim();
    if (!sectionName) return;

    // ヘッダー要素から最も近い「エモートグリッドを含むブロック」を探す。
    // strong → ... → emote-picker__content-block（もしくは相当する祖先）配下の emote-grid を対象にする。
    // strong の祖先を遡り emote-grid の兄弟ノードを持つ共通祖先まで辿る。
    let container = headerEl.parentElement;
    let emoteGrid = null;
    while (container && container !== document.body) {
      emoteGrid = container.querySelector('.emote-grid');
      if (emoteGrid) break;
      container = container.parentElement;
    }
    if (!emoteGrid) return;

    const emotes = [];
    const seen = new Set();

    emoteGrid.querySelectorAll('img.emote-picker__image').forEach(img => {
      const emoteId = (img.getAttribute('alt') || '').trim();
      if (!emoteId || seen.has(emoteId)) return;

      let imageUrl = '';
      for (const part of (img.getAttribute('srcset') || '').split(',').map(s => s.trim())) {
        if (part.includes('2.0')) { imageUrl = part.split(' ')[0]; break; }
      }
      if (!imageUrl) imageUrl = (img.getAttribute('src') || '').replace(/\/1\.0$/, '/2.0');
      if (!imageUrl) return;

      seen.add(emoteId);
      emotes.push({ emoteId, imageUrl });
    });

    if (emotes.length > 0) {
      // 同名セクションが複数ある場合（タブ切り替えで重複等）は末尾に連番を付与
      let key = sectionName;
      if (channelMap[key]) {
        let i = 2;
        while (channelMap[`${sectionName} (${i})`]) i++;
        key = `${sectionName} (${i})`;
      }
      channelMap[key] = emotes;
    }
  });

  return channelMap;
}

function collectAndSend() {
  const channelMap = extractEmotesByChannel();
  if (Object.keys(channelMap).length === 0) return;

  let hasChange = false;
  for (const [ch, emotes] of Object.entries(channelMap)) {
    const sig = emotes.map(e => e.emoteId).join(',');
    if (lastSentSignatures[ch] !== sig) { lastSentSignatures[ch] = sig; hasChange = true; }
  }
  if (!hasChange) return;

  chrome.runtime.sendMessage({ action: 'emotesCollected', channelMap });
}

function scheduleCollect() {
  clearTimeout(collectDebounceTimer);
  collectDebounceTimer = setTimeout(collectAndSend, 400);
}

// ===== エモートピッカー監視 =====

function observeEmotePicker() {
  emoteObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        // gnuxAP クラスの strong、emote-grid、emote-picker__tab-content が追加されたら収集
        if (
          node.querySelector?.('strong.gnuxAP, strong[class*="gnuxAP"]') ||
          node.querySelector?.('.emote-grid') ||
          node.classList?.contains('emote-grid') ||
          node.classList?.contains('emote-picker__tab-content') ||
          node.querySelector?.('.emote-picker__tab-content')
        ) { scheduleCollect(); }
      }
      // 既存ノード内の変化（タブ切り替えによる emote-grid の中身更新など）
      if (mutation.target?.closest?.('.emote-grid') ||
          mutation.target?.closest?.('.emote-picker__tab-content')) {
        scheduleCollect();
      }
    }
  });
  emoteObserver.observe(document.body, { childList: true, subtree: true });
}

// ===== チャット入力 =====

function dispatchKeyEvent(el, key, code, keyCode) {
  ['keydown', 'keypress', 'keyup'].forEach(type =>
    el.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }))
  );
}

function doInsert(chatInput, emoteId) {
  const text = `:${emoteId}`;
  const bi = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text });
  chatInput.dispatchEvent(bi);
  if (!bi.defaultPrevented)
    chatInput.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));

  const statusEl =
    chatInput.closest('.chat-input__textarea')?.parentElement?.querySelector('[role="status"]') ??
    document.querySelector('[role="status"]');

  let tabFired = false;
  function fireTab() { if (tabFired) return; tabFired = true; dispatchKeyEvent(chatInput, 'Tab', 'Tab', 9); }

  if (statusEl) {
    const obs = new MutationObserver(() => {
      if (statusEl.querySelector('.emote-autocomplete-provider__image')) { obs.disconnect(); fireTab(); }
    });
    obs.observe(statusEl, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); fireTab(); }, 500);
  } else {
    setTimeout(fireTab, 100);
  }
}

function insertEmoteToChat(emoteId) {
  const chatInput =
    document.querySelector('[data-slate-editor="true"][contenteditable="true"]') ||
    document.querySelector('.chat-wysiwyg-input__editor[contenteditable="true"]');
  if (!chatInput) { console.warn('[EmoteBar] chat input not found'); return; }

  if (chatInput.classList.contains('focus-visible')) { doInsert(chatInput, emoteId); return; }

  chatInput.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  chatInput.focus();
  chatInput.dispatchEvent(new FocusEvent('focus', { bubbles: false }));

  const obs = new MutationObserver((_, o) => {
    if (chatInput.classList.contains('focus-visible')) { o.disconnect(); doInsert(chatInput, emoteId); }
  });
  obs.observe(chatInput, { attributes: true, attributeFilter: ['class'] });
  setTimeout(() => { obs.disconnect(); doInsert(chatInput, emoteId); }, 200);
}

// ===== メッセージリスナー =====

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'insertEmoteToChat') { insertEmoteToChat(message.emoteId); sendResponse({ ok: true }); }
  if (message.action === 'requestEmotes') { sendResponse({ channelMap: extractEmotesByChannel() }); }
  return true;
});

observeEmotePicker();
setTimeout(collectAndSend, 1500);
