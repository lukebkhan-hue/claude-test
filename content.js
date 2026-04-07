// Content script — injected into every page.
// Refreshes the target page every 1s to scan for keywords.
// Action chain: scan → click "View" → handle follow-up page automatically.

let config = null;
let refreshTimer = null;

// Request config from background on load.
chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response && response.enabled) {
    runActions(response);
  }
});

// Listen for config pushes from background.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_MONITORING") {
    runActions(msg.config);
    sendResponse({ ok: true });
  }
});

function runActions(cfg) {
  config = cfg;
  if (!config.enabled) return;

  // Check workflow state stored by background.
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
    if (chrome.runtime.lastError) state = {};

    const phase = state?.phase || "SCANNING";

    if (phase === "SCANNING") {
      handleScanningPhase();
    } else if (phase === "FOLLOW_UP") {
      handleFollowUpPage();
    }
  });
}

// ─── PHASE 1: SCANNING ─────────────────────────────────────────────────────
// On the target URL, scan page text for keywords. On match, alert + click "View".
// Auto-refresh every 1 second.

function handleScanningPhase() {
  if (!config.targetUrl || !config.keywords) return;

  // Only act on the target URL.
  if (!urlMatches(window.location.href, config.targetUrl)) return;

  const keywords = config.keywords
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  if (keywords.length === 0) return;

  console.log("[Keyword Monitor] Scanning for:", keywords.join(", "));

  // Scan the page for keywords.
  const matchResult = findKeywordOnPage(keywords);

  if (matchResult) {
    console.log("[Keyword Monitor] Match found:", matchResult.keyword);

    // Send alert notification + sound.
    chrome.runtime.sendMessage({
      type: "KEYWORD_MATCH",
      keyword: matchResult.keyword,
      count: 1,
    });

    // Find and click the nearest "View" button.
    const viewBtn = findNearestButton(matchResult.element, "view");
    if (viewBtn) {
      console.log("[Keyword Monitor] Clicking 'View' button.");
      // Tell background we're moving to follow-up phase.
      chrome.runtime.sendMessage({
        type: "SET_STATE",
        state: { phase: "FOLLOW_UP", keyword: matchResult.keyword },
      });
      viewBtn.click();
      return; // Navigation will happen, no need to set up refresh.
    } else {
      console.log("[Keyword Monitor] No 'View' button found near match.");
    }
  }

  // No match yet — schedule page refresh in 1 second.
  scheduleRefresh();
}

function findKeywordOnPage(keywords) {
  // Walk all text nodes to find exact keyword locations in the DOM.
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null
  );

  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    const text = textNode.textContent.toLowerCase();

    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        return {
          keyword,
          element: textNode.parentElement,
          textNode,
        };
      }
    }
  }

  return null;
}

function findNearestButton(element, buttonLabel) {
  const label = buttonLabel.toLowerCase();

  // Strategy 1: Look within the same row/container (parent, grandparent, etc.)
  let ancestor = element;
  for (let i = 0; i < 10; i++) {
    if (!ancestor) break;
    ancestor = ancestor.parentElement;
    if (!ancestor) break;

    const btns = ancestor.querySelectorAll(
      'button, a, input[type="button"], input[type="submit"], [role="button"]'
    );
    for (const btn of btns) {
      const btnText = (btn.textContent || btn.value || "").trim().toLowerCase();
      if (btnText === label || btnText.includes(label)) {
        return btn;
      }
    }
  }

  // Strategy 2: Find all matching buttons on page and pick the closest by DOM distance.
  const allBtns = document.querySelectorAll(
    'button, a, input[type="button"], input[type="submit"], [role="button"]'
  );
  let closestBtn = null;
  let closestDist = Infinity;

  const elRect = element.getBoundingClientRect();
  const elY = elRect.top + elRect.height / 2;

  for (const btn of allBtns) {
    const btnText = (btn.textContent || btn.value || "").trim().toLowerCase();
    if (btnText === label || btnText.includes(label)) {
      const btnRect = btn.getBoundingClientRect();
      const btnY = btnRect.top + btnRect.height / 2;
      const dist = Math.abs(elY - btnY);
      if (dist < closestDist) {
        closestDist = dist;
        closestBtn = btn;
      }
    }
  }

  return closestBtn;
}

function scheduleRefresh() {
  // Clear any existing timer to avoid duplicates.
  if (refreshTimer) clearTimeout(refreshTimer);

  refreshTimer = setTimeout(() => {
    location.reload();
  }, 1000);
}

// ─── PHASE 2: FOLLOW-UP PAGE ───────────────────────────────────────────────
// After clicking "View", we land on an unknown URL.
// Detect what's on the page and act accordingly:
//   - "Express Interest" button → click it
//   - Checkbox near bottom + "Submit" button → check box, then click submit

function handleFollowUpPage() {
  console.log("[Keyword Monitor] Follow-up page detected. Scanning for actions...");

  // Small delay to ensure page is fully rendered.
  setTimeout(() => {
    // Try: "Express Interest" button.
    const expressBtn = findButtonByLabel("express interest");
    if (expressBtn) {
      console.log("[Keyword Monitor] Clicking 'Express Interest'.");
      chrome.runtime.sendMessage({
        type: "SET_STATE",
        state: { phase: "COMPLETE" },
      });
      expressBtn.click();
      resetAfterDelay();
      return;
    }

    // Try: Checkbox at bottom + "Submit" button.
    const checkbox = findBottomCheckbox();
    const submitBtn = findButtonByLabel("submit");

    if (checkbox && submitBtn) {
      console.log("[Keyword Monitor] Checking checkbox and clicking 'Submit'.");
      clickCheckbox(checkbox);
      chrome.runtime.sendMessage({
        type: "SET_STATE",
        state: { phase: "COMPLETE" },
      });
      // Longer delay between check and submit to let validation/state update.
      setTimeout(() => {
        simulateClick(submitBtn);
        resetAfterDelay();
      }, 500);
      return;
    }

    // Neither pattern found — this page may still be loading or is unexpected.
    // Retry once after a short delay.
    console.log("[Keyword Monitor] No known actions found. Retrying in 1s...");
    setTimeout(() => {
      const expressBtn2 = findButtonByLabel("express interest");
      if (expressBtn2) {
        chrome.runtime.sendMessage({ type: "SET_STATE", state: { phase: "COMPLETE" } });
        expressBtn2.click();
        resetAfterDelay();
        return;
      }

      const checkbox2 = findBottomCheckbox();
      const submitBtn2 = findButtonByLabel("submit");
      if (checkbox2 && submitBtn2) {
        clickCheckbox(checkbox2);
        chrome.runtime.sendMessage({ type: "SET_STATE", state: { phase: "COMPLETE" } });
        setTimeout(() => {
          simulateClick(submitBtn2);
          resetAfterDelay();
        }, 500);
        return;
      }

      // Give up on this follow-up and go back to scanning.
      console.log("[Keyword Monitor] No actions found. Returning to scan mode.");
      resetToScanning();
    }, 1000);
  }, 500);
}

function findButtonByLabel(label) {
  const lower = label.toLowerCase();

  // Cast a wide net: real buttons, links, divs/spans with role or click handlers.
  const candidates = document.querySelectorAll(
    'button, a, input[type="button"], input[type="submit"], [role="button"], ' +
    '[class*="btn"], [class*="button"], [class*="submit"], [class*="Button"], [class*="Submit"]'
  );

  for (const el of candidates) {
    const text = (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (text === lower || text.includes(lower)) {
      return el;
    }
  }

  // Fallback: walk ALL elements looking for one whose text matches.
  const allEls = document.querySelectorAll("*");
  for (const el of allEls) {
    // Only match leaf-ish elements (avoid matching a huge container).
    const directText = getDirectText(el).toLowerCase();
    if (directText === lower || directText.includes(lower)) {
      // Prefer clickable-looking elements.
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || "";
      const cursor = window.getComputedStyle(el).cursor;
      if (tag === "button" || tag === "a" || role === "button" || cursor === "pointer") {
        return el;
      }
    }
  }

  return null;
}

function getDirectText(el) {
  // Get only the direct text of an element (not deeply nested children).
  let text = "";
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent;
    }
  }
  return text.trim();
}

function findBottomCheckbox() {
  // Strategy 1: Real <input type="checkbox"> elements.
  let checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));

  // Strategy 2: Custom checkbox elements (role="checkbox", aria-checked, common class names).
  const customCheckboxes = document.querySelectorAll(
    '[role="checkbox"], [class*="checkbox"], [class*="Checkbox"], ' +
    '[class*="check-box"], [class*="CheckBox"], [data-testid*="checkbox"]'
  );
  for (const el of customCheckboxes) {
    if (!checkboxes.includes(el)) {
      checkboxes.push(el);
    }
  }

  // Strategy 3: Look for the "Agreement" section and find any clickable element near it
  // that looks like a checkbox (small square element).
  if (checkboxes.length === 0) {
    const allEls = document.querySelectorAll("*");
    for (const el of allEls) {
      const rect = el.getBoundingClientRect();
      // Checkboxes are typically small square elements.
      if (rect.width >= 10 && rect.width <= 40 && rect.height >= 10 && rect.height <= 40) {
        const ratio = rect.width / rect.height;
        if (ratio > 0.7 && ratio < 1.4) {
          // Check if it's near text containing "agree" or "agreement".
          const parent = el.closest("div, section, form, fieldset") || el.parentElement;
          if (parent) {
            const parentText = (parent.textContent || "").toLowerCase();
            if (parentText.includes("agree") || parentText.includes("terms") || parentText.includes("accept")) {
              checkboxes.push(el);
            }
          }
        }
      }
    }
  }

  if (checkboxes.length === 0) return null;

  // Return the one closest to the bottom of the page.
  let bottomCheckbox = null;
  let maxY = -Infinity;

  for (const cb of checkboxes) {
    const rect = cb.getBoundingClientRect();
    if (rect.top > maxY) {
      maxY = rect.top;
      bottomCheckbox = cb;
    }
  }

  return bottomCheckbox;
}

function resetAfterDelay() {
  // After completing follow-up actions, return to scanning after a brief pause
  // so the clicked action has time to process.
  setTimeout(() => {
    resetToScanning();
  }, 2000);
}

function resetToScanning() {
  chrome.runtime.sendMessage({
    type: "SET_STATE",
    state: { phase: "SCANNING" },
  });
  // Navigate back to the target URL and resume the refresh loop.
  if (config.targetUrl) {
    // If we're not on the target URL, go back to it.
    if (!urlMatches(window.location.href, config.targetUrl)) {
      window.location.href = config.targetUrl;
    } else {
      scheduleRefresh();
    }
  }
}

// ─── CLICK HELPERS ──────────────────────────────────────────────────────────

function simulateClick(el) {
  // Dispatch a full sequence of mouse events to trigger framework handlers.
  const events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  for (const evtName of events) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const evt = new MouseEvent(evtName, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
    });
    el.dispatchEvent(evt);
  }
  // Also call .click() as a fallback.
  el.click();
}

function clickCheckbox(cb) {
  // For real <input type="checkbox">, set checked and fire change event.
  if (cb.tagName === "INPUT" && cb.type === "checkbox") {
    if (!cb.checked) {
      cb.focus();
      simulateClick(cb);
      // If click didn't toggle it, force it.
      if (!cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
        cb.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    return;
  }

  // For custom checkboxes (div/span with role="checkbox" etc.)
  simulateClick(cb);

  // Also try clicking the associated <label> if there is one.
  const id = cb.getAttribute("id") || cb.getAttribute("data-id");
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`);
    if (label) simulateClick(label);
  }

  // Try clicking the parent label if the checkbox is nested inside one.
  const parentLabel = cb.closest("label");
  if (parentLabel && parentLabel !== cb) {
    simulateClick(parentLabel);
  }
}

// ─── UTILITIES ──────────────────────────────────────────────────────────────

function urlMatches(current, pattern) {
  const normalizedCurrent = current.toLowerCase();
  const normalizedPattern = pattern.toLowerCase().trim();
  if (normalizedCurrent.startsWith(normalizedPattern)) return true;
  if (normalizedCurrent.includes(normalizedPattern)) return true;
  return false;
}
