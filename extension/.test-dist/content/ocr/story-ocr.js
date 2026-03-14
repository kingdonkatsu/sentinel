"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storyOcr = exports.OCR_MAX_HEIGHT = exports.OCR_MAX_WIDTH = exports.OCR_DEFAULT_TIMEOUT_MS = void 0;
exports.normalizeOcrText = normalizeOcrText;
exports.isUsableOcrText = isUsableOcrText;
exports.mapOcrHostSuccess = mapOcrHostSuccess;
exports.mapOcrFailure = mapOcrFailure;
const image_analyser_1 = require("../image-analyser");
const ocr_spike_bridge_1 = require("../dev/ocr-spike-bridge");
const OCR_HOST_PAGE = "src/content/dev/ocr-host.html";
exports.OCR_DEFAULT_TIMEOUT_MS = 3000;
exports.OCR_MAX_WIDTH = 1080;
exports.OCR_MAX_HEIGHT = 1920;
class StoryOcrRunner {
    host = new OcrHostClient();
    queue = Promise.resolve();
    async recognizeViewer(viewer, timeoutMs = exports.OCR_DEFAULT_TIMEOUT_MS) {
        const task = this.queue.then(() => this.runRecognize(viewer, timeoutMs));
        this.queue = task.then(() => undefined, () => undefined);
        return task;
    }
    dispose() {
        this.host.stop();
        this.queue = Promise.resolve();
    }
    async runRecognize(viewer, timeoutMs) {
        const startedAt = performance.now();
        try {
            const media = (0, image_analyser_1.findPrimaryStoryMedia)(viewer);
            if (!media) {
                throw new Error("No renderable story media found");
            }
            const summary = await this.host.recognize(buildHostMediaRequest(media, exports.OCR_MAX_WIDTH, exports.OCR_MAX_HEIGHT), timeoutMs);
            return mapOcrHostSuccess(summary, Math.round(performance.now() - startedAt));
        }
        catch (error) {
            return mapOcrFailure(error, Math.round(performance.now() - startedAt));
        }
    }
}
class OcrHostClient {
    iframe = null;
    frameReady = null;
    pending = new Map();
    hostUrl;
    hostOrigin;
    started = false;
    constructor() {
        this.hostUrl = chrome.runtime.getURL(OCR_HOST_PAGE);
        this.hostOrigin = new URL(this.hostUrl).origin;
    }
    start() {
        if (this.started) {
            return;
        }
        this.started = true;
        window.addEventListener("message", this.onMessage);
    }
    stop() {
        this.started = false;
        window.removeEventListener("message", this.onMessage);
        for (const { reject } of this.pending.values()) {
            reject(new Error("OCR host shut down"));
        }
        this.pending.clear();
        if (this.iframe) {
            this.iframe.remove();
            this.iframe = null;
        }
        this.frameReady = null;
    }
    async recognize(media, timeoutMs) {
        this.start();
        const targetWindow = await this.ensureFrame();
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            const request = {
                type: ocr_spike_bridge_1.OCR_HOST_REQUEST_TYPE,
                requestId,
                media,
                timeoutMs,
            };
            targetWindow.postMessage(request, this.hostOrigin);
        });
    }
    async ensureFrame() {
        if (this.iframe?.contentWindow) {
            return this.iframe.contentWindow;
        }
        if (this.frameReady) {
            return this.frameReady;
        }
        this.frameReady = new Promise((resolve, reject) => {
            const iframe = document.createElement("iframe");
            iframe.id = "sentinel-ocr-host-frame";
            iframe.src = this.hostUrl;
            iframe.style.display = "none";
            iframe.setAttribute("aria-hidden", "true");
            iframe.addEventListener("load", () => {
                if (!iframe.contentWindow) {
                    reject(new Error("OCR host iframe loaded without contentWindow"));
                    return;
                }
                this.iframe = iframe;
                resolve(iframe.contentWindow);
            }, { once: true });
            iframe.addEventListener("error", () => {
                this.frameReady = null;
                reject(new Error("Failed to load OCR host iframe"));
            }, { once: true });
            (document.documentElement || document.body || document.head).appendChild(iframe);
        }).catch((error) => {
            this.frameReady = null;
            if (this.iframe) {
                this.iframe.remove();
                this.iframe = null;
            }
            throw error;
        });
        return this.frameReady;
    }
    onMessage = (event) => {
        if (event.origin !== this.hostOrigin ||
            !event.data ||
            typeof event.data !== "object" ||
            event.data.type !== ocr_spike_bridge_1.OCR_HOST_RESPONSE_TYPE) {
            return;
        }
        const response = event.data;
        const pending = this.pending.get(response.requestId);
        if (!pending) {
            return;
        }
        this.pending.delete(response.requestId);
        if (!response.ok || !response.result) {
            pending.reject(new Error(response.error || "OCR host failed"));
            return;
        }
        pending.resolve(response.result);
    };
}
function normalizeOcrText(value) {
    return value.replace(/\s+/g, " ").trim();
}
function isUsableOcrText(text) {
    const normalized = normalizeOcrText(text);
    if (!normalized) {
        return false;
    }
    if (!/[A-Za-z0-9]/.test(normalized)) {
        return false;
    }
    const compact = normalized.replace(/[^A-Za-z0-9]/g, "");
    if (compact.length < 4) {
        return false;
    }
    const tokens = tokenizeOcrText(normalized);
    if (tokens.length === 0) {
        return false;
    }
    if (tokens.every((token) => token.length <= 1 || /^\d+$/.test(token))) {
        return false;
    }
    const hasStrongAlphaToken = tokens.some((token) => /[A-Za-z]/.test(token) && token.length >= 4);
    const hasMultipleMediumAlphaTokens = tokens.filter((token) => /[A-Za-z]/.test(token) && token.length >= 3).length >= 2;
    const hasTimeLikeSignal = /\b\d{1,2}:\d{2}\b/.test(normalized) &&
        tokens.some((token) => /[A-Za-z]/.test(token) && token.length >= 2);
    if (!hasStrongAlphaToken && !hasMultipleMediumAlphaTokens && !hasTimeLikeSignal) {
        return false;
    }
    const artifactLikeTokens = tokens.filter((token) => token.length <= 1 ||
        /^\d+$/.test(token) ||
        (/^[A-Za-z]+$/.test(token) &&
            token.length <= 2 &&
            !/[aeiouy]/i.test(token)));
    if (tokens.length >= 3 && artifactLikeTokens.length / tokens.length >= 0.75) {
        return false;
    }
    return true;
}
function mapOcrHostSuccess(result, latencyMs) {
    const metadata = {
        captureHeight: result.captureHeight,
        captureWidth: result.captureWidth,
        confidence: result.confidence ?? undefined,
        confidentWordCount: result.confidentWordCount,
        sourceHeight: result.sourceHeight,
        sourceWidth: result.sourceWidth,
        strategy: result.strategy,
        totalWordCount: result.totalWordCount,
    };
    if (result.strategy === "no-text-timeout") {
        return {
            status: "timeout",
            latencyMs,
            strategy: result.strategy,
            ...metadata,
        };
    }
    const text = normalizeOcrText(result.text ?? "");
    if (!isUsableOcrText(text)) {
        return {
            status: "no_text",
            latencyMs,
            ...metadata,
        };
    }
    return {
        status: "ok",
        latencyMs,
        text,
        ...metadata,
    };
}
function mapOcrFailure(error, latencyMs) {
    const message = normalizeError(error);
    if (/timed out/i.test(message)) {
        return {
            status: "timeout",
            error: message,
            latencyMs,
        };
    }
    return {
        status: "error",
        error: message,
        latencyMs,
    };
}
function buildHostMediaRequest(media, maxWidth, maxHeight) {
    const sourceUrl = media instanceof HTMLImageElement
        ? media.currentSrc || media.src
        : media.currentSrc || media.src;
    if (!sourceUrl) {
        throw new Error("Story media URL is missing");
    }
    if (media instanceof HTMLImageElement) {
        return {
            kind: "image",
            maxHeight,
            maxWidth,
            url: sourceUrl,
        };
    }
    return {
        currentTime: media.currentTime,
        kind: "video",
        maxHeight,
        maxWidth,
        url: sourceUrl,
    };
}
function tokenizeOcrText(text) {
    return normalizeOcrText(text)
        .split(/\s+/)
        .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
        .filter(Boolean);
}
function normalizeError(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (typeof error === "string" && error.trim()) {
        return error;
    }
    if (error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string") {
        return error.message;
    }
    try {
        return JSON.stringify(error);
    }
    catch {
        return "OCR failed unexpectedly";
    }
}
let sharedStoryOcr = null;
function getSharedStoryOcr() {
    if (!sharedStoryOcr) {
        sharedStoryOcr = new StoryOcrRunner();
    }
    return sharedStoryOcr;
}
exports.storyOcr = {
    dispose() {
        sharedStoryOcr?.dispose();
        sharedStoryOcr = null;
    },
    recognizeViewer(viewer, timeoutMs = exports.OCR_DEFAULT_TIMEOUT_MS) {
        return getSharedStoryOcr().recognizeViewer(viewer, timeoutMs);
    },
};
