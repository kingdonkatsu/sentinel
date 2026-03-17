"use strict";
/**
 * Manages lazy loading, lifecycle, and disposal of TF.js models.
 *
 * Models are loaded on first use and reference-counted. A model is
 * unloaded after INACTIVITY_MS of non-use, or immediately when
 * memory pressure is detected.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.modelManager = void 0;
const INACTIVITY_MS = 60_000;
class ModelManager {
    tf = null;
    models = new Map();
    backendReady = false;
    /** Lazy-loads TF.js and selects the best available backend. */
    async init() {
        if (this.tf)
            return this.tf;
        try {
            const tf = await Promise.resolve().then(() => __importStar(require("@tensorflow/tfjs")));
            await this.selectBackend(tf);
            this.tf = tf;
            this.backendReady = true;
            return tf;
        }
        catch {
            return null;
        }
    }
    async selectBackend(tf) {
        // Prefer GPU backends; fall back to CPU without WASM path issues
        const backends = ["webgpu", "webgl", "cpu"];
        for (const backend of backends) {
            try {
                await tf.setBackend(backend);
                await tf.ready();
                console.log(`[Sentinel] TF.js backend: ${backend}`);
                return;
            }
            catch {
                // try next
            }
        }
    }
    /**
     * Loads (or returns cached) a TF.js model from the extension bundle.
     * modelPath must be a key recognisable by chrome.runtime.getURL,
     * e.g. "models/blazeface/model.json".
     *
     * Returns null if TF.js is unavailable or the model file is not bundled.
     */
    async load(modelPath) {
        if (this.models.has(modelPath)) {
            const entry = this.models.get(modelPath);
            entry.lastUsed = Date.now();
            this.resetInactivityTimer(modelPath, entry);
            return entry.model;
        }
        const tf = await this.init();
        if (!tf)
            return null;
        const url = chrome.runtime.getURL(modelPath);
        try {
            const model = await tf.loadGraphModel(url);
            const entry = {
                model,
                lastUsed: Date.now(),
                inactivityTimer: null,
            };
            this.resetInactivityTimer(modelPath, entry);
            this.models.set(modelPath, entry);
            console.log(`[Sentinel] Loaded model: ${modelPath}`);
            return model;
        }
        catch {
            // Model file not bundled yet — silent fallback
            return null;
        }
    }
    resetInactivityTimer(path, entry) {
        if (entry.inactivityTimer)
            clearTimeout(entry.inactivityTimer);
        entry.inactivityTimer = setTimeout(() => {
            this.unload(path);
        }, INACTIVITY_MS);
    }
    unload(modelPath) {
        const entry = this.models.get(modelPath);
        if (!entry)
            return;
        if (entry.inactivityTimer)
            clearTimeout(entry.inactivityTimer);
        try {
            entry.model.dispose();
        }
        catch {
            // ignore disposal errors
        }
        this.models.delete(modelPath);
    }
    unloadAll() {
        for (const path of [...this.models.keys()]) {
            this.unload(path);
        }
        // Also clear any Transformers.js pipeline reference
        this.transformersPipeline = null;
    }
    get isReady() {
        return this.backendReady;
    }
    get tf_() {
        return this.tf;
    }
    // ─── Transformers.js support ─────────────────────────────────────────────
    transformersPipeline = null;
    transformersLoading = false;
    /**
     * Returns the Transformers.js `env` object so callers can configure
     * model paths and remote-access flags before the first pipeline call.
     * Returns null if @xenova/transformers is not installed.
     */
    async getTransformersEnv() {
        try {
            const { env } = await Promise.resolve().then(() => __importStar(require("@xenova/transformers")));
            return env;
        }
        catch {
            return null;
        }
    }
    /**
     * Clears the cached Transformers.js pipeline (e.g. under memory pressure).
     */
    unloadTransformers() {
        this.transformersPipeline = null;
        this.transformersLoading = false;
    }
}
// Singleton shared across all analysers in the content script
exports.modelManager = new ModelManager();
