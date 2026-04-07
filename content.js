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

  if (msg.type === "SCROLL_TO_CHECKBOX") {
    // User clicked the notification — scroll to the checkbox area.
    window.scrollTo(0, document.body.scrollHeight);
    setTimeout(() => {
      const checkbox = findBottomCheckbox();
      if (checkbox) {
        scrollToElement(checkbox);
      }
    }, 300);
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
    } else if (phase === "WAITING_FOR_USER") {
      // Do nothing — user needs to manually check box and submit.
      // Just keep the page scrolled to the checkbox.
      console.log("[Keyword Monitor] Waiting for user to check box and submit.");
      window.scrollTo(0, document.body.scrollHeight);
      setTimeout(() => {
        const checkbox = findBottomCheckbox();
        if (checkbox) scrollToElement(checkbox);
      }, 300);
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

  // First, scroll to the very bottom so all elements are rendered and visible.
  window.scrollTo(0, document.body.scrollHeight);

  // Allow time for scroll + any lazy-loaded content to appear.
  setTimeout(() => {
    window.scrollTo(0, document.body.scrollHeight);

    setTimeout(() => {
      // Try: "Express Interest" button — auto-click this one.
      const expressBtn = findButtonByLabel("express interest");
      if (expressBtn) {
        console.log("[Keyword Monitor] Clicking 'Express Interest'.");
        scrollToAndClick(expressBtn);
        chrome.runtime.sendMessage({
          type: "SET_STATE",
          state: { phase: "COMPLETE" },
        });
        resetAfterDelay();
        return;
      }

      // Checkbox + Submit page — scroll to bottom and alert the user.
      // User will manually check the box and click Submit.
      const checkbox = findBottomCheckbox();
      const submitBtn = findButtonByLabel("submit");

      if (checkbox || submitBtn) {
        console.log("[Keyword Monitor] Checkbox/Submit page detected. Scrolling to bottom and alerting user.");

        // Set state to WAITING — stops all auto-refresh and auto-actions.
        chrome.runtime.sendMessage({
          type: "SET_STATE",
          state: { phase: "WAITING_FOR_USER" },
        });

        // Scroll to the checkbox area so it's visible when user switches to the tab.
        const target = checkbox || submitBtn;
        scrollToElement(target);

        // Send alert — notification click will bring user to this tab.
        chrome.runtime.sendMessage({
          type: "KEYWORD_MATCH_MANUAL",
          keyword: "Action required — check the box and submit",
          tabId: null, // background will use sender.tab
        });

        // Everything stops here. No refresh, no reset.
        // User handles it manually.
        return;
      }

      // Neither pattern found — retry.
      console.log("[Keyword Monitor] No known actions found. Retrying in 1.5s...");
      setTimeout(() => {
        window.scrollTo(0, document.body.scrollHeight);

        setTimeout(() => {
          const expressBtn2 = findButtonByLabel("express interest");
          if (expressBtn2) {
            chrome.runtime.sendMessage({ type: "SET_STATE", state: { phase: "COMPLETE" } });
            scrollToAndClick(expressBtn2);
            resetAfterDelay();
            return;
          }

          const checkbox2 = findBottomCheckbox();
          const submitBtn2 = findButtonByLabel("submit");
          if (checkbox2 || submitBtn2) {
            chrome.runtime.sendMessage({
              type: "SET_STATE",
              state: { phase: "WAITING_FOR_USER" },
            });
            const target2 = checkbox2 || submitBtn2;
            scrollToElement(target2);
            chrome.runtime.sendMessage({
              type: "KEYWORD_MATCH_MANUAL",
              keyword: "Action required — check the box and submit",
            });
            return;
          }

          console.log("[Keyword Monitor] No actions found. Returning to scan mode.");
          resetToScanning();
        }, 500);
      }, 1500);
    }, 500);
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
  // ── 99designs / styled-components pattern ──
  // The real <input type="checkbox"> has class "HiddenInput" (invisible).
  // The visible clickable element is a sibling <div> with class containing
  // "VisibleInput" or "ClickableInput".

  // First, try to find the accept-statement checkbox by ID (99designs).
  const acceptInput = document.querySelector('#accept-statement');
  if (acceptInput) {
    // Find the visible clickable sibling div.
    const parent = acceptInput.parentElement;
    if (parent) {
      const visibleDiv = parent.querySelector(
        '[class*="VisibleInput"], [class*="ClickableInput"], [class*="visible"]'
      );
      if (visibleDiv) {
        console.log("[Keyword Monitor] Found VisibleInput sibling for #accept-statement");
        return visibleDiv;
      }
    }
    // If no visible sibling, return the input itself as fallback.
    return acceptInput;
  }

  // ── Generic: find hidden checkbox + visible sibling pattern ──
  const allCheckboxInputs = document.querySelectorAll('input[type="checkbox"]');
  for (const input of allCheckboxInputs) {
    const cls = (input.className || "").toLowerCase();
    // Detect if this input is hidden (class contains "hidden", or zero size).
    const rect = input.getBoundingClientRect();
    const isHidden = cls.includes("hidden") || (rect.width === 0 && rect.height === 0) ||
                     window.getComputedStyle(input).display === "none" ||
                     window.getComputedStyle(input).visibility === "hidden" ||
                     window.getComputedStyle(input).opacity === "0";

    if (isHidden) {
      // Look for a visible sibling that acts as the clickable checkbox.
      const parent = input.parentElement;
      if (parent) {
        for (const sibling of parent.children) {
          if (sibling === input) continue;
          const sRect = sibling.getBoundingClientRect();
          if (sRect.width > 0 && sRect.height > 0 && sRect.width <= 60 && sRect.height <= 60) {
            console.log("[Keyword Monitor] Found visible sibling for hidden checkbox:", sibling.className);
            return sibling;
          }
        }
      }
    }

    // Not hidden — return it directly.
    if (!isHidden) {
      return input;
    }
  }

  // ── Fallback: custom checkbox elements by role/class ──
  const customSelectors = [
    '[role="checkbox"]',
    '[class*="checkbox"]', '[class*="Checkbox"]',
    '[class*="check-box"]', '[class*="CheckBox"]',
    '[data-testid*="checkbox"]',
    '[aria-checked]',
  ].join(", ");
  const customCheckboxes = document.querySelectorAll(customSelectors);
  if (customCheckboxes.length > 0) {
    return getBottomMost(Array.from(customCheckboxes));
  }

  // ── Last resort: search near agreement text ──
  const agreementContainer = findAgreementContainer();
  if (!agreementContainer) return null;

  // Look for any small clickable element in the agreement area.
  for (const el of agreementContainer.querySelectorAll("*")) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.width > 60 || rect.height > 60) continue;
    const ratio = rect.width / rect.height;
    if (ratio > 0.5 && ratio < 2) {
      const text = (el.textContent || "").trim();
      if (text.length <= 2) {
        return el;
      }
    }
  }

  console.log("[Keyword Monitor] No checkbox found on page.");
  return null;
}

function findAgreementContainer() {
  // Walk text nodes to find "I agree" or "Agreement".
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null
  );

  let agreementNode = null;
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent.toLowerCase();
    if (text.includes("i agree") || text.includes("agreement")) {
      agreementNode = walker.currentNode.parentElement;
      break;
    }
  }

  if (!agreementNode) return null;

  // Walk up a few levels to find a container that likely holds the whole
  // checkbox + label row.
  let container = agreementNode;
  for (let i = 0; i < 6; i++) {
    if (!container.parentElement) break;
    container = container.parentElement;
    // Stop when we reach something that looks like a form section.
    const tag = container.tagName.toLowerCase();
    if (tag === "form" || tag === "section" || tag === "fieldset") break;
  }

  return container;
}

function getBottomMost(elements) {
  let bottom = null;
  let maxY = -Infinity;
  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    if (rect.top > maxY) {
      maxY = rect.top;
      bottom = el;
    }
  }
  return bottom;
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

// ─── SCROLL + CLICK HELPERS ─────────────────────────────────────────────────

function scrollToElement(el) {
  el.scrollIntoView({ behavior: "instant", block: "center" });
}

function scrollToAndClick(el) {
  scrollToElement(el);
  setTimeout(() => {
    simulateClick(el);
  }, 200);
}

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
  console.log("[Keyword Monitor] clickCheckbox target:", cb.tagName, cb.className, cb.id);

  // For real <input type="checkbox">, set checked and fire change event.
  if (cb.tagName === "INPUT" && cb.type === "checkbox") {
    if (!cb.checked) {
      cb.focus();
      simulateClick(cb);
      if (!cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
        cb.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    return;
  }

  // This is a visible proxy element (e.g. ClickableInput__VisibleInput).
  // Click it with full mouse event simulation.
  simulateClick(cb);

  // Also find and force-check any hidden <input type="checkbox"> sibling.
  // This ensures React/framework state is updated.
  const parent = cb.parentElement;
  if (parent) {
    const hiddenInput = parent.querySelector('input[type="checkbox"]');
    if (hiddenInput && !hiddenInput.checked) {
      console.log("[Keyword Monitor] Force-checking hidden sibling input:", hiddenInput.id);
      hiddenInput.checked = true;
      hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
      hiddenInput.dispatchEvent(new Event("input", { bubbles: true }));
      // Also dispatch click on the hidden input in case React listens on it.
      hiddenInput.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  }

  // Walk up a few levels looking for a hidden input (may not be direct sibling).
  let ancestor = parent;
  for (let i = 0; i < 4; i++) {
    if (!ancestor || !ancestor.parentElement) break;
    ancestor = ancestor.parentElement;
    const input = ancestor.querySelector('input[type="checkbox"]');
    if (input && !input.checked) {
      console.log("[Keyword Monitor] Force-checking ancestor input:", input.id);
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      break;
    }
  }

  // Try toggling aria-checked for accessible custom checkboxes.
  const ariaChecked = cb.getAttribute("aria-checked");
  if (ariaChecked === "false") {
    cb.setAttribute("aria-checked", "true");
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
