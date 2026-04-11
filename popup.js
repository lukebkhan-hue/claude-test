// Popup script — handles configuration UI.

const targetUrlEl = document.getElementById("targetUrl");
const keywordsEl = document.getElementById("keywords");
const enabledEl = document.getElementById("enabled");
const saveBtn = document.getElementById("save");
const resumeBtn = document.getElementById("resume");
const statusEl = document.getElementById("status");

// Load saved config on open.
chrome.storage.local.get(["targetUrl", "keywords", "enabled"], (data) => {
  targetUrlEl.value = data.targetUrl || "";
  keywordsEl.value = data.keywords || "";
  enabledEl.checked = !!data.enabled;
});

// Check current state and show Resume button if waiting.
chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
  if (state?.phase === "WAITING_FOR_USER") {
    resumeBtn.style.display = "block";
    statusEl.style.color = "#ff9800";
    statusEl.textContent = "Waiting for you to check box & submit.";
  }
});

saveBtn.addEventListener("click", () => {
  const targetUrl = targetUrlEl.value.trim();
  const keywords = keywordsEl.value.trim();
  const enabled = enabledEl.checked;

  if (enabled && !targetUrl) {
    statusEl.style.color = "#f44336";
    statusEl.textContent = "Please enter a target URL.";
    return;
  }

  if (enabled && !keywords) {
    statusEl.style.color = "#f44336";
    statusEl.textContent = "Please enter at least one keyword.";
    return;
  }

  chrome.storage.local.set({ targetUrl, keywords, enabled }, () => {
    statusEl.style.color = "#4caf50";
    statusEl.textContent = enabled ? "Monitoring active!" : "Monitoring paused.";
    resumeBtn.style.display = "none";
    setTimeout(() => {
      statusEl.textContent = "";
    }, 2000);
  });
});

// Resume button — resets state to SCANNING and navigates back to target URL.
resumeBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({
    type: "SET_STATE",
    state: { phase: "SCANNING" },
  });

  // Navigate active tab back to target URL.
  chrome.storage.local.get(["targetUrl"], (data) => {
    if (data.targetUrl) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.update(tabs[0].id, { url: data.targetUrl });
        }
      });
    }
  });

  resumeBtn.style.display = "none";
  statusEl.style.color = "#4caf50";
  statusEl.textContent = "Resumed! Scanning...";
});
