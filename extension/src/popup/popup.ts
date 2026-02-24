const apiUrlInput = document.getElementById("apiUrl") as HTMLInputElement;
const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const thresholdInput = document.getElementById("threshold") as HTMLInputElement;
const thresholdValue = document.getElementById("thresholdValue")!;
const imageWeightInput = document.getElementById("imageWeight") as HTMLInputElement;
const imageWeightValue = document.getElementById("imageWeightValue")!;
const textWeightValue = document.getElementById("textWeightValue")!;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;

// Load saved config
chrome.storage.local.get(
  ["sentinel_api_url", "sentinel_api_key", "sentinel_threshold", "sentinel_weights"],
  (result) => {
    apiUrlInput.value = result.sentinel_api_url || "http://localhost:8000";
    apiKeyInput.value = result.sentinel_api_key || "";
    thresholdInput.value = String(result.sentinel_threshold || 70);
    thresholdValue.textContent = String(result.sentinel_threshold || 70);

    const weights = result.sentinel_weights || { image: 0.5, text: 0.5 };
    imageWeightInput.value = String(Math.round(weights.image * 100));
    updateWeightDisplay();
  }
);

thresholdInput.addEventListener("input", () => {
  thresholdValue.textContent = thresholdInput.value;
});

imageWeightInput.addEventListener("input", updateWeightDisplay);

function updateWeightDisplay() {
  const imgPct = parseInt(imageWeightInput.value, 10);
  const txtPct = 100 - imgPct;
  imageWeightValue.textContent = `${imgPct}%`;
  textWeightValue.textContent = `${txtPct}%`;
}

saveBtn.addEventListener("click", () => {
  const imgWeight = parseInt(imageWeightInput.value, 10) / 100;

  chrome.storage.local.set(
    {
      sentinel_api_url: apiUrlInput.value.trim(),
      sentinel_api_key: apiKeyInput.value.trim(),
      sentinel_threshold: parseInt(thresholdInput.value, 10),
      sentinel_weights: {
        image: imgWeight,
        text: 1 - imgWeight,
      },
    },
    () => {
      statusEl.style.display = "block";
      setTimeout(() => {
        statusEl.style.display = "none";
      }, 2000);
    }
  );
});
