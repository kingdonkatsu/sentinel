import type {
  ModalityType,
  RiskScore,
  StoredSentinelConfig,
  TransmissionResult,
} from "../shared/types";
import { DEFAULT_CONFIG } from "../shared/types";

const CONFIG_KEYS = [
  "sentinel_api_url",
  "sentinel_api_key",
  "sentinel_threshold",
  "sentinel_weights",
] as const;

const CONFIRMATION_POLL_ALARM = "sentinel_calibration_poll";
const LAST_CHECK_KEY = "sentinel_last_confirmation_check";

// ── Lifecycle ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Sentinel] Extension installed");
  void ensureDefaultConfig();
  void scheduleConfirmationPoll();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureDefaultConfig();
  void scheduleConfirmationPoll();
});

// ── Alarms (MV3 safe periodic task) ───────────────────────────────────────

async function scheduleConfirmationPoll(): Promise<void> {
  if (!chrome.alarms) {
    console.warn(
      "[Sentinel] chrome.alarms API unavailable; confirmation polling disabled"
    );
    return;
  }

  // Minimum period in MV3 is 1 minute
  await chrome.alarms.create(CONFIRMATION_POLL_ALARM, {
    periodInMinutes: 1,
    delayInMinutes: 1,
  });
}

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CONFIRMATION_POLL_ALARM) {
      void pollConfirmations();
    }
  });
} else {
  console.warn(
    "[Sentinel] chrome.alarms API unavailable; confirmation polling disabled"
  );
}

async function pollConfirmations(): Promise<void> {
  const config = await getStoredConfig();
  const stored = await chrome.storage.local.get(LAST_CHECK_KEY);
  const since: number = (stored[LAST_CHECK_KEY] as number | undefined) ?? 0;

  try {
    const res = await fetch(
      `${config.sentinel_api_url}/api/v1/confirmations?since=${since}`,
      { headers: { "X-Sentinel-Key": config.sentinel_api_key } }
    );
    if (!res.ok) return;

    const confirmations = (await res.json()) as Array<{
      username: string;
      modality_scores: Partial<Record<ModalityType, number>>;
      timestamp: number;
    }>;

    if (confirmations.length === 0) return;

    // Forward each confirmation to active Instagram content scripts
    const tabs = await chrome.tabs.query({ url: "*://www.instagram.com/*" });
    for (const confirmation of confirmations) {
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, {
            type: "CALIBRATION_CONFIRM",
            modalityScores: confirmation.modality_scores,
          }).catch(() => {
            // Tab may not have an active content script — ignore
          });
        }
      }
    }

    // Advance cursor to the latest confirmation timestamp
    const latest = Math.max(...confirmations.map((c) => c.timestamp));
    await chrome.storage.local.set({ [LAST_CHECK_KEY]: latest });
  } catch {
    // Network failure — retry next alarm cycle
  }
}

// ── Message handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message, sendResponse);
  return true;
});

async function handleMessage(
  message: unknown,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  try {
    if (!message || typeof message !== "object" || !("type" in message)) {
      sendResponse({ ok: false, error: "Unknown message" });
      return;
    }

    switch ((message as { type: unknown }).type) {
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
        const result = await submitScore(message.score, message.modalityScores);
        sendResponse(result);
        return;
      }

      case "PING_API": {
        const result = await pingApi();
        sendResponse(result);
        return;
      }

      case "FETCH_MEDIA_BYTES": {
        if (!isFetchMediaBytesMessage(message)) {
          sendResponse({ ok: false, error: "Invalid media fetch payload" });
          return;
        }
        const result = await fetchMediaBytes(message.url);
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

// ── API calls ──────────────────────────────────────────────────────────────

async function submitScore(
  score: RiskScore,
  modalityScores?: Partial<Record<ModalityType, number>>
): Promise<TransmissionResult> {
  const config = await getStoredConfig();
  if (!config.sentinel_api_key) {
    return { ok: false, error: "API key is missing" };
  }

  try {
    const apiUrl = `${config.sentinel_api_url}/api/v1/scores`;
    const hasTextScore = typeof modalityScores?.text === "number";
    const hasImageScore =
      typeof modalityScores?.visual === "number" ||
      typeof modalityScores?.video === "number";
    const body: Record<string, unknown> = {
      username: score.username,
      composite_score: score.composite,
      text_score: hasTextScore ? score.textScore : null,
      image_score: hasImageScore ? score.imageScore : null,
      timestamp: score.timestamp,
    };

    if (modalityScores && Object.keys(modalityScores).length > 0) {
      body.modality_scores = modalityScores;
    }

    let response = await postScore(apiUrl, config.sentinel_api_key, body);
    let errorBody = response.ok
      ? ""
      : await response.text().catch(() => "");

    const needsLegacyRetry =
      response.status === 422 &&
      (!hasTextScore || !hasImageScore);

    if (needsLegacyRetry) {
      const legacyBody: Record<string, unknown> = {
        ...body,
        text_score: hasTextScore ? score.textScore : 50,
        image_score: hasImageScore ? score.imageScore : 50,
      };

      console.warn(
        "[Sentinel] Backend rejected nullable sub-scores; retrying with legacy neutral placeholders",
        {
          apiUrl,
          username: score.username,
          status: response.status,
          errorBody,
        }
      );

      response = await postScore(apiUrl, config.sentinel_api_key, legacyBody);
      errorBody = response.ok
        ? ""
        : await response.text().catch(() => "");
    }

    if (!response.ok) {
      console.warn("[Sentinel] Backend score submit failed", {
        apiUrl,
        username: score.username,
        status: response.status,
        errorBody,
      });
      return {
        ok: false,
        status: response.status,
        error: `Backend returned ${response.status}`,
      };
    }

    console.log("[Sentinel] Backend score submitted", {
      apiUrl,
      username: score.username,
      status: response.status,
    });

    return { ok: true, status: response.status };
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "Failed to reach backend";
    console.warn("[Sentinel] Backend score submit threw", {
      apiUrl: `${config.sentinel_api_url}/api/v1/scores`,
      username: score.username,
      error: messageText,
    });
    return { ok: false, error: messageText };
  }
}

async function postScore(
  apiUrl: string,
  apiKey: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sentinel-Key": apiKey,
    },
    body: JSON.stringify(body),
  });
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

async function fetchMediaBytes(
  url: string
): Promise<
  | { ok: true; bytes: ArrayBuffer; contentType: string }
  | { ok: false; error: string; status?: number }
> {
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Media fetch returned ${response.status}`,
      };
    }

    const bytes = await response.arrayBuffer();
    const contentType =
      response.headers.get("content-type") || "application/octet-stream";

    return { ok: true, bytes, contentType };
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "Failed to fetch media bytes";
    return { ok: false, error: messageText };
  }
}

// ── Config helpers ─────────────────────────────────────────────────────────

async function ensureDefaultConfig(): Promise<void> {
  const stored = await chrome.storage.local.get(CONFIG_KEYS);
  const updates: Partial<StoredSentinelConfig> = {};

  if (!stored.sentinel_api_url) updates.sentinel_api_url = DEFAULT_CONFIG.sentinel_api_url;
  if (!stored.sentinel_api_key) updates.sentinel_api_key = DEFAULT_CONFIG.sentinel_api_key;
  if (!stored.sentinel_threshold) updates.sentinel_threshold = DEFAULT_CONFIG.sentinel_threshold;
  if (!stored.sentinel_weights) updates.sentinel_weights = DEFAULT_CONFIG.sentinel_weights;

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

async function getStoredConfig(): Promise<StoredSentinelConfig> {
  await ensureDefaultConfig();
  const config = await chrome.storage.local.get(CONFIG_KEYS);
  return {
    sentinel_api_url: config.sentinel_api_url || DEFAULT_CONFIG.sentinel_api_url,
    sentinel_api_key: config.sentinel_api_key || DEFAULT_CONFIG.sentinel_api_key,
    sentinel_threshold: config.sentinel_threshold || DEFAULT_CONFIG.sentinel_threshold,
    sentinel_weights: config.sentinel_weights || DEFAULT_CONFIG.sentinel_weights,
  };
}

// ── Type guards ────────────────────────────────────────────────────────────

function isSaveConfigMessage(
  message: { type: unknown; [key: string]: unknown }
): message is { type: "SAVE_CONFIG"; config: Partial<StoredSentinelConfig> } {
  return typeof message.config === "object" && message.config !== null;
}

function isSubmitScoreMessage(
  message: { type: unknown; [key: string]: unknown }
): message is {
  type: "SUBMIT_SCORE";
  score: RiskScore;
  modalityScores?: Partial<Record<ModalityType, number>>;
} {
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

function isFetchMediaBytesMessage(
  message: { type: unknown; [key: string]: unknown }
): message is { type: "FETCH_MEDIA_BYTES"; url: string } {
  return typeof message.url === "string" && message.url.length > 0;
}
