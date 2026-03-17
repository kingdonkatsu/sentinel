"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEMANTIC_MODEL_TIMEOUT_MS = void 0;
exports.getSemanticTextModelHost = getSemanticTextModelHost;
const semantic_host_bridge_1 = require("./semantic-host-bridge");
const SEMANTIC_HOST_PAGE = "src/content/semantic/semantic-host.html";
exports.SEMANTIC_MODEL_TIMEOUT_MS = 5000;
class SemanticHostClient {
    iframe = null;
    frameReady = null;
    hostOrigin;
    hostUrl;
    pending = new Map();
    queue = Promise.resolve();
    started = false;
    constructor() {
        if (!chrome?.runtime?.id) {
            throw new Error("Extension context invalidated");
        }
        this.hostUrl = chrome.runtime.getURL(SEMANTIC_HOST_PAGE);
        this.hostOrigin = new URL(this.hostUrl).origin;
    }
    async scoreText(text, timeoutMs = exports.SEMANTIC_MODEL_TIMEOUT_MS) {
        const task = this.queue.then(() => this.runScoreText(text, timeoutMs));
        this.queue = task.then(() => undefined, () => undefined);
        return task;
    }
    dispose() {
        this.started = false;
        window.removeEventListener("message", this.onMessage);
        for (const { reject } of this.pending.values()) {
            reject(new Error("MiniLM host shut down"));
        }
        this.pending.clear();
        if (this.iframe) {
            this.iframe.remove();
            this.iframe = null;
        }
        this.frameReady = null;
        this.queue = Promise.resolve();
    }
    start() {
        if (this.started) {
            return;
        }
        this.started = true;
        window.addEventListener("message", this.onMessage);
    }
    async runScoreText(text, timeoutMs) {
        this.start();
        const targetWindow = await this.ensureFrame();
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            const request = {
                type: semantic_host_bridge_1.SEMANTIC_HOST_REQUEST_TYPE,
                requestId,
                text,
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
            iframe.id = "sentinel-semantic-host-frame";
            iframe.src = this.hostUrl;
            iframe.style.display = "none";
            iframe.setAttribute("aria-hidden", "true");
            iframe.addEventListener("load", () => {
                if (!iframe.contentWindow) {
                    reject(new Error("MiniLM host iframe loaded without contentWindow"));
                    return;
                }
                this.iframe = iframe;
                resolve(iframe.contentWindow);
            }, { once: true });
            iframe.addEventListener("error", () => {
                this.frameReady = null;
                reject(new Error("Failed to load MiniLM host iframe"));
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
            event.data.type !== semantic_host_bridge_1.SEMANTIC_HOST_RESPONSE_TYPE) {
            return;
        }
        const response = event.data;
        const pending = this.pending.get(response.requestId);
        if (!pending) {
            return;
        }
        this.pending.delete(response.requestId);
        if (!response.ok || !response.result) {
            pending.reject(new Error(response.error || "MiniLM host failed"));
            return;
        }
        pending.resolve(response.result);
    };
}
class UnavailableSemanticScorer {
    dispose() {
        // No-op outside the extension runtime.
    }
    async scoreText() {
        throw new Error("MiniLM host is unavailable outside the extension runtime");
    }
}
let sharedSemanticTextModelHost = null;
function getSemanticTextModelHost() {
    if (sharedSemanticTextModelHost) {
        return sharedSemanticTextModelHost;
    }
    const runtime = typeof chrome !== "undefined" ? chrome.runtime : undefined;
    sharedSemanticTextModelHost =
        runtime?.getURL && typeof document !== "undefined"
            ? new SemanticHostClient()
            : new UnavailableSemanticScorer();
    return sharedSemanticTextModelHost;
}
