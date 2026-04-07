// Background service worker — manages notifications and alert sound playback.

const OFFSCREEN_DOC = "offscreen.html";

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

// Listen for keyword match messages from content scripts.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "KEYWORD_MATCH") {
    handleMatch(msg, sender);
    sendResponse({ ok: true });
  }

  if (msg.type === "GET_CONFIG") {
    chrome.storage.local.get(["targetUrl", "keywords", "enabled"], (data) => {
      sendResponse(data);
    });
    return true; // async response
  }
});

async function handleMatch(msg, sender) {
  const { keyword, count } = msg;
  const tabTitle = sender.tab?.title || "Unknown page";

  // Show browser notification
  const notifId = `kw-${keyword}-${Date.now()}`;
  chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Keyword Detected!",
    message: `"${keyword}" found (new occurrence #${count}) on ${tabTitle}`,
    priority: 2,
  });

  // Play alert sound via offscreen document
  try {
    await ensureOffscreen();
    chrome.runtime.sendMessage({ type: "PLAY_ALERT" });
  } catch (err) {
    console.error("Failed to play alert sound:", err);
  }
}

// When a tab updates, notify the content script with current config.
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
