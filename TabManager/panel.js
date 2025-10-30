document.getElementById("close-btn").addEventListener("click", () => {
  parent.document.getElementById("tab-manager-panel").remove();
});

async function refreshTabs() {
  const tabs = await chrome.tabs.query({});
  const list = document.getElementById("tab-list");
  list.innerHTML = "";

  for (const tab of tabs) {
    const li = document.createElement("li");
    li.textContent = tab.title || "(no title)";
    li.className = "tab-item";

    li.addEventListener("click", () => {
      chrome.tabs.update(tab.id, { active: true });
    });

    list.appendChild(li);
  }
}

refreshTabs();
