"use strict";
/**
 * Manages the calibration feedback loop that gently nudges base weights
 * toward modalities that historically correlated with confirmed cases.
 *
 * State lives in chrome.storage.local so calibration survives browser restart.
 * Calibration still resets every 7 days to prevent runaway drift.
 *
 * When a social worker marks a case as actionable on the dashboard,
 * the dashboard can send a message to the extension:
 *   { type: "SENTINEL_CONFIRMED", username, modalityScores }
 * The calibrator records which modalities had high scores for that case.
 *
 * Weight adjustment is capped at ±5% from base to stay conservative.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.weightCalibrator = exports.WeightCalibrator = exports.CALIBRATION_RESET_INTERVAL_MS = exports.CALIBRATION_STORAGE_KEY = void 0;
const composite_scorer_1 = require("./composite-scorer");
exports.CALIBRATION_STORAGE_KEY = "sentinel_calibration";
exports.CALIBRATION_RESET_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_ADJUSTMENT = 0.05; // ±5% from base weight
class WeightCalibrator {
    state = null;
    storageArea;
    now;
    constructor(storageArea, now = () => Date.now()) {
        this.storageArea = storageArea ?? getDefaultStorageArea();
        this.now = now;
    }
    async load() {
        try {
            const result = await this.storageArea.get(exports.CALIBRATION_STORAGE_KEY);
            const stored = result[exports.CALIBRATION_STORAGE_KEY];
            if (stored && this.now() - stored.lastCalibrated < exports.CALIBRATION_RESET_INTERVAL_MS) {
                this.state = stored;
            }
            else {
                this.state = this.defaultState();
                await this.persist();
            }
        }
        catch {
            this.state = this.defaultState();
        }
    }
    /**
     * Records a "confirmed" signal for the given modality scores.
     * Called when a social worker acts on a flagged account.
     */
    async recordConfirmed(modalityScores) {
        if (!this.state)
            await this.load();
        for (const [modality, score] of Object.entries(modalityScores)) {
            const acc = this.state.modalityAccuracy[modality] ?? { hits: 0, total: 0 };
            acc.total += 1;
            // Count as a "hit" if this modality had a high score (>= 70)
            if (score >= 70)
                acc.hits += 1;
            this.state.modalityAccuracy[modality] = acc;
        }
        this.recalculateWeights();
        await this.persist();
    }
    /**
     * Returns calibrated base weights. Falls back to defaults if not loaded.
     */
    getWeights() {
        if (!this.state?.adjustedWeights)
            return { ...composite_scorer_1.BASE_WEIGHTS };
        const weights = { ...composite_scorer_1.BASE_WEIGHTS };
        for (const [modality, adjusted] of Object.entries(this.state.adjustedWeights)) {
            weights[modality] = adjusted;
        }
        return weights;
    }
    recalculateWeights() {
        if (!this.state)
            return;
        const adjusted = {};
        for (const [modality, acc] of Object.entries(this.state.modalityAccuracy)) {
            if (acc.total < 3)
                continue; // not enough data to calibrate
            const accuracy = acc.hits / acc.total;
            const base = composite_scorer_1.BASE_WEIGHTS[modality] ?? 0;
            // Nudge: positive when accuracy > 0.5, negative when below
            const nudge = base * 0.1 * (accuracy - 0.5);
            const clamped = Math.max(base - MAX_ADJUSTMENT, Math.min(base + MAX_ADJUSTMENT, base + nudge));
            adjusted[modality] = clamped;
        }
        this.state.adjustedWeights = adjusted;
    }
    defaultState() {
        return {
            modalityAccuracy: {},
            lastCalibrated: this.now(),
            adjustedWeights: undefined,
        };
    }
    async persist() {
        try {
            await this.storageArea.set({ [exports.CALIBRATION_STORAGE_KEY]: this.state });
        }
        catch {
            // storage unavailable — degrade gracefully
        }
    }
}
exports.WeightCalibrator = WeightCalibrator;
exports.weightCalibrator = new WeightCalibrator();
function getDefaultStorageArea() {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
        return chrome.storage.local;
    }
    return {
        async get() {
            return {};
        },
        async set() {
            // no-op in non-extension environments
        },
    };
}
