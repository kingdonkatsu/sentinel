"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScoreTransmitter = void 0;
class ScoreTransmitter {
    initialized = false;
    async init() {
        this.initialized = true;
    }
    async send(score, modalityScores) {
        if (!this.initialized) {
            await this.init();
        }
        try {
            const result = (await chrome.runtime.sendMessage({
                type: "SUBMIT_SCORE",
                score,
                modalityScores,
            }));
            if (!result?.ok) {
                const error = result?.error || "Unknown transmission failure";
                console.warn("[Sentinel] Score transmission failed:", error);
            }
            return result || { ok: false, error: "No response from service worker" };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Score transmission failed";
            console.warn("[Sentinel] Score transmission failed:", message);
            return { ok: false, error: message };
        }
    }
}
exports.ScoreTransmitter = ScoreTransmitter;
