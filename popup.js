// Popup script — handles configuration UI.

const targetUrlEl = document.getElementById("targetUrl");
const keywordsEl = document.getElementById("keywords");
const enabledEl = document.getElementById("enabled");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

// Load saved config on open.
chrome.storage.local.get(["targetUrl", "keywords", "enabled"], (data) => {
  targetUrlEl.value = data.targetUrl || "";
  keywordsEl.value = data.keywords || "";
  enabledEl.checked = !!data.enabled;
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
    setTimeout(() => {
      statusEl.textContent = "";
    }, 2000);
  });
});
