"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DevOcrSpike = void 0;
const tesseract_js_1 = require("tesseract.js");
const image_analyser_1 = require("../image-analyser");
const OCR_TRIGGER_EVENT = "sentinel:ocr-spike";
const OCR_TIMEOUT_MS = 3000;
const OCR_MAX_WIDTH = 1080;
const OCR_MAX_HEIGHT = 1920;
const LOG_PREFIX = "[Sentinel][OCR Spike]";
class DevOcrSpike {
    getViewer;
    overlay = new OcrSpikeOverlay();
    worker = null;
    workerPromise = null;
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
        void this.resetWorker();
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
                detail: "Capturing story media",
            });
            const canvas = await (0, image_analyser_1.captureMediaCanvas)(media, {
                maxWidth: OCR_MAX_WIDTH,
                maxHeight: OCR_MAX_HEIGHT,
            });
            if (!canvas) {
                throw new Error("Story capture failed");
            }
            const sourceDimensions = media instanceof HTMLImageElement
                ? `${media.naturalWidth}x${media.naturalHeight}`
                : `${media.videoWidth}x${media.videoHeight}`;
            const captureDimensions = `${canvas.width}x${canvas.height}`;
            this.overlay.render({
                state: "running",
                title: "OCR spike running",
                detail: `Running OCR on ${captureDimensions}`,
            });
            const worker = await this.getWorker();
            const result = await this.recognizeWithTimeout(worker, canvas, OCR_TIMEOUT_MS);
            const latencyMs = Math.round(performance.now() - startedAt);
            const summary = this.summarize(result);
            const mediaType = media instanceof HTMLImageElement ? "image" : "video";
            console.groupCollapsed(`${LOG_PREFIX} ${summary.text ? "result" : "empty"} (${latencyMs}ms)`);
            console.log("trigger", trigger);
            console.log("capture", {
                mediaType,
                sourceDimensions,
                captureDimensions,
            });
            console.log("ocr", {
                latencyMs,
                confidence: summary.confidence,
                totalWordCount: summary.totalWordCount,
                confidentWordCount: summary.confidentWordCount,
                text: summary.text || "(empty)",
            });
            console.groupEnd();
            this.overlay.render({
                state: summary.text ? "success" : "empty",
                title: summary.text ? "OCR spike result" : "OCR spike empty",
                detail: `${mediaType} ${captureDimensions}`,
                latencyMs,
                confidence: summary.confidence,
                text: summary.text || "(empty)",
            });
        }
        catch (error) {
            const latencyMs = Math.round(performance.now() - startedAt);
            const message = error instanceof Error ? error.message : "OCR spike failed unexpectedly";
            if (/timeout/i.test(message)) {
                await this.resetWorker();
            }
            console.warn(`${LOG_PREFIX} failed`, {
                latencyMs,
                error: message,
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
    async getWorker() {
        if (this.worker) {
            return this.worker;
        }
        if (this.workerPromise) {
            return this.workerPromise;
        }
        this.workerPromise = (0, tesseract_js_1.createWorker)("eng", tesseract_js_1.OEM.LSTM_ONLY, {
            cacheMethod: "none",
            corePath: chrome.runtime.getURL("models/tesseract"),
            langPath: chrome.runtime.getURL("models/tesseract/lang-data/4.0.0_best_int"),
            logger: (message) => {
                const progressPercent = Math.round((message.progress ?? 0) * 100);
                this.lastProgress = `${message.status} (${progressPercent}%)`;
                if (this.isRunning) {
                    this.overlay.render({
                        state: "running",
                        title: "OCR spike running",
                        detail: this.lastProgress,
                    });
                }
            },
            workerBlobURL: false,
            workerPath: chrome.runtime.getURL("models/tesseract/worker.min.js"),
        })
            .then(async (worker) => {
            await worker.setParameters({
                preserve_interword_spaces: "1",
                tessedit_pageseg_mode: tesseract_js_1.PSM.SPARSE_TEXT,
                user_defined_dpi: "150",
            });
            this.worker = worker;
            this.lastProgress = "ready";
            return worker;
        })
            .catch(async (error) => {
            this.workerPromise = null;
            if (this.worker) {
                await this.resetWorker();
            }
            throw error;
        });
        return this.workerPromise;
    }
    async resetWorker() {
        const worker = this.worker;
        this.worker = null;
        this.workerPromise = null;
        this.lastProgress = "idle";
        if (worker) {
            try {
                await worker.terminate();
            }
            catch {
                // Ignore worker shutdown failures in the spike path.
            }
        }
    }
    recognizeWithTimeout(worker, image, timeoutMs) {
        const recognizePromise = worker.recognize(image, {}, {
            blocks: true,
            text: true,
        });
        return Promise.race([
            recognizePromise,
            new Promise((_, reject) => {
                window.setTimeout(() => {
                    reject(new Error(`OCR timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
    }
    summarize(result) {
        const text = normalizeWhitespace(result.data.text ?? "");
        const words = Array.isArray(result.data.words) ? result.data.words : [];
        const confidentWordCount = words.filter((word) => word.confidence >= 60).length;
        return {
            confidence: typeof result.data.confidence === "number"
                ? Math.round(result.data.confidence * 10) / 10
                : null,
            confidentWordCount,
            text,
            totalWordCount: words.length,
        };
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
