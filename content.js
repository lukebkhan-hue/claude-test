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
      if (!checkbox.checked) {
        checkbox.click();
      }
      chrome.runtime.sendMessage({
        type: "SET_STATE",
        state: { phase: "COMPLETE" },
      });
      // Brief delay between check and submit to let any validation run.
      setTimeout(() => {
        submitBtn.click();
        resetAfterDelay();
      }, 300);
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
        if (!checkbox2.checked) checkbox2.click();
        chrome.runtime.sendMessage({ type: "SET_STATE", state: { phase: "COMPLETE" } });
        setTimeout(() => {
          submitBtn2.click();
          resetAfterDelay();
        }, 300);
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
  const btns = document.querySelectorAll(
    'button, a, input[type="button"], input[type="submit"], [role="button"]'
  );
  for (const btn of btns) {
    const text = (btn.textContent || btn.value || "").trim().toLowerCase();
    if (text === lower || text.includes(lower)) {
      return btn;
    }
  }
  return null;
}

function findBottomCheckbox() {
  // Find all checkboxes and return the one closest to the bottom of the page.
  const checkboxes = document.querySelectorAll('input[type="checkbox"]');
  if (checkboxes.length === 0) return null;

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

// ─── UTILITIES ──────────────────────────────────────────────────────────────

function urlMatches(current, pattern) {
  const normalizedCurrent = current.toLowerCase();
  const normalizedPattern = pattern.toLowerCase().trim();
  if (normalizedCurrent.startsWith(normalizedPattern)) return true;
  if (normalizedCurrent.includes(normalizedPattern)) return true;
  return false;
}
