// Inject the panel iframe only once
if (!document.getElementById('tab-manager-panel')) {
  const iframe = document.createElement('iframe');
  iframe.id = 'tab-manager-panel';
  iframe.src = chrome.runtime.getURL('panel.html');
  iframe.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    width: 400px;
    height: 100%;
    z-index: 999999;
    border: none;
    box-shadow: -3px 0 8px rgba(0,0,0,0.3);
  `;
  document.body.appendChild(iframe);
}
