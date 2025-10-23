chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "groupTabsByDomain") {
    groupTabs();
  }
});

function groupTabs() {
  chrome.tabs.query({}, function(tabs) {
    const groups = {};
    tabs.forEach(tab => {
      try {
        const url = new URL(tab.url);
        const domain = url.hostname;
        if (!groups[domain]) {
          groups[domain] = [];
        }
        groups[domain].push(tab.id);
      } catch (e) {
        // chrome:// や about:blank などを無視
      }
    });

    Object.entries(groups).forEach(([domain, tabIds]) => {
      if (tabIds.length > 1) {
        chrome.tabs.group({ tabIds }, function(groupId) {
          if (chrome.runtime.lastError) {
            console.error('Group Error:', chrome.runtime.lastError.message);
            return;
          }
          chrome.tabGroups.update(groupId, {
            //title: domain,
            //color: 'blue'
          }, () => {
            if (chrome.runtime.lastError) {
              console.error('Update Error:', chrome.runtime.lastError.message);
            }
          });
        });
      }
    });
  });
}

chrome.action.onClicked.addListener(groupTabs);
