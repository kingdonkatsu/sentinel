"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const types_1 = require("../shared/types");
const apiUrlInput = document.getElementById("apiUrl");
const apiKeyInput = document.getElementById("apiKey");
const thresholdInput = document.getElementById("threshold");
const thresholdValue = document.getElementById("thresholdValue");
const imageWeightInput = document.getElementById("imageWeight");
const imageWeightValue = document.getElementById("imageWeightValue");
const textWeightValue = document.getElementById("textWeightValue");
const saveBtn = document.getElementById("saveBtn");
const pingBtn = document.getElementById("pingBtn");
const analyseBtn = document.getElementById("analyseBtn");
const statusEl = document.getElementById("status");
void initialisePopup();
thresholdInput.addEventListener("input", () => {
    thresholdValue.textContent = thresholdInput.value;
});
imageWeightInput.addEventListener("input", updateWeightDisplay);
saveBtn.addEventListener("click", async () => {
    await runWithButtonState(saveBtn, async () => {
        try {
            const config = getConfigFromForm();
            const result = await sendRuntimeMessage({
                type: "SAVE_CONFIG",
                config,
            });
            if (!result.ok) {
                showStatus(result.error || "Could not save configuration.", true);
                return;
            }
            showStatus("Settings saved. Reload Instagram if it is already open.");
        }
        catch (error) {
            showRuntimeError("Could not save configuration.", error);
        }
    });
});
pingBtn.addEventListener("click", async () => {
    await runWithButtonState(pingBtn, async () => {
        try {
            const result = await sendRuntimeMessage({
                type: "PING_API",
            });
            if (!result.ok) {
                showStatus(result.error || "Unable to reach backend API.", true);
                return;
            }
            showStatus("Backend API is reachable.");
        }
        catch (error) {
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
            }));
            if (!response?.ok) {
                showStatus(response?.message || "Could not analyse the current Instagram tab.", true);
                return;
            }
            showStatus(response.message);
        }
        catch {
            showStatus("Instagram content script is not ready. Reload the tab and try again.", true);
        }
    });
});
async function loadConfig() {
    const stored = await sendRuntimeMessage({
        type: "GET_CONFIG",
    });
    apiUrlInput.value =
        stored.sentinel_api_url || types_1.DEFAULT_CONFIG.sentinel_api_url;
    apiKeyInput.value =
        stored.sentinel_api_key || types_1.DEFAULT_CONFIG.sentinel_api_key;
    thresholdInput.value = String(stored.sentinel_threshold || types_1.DEFAULT_CONFIG.sentinel_threshold);
    thresholdValue.textContent = thresholdInput.value;
    const weights = stored.sentinel_weights || types_1.DEFAULT_CONFIG.sentinel_weights;
    imageWeightInput.value = String(Math.round(weights.image * 100));
    updateWeightDisplay();
}
async function initialisePopup() {
    try {
        await loadConfig();
    }
    catch (error) {
        showRuntimeError("Could not load saved settings.", error);
    }
}
function getConfigFromForm() {
    const imageWeight = parseInt(imageWeightInput.value, 10) / 100;
    return {
        sentinel_api_url: apiUrlInput.value.trim() || types_1.DEFAULT_CONFIG.sentinel_api_url,
        sentinel_api_key: apiKeyInput.value.trim() || types_1.DEFAULT_CONFIG.sentinel_api_key,
        sentinel_threshold: parseInt(thresholdInput.value, 10) || types_1.DEFAULT_CONFIG.sentinel_threshold,
        sentinel_weights: {
            image: imageWeight,
            text: 1 - imageWeight,
        },
    };
}
function updateWeightDisplay() {
    const imageWeight = parseInt(imageWeightInput.value, 10);
    const textWeight = 100 - imageWeight;
    imageWeightValue.textContent = `${imageWeight}%`;
    textWeightValue.textContent = `${textWeight}%`;
}
function showStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.style.display = "block";
    statusEl.classList.toggle("error", isError);
}
function showRuntimeError(prefix, error) {
    const details = error instanceof Error && error.message ? ` ${error.message}` : "";
    showStatus(`${prefix}${details}`, true);
}
async function sendRuntimeMessage(message) {
    return (await chrome.runtime.sendMessage(message));
}
async function runWithButtonState(button, action) {
    const originalText = button.textContent;
    button.disabled = true;
    button.style.opacity = "0.7";
    try {
        await action();
    }
    finally {
        button.disabled = false;
        button.style.opacity = "";
        button.textContent = originalText;
    }
}
