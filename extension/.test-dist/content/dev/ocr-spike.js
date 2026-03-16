"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initOcrSpike = initOcrSpike;
const image_analyser_1 = require("../image-analyser");
const visual_emotion_analyser_1 = require("../analysers/visual-emotion-analyser");
const secure_cleanup_1 = require("../privacy/secure-cleanup");
const HOTKEY_ALT = true;
const HOTKEY_SHIFT = true;
const HOTKEY_KEY = "o";
const MAX_OCR_WIDTH = 1080;
const MAX_OCR_HEIGHT = 1920;
const OCR_TIMEOUT_MS = 3000;
const CAPTURE_TAB_TIMEOUT_MS = 2000;
class OcrSpike {
    busy = false;
    workerPromise = null;
    overlay = null;
    previewPanel = null;
    visualAnalyser = new visual_emotion_analyser_1.VisualEmotionAnalyser();
    init() {
        document.addEventListener("keydown", this.onKeyDown, true);
        document.addEventListener("sentinel:ocr-spike", this.onCustomTrigger);
        console.log("[Sentinel][OCR Spike] Ready. Trigger with Alt+Shift+O or document.dispatchEvent(new CustomEvent('sentinel:ocr-spike')).");
    }
    onKeyDown = (event) => {
        if (event.altKey === HOTKEY_ALT &&
            event.shiftKey === HOTKEY_SHIFT &&
            event.key.toLowerCase() === HOTKEY_KEY) {
            event.preventDefault();
            void this.trigger("hotkey");
        }
    };
    onCustomTrigger = () => {
        void this.trigger("custom-event");
    };
    async trigger(reason) {
        if (this.busy) {
            this.renderOverlay("running", "OCR spike already running...");
            return;
        }
        this.busy = true;
        const t0 = performance.now();
        let imageModel = null;
        this.renderOverlay("running", "Running OCR spike...");
        try {
            const viewer = this.findStoryViewer();
            console.log("[Sentinel][OCR Spike] Triggered", {
                trigger: reason,
                viewerDetected: Boolean(viewer),
            });
            const capture = await this.captureStoryForOcr(viewer);
            if (!capture) {
                throw new Error("Unable to capture current story frame.");
            }
            this.renderCapturePreview(capture);
            imageModel =
                (await this.analyseViewerImageModel(viewer)) ??
                    (await this.analyseCapturedImage(capture));
            const result = (await chrome.runtime.sendMessage({
                type: "OCR_SPIKE_RECOGNIZE",
                imageData: {
                    width: capture.width,
                    height: capture.height,
                    data: Array.from(capture.data),
                },
            }));
            if (!result?.ok) {
                throw new Error(result?.error || "OCR spike recognize call failed");
            }
            const recognizeLatency = result.recognizeMs;
            const totalLatency = Math.round(performance.now() - t0);
            const text = (result.text || "").trim();
            const confidence = typeof result.confidence === "number" ? `${Math.round(result.confidence)}%` : null;
            const wordCount = result.wordCount;
            const imageModelConfidenceText = typeof imageModel.confidence === "number"
                ? `${Math.round(imageModel.confidence * 100)}%`
                : "n/a";
            const imageModelAdjustedScore = this.confidenceAdjustedImageScore(imageModel.score, imageModel.confidence);
            const imageModelStrategy = imageModel.strategy === "face-blend"
                ? `face-blend${typeof imageModel.faceCount === "number" ? ` (${imageModel.faceCount} face)` : ""}`
                : imageModel.strategy;
            const imageModelSourceLabel = imageModel.source === "story-capture"
                ? "pipeline story capture"
                : imageModel.source === "ocr-capture"
                    ? "OCR capture"
                    : imageModel.source;
            console.log("[Sentinel][OCR Spike] Result", {
                trigger: reason,
                latencyMs: totalLatency,
                recognizeMs: recognizeLatency,
                captureResolution: `${capture.width}x${capture.height}`,
                imageModelScore: imageModel.score,
                imageModelConfidence: imageModel.confidence,
                imageModelAdjustedScore,
                imageModelStrategy,
                imageModelSource: imageModel.source,
                imageModelMlScore: imageModel.mlScore,
                heuristicTone: imageModel.heuristicTone,
                heuristicScene: imageModel.heuristicScene,
                text,
                confidence,
                wordCount,
            });
            this.renderOverlay("success", [
                `OCR spike complete (${totalLatency}ms)`,
                `Image model score: ${imageModel.score} (${imageModelConfidenceText})`,
                `Image model adjusted score: ${imageModelAdjustedScore}`,
                `Image model path: ${imageModelStrategy}`,
                `Image model source: ${imageModelSourceLabel}`,
                typeof imageModel.heuristicTone === "number" &&
                    typeof imageModel.heuristicScene === "number"
                    ? `Heuristic components (tone/scene): ${imageModel.heuristicTone}/${imageModel.heuristicScene}`
                    : "",
                `Confidence: ${confidence ?? "n/a"}`,
                text.length > 0 ? text : "(empty)",
            ]
                .filter((line) => line.length > 0)
                .join("\n"));
        }
        catch (error) {
            const message = error instanceof Error && error.message ? error.message : String(error);
            const latency = Math.round(performance.now() - t0);
            console.warn("[Sentinel][OCR Spike] Failed", {
                trigger: reason,
                latencyMs: latency,
                error: message,
            });
            this.renderOverlay("error", [
                `OCR spike failed (${latency}ms)`,
                imageModel
                    ? `Image model score: ${imageModel.score} (${Math.round(imageModel.confidence * 100)}%)`
                    : "Image model score: n/a",
                imageModel
                    ? `Image model adjusted score: ${this.confidenceAdjustedImageScore(imageModel.score, imageModel.confidence)}`
                    : "",
                imageModel ? `Image model path: ${imageModel.strategy}` : "",
                imageModel ? `Image model source: ${imageModel.source}` : "",
                message,
            ]
                .filter((line) => line.length > 0)
                .join("\n"));
        }
        finally {
            this.busy = false;
        }
    }
    findStoryViewer() {
        const candidates = Array.from(document.querySelectorAll("div[role='dialog'], main, section, article"));
        let best = null;
        let bestArea = 0;
        for (const candidate of candidates) {
            const media = (0, image_analyser_1.findPrimaryStoryMedia)(candidate);
            if (!media)
                continue;
            const rect = candidate.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > bestArea) {
                best = candidate;
                bestArea = area;
            }
        }
        return best;
    }
    async captureStoryForOcr(viewer) {
        const media = (viewer ? (0, image_analyser_1.findPrimaryStoryMedia)(viewer) : null) ?? this.findGlobalMediaCandidate();
        if (!media) {
            if (viewer) {
                console.log("[Sentinel][OCR Spike] Capture path: screenshot fallback (no media candidate)");
                return this.captureFromVisibleTab(viewer);
            }
            return null;
        }
        console.log("[Sentinel][OCR Spike] Capture source", {
            tag: media.tagName.toLowerCase(),
            rect: this.mediaRect(media),
        });
        const local = this.captureFromMedia(media);
        if (local) {
            console.log("[Sentinel][OCR Spike] Capture path: local drawImage");
            return local;
        }
        if (media instanceof HTMLImageElement) {
            const source = media.currentSrc || media.src;
            if (source) {
                console.log("[Sentinel][OCR Spike] Capture path: remote fetch bytes");
                const remote = await this.captureFromRemoteSource(source);
                if (remote)
                    return remote;
                console.log("[Sentinel][OCR Spike] Remote fetch failed, trying screenshot fallback");
            }
        }
        console.log("[Sentinel][OCR Spike] Capture path: screenshot fallback");
        return this.captureFromVisibleTabRegion(media.getBoundingClientRect());
    }
    async captureFromVisibleTab(viewer) {
        return this.captureFromVisibleTabRegion(viewer.getBoundingClientRect());
    }
    async captureFromVisibleTabRegion(region) {
        const regionWidth = Math.max(1, Math.round(region.width));
        const regionHeight = Math.max(1, Math.round(region.height));
        if (regionWidth < 10 || regionHeight < 10) {
            console.log("[Sentinel][OCR Spike] Screenshot fallback skipped (region too small)", {
                width: regionWidth,
                height: regionHeight,
            });
            return null;
        }
        const response = (await this.sendMessageWithTimeout({
            type: "CAPTURE_VISIBLE_TAB",
        }, CAPTURE_TAB_TIMEOUT_MS, "capture_timeout"));
        if (!response?.ok || typeof response.dataUrl !== "string") {
            console.log("[Sentinel][OCR Spike] Screenshot fallback failed", response);
            return null;
        }
        let bitmap;
        try {
            bitmap = await this.dataUrlToBitmap(response.dataUrl);
        }
        catch (error) {
            console.log("[Sentinel][OCR Spike] Screenshot decode failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;
        const scaleX = bitmap.width / Math.max(1, viewportWidth);
        const scaleY = bitmap.height / Math.max(1, viewportHeight);
        const crop = this.clampCrop({
            x: Math.round(region.left * scaleX),
            y: Math.round(region.top * scaleY),
            width: Math.round(region.width * scaleX),
            height: Math.round(region.height * scaleY),
        }, bitmap.width, bitmap.height);
        const { width, height } = this.boundedSize(crop.width, crop.height);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            bitmap.close();
            canvas.remove();
            return null;
        }
        try {
            ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
            return ctx.getImageData(0, 0, width, height);
        }
        finally {
            bitmap.close();
            canvas.remove();
        }
    }
    findGlobalMediaCandidate() {
        const media = Array.from(document.querySelectorAll("video, img[src]"))
            .filter((el) => {
            if (el instanceof HTMLImageElement) {
                return el.naturalWidth > 0 && this.isRenderableMedia(el);
            }
            if (el instanceof HTMLVideoElement) {
                return el.videoWidth > 0 && el.videoHeight > 0 && this.isRenderableMedia(el);
            }
            return false;
        })
            .sort((a, b) => this.mediaArea(b) - this.mediaArea(a));
        return media[0] ?? null;
    }
    isRenderableMedia(media) {
        const rect = media.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 120)
            return false;
        const style = window.getComputedStyle(media);
        if (style.display === "none" ||
            style.visibility === "hidden" ||
            Number.parseFloat(style.opacity || "1") < 0.05) {
            return false;
        }
        const overlapW = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const overlapH = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        return overlapW > 40 && overlapH > 40;
    }
    mediaArea(media) {
        const rect = media.getBoundingClientRect();
        const overlapW = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
        const overlapH = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
        return overlapW * overlapH;
    }
    mediaRect(media) {
        const rect = media.getBoundingClientRect();
        return `${Math.round(rect.width)}x${Math.round(rect.height)}@(${Math.round(rect.left)},${Math.round(rect.top)})`;
    }
    captureFromMedia(media) {
        const sourceWidth = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
        const sourceHeight = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
        if (!sourceWidth || !sourceHeight) {
            return null;
        }
        const { width, height } = this.boundedSize(sourceWidth, sourceHeight);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            canvas.remove();
            return null;
        }
        try {
            ctx.drawImage(media, 0, 0, width, height);
            return ctx.getImageData(0, 0, width, height);
        }
        catch {
            return null;
        }
        finally {
            canvas.remove();
        }
    }
    async captureFromRemoteSource(source) {
        if (!/^https?:\/\//i.test(source)) {
            return null;
        }
        const response = (await chrome.runtime.sendMessage({
            type: "FETCH_MEDIA_BYTES",
            url: source,
        }));
        if (!response?.ok || !(response.bytes instanceof ArrayBuffer)) {
            return null;
        }
        const blob = new Blob([response.bytes], {
            type: response.contentType || "image/jpeg",
        });
        const bitmap = await createImageBitmap(blob);
        const { width, height } = this.boundedSize(bitmap.width, bitmap.height);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            bitmap.close();
            canvas.remove();
            return null;
        }
        try {
            ctx.drawImage(bitmap, 0, 0, width, height);
            return ctx.getImageData(0, 0, width, height);
        }
        finally {
            bitmap.close();
            canvas.remove();
        }
    }
    dataUrlToBitmap(dataUrl) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = async () => {
                try {
                    const bitmap = await createImageBitmap(image);
                    resolve(bitmap);
                }
                catch (error) {
                    reject(error);
                }
            };
            image.onerror = () => reject(new Error("Failed to decode screenshot data URL"));
            image.src = dataUrl;
        });
    }
    async sendMessageWithTimeout(message, timeoutMs, timeoutCode) {
        let timer = null;
        try {
            return (await Promise.race([
                chrome.runtime.sendMessage(message),
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve({ ok: false, error: timeoutCode }), timeoutMs);
                }),
            ]));
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    clampCrop(crop, maxWidth, maxHeight) {
        const x = Math.max(0, Math.min(crop.x, maxWidth - 1));
        const y = Math.max(0, Math.min(crop.y, maxHeight - 1));
        const width = Math.max(1, Math.min(crop.width, maxWidth - x));
        const height = Math.max(1, Math.min(crop.height, maxHeight - y));
        return { x, y, width, height };
    }
    boundedSize(width, height) {
        const scale = Math.min(MAX_OCR_WIDTH / width, MAX_OCR_HEIGHT / height, 1);
        return {
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
        };
    }
    confidenceAdjustedImageScore(score, confidence) {
        const c = Math.max(0, Math.min(1, confidence));
        // Pull uncertain scores toward neutral (50).
        return Math.round(50 + (score - 50) * c);
    }
    async analyseViewerImageModel(viewer) {
        if (!viewer) {
            return null;
        }
        try {
            const frame = await (0, image_analyser_1.captureStoryImage)(viewer);
            if (!frame) {
                return null;
            }
            const result = await this.visualAnalyser.scoreCapturedFrame((0, secure_cleanup_1.cloneImageData)(frame));
            console.log("[Sentinel][OCR Spike] Image model analysed (story-capture)", {
                score: result.score,
                confidence: result.confidence,
                strategy: result.strategy,
                mlScore: result.mlScore,
                faceCount: result.faceCount,
                heuristicTone: result.heuristic.toneScore,
                heuristicScene: result.heuristic.sceneCueScore,
            });
            return {
                score: result.score,
                confidence: result.confidence,
                strategy: result.strategy,
                source: "story-capture",
                mlScore: result.mlScore,
                faceCount: result.faceCount,
                heuristicTone: result.heuristic.toneScore,
                heuristicScene: result.heuristic.sceneCueScore,
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn("[Sentinel][OCR Spike] Story-capture image analysis failed", {
                error: message,
            });
            return null;
        }
    }
    async analyseCapturedImage(capture) {
        try {
            const cloned = (0, secure_cleanup_1.cloneImageData)(capture);
            const result = await this.visualAnalyser.scoreCapturedFrame(cloned);
            console.log("[Sentinel][OCR Spike] Image model analysed", {
                score: result.score,
                confidence: result.confidence,
                strategy: result.strategy,
                mlScore: result.mlScore,
                faceCount: result.faceCount,
                heuristicTone: result.heuristic.toneScore,
                heuristicScene: result.heuristic.sceneCueScore,
            });
            return {
                score: result.score,
                confidence: result.confidence,
                strategy: result.strategy,
                source: "ocr-capture",
                mlScore: result.mlScore,
                faceCount: result.faceCount,
                heuristicTone: result.heuristic.toneScore,
                heuristicScene: result.heuristic.sceneCueScore,
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn("[Sentinel][OCR Spike] Image model analysis failed", { error: message });
            return {
                score: 50,
                confidence: 0,
                strategy: "analysis-error",
                source: "analysis-error",
            };
        }
    }
    renderCapturePreview(capture) {
        const canvas = document.createElement("canvas");
        canvas.width = capture.width;
        canvas.height = capture.height;
        const ctx = canvas.getContext("2d");
        if (!ctx)
            return;
        ctx.putImageData(capture, 0, 0);
        const dataUrl = canvas.toDataURL("image/png");
        canvas.remove();
        if (!this.previewPanel) {
            this.previewPanel = document.createElement("div");
            this.previewPanel.id = "sentinel-ocr-spike-preview";
            Object.assign(this.previewPanel.style, {
                position: "fixed",
                left: "12px",
                bottom: "12px",
                zIndex: "2147483647",
                width: "220px",
                padding: "8px",
                borderRadius: "8px",
                border: "1px solid rgba(255,255,255,0.2)",
                background: "#0f172a",
                color: "#e2e8f0",
                boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: "11px",
            });
            document.documentElement.appendChild(this.previewPanel);
        }
        this.previewPanel.innerHTML = "";
        const title = document.createElement("div");
        title.textContent = `OCR capture ${capture.width}x${capture.height}`;
        title.style.marginBottom = "6px";
        title.style.opacity = "0.9";
        const img = document.createElement("img");
        img.src = dataUrl;
        img.alt = "Sentinel OCR captured frame";
        img.style.width = "100%";
        img.style.height = "auto";
        img.style.borderRadius = "6px";
        img.style.display = "block";
        img.style.background = "#111827";
        this.previewPanel.appendChild(title);
        this.previewPanel.appendChild(img);
        console.log("[Sentinel][OCR Spike] Capture preview rendered", {
            width: capture.width,
            height: capture.height,
        });
    }
    // OCR runs in service worker to avoid Instagram CSP blocking page-side worker creation.
    renderOverlay(state, message) {
        if (!this.overlay) {
            this.overlay = document.createElement("div");
            this.overlay.id = "sentinel-ocr-spike-overlay";
            Object.assign(this.overlay.style, {
                position: "fixed",
                right: "12px",
                bottom: "12px",
                zIndex: "2147483647",
                maxWidth: "420px",
                maxHeight: "55vh",
                overflowY: "auto",
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid rgba(255,255,255,0.2)",
                boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: "12px",
                lineHeight: "1.35",
            });
            document.documentElement.appendChild(this.overlay);
        }
        const palette = state === "running"
            ? { bg: "#1f2937", fg: "#dbeafe" }
            : state === "success"
                ? { bg: "#052e16", fg: "#dcfce7" }
                : state === "error"
                    ? { bg: "#3f1d1d", fg: "#fee2e2" }
                    : { bg: "#111827", fg: "#f9fafb" };
        this.overlay.style.background = palette.bg;
        this.overlay.style.color = palette.fg;
        this.overlay.textContent = `[Sentinel OCR Spike] ${message}`;
    }
}
let instance = null;
function initOcrSpike() {
    if (instance)
        return;
    instance = new OcrSpike();
    instance.init();
}
