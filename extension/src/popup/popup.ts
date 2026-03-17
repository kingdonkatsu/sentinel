import type { StoredSentinelConfig, TransmissionResult } from "../shared/types";
import { DEFAULT_CONFIG } from "../shared/types";

const apiUrlInput = document.getElementById("apiUrl") as HTMLInputElement;
const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const thresholdInput = document.getElementById("threshold") as HTMLInputElement;
const thresholdValue = document.getElementById("thresholdValue") as HTMLElement;
const imageWeightInput = document.getElementById("imageWeight") as HTMLInputElement;
const imageWeightValue = document.getElementById("imageWeightValue") as HTMLElement;
const textWeightValue = document.getElementById("textWeightValue") as HTMLElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const pingBtn = document.getElementById("pingBtn") as HTMLButtonElement;
const analyseBtn = document.getElementById("analyseBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;

void initialisePopup();

thresholdInput.addEventListener("input", () => {
  thresholdValue.textContent = thresholdInput.value;
});

imageWeightInput.addEventListener("input", updateWeightDisplay);

saveBtn.addEventListener("click", async () => {
  await runWithButtonState(saveBtn, async () => {
    try {
      const config = getConfigFromForm();
      const result = await sendRuntimeMessage<TransmissionResult>({
        type: "SAVE_CONFIG",
        config,
      });

      if (!result.ok) {
        showStatus(result.error || "Could not save configuration.", true);
        return;
      }

      showStatus("Settings saved. Reload Instagram if it is already open.");
    } catch (error) {
      showRuntimeError("Could not save configuration.", error);
    }
  });
});

pingBtn.addEventListener("click", async () => {
  await runWithButtonState(pingBtn, async () => {
    try {
      const result = await sendRuntimeMessage<TransmissionResult>({
        type: "PING_API",
      });

      if (!result.ok) {
        showStatus(result.error || "Unable to reach backend API.", true);
        return;
      }

      showStatus("Backend API is reachable.");
    } catch (error) {
      showRuntimeError("Could not contact the extension background worker.", error);
    }
  });
});

analyseBtn.addEventListener("click", async () => {
  await runWithButtonState(analyseBtn, async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab?.id) {
      showStatus("Open Instagram in the active tab first.", true);
      return;
    }

    if (!tab.url?.startsWith("https://www.instagram.com/")) {
      showStatus("Switch to an Instagram tab before running analysis.", true);
      return;
    }

    try {
      const response = (await chrome.tabs.sendMessage(tab.id, {
        type: "MANUAL_ANALYSE_STORY",
      })) as
        | {
            ok: boolean;
            message: string;
          }
        | undefined;

      if (!response?.ok) {
        showStatus(
          response?.message || "Could not analyse the current Instagram tab.",
          true
        );
        return;
      }

      showStatus(response.message);
    } catch {
      showStatus(
        "Instagram content script is not ready. Reload the tab and try again.",
        true
      );
    }
  });
});

async function loadConfig(): Promise<void> {
  const stored = await sendRuntimeMessage<Partial<StoredSentinelConfig>>({
    type: "GET_CONFIG",
  });

  apiUrlInput.value =
    stored.sentinel_api_url || DEFAULT_CONFIG.sentinel_api_url;
  apiKeyInput.value =
    stored.sentinel_api_key || DEFAULT_CONFIG.sentinel_api_key;
  thresholdInput.value = String(
    stored.sentinel_threshold || DEFAULT_CONFIG.sentinel_threshold
  );
  thresholdValue.textContent = thresholdInput.value;

  const weights = stored.sentinel_weights || DEFAULT_CONFIG.sentinel_weights;
  imageWeightInput.value = String(Math.round(weights.image * 100));
  updateWeightDisplay();
}

async function initialisePopup(): Promise<void> {
  try {
    await loadConfig();
  } catch (error) {
    showRuntimeError("Could not load saved settings.", error);
  }
}

function getConfigFromForm(): StoredSentinelConfig {
  const imageWeight = parseInt(imageWeightInput.value, 10) / 100;

  return {
    sentinel_api_url: apiUrlInput.value.trim() || DEFAULT_CONFIG.sentinel_api_url,
    sentinel_api_key: apiKeyInput.value.trim() || DEFAULT_CONFIG.sentinel_api_key,
    sentinel_threshold:
      parseInt(thresholdInput.value, 10) || DEFAULT_CONFIG.sentinel_threshold,
    sentinel_weights: {
      image: imageWeight,
      text: 1 - imageWeight,
    },
  };
}

function updateWeightDisplay() {
  const imageWeight = parseInt(imageWeightInput.value, 10);
  const textWeight = 100 - imageWeight;

  imageWeightValue.textContent = `${imageWeight}% IMG`;
  textWeightValue.textContent = `${textWeight}% TXT`;
}

function showStatus(message: string, isError = false) {
  statusEl.textContent = message;
  statusEl.style.display = "block";
  statusEl.classList.remove("success", "error");
  statusEl.classList.add(isError ? "error" : "success");
}

function showRuntimeError(prefix: string, error: unknown) {
  const details =
    error instanceof Error && error.message ? ` ${error.message}` : "";
  showStatus(`${prefix}${details}`, true);
}

async function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  return (await chrome.runtime.sendMessage(message)) as T;
}

async function runWithButtonState(
  button: HTMLButtonElement,
  action: () => Promise<void>
) {
  const originalText = button.textContent;
  button.disabled = true;
  button.style.opacity = "0.7";

  try {
    await action();
  } finally {
    button.disabled = false;
    button.style.opacity = "";
    button.textContent = originalText;
  }
}
