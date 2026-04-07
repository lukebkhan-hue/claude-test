// Content script — injected into every page.
// Uses MutationObserver for real-time, refresh-free monitoring.

let observer = null;
let config = null;
// Track cumulative count per keyword so repeat occurrences trigger new alerts.
let keywordCounts = {};

// Request config from background on load.
chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response && response.enabled) {
    applyConfig(response);
  }
});

// Listen for config pushes from background.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_MONITORING") {
    applyConfig(msg.config);
    sendResponse({ ok: true });
  }
});

function applyConfig(newConfig) {
  // Stop any existing observer before reconfiguring.
  stopMonitoring();

  config = newConfig;
  if (!config.enabled || !config.targetUrl || !config.keywords) return;

  // Check if current page URL matches the target pattern.
  if (!urlMatches(window.location.href, config.targetUrl)) return;

  // Parse keywords (comma-separated, trimmed, lowercased).
  const keywords = config.keywords
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  if (keywords.length === 0) return;

  // Reset counts only if keywords changed.
  const keyStr = keywords.join("|");
  if (keywordCounts.__keyStr !== keyStr) {
    keywordCounts = { __keyStr: keyStr };
  }

  // Initial full-page scan.
  scanNode(document.body, keywords);

  // Observe all future DOM mutations.
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Scan added nodes.
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          scanNode(node, keywords);
        }
      }
      // Also catch text changes within existing nodes.
      if (mutation.type === "characterData" && mutation.target) {
        scanNode(mutation.target, keywords);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  console.log("[Keyword Monitor] Monitoring active for:", keywords.join(", "));
}

function stopMonitoring() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function urlMatches(current, pattern) {
  // Support simple substring/glob matching.
  // If the pattern starts with "http" treat it as a prefix match.
  // Otherwise treat it as a substring match.
  const normalizedCurrent = current.toLowerCase();
  const normalizedPattern = pattern.toLowerCase().trim();

  // Exact or prefix
  if (normalizedCurrent.startsWith(normalizedPattern)) return true;
  // Substring
  if (normalizedCurrent.includes(normalizedPattern)) return true;

  return false;
}

function scanNode(root, keywords) {
  // Collect all text content under the root.
  const text = (root.textContent || "").toLowerCase();
  if (!text) return;

  for (const keyword of keywords) {
    // Count how many times this keyword appears in the scanned text.
    const occurrences = countOccurrences(text, keyword);
    if (occurrences === 0) continue;

    const prevCount = keywordCounts[keyword] || 0;

    // We track the cumulative maximum seen in the full page to detect NEW
    // appearances. On each mutation we re-scan the full body to get the
    // accurate total.
    const totalInPage = countOccurrences(
      (document.body.textContent || "").toLowerCase(),
      keyword
    );

    if (totalInPage > prevCount) {
      // New occurrences detected — alert for each one.
      const newOccurrences = totalInPage - prevCount;
      keywordCounts[keyword] = totalInPage;

      for (let i = 0; i < newOccurrences; i++) {
        chrome.runtime.sendMessage({
          type: "KEYWORD_MATCH",
          keyword: keyword,
          count: prevCount + i + 1,
        });
      }
    }
  }
}

function countOccurrences(text, keyword) {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(keyword, pos)) !== -1) {
    count++;
    pos += keyword.length;
  }
  return count;
}
