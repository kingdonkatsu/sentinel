// Sentinel Background Service Worker
// Manages extension lifecycle and message routing

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Sentinel] Extension installed");

  // Set default config
  chrome.storage.local.get(["sentinel_api_url"], (result) => {
    if (!result.sentinel_api_url) {
      chrome.storage.local.set({
        sentinel_api_url: "http://localhost:8000",
        sentinel_api_key: "sentinel-hackathon-key",
        sentinel_threshold: 70,
        sentinel_weights: { image: 0.5, text: 0.5 },
      });
    }
  });
});

// Handle messages from content script or popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_CONFIG") {
    chrome.storage.local.get(
      [
        "sentinel_api_url",
        "sentinel_api_key",
        "sentinel_threshold",
        "sentinel_weights",
      ],
      (result) => {
        sendResponse(result);
      }
    );
    return true; // Async response
  }

  if (message.type === "SAVE_CONFIG") {
    chrome.storage.local.set(message.config, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});
