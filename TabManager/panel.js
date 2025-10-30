function createPlaceholderFavicon(tab) {
  const span = document.createElement('span');
  span.className = 'tab-favicon tab-favicon--placeholder';

  const title = (tab.title || tab.url || '').trim();
  const initial = title.charAt(0);
  span.textContent = initial ? initial.toUpperCase() : '•';

  return span;
}

function createFaviconElement(tab) {
  const faviconUrl = tab.favIconUrl;
  if (typeof faviconUrl === 'string' && faviconUrl.length > 0) {
    const img = document.createElement('img');
    img.className = 'tab-favicon';
    img.src = faviconUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      img.replaceWith(createPlaceholderFavicon(tab));
    });
    return img;
  }

  return createPlaceholderFavicon(tab);
}

async function refreshTabs() {
  const tabs = await chrome.tabs.query({});

  const list = document.getElementById('tab-list');
  list.innerHTML = '';

  for (const tab of tabs) {
    const li = document.createElement('li');
    li.className = 'tab-item';
    if (tab.active) {
      li.classList.add('is-active');
    }

    const favicon = createFaviconElement(tab);

    const fullTitle = tab.title || '(no title)';

    const content = document.createElement('div');
    content.className = 'tab-text';
    content.textContent = fullTitle;
    content.title = fullTitle;

    const closeButton = document.createElement('button');
    closeButton.className = 'tab-close-btn';
    closeButton.type = 'button';
    closeButton.textContent = '✕';
    closeButton.title = 'タブを閉じる';
    closeButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        await chrome.tabs.remove(tab.id);
      } catch (error) {
        console.error('Failed to close tab:', error);
      }
    });

    li.appendChild(favicon);
    li.appendChild(content);
    li.appendChild(closeButton);
    li.title = fullTitle;

    li.addEventListener('click', async () => {
      await chrome.tabs.update(tab.id, { active: true });
      if (typeof tab.windowId === 'number') {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    });

    list.appendChild(li);
  }
}

function attachEventListeners() {
  document.getElementById('close-btn').addEventListener('click', () => {
    window.parent.postMessage({ type: 'TabManagerClosePanel' }, '*');
    chrome.runtime.sendMessage({ type: 'TabManagerPanelClosedByUser' }).catch((error) => {
      console.error('Failed to notify background about panel close:', error);
    });
  });

  chrome.tabs.onActivated.addListener(refreshTabs);
  chrome.tabs.onCreated.addListener(refreshTabs);
  chrome.tabs.onRemoved.addListener(refreshTabs);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url) {
      refreshTabs();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  attachEventListeners();
  setupHeaderBehavior();
  refreshTabs();
});

function setupHeaderBehavior() {
  const header = document.querySelector('header');
  if (!header) {
    return;
  }

  const updateHeaderState = () => {
    const shouldBeCompact = window.scrollY > 0;
    header.classList.toggle('is-compact', shouldBeCompact);
  };

  window.addEventListener('scroll', updateHeaderState, { passive: true });
  updateHeaderState();
}
