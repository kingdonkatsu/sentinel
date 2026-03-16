"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tesseract_js_1 = require("tesseract.js");
const OCR_TIMEOUT_MS = 3000;
const OCR_LANG_PATH = "https://tessdata.projectnaptha.com/4.0.0";
let workerPromise = null;
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (isPingMessage(message)) {
        sendResponse({ ok: true, ready: true });
        return false;
    }
    if (!isOffscreenRecognizeMessage(message)) {
        return false;
    }
    void recognize(message.imageData).then(sendResponse);
    return true;
});
async function recognize(imageData) {
    let worker;
    try {
        worker = await getWorker();
    }
    catch (error) {
        const messageText = normalizeError(error, "worker init failed");
        console.warn("[Sentinel][OCR Spike][Offscreen] worker init failed:", messageText);
        return { ok: false, error: `worker_init_failed: ${messageText}` };
    }
    try {
        const frame = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
        const t0 = performance.now();
        const result = await withTimeout(worker.recognize(frame), OCR_TIMEOUT_MS);
        const recognizeMs = Math.round(performance.now() - t0);
        const text = (result?.data?.text || "").trim();
        const words = Array.isArray(result?.data?.words) ? result.data.words : [];
        const confidences = words
            .map((word) => word.confidence)
            .filter((value) => typeof value === "number");
        const confidence = typeof result?.data?.confidence === "number"
            ? result.data.confidence
            : confidences.length > 0
                ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
                : null;
        const wordCount = text.length > 0 ? text.split(/\s+/).filter(Boolean).length : 0;
        return { ok: true, text, confidence, wordCount, recognizeMs };
    }
    catch (error) {
        const messageText = normalizeError(error, "OCR offscreen recognition failed");
        console.warn("[Sentinel][OCR Spike][Offscreen] recognize failed:", messageText);
        return { ok: false, error: `recognize_failed: ${messageText}` };
    }
}
async function getWorker() {
    if (!workerPromise) {
        workerPromise = (0, tesseract_js_1.createWorker)("eng", 1, {
            workerBlobURL: false,
            langPath: OCR_LANG_PATH,
            logger: (message) => {
                if (message &&
                    typeof message === "object" &&
                    "status" in message) {
                    const typed = message;
                    if (typed.status === "loading tesseract core" ||
                        typed.status === "loading language traineddata" ||
                        typed.status === "initializing tesseract") {
                        console.log("[Sentinel][OCR Spike][Offscreen]", typed);
                    }
                }
            },
        });
    }
    return workerPromise;
}
async function withTimeout(promise, timeoutMs) {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("OCR timeout")), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function isOffscreenRecognizeMessage(value) {
    if (!value || typeof value !== "object")
        return false;
    const message = value;
    return (message.type === "OCR_SPIKE_OFFSCREEN_RECOGNIZE" &&
        typeof message.imageData?.width === "number" &&
        typeof message.imageData?.height === "number" &&
        Array.isArray(message.imageData?.data));
}
function isPingMessage(value) {
    return (!!value &&
        typeof value === "object" &&
        "type" in value &&
        value.type === "OCR_SPIKE_OFFSCREEN_PING");
}
function normalizeError(error, fallback) {
    if (error instanceof Error) {
        if (error.stack)
            return `${error.message} | ${error.stack.split("\n")[0] ?? ""}`;
        return error.message || fallback;
    }
    if (typeof error === "string")
        return error.trim().length > 0 ? error : fallback;
    try {
        const serialized = JSON.stringify(error);
        return serialized && serialized !== "{}" ? serialized : fallback;
    }
    catch {
        return fallback;
    }
}
