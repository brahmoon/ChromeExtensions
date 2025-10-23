document.getElementById('groupTabs').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: "groupTabsByDomain" });
});
