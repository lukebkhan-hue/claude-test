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

// Check checkbox then click submit as a single debugger session.
// Strategy: Focus the checkbox, press Space to toggle it (trusted keyboard event),
// then click Submit with trusted mouse event. No coordinate calculation needed
// for the checkbox — avoids all debug bar layout shift issues.
async function trustedCheckboxAndSubmit(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await sleep(500);

    // Step 1: Scroll to checkbox and focus it.
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `
        (function() {
          var cb = document.querySelector('#accept-statement')
                || document.querySelector('input[type="checkbox"]');
          if (cb) {
            cb.scrollIntoView({ block: 'center' });
            cb.focus();
            return 'focused: ' + cb.id;
          }
          // Try focusing the label instead.
          var label = document.querySelector('label[for="accept-statement"]');
          if (label) {
            label.scrollIntoView({ block: 'center' });
            label.focus();
            return 'focused label';
          }
          return 'not found';
        })()
      `,
      returnByValue: true,
    });

    await sleep(200);

    // Step 2: Press Space key to toggle the checkbox.
    // Space is the native browser shortcut for toggling a focused checkbox.
    // Debugger key events are trusted (isTrusted=true).
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
      nativeVirtualKeyCode: 32,
    });
    await sleep(50);
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
      nativeVirtualKeyCode: 32,
    });

    await sleep(500);

    // Step 3: Verify.
    const verifyResult = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `
        (function() {
          var cb = document.querySelector('#accept-statement')
                || document.querySelector('input[type="checkbox"]');
          return cb ? cb.checked : false;
        })()
      `,
      returnByValue: true,
    });

    const checked = verifyResult.result?.value;
    console.log("[Keyword Monitor] Space key → checkbox checked:", checked);

    // Step 4: If space didn't work, try clicking the VisibleInput div.
    if (!checked) {
      console.log("[Keyword Monitor] Space didn't work. Trying click on VisibleInput div...");
      const visResult = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: `
          (function() {
            var el = document.querySelector('[class*="VisibleInput"]')
                  || document.querySelector('[class*="ClickableInput"]');
            if (!el) {
              // Try the label.
              el = document.querySelector('label[for="accept-statement"]');
            }
            if (!el) return null;
            el.scrollIntoView({ block: 'center' });
            var rect = el.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()
        `,
        returnByValue: true,
      });

      if (visResult.result?.value) {
        await debuggerClickAt(tabId, visResult.result.value.x, visResult.result.value.y);
        await sleep(500);
      }
    }

    // Step 5: If STILL not checked, try Tab to the checkbox and Space again.
    const verify2 = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `(document.querySelector('#accept-statement') || document.querySelector('input[type="checkbox"]'))?.checked || false`,
      returnByValue: true,
    });

    if (!verify2.result?.value) {
      console.log("[Keyword Monitor] Still not checked. Trying Tab + Space...");
      // Press Tab multiple times to find the checkbox.
      for (let i = 0; i < 15; i++) {
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
          type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
        });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
          type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
        });
        await sleep(50);

        // Check if checkbox is now focused.
        const focusCheck = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: `document.activeElement?.id === 'accept-statement' || document.activeElement?.type === 'checkbox'`,
          returnByValue: true,
        });

        if (focusCheck.result?.value) {
          console.log("[Keyword Monitor] Checkbox focused via Tab. Pressing Space...");
          await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
            type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
          });
          await sleep(50);
          await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
            type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
          });
          await sleep(300);
          break;
        }
      }
    }

    // Final verification.
    const finalCheck = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `(document.querySelector('#accept-statement') || document.querySelector('input[type="checkbox"]'))?.checked || false`,
      returnByValue: true,
    });
    console.log("[Keyword Monitor] Final checkbox state:", finalCheck.result?.value);

    await sleep(300);

    // Step 6: Click the Submit button.
    const subResult = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `
        (function() {
          var all = document.querySelectorAll('button, [role="button"], a, input[type="submit"]');
          var el = null;
          for (var i = 0; i < all.length; i++) {
            var text = (all[i].textContent || all[i].value || '').trim().toLowerCase();
            if (text === 'submit' || text.includes('submit')) {
              el = all[i]; break;
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
    if (subCoords) {
      await debuggerClickAt(tabId, subCoords.x, subCoords.y);
      console.log("[Keyword Monitor] Submit clicked at:", subCoords.x, subCoords.y);
    }

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
      trustedCheckboxAndSubmit(tabId).then(result => {
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
