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

// ─── TRUSTED CLICK VIA DEBUGGER API ─────────────────────────────────────────
// Uses DevTools Protocol to send real browser-level input events.
// Gets element coordinates AFTER attaching debugger (the debug banner shifts layout).

async function trustedClickBySelector(tabId, selector) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");

    // Wait a moment for the debug bar to render and layout to settle.
    await sleep(300);

    // Get element coordinates from within the page AFTER debugger is attached
    // (the debug bar shifts content down, so pre-calculated coords are wrong).
    const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `
        (function() {
          var el = document.querySelector('${selector}');
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          var rect = el.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()
      `,
      returnByValue: true,
    });

    const coords = result.result?.value;
    if (!coords) {
      await chrome.debugger.detach({ tabId });
      return { ok: false, error: "Element not found: " + selector };
    }

    const { x, y } = coords;
    console.log("[Keyword Monitor] Trusted click at:", x, y, "for:", selector);

    // Mouse move to target.
    const steps = 8;
    const startX = x + (Math.random() - 0.5) * 150;
    const startY = y - 60 - Math.random() * 80;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ease = 1 - Math.pow(1 - t, 2);
      const cx = startX + (x - startX) * ease + (Math.random() - 0.5) * 2;
      const cy = startY + (y - startY) * ease + (Math.random() - 0.5) * 2;
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(cx),
        y: Math.round(cy),
      });
      await sleep(10 + Math.random() * 15);
    }

    await sleep(30 + Math.random() * 50);

    // Mouse down.
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: Math.round(x), y: Math.round(y),
      button: "left",
      clickCount: 1,
    });

    await sleep(20 + Math.random() * 40);

    // Mouse up.
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: Math.round(x), y: Math.round(y),
      button: "left",
      clickCount: 1,
    });

    await chrome.debugger.detach({ tabId });
    return { ok: true };
  } catch (err) {
    console.error("[Keyword Monitor] Debugger click failed:", err);
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    return { ok: false, error: err.message };
  }
}

// Click checkbox then submit as a single debugger session (attach once).
async function trustedCheckboxAndSubmit(tabId, checkboxSelector, submitSelector) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await sleep(400);

    // Scroll to and get checkbox coords.
    const cbResult = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `
        (function() {
          var el = document.querySelector('${checkboxSelector}');
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          var rect = el.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()
      `,
      returnByValue: true,
    });

    const cbCoords = cbResult.result?.value;
    if (!cbCoords) {
      await chrome.debugger.detach({ tabId });
      return { ok: false, error: "Checkbox not found" };
    }

    // Click the checkbox.
    await debuggerClickAt(tabId, cbCoords.x, cbCoords.y);
    console.log("[Keyword Monitor] Checkbox clicked at:", cbCoords.x, cbCoords.y);

    await sleep(800);

    // Scroll to and get submit button coords.
    const subResult = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `
        (function() {
          var el = document.querySelector('${submitSelector}');
          if (!el) {
            // Fallback: find by text content.
            var all = document.querySelectorAll('button, [role="button"], a, input[type="submit"]');
            for (var i = 0; i < all.length; i++) {
              if ((all[i].textContent || '').trim().toLowerCase().includes('submit')) {
                el = all[i]; break;
              }
            }
          }
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          var rect = el.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()
      `,
      returnByValue: true,
    });

    const subCoords = subResult.result?.value;
    if (!subCoords) {
      await chrome.debugger.detach({ tabId });
      return { ok: false, error: "Submit not found" };
    }

    // Click the submit button.
    await debuggerClickAt(tabId, subCoords.x, subCoords.y);
    console.log("[Keyword Monitor] Submit clicked at:", subCoords.x, subCoords.y);

    await chrome.debugger.detach({ tabId });
    return { ok: true };
  } catch (err) {
    console.error("[Keyword Monitor] Debugger checkbox+submit failed:", err);
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    return { ok: false, error: err.message };
  }
}

async function debuggerClickAt(tabId, x, y) {
  x = Math.round(x);
  y = Math.round(y);

  // Brief mouse move approach.
  const startX = x + (Math.random() - 0.5) * 100;
  const startY = y - 40 - Math.random() * 60;
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    const cx = Math.round(startX + (x - startX) * t + (Math.random() - 0.5) * 2);
    const cy = Math.round(startY + (y - startY) * t + (Math.random() - 0.5) * 2);
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: cx, y: cy,
    });
    await sleep(10 + Math.random() * 10);
  }

  await sleep(20 + Math.random() * 30);

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1,
  });
  await sleep(20 + Math.random() * 30);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

  if (msg.type === "TRUSTED_CLICK_SELECTOR") {
    const tabId = sender.tab?.id;
    if (tabId) {
      trustedClickBySelector(tabId, msg.selector).then(result => {
        sendResponse(result);
      });
    } else {
      sendResponse({ ok: false, error: "No tab ID" });
    }
    return true;
  }

  if (msg.type === "TRUSTED_CHECKBOX_SUBMIT") {
    const tabId = sender.tab?.id;
    if (tabId) {
      trustedCheckboxAndSubmit(tabId, msg.checkboxSelector, msg.submitSelector).then(result => {
        sendResponse(result);
      });
    } else {
      sendResponse({ ok: false, error: "No tab ID" });
    }
    return true;
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
