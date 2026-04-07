// Offscreen document — exists solely to play the alert sound.
// Service workers cannot play audio directly, so we use this offscreen page.

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PLAY_ALERT") {
    playAlert();
  }
});

function playAlert() {
  const audio = new Audio(chrome.runtime.getURL("sounds/alert.wav"));
  audio.volume = 0.7;
  audio.play().catch((err) => {
    console.error("[Keyword Monitor] Audio playback failed:", err);
  });
}
