"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DevOcrSpike = void 0;
const image_analyser_1 = require("../image-analyser");
const story_ocr_1 = require("../ocr/story-ocr");
const OCR_TRIGGER_EVENT = "sentinel:ocr-spike";
const LOG_PREFIX = "[Sentinel][OCR Spike]";
class DevOcrSpike {
    getViewer;
    overlay = new OcrSpikeOverlay();
    isRunning = false;
    lastProgress = "idle";
    constructor(options) {
        this.getViewer = options.getViewer;
    }
    start() {
        document.addEventListener("keydown", this.onKeyDown, true);
        document.addEventListener(OCR_TRIGGER_EVENT, this.onCustomTrigger);
    }
    stop() {
        document.removeEventListener("keydown", this.onKeyDown, true);
        document.removeEventListener(OCR_TRIGGER_EVENT, this.onCustomTrigger);
        this.overlay.dismiss();
    }
    onKeyDown = (event) => {
        if (!event.altKey ||
            !event.shiftKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.code !== "KeyO") {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        void this.run("keyboard");
    };
    onCustomTrigger = () => {
        void this.run("custom-event");
    };
    async run(trigger) {
        if (this.isRunning) {
            this.overlay.render({
                state: "running",
                title: "OCR spike already running",
                detail: this.lastProgress,
            });
            console.warn(`${LOG_PREFIX} Trigger ignored; OCR is already running`);
            return;
        }
        this.isRunning = true;
        const startedAt = performance.now();
        try {
            const viewer = this.getViewer();
            if (!viewer) {
                throw new Error("No Instagram story viewer detected");
            }
            const media = (0, image_analyser_1.findPrimaryStoryMedia)(viewer);
            if (!media) {
                throw new Error("No renderable story media found");
            }
            this.overlay.render({
                state: "running",
                title: "OCR spike running",
                detail: "Inspecting story media",
            });
            this.overlay.render({
                state: "running",
                title: "OCR spike running",
                detail: `Running shared OCR on ${media instanceof HTMLImageElement ? "image" : "video"} media`,
            });
            this.lastProgress = "running OCR";
            const mediaType = media instanceof HTMLImageElement ? "image" : "video";
            const result = await story_ocr_1.storyOcr.recognizeViewer(viewer, story_ocr_1.OCR_DEFAULT_TIMEOUT_MS);
            const latencyMs = Math.round(performance.now() - startedAt);
            renderResultLog(trigger, mediaType, result, latencyMs);
            this.overlay.render(buildOverlayPayload(mediaType, result, latencyMs));
        }
        catch (error) {
            const latencyMs = Math.round(performance.now() - startedAt);
            const message = normalizeError(error);
            console.warn(`${LOG_PREFIX} failed`, {
                latencyMs,
                error: message,
                rawError: error,
            });
            this.overlay.render({
                state: "error",
                title: "OCR spike failed",
                detail: message,
                latencyMs,
            });
        }
        finally {
            this.isRunning = false;
        }
    }
}
exports.DevOcrSpike = DevOcrSpike;
class OcrSpikeOverlay {
    shadowHost = null;
    dismissTimer = null;
    render(payload) {
        if (!document.body) {
            return;
        }
        this.ensureHost();
        if (!this.shadowHost?.shadowRoot) {
            return;
        }
        if (this.dismissTimer) {
            clearTimeout(this.dismissTimer);
            this.dismissTimer = null;
        }
        const { accent, background } = paletteForState(payload.state);
        const text = escapeHtml(payload.text ?? "");
        const latency = typeof payload.latencyMs === "number" ? `${payload.latencyMs}ms` : "n/a";
        const confidence = typeof payload.confidence === "number"
            ? `${payload.confidence.toFixed(1)}`
            : "n/a";
        this.shadowHost.shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        .panel {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          width: min(360px, calc(100vw - 24px));
          box-sizing: border-box;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: ${background};
          color: #f8fafc;
          box-shadow: 0 18px 45px rgba(0, 0, 0, 0.35);
          font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          overflow: hidden;
          backdrop-filter: blur(10px);
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 14px 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        }
        .title {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .dot {
          width: 9px;
          height: 9px;
          border-radius: 999px;
          flex: none;
          background: ${accent};
          box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.08);
        }
        .detail {
          padding: 10px 14px 0;
          color: rgba(248, 250, 252, 0.82);
        }
        .meta {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          padding: 12px 14px 0;
        }
        .meta-card {
          border-radius: 10px;
          background: rgba(15, 23, 42, 0.28);
          padding: 8px 10px;
        }
        .meta-label {
          font-size: 10px;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          color: rgba(248, 250, 252, 0.62);
        }
        .meta-value {
          margin-top: 2px;
          font-size: 13px;
          font-weight: 600;
        }
        .text {
          margin: 12px 14px 14px;
          padding: 10px 11px;
          border-radius: 10px;
          background: rgba(15, 23, 42, 0.35);
          color: #f8fafc;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 190px;
          overflow: auto;
        }
      </style>
      <div class="panel" role="status" aria-live="polite">
        <div class="header">
          <div class="title">${escapeHtml(payload.title)}</div>
          <div class="dot"></div>
        </div>
        <div class="detail">${escapeHtml(payload.detail)}</div>
        <div class="meta">
          <div class="meta-card">
            <div class="meta-label">Latency</div>
            <div class="meta-value">${latency}</div>
          </div>
          <div class="meta-card">
            <div class="meta-label">Confidence</div>
            <div class="meta-value">${confidence}</div>
          </div>
        </div>
        <div class="text">${text || "(empty)"}</div>
      </div>
    `;
        if (payload.state !== "running") {
            this.dismissTimer = window.setTimeout(() => this.dismiss(), 12000);
        }
    }
    dismiss() {
        if (this.dismissTimer) {
            clearTimeout(this.dismissTimer);
            this.dismissTimer = null;
        }
        if (this.shadowHost) {
            this.shadowHost.remove();
            this.shadowHost = null;
        }
    }
    ensureHost() {
        if (this.shadowHost?.isConnected) {
            return;
        }
        this.shadowHost = document.createElement("div");
        this.shadowHost.id = "sentinel-ocr-spike-host";
        this.shadowHost.attachShadow({ mode: "open" });
        document.body.appendChild(this.shadowHost);
    }
}
function normalizeWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
}
function renderResultLog(trigger, mediaType, result, latencyMs) {
    const sourceDimensions = typeof result.sourceWidth === "number" && typeof result.sourceHeight === "number"
        ? `${result.sourceWidth}x${result.sourceHeight}`
        : "n/a";
    const captureDimensions = typeof result.captureWidth === "number" && typeof result.captureHeight === "number"
        ? `${result.captureWidth}x${result.captureHeight}`
        : "n/a";
    if (result.status === "error" || result.status === "timeout") {
        console.warn(`${LOG_PREFIX} failed`, {
            latencyMs,
            error: result.error || result.status,
            ocrStatus: result.status,
            strategy: result.strategy,
        });
        return;
    }
    console.groupCollapsed(`${LOG_PREFIX} ${result.status === "ok" ? "result" : "empty"} (${latencyMs}ms)`);
    console.log("trigger", trigger);
    console.log("capture", {
        mediaType,
        sourceDimensions,
        captureDimensions,
    });
    console.log("ocr", {
        latencyMs,
        status: result.status,
        confidence: result.confidence ?? null,
        totalWordCount: result.totalWordCount ?? null,
        confidentWordCount: result.confidentWordCount ?? null,
        strategy: result.strategy,
        text: result.status === "ok" ? result.text : "(empty)",
    });
    console.groupEnd();
}
function buildOverlayPayload(mediaType, result, latencyMs) {
    const captureDimensions = typeof result.captureWidth === "number" && typeof result.captureHeight === "number"
        ? `${result.captureWidth}x${result.captureHeight}`
        : "n/a";
    if (result.status === "ok") {
        return {
            state: "success",
            title: "OCR spike result",
            detail: `${mediaType} ${captureDimensions} via ${result.strategy ?? "ocr"}`,
            latencyMs,
            confidence: result.confidence ?? null,
            text: result.text,
        };
    }
    if (result.status === "no_text") {
        return {
            state: "empty",
            title: "OCR spike empty",
            detail: `${mediaType} ${captureDimensions} via ${result.strategy ?? "ocr"}`,
            latencyMs,
            confidence: result.confidence ?? null,
            text: "(empty)",
        };
    }
    return {
        state: "error",
        title: result.status === "timeout" ? "OCR spike timeout" : "OCR spike failed",
        detail: result.error || result.status,
        latencyMs,
        confidence: result.confidence ?? null,
        text: "",
    };
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function paletteForState(state) {
    switch (state) {
        case "success":
            return {
                accent: "#38bdf8",
                background: "linear-gradient(160deg, rgba(14, 116, 144, 0.96), rgba(15, 23, 42, 0.96))",
            };
        case "empty":
            return {
                accent: "#fbbf24",
                background: "linear-gradient(160deg, rgba(133, 77, 14, 0.96), rgba(15, 23, 42, 0.96))",
            };
        case "error":
            return {
                accent: "#fb7185",
                background: "linear-gradient(160deg, rgba(127, 29, 29, 0.96), rgba(15, 23, 42, 0.96))",
            };
        case "running":
        default:
            return {
                accent: "#a78bfa",
                background: "linear-gradient(160deg, rgba(49, 46, 129, 0.96), rgba(15, 23, 42, 0.96))",
            };
    }
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
        return "OCR spike failed unexpectedly";
    }
}
