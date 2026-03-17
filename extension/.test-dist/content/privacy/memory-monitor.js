"use strict";
/**
 * Monitors JS heap pressure and triggers model unloading when needed.
 * Prevents the extension from consuming excessive memory on low-end devices.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.memoryMonitor = exports.MemoryMonitor = void 0;
const model_manager_1 = require("../models/model-manager");
const PRESSURE_THRESHOLD_MB = 500;
class MemoryMonitor {
    checkInterval = null;
    /** Returns current JS heap usage in MB, or 0 if the API is unavailable. */
    getUsedMB() {
        const mem = performance.memory;
        if (!mem)
            return 0;
        return Math.round(mem.usedJSHeapSize / (1024 * 1024));
    }
    isUnderPressure() {
        return this.getUsedMB() > PRESSURE_THRESHOLD_MB;
    }
    /**
     * Starts periodic pressure checks every intervalMs.
     * When pressure is detected, all loaded models are unloaded so the
     * analyser falls back to lightweight heuristics.
     */
    startMonitoring(intervalMs = 30_000) {
        if (this.checkInterval)
            return;
        this.checkInterval = setInterval(() => {
            if (this.isUnderPressure()) {
                console.warn(`[Sentinel] Memory pressure (${this.getUsedMB()} MB) — unloading models`);
                model_manager_1.modelManager.unloadAll();
            }
        }, intervalMs);
    }
    stopMonitoring() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }
}
exports.MemoryMonitor = MemoryMonitor;
exports.memoryMonitor = new MemoryMonitor();
