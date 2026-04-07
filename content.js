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
    } else if (phase === "ACTING") {
      // Already in progress — don't re-trigger.
      console.log("[Keyword Monitor] Action in progress, ignoring re-entry.");
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
  console.log("[Keyword Monitor] Follow-up page detected. Starting action attempts...");

  // Set state immediately so re-entry doesn't re-trigger this.
  chrome.runtime.sendMessage({
    type: "SET_STATE",
    state: { phase: "ACTING" },
  });

  // Try repeatedly until we succeed — don't give up and go back to scanning.
  let attempts = 0;
  const maxAttempts = 20; // ~20 seconds of trying

  function tryActions() {
    attempts++;
    console.log("[Keyword Monitor] Follow-up attempt", attempts);

    // Scroll to bottom each attempt to ensure content is loaded.
    window.scrollTo(0, document.body.scrollHeight);

    setTimeout(() => {
      // Try: "Express Interest" button.
      const expressBtn = findButtonByLabel("express interest");
      if (expressBtn) {
        console.log("[Keyword Monitor] Found 'Express Interest'. Trusted-clicking.");
        chrome.runtime.sendMessage({
          type: "TRUSTED_CLICK_SELECTOR",
          selector: '[class*="express"], button, a',
        }, (result) => {
          console.log("[Keyword Monitor] Express Interest result:", result);
          // Fallback: also try humanClick.
          humanClick(expressBtn);
          chrome.runtime.sendMessage({ type: "SET_STATE", state: { phase: "COMPLETE" } });
          resetAfterDelay();
        });
        return;
      }

      // Try: checkbox + submit page.
      // Check if we have the 99designs accept-statement checkbox.
      const hasCheckbox = document.querySelector('#accept-statement') ||
                          document.querySelector('label[for="accept-statement"]') ||
                          findBottomCheckbox();
      const hasSubmit = findButtonByLabel("submit");

      if (hasCheckbox && hasSubmit) {
        console.log("[Keyword Monitor] Found checkbox + submit. Delegating to background for trusted clicks.");

        chrome.runtime.sendMessage({
          type: "KEYWORD_MATCH",
          keyword: "checkbox page reached",
          count: 1,
        });

        // Let background handle everything via debugger —
        // it will scroll, find, and click elements with correct coords.
        chrome.runtime.sendMessage({
          type: "TRUSTED_CHECKBOX_SUBMIT",
          checkboxSelector: 'label[for="accept-statement"]',
          submitSelector: 'button, [role="button"], input[type="submit"]',
        }, (result) => {
          console.log("[Keyword Monitor] Trusted checkbox+submit result:", result);
          if (result?.ok) {
            chrome.runtime.sendMessage({ type: "SET_STATE", state: { phase: "COMPLETE" } });
            resetAfterDelay();
          } else {
            // Trusted click failed — retry.
            console.log("[Keyword Monitor] Trusted click failed, retrying...");
            if (attempts < maxAttempts) {
              setTimeout(tryActions, 1500);
            } else {
              resetToScanning();
            }
          }
        });
        return;
      }

      // If only submit found, click it.
      if (hasSubmit) {
        chrome.runtime.sendMessage({
          type: "TRUSTED_CLICK_SELECTOR",
          selector: 'button, [role="button"], input[type="submit"]',
        }, () => {
          chrome.runtime.sendMessage({ type: "SET_STATE", state: { phase: "COMPLETE" } });
          resetAfterDelay();
        });
        return;
      }

      // Nothing found yet — retry.
      if (attempts < maxAttempts) {
        console.log("[Keyword Monitor] Elements not found yet. Retrying in 1s...");
        setTimeout(tryActions, 1000);
      } else {
        console.log("[Keyword Monitor] Max attempts reached. Returning to scan mode.");
        resetToScanning();
      }
    }, 500);
  }

  // Start first attempt after a delay for page to load.
  setTimeout(tryActions, 1500);
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
  // There's a <label for="accept-statement"> that natively toggles it.
  // Clicking the label is the most reliable approach.

  // First, try to find the accept-statement checkbox by ID (99designs).
  const acceptInput = document.querySelector('#accept-statement');
  if (acceptInput) {
    // Best target: the <label for="accept-statement"> element.
    const label = document.querySelector('label[for="accept-statement"]');
    if (label) {
      console.log("[Keyword Monitor] Found <label for='accept-statement'> — using it as click target");
      return label;
    }

    // Fallback: the VisibleInput div.
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
    return acceptInput;
  }

  // ── Generic: find any checkbox input and its associated label ──
  const allCheckboxInputs = document.querySelectorAll('input[type="checkbox"]');
  for (const input of allCheckboxInputs) {
    // First, try to find a <label for="..."> that targets this input.
    if (input.id) {
      const label = document.querySelector(`label[for="${input.id}"]`);
      if (label) {
        console.log("[Keyword Monitor] Found label for checkbox #" + input.id);
        return label;
      }
    }

    const cls = (input.className || "").toLowerCase();
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

// ─── HUMAN-LIKE MOUSE SIMULATION ────────────────────────────────────────────

function scrollToElement(el) {
  el.scrollIntoView({ behavior: "instant", block: "center" });
}

function scrollToAndClick(el) {
  scrollToElement(el);
  setTimeout(() => {
    humanClick(el);
  }, 200);
}

// Simulate realistic human mouse movement along a curved path, then click.
// Returns a Promise that resolves after the click is done.
function humanClick(el) {
  return new Promise((resolve) => {
    const rect = el.getBoundingClientRect();
    const targetX = rect.left + rect.width / 2 + (Math.random() - 0.5) * (rect.width * 0.3);
    const targetY = rect.top + rect.height / 2 + (Math.random() - 0.5) * (rect.height * 0.3);

    // Start from a random offset position (simulates cursor coming from elsewhere).
    const startX = targetX + (Math.random() - 0.5) * 300 - 150;
    const startY = targetY - 100 - Math.random() * 200;

    // Generate a Bezier curve path with some randomness.
    const steps = 15 + Math.floor(Math.random() * 10); // 15–25 steps
    const points = generateCurvePath(startX, startY, targetX, targetY, steps);

    let i = 0;

    function moveNext() {
      if (i < points.length) {
        const p = points[i];
        const moveEvt = new MouseEvent("mousemove", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: p.x,
          clientY: p.y,
        });
        // Dispatch on document and the element.
        document.dispatchEvent(moveEvt);

        // When we get close, also dispatch mouseenter/mouseover on the target.
        if (i === points.length - 3) {
          el.dispatchEvent(new MouseEvent("mouseenter", {
            bubbles: true, view: window, clientX: p.x, clientY: p.y,
          }));
          el.dispatchEvent(new MouseEvent("mouseover", {
            bubbles: true, view: window, clientX: p.x, clientY: p.y,
          }));
        }

        i++;
        // Variable delay between moves: 8–25ms (human-like).
        const delay = 8 + Math.random() * 17;
        setTimeout(moveNext, delay);
      } else {
        // Mouse is now over the target — pause briefly, then click.
        const pauseBeforeClick = 50 + Math.random() * 100;
        setTimeout(() => {
          performClick(el, targetX, targetY);
          resolve();
        }, pauseBeforeClick);
      }
    }

    moveNext();
  });
}

function generateCurvePath(x0, y0, x1, y1, steps) {
  // Quadratic Bezier with a random control point for natural curvature.
  const cpX = (x0 + x1) / 2 + (Math.random() - 0.5) * 100;
  const cpY = (y0 + y1) / 2 + (Math.random() - 0.5) * 80;

  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Ease-out: faster start, slower approach (like a human).
    const ease = 1 - Math.pow(1 - t, 2);

    const x = (1 - ease) * (1 - ease) * x0 + 2 * (1 - ease) * ease * cpX + ease * ease * x1;
    const y = (1 - ease) * (1 - ease) * y0 + 2 * (1 - ease) * ease * cpY + ease * ease * y1;

    // Add tiny jitter to simulate hand tremor.
    const jitterX = (Math.random() - 0.5) * 2;
    const jitterY = (Math.random() - 0.5) * 2;

    points.push({ x: x + jitterX, y: y + jitterY });
  }
  return points;
}

function performClick(el, x, y) {
  const commonOpts = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x + window.screenX,
    screenY: y + window.screenY,
    button: 0,
    buttons: 1,
  };

  // Full realistic event sequence.
  el.dispatchEvent(new PointerEvent("pointerdown", { ...commonOpts, pointerId: 1, pointerType: "mouse" }));
  el.dispatchEvent(new MouseEvent("mousedown", commonOpts));

  // Brief hold (humans don't release instantly).
  setTimeout(() => {
    const releaseOpts = { ...commonOpts, buttons: 0 };
    el.dispatchEvent(new PointerEvent("pointerup", { ...releaseOpts, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", releaseOpts));
    el.dispatchEvent(new MouseEvent("click", releaseOpts));

    // Also call native .click() as fallback.
    el.click();
  }, 30 + Math.random() * 50);
}

// Legacy wrapper used in some places.
function simulateClick(el) {
  humanClick(el);
}

async function clickCheckbox(cb) {
  console.log("[Keyword Monitor] clickCheckbox target:", cb.tagName, cb.className);

  // If this is a <label for="...">, just human-click it.
  // The browser natively toggles the associated input via the `for` attribute.
  if (cb.tagName === "LABEL") {
    console.log("[Keyword Monitor] Clicking <label> — browser will toggle the checkbox natively.");
    await humanClick(cb);
    return;
  }

  // For real <input type="checkbox">, simulate human click.
  if (cb.tagName === "INPUT" && cb.type === "checkbox") {
    if (!cb.checked) {
      cb.focus();
      await humanClick(cb);
      if (!cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
        cb.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    return;
  }

  // Visible proxy element (e.g. ClickableInput__VisibleInput).
  await humanClick(cb);

  // Also find and force-check any hidden <input type="checkbox"> nearby.
  let ancestor = cb;
  for (let i = 0; i < 5; i++) {
    if (!ancestor || !ancestor.parentElement) break;
    ancestor = ancestor.parentElement;
    const input = ancestor.querySelector('input[type="checkbox"]');
    if (input && !input.checked) {
      console.log("[Keyword Monitor] Force-checking input:", input.id);
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      break;
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
