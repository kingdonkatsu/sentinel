import type { RiskScore, StoredSentinelConfig, TransmissionResult } from "../shared/types";
import { DEFAULT_CONFIG } from "../shared/types";

const CONFIG_KEYS = [
  "sentinel_api_url",
  "sentinel_api_key",
  "sentinel_threshold",
  "sentinel_weights",
] as const;

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Sentinel] Extension installed");
  void ensureDefaultConfig();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureDefaultConfig();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message, sendResponse);
  return true;
});

async function ensureDefaultConfig(): Promise<void> {
  const stored = await chrome.storage.local.get(CONFIG_KEYS);
  const updates: Partial<StoredSentinelConfig> = {};

  if (!stored.sentinel_api_url) {
    updates.sentinel_api_url = DEFAULT_CONFIG.sentinel_api_url;
  }
  if (!stored.sentinel_api_key) {
    updates.sentinel_api_key = DEFAULT_CONFIG.sentinel_api_key;
  }
  if (!stored.sentinel_threshold) {
    updates.sentinel_threshold = DEFAULT_CONFIG.sentinel_threshold;
  }
  if (!stored.sentinel_weights) {
    updates.sentinel_weights = DEFAULT_CONFIG.sentinel_weights;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

async function handleMessage(
  message: unknown,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  try {
    if (!message || typeof message !== "object" || !("type" in message)) {
      sendResponse({ ok: false, error: "Unknown message" });
      return;
    }

    switch (message.type) {
      case "GET_CONFIG": {
        await ensureDefaultConfig();
        const config = await chrome.storage.local.get(CONFIG_KEYS);
        sendResponse(config);
        return;
      }

      case "SAVE_CONFIG": {
        const config = isSaveConfigMessage(message) ? message.config : {};
        await chrome.storage.local.set(config);
        sendResponse({ ok: true });
        return;
      }

      case "SUBMIT_SCORE": {
        if (!isSubmitScoreMessage(message)) {
          sendResponse({ ok: false, error: "Invalid score payload" });
          return;
        }

        const result = await submitScore(message.score);
        sendResponse(result);
        return;
      }

      case "PING_API": {
        const result = await pingApi();
        sendResponse(result);
        return;
      }

      default:
        sendResponse({ ok: false, error: "Unsupported message type" });
    }
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "Unexpected extension error";
    sendResponse({ ok: false, error: messageText });
  }
}

async function submitScore(score: RiskScore): Promise<TransmissionResult> {
  const config = await getStoredConfig();
  if (!config.sentinel_api_key) {
    return { ok: false, error: "API key is missing" };
  }

  try {
    const response = await fetch(`${config.sentinel_api_url}/api/v1/scores`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentinel-Key": config.sentinel_api_key,
      },
      body: JSON.stringify({
        username: score.username,
        composite_score: score.composite,
        text_score: score.textScore,
        image_score: score.imageScore,
        timestamp: score.timestamp,
      }),
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Backend returned ${response.status}`,
      };
    }

    return { ok: true, status: response.status };
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "Failed to reach backend";
    return { ok: false, error: messageText };
  }
}

async function pingApi(): Promise<TransmissionResult> {
  const config = await getStoredConfig();

  try {
    const response = await fetch(`${config.sentinel_api_url}/api/v1/health`);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Health check returned ${response.status}`,
      };
    }

    return { ok: true, status: response.status };
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "API ping failed";
    return { ok: false, error: messageText };
  }
}

async function getStoredConfig(): Promise<StoredSentinelConfig> {
  await ensureDefaultConfig();
  const config = await chrome.storage.local.get(CONFIG_KEYS);

  return {
    sentinel_api_url:
      config.sentinel_api_url || DEFAULT_CONFIG.sentinel_api_url,
    sentinel_api_key:
      config.sentinel_api_key || DEFAULT_CONFIG.sentinel_api_key,
    sentinel_threshold:
      config.sentinel_threshold || DEFAULT_CONFIG.sentinel_threshold,
    sentinel_weights:
      config.sentinel_weights || DEFAULT_CONFIG.sentinel_weights,
  };
}

function isSaveConfigMessage(
  message: { type: unknown; [key: string]: unknown }
): message is { type: "SAVE_CONFIG"; config: Partial<StoredSentinelConfig> } {
  return typeof message.config === "object" && message.config !== null;
}

function isSubmitScoreMessage(
  message: { type: unknown; [key: string]: unknown }
): message is { type: "SUBMIT_SCORE"; score: RiskScore } {
  if (!("score" in message) || typeof message.score !== "object" || !message.score) {
    return false;
  }

  const score = message.score as Partial<RiskScore>;
  return (
    typeof score.username === "string" &&
    typeof score.composite === "number" &&
    typeof score.textScore === "number" &&
    typeof score.imageScore === "number" &&
    typeof score.timestamp === "number"
  );
}
