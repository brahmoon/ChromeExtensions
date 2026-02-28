# TabManager.v1.3-a 自動グループ化修正差分

```diff
diff --git a/TabManager.v1.3-a/background.js b/TabManager.v1.3-a/background.js
index 5e29e54..964242b 100644
--- a/TabManager.v1.3-a/background.js
+++ b/TabManager.v1.3-a/background.js
@@ -54,6 +54,9 @@ const detachedTabSourceWindowState = new Map();
 let tabListSyncSequence = 0;
 const autoGroupingInFlightTabIds = new Set();
 const autoGroupingPendingTabIds = new Set();
+const autoGroupingWindowDebounceTimers = new Map();
+const autoGroupingQueuedTabsByWindow = new Map();
+const AUTO_GROUPING_WINDOW_DEBOUNCE_MS = 300;
 
 async function warmTabGroupIdCache() {
   try {
@@ -1079,7 +1082,7 @@ chrome.tabs.onCreated.addListener((tab) => {
     setWindowAutoGroupingState(tab.windowId, autoDomainGroupingEnabled);
   }
 
-  autoGroupTabByDomain(tab, { requireActiveContext: false }).catch(() => {});
+  queueAutoGroupTabByDomain(tab, { requireActiveContext: false });
   persistTabListSyncEntity('created').catch(() => {});
 });
 
@@ -1110,7 +1113,7 @@ chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
         try {
           const attachedTab = await chrome.tabs.get(tabId);
           if (attachedTab) {
-            await autoGroupTabByDomain(attachedTab, { requireActiveContext: false });
+            queueAutoGroupTabByDomain(attachedTab, { requireActiveContext: false });
           }
         } catch (error) {
           // ignore lookup failure for moved/closed tabs
@@ -1153,7 +1156,7 @@ chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
     return;
   }
 
-  autoGroupTabByDomain(tab, { requireActiveContext: false }).catch(() => {});
+  queueAutoGroupTabByDomain(tab, { requireActiveContext: false });
 });
 
 function extractDomainForGrouping(url) {
@@ -1544,7 +1547,7 @@ async function disbandSingletonGroupAfterRemoval(windowId, groupId) {
   try {
     const refreshed = await chrome.tabs.get(loneTab.id);
     if (refreshed) {
-      await autoGroupTabByDomain(refreshed, { requireActiveContext: false });
+      queueAutoGroupTabByDomain(refreshed, { requireActiveContext: false });
     }
   } catch (error) {
     // ignore follow-up regroup failures for closed or transient tabs
@@ -1582,7 +1585,7 @@ async function runCommonGroupingForSingletonTabsInWindow(windowId, { excludeTabI
       continue;
     }
 
-    await autoGroupTabByDomain(loneTab, { requireActiveContext: false });
+    queueAutoGroupTabByDomain(loneTab, { requireActiveContext: false });
   }
 }
 
@@ -1612,11 +1615,6 @@ async function autoGroupTabByDomainCore(tab, { requireActiveContext } = {}) {
     if (!tab.active) {
       return;
     }
-
-    const activeWindowId = await resolveLastFocusedWindowId();
-    if (!Number.isFinite(activeWindowId) || activeWindowId !== tab.windowId) {
-      return;
-    }
   }
 
   const url = typeof tab.url === 'string' && tab.url.length > 0 ? tab.url : tab.pendingUrl;
@@ -1690,7 +1688,7 @@ async function autoGroupTabByDomainCore(tab, { requireActiveContext } = {}) {
         chrome.tabs.get(tab.id)
           .then((freshTab) => {
             if (freshTab) {
-              autoGroupTabByDomain(freshTab, { requireActiveContext: false }).catch(() => {});
+              queueAutoGroupTabByDomain(freshTab, { requireActiveContext: false });
             }
           })
           .catch(() => {});
@@ -1739,6 +1737,43 @@ async function autoGroupTabByDomain(tab, options = {}) {
   }
 }
 
+function queueAutoGroupTabByDomain(tab, options = {}) {
+  if (!tab || !Number.isFinite(tab.id) || !Number.isFinite(tab.windowId)) {
+    return;
+  }
+
+  const windowId = tab.windowId;
+  let queuedTabs = autoGroupingQueuedTabsByWindow.get(windowId);
+  if (!queuedTabs) {
+    queuedTabs = new Map();
+    autoGroupingQueuedTabsByWindow.set(windowId, queuedTabs);
+  }
+  queuedTabs.set(tab.id, { tab, options });
+
+  const existingTimer = autoGroupingWindowDebounceTimers.get(windowId);
+  if (existingTimer) {
+    clearTimeout(existingTimer);
+  }
+
+  const timer = setTimeout(() => {
+    autoGroupingWindowDebounceTimers.delete(windowId);
+    const pending = autoGroupingQueuedTabsByWindow.get(windowId);
+    autoGroupingQueuedTabsByWindow.delete(windowId);
+
+    if (!pending || pending.size === 0) {
+      return;
+    }
+
+    (async () => {
+      for (const queued of pending.values()) {
+        await autoGroupTabByDomain(queued.tab, queued.options).catch(() => {});
+      }
+    })().catch(() => {});
+  }, AUTO_GROUPING_WINDOW_DEBOUNCE_MS);
+
+  autoGroupingWindowDebounceTimers.set(windowId, timer);
+}
+
 
 async function resolveWindowIdForGrouping(explicitWindowId, sender) {
   if (Number.isFinite(explicitWindowId)) {
@@ -1938,21 +1973,12 @@ chrome.storage.onChanged.addListener((changes, areaName) => {
     }
 
     if (!wasEnabled && autoDomainGroupingEnabled) {
-      resolveLastFocusedWindowId()
-        .then((focusedWindowId) => {
-          if (!Number.isFinite(focusedWindowId)) {
-            return null;
+      groupTabsByDomain({ scope: GROUP_SCOPE_ALL })
+        .then((hasGroupingChanges) => {
+          if (hasGroupingChanges) {
+            return persistTabListSyncEntity('auto-domain-grouping-enabled');
           }
-
-          return groupTabsByDomain({
-            scope: GROUP_SCOPE_CURRENT,
-            windowId: focusedWindowId,
-          }).then((hasGroupingChanges) => {
-            if (hasGroupingChanges) {
-              return persistTabListSyncEntity('auto-domain-grouping-enabled');
-            }
-            return null;
-          });
+          return null;
         })
         .catch((error) => {
           console.debug('Failed to run initial auto domain grouping:', error);
```
