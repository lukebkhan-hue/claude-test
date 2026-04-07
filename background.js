// Background service worker — manages notifications, alert sound, and workflow state.

const OFFSCREEN_DOC = "offscreen.html";

// In-memory workflow state.
let workflowState = { phase: "SCANNING" };

// Global match counter to ensure every notification is unique.
let matchCounter = 0;

// Ensure the offscreen document exists for playing audio.
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOC)],
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOC,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play alert sound when a keyword match is detected.",
    });
  }
}

// Map notification IDs to tab IDs so we can focus the right tab on click.
const notifToTab = {};

// When user clicks a notification, focus/switch to the associated tab.
chrome.notifications.onClicked.addListener((notifId) => {
  const tabId = notifToTab[notifId];
  if (tabId) {
    chrome.tabs.update(tabId, { active: true });
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.windowId) {
        chrome.windows.update(tab.windowId, { focused: true });
      }
    });
    // Tell the content script to scroll to the checkbox area again.
    chrome.tabs.sendMessage(tabId, { type: "SCROLL_TO_CHECKBOX" }).catch(() => {});
    delete notifToTab[notifId];
  }
});

// Listen for messages from content scripts.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "KEYWORD_MATCH") {
    handleMatch(msg, sender);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "KEYWORD_MATCH_MANUAL") {
    handleManualMatch(msg, sender);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "GET_CONFIG") {
    chrome.storage.local.get(["targetUrl", "keywords", "enabled"], (data) => {
      sendResponse(data);
    });
    return true; // async response
  }

  if (msg.type === "GET_STATE") {
    sendResponse(workflowState);
    return;
  }

  if (msg.type === "SET_STATE") {
    workflowState = msg.state || { phase: "SCANNING" };
    console.log("[Keyword Monitor] State →", workflowState.phase);
    sendResponse({ ok: true });
    return;
  }
});

async function handleMatch(msg, sender) {
  const { keyword } = msg;
  const tabTitle = sender.tab?.title || "Unknown page";
  matchCounter++;

  const notifId = `kw-${matchCounter}-${Date.now()}`;
  const tabId = sender.tab?.id;

  chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Keyword Detected!",
    message: `"${keyword}" found (alert #${matchCounter}) on ${tabTitle}`,
    priority: 2,
  });

  if (tabId) notifToTab[notifId] = tabId;

  // Play alert sound via offscreen document
  try {
    await ensureOffscreen();
    chrome.runtime.sendMessage({ type: "PLAY_ALERT" });
  } catch (err) {
    console.error("Failed to play alert sound:", err);
  }
}

async function handleManualMatch(msg, sender) {
  const tabTitle = sender.tab?.title || "Unknown page";
  const tabId = sender.tab?.id;
  matchCounter++;

  const notifId = `manual-${matchCounter}-${Date.now()}`;

  chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Action Required!",
    message: `Keyword matched! Check the box and submit on: ${tabTitle}. Click here to go there.`,
    priority: 2,
    requireInteraction: true, // Keep notification visible until user clicks it.
  });

  if (tabId) notifToTab[notifId] = tabId;

  // Play alert sound.
  try {
    await ensureOffscreen();
    chrome.runtime.sendMessage({ type: "PLAY_ALERT" });
  } catch (err) {
    console.error("Failed to play alert sound:", err);
  }
}

// When a tab finishes loading, send it the current config + state.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    chrome.storage.local.get(["targetUrl", "keywords", "enabled"], (data) => {
      if (data.enabled && data.targetUrl && data.keywords) {
        chrome.tabs.sendMessage(tabId, {
          type: "START_MONITORING",
          config: data,
        }).catch(() => {
          // Content script not ready yet — ignore
        });
      }
    });
  }
});

// Re-inject config when storage changes so active tabs pick it up immediately.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  // Reset workflow state when config changes (user hit Save).
  workflowState = { phase: "SCANNING" };

  chrome.storage.local.get(["targetUrl", "keywords", "enabled"], (data) => {
    if (!data.enabled) return;
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          type: "START_MONITORING",
          config: data,
        }).catch(() => {});
      }
    });
  });
});
