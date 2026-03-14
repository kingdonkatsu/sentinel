"use strict";
/**
 * Semantic text analyser.
 *
 * Uses MiniLM-L6-v2 (via Transformers.js, ONNX int8, ~6 MB) to compute
 * sentence embeddings. Risk is measured by cosine similarity to the 50
 * reference distress phrases in distress-phrases.ts.
 *
 * Fast-path pre-filter: if the keyword analyser returns a very strong signal
 * (score > 80 or score < 20), skip model inference to save ~20-60 ms.
 *
 * Phrase embeddings are computed on first load and cached in
 * chrome.storage.local (persisted across sessions). They are re-computed
 * if the phrase list version changes.
 *
 * Privacy: the raw text string is passed only to the local ONNX model running
 * entirely in the content script. It is never stored or transmitted.
 *
 * Model path (bundled in extension):
 *   public/models/Xenova/all-MiniLM-L6-v2/
 *
 * See public/models/README.md for download instructions.
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
exports.SemanticTextAnalyser = void 0;
const story_ocr_1 = require("../ocr/story-ocr");
const image_analyser_1 = require("../image-analyser");
const text_analyser_1 = require("../text-analyser");
const secure_cleanup_1 = require("../privacy/secure-cleanup");
const distress_phrases_1 = require("./distress-phrases");
const semantic_text_scoring_1 = require("./semantic-text-scoring");
// Bump this when the phrase list changes — forces cache invalidation
const PHRASE_LIST_VERSION = 1;
const PHRASE_CACHE_KEY = "sentinel_phrase_embeddings_v1";
// Minimum text length to bother running the model
const MIN_TEXT_LENGTH = 10;
const OCR_TIMEOUT_MS = 3000;
// Keyword pre-filter thresholds
const PREFILTER_HIGH = 78;
const PREFILTER_LOW = 22;
class SemanticTextAnalyser {
    modality = "text";
    embedder = null;
    modelLoading = false;
    modelLoadAttempted = false;
    ocrRunner;
    /** Pre-computed phrase embeddings — [phraseIndex][dim] */
    phraseEmbeddings = null;
    constructor(deps = {}) {
        this.ocrRunner = deps.ocrRunner ?? story_ocr_1.storyOcr;
    }
    isAvailable(viewer) {
        return (0, image_analyser_1.findPrimaryStoryMedia)(viewer) !== null;
    }
    async analyse(viewer) {
        const t0 = performance.now();
        const ocrResult = await this.ocrRunner.recognizeViewer(viewer, OCR_TIMEOUT_MS);
        if (ocrResult.status !== "ok") {
            const status = ocrResult.status === "no_text" ? "missing" : "uncertain";
            console.log("[Sentinel][Story OCR]", {
                latencyMs: ocrResult.latencyMs,
                ocrConfidence: ocrResult.confidence ?? null,
                status: ocrResult.status,
                strategy: ocrResult.strategy,
                textScoringRan: false,
            });
            return this.result(50, 0, false, performance.now() - t0, status);
        }
        let rawText = ocrResult.text;
        try {
            const result = await this.analyseProvidedText(rawText);
            const finalResult = {
                ...result,
                inferenceTimeMs: performance.now() - t0,
                status: "ok",
            };
            console.log("[Sentinel][Story OCR]", {
                latencyMs: ocrResult.latencyMs,
                ocrConfidence: ocrResult.confidence ?? null,
                status: ocrResult.status,
                strategy: ocrResult.strategy,
                textScoringRan: true,
            });
            return finalResult;
        }
        finally {
            rawText = (0, secure_cleanup_1.releaseString)(rawText);
        }
    }
    async analyseProvidedText(rawText) {
        const t0 = performance.now();
        const normalizedText = rawText.trim();
        if (!normalizedText) {
            return this.result(50, 0, false, performance.now() - t0, "missing");
        }
        // ── Fast-path keyword pre-filter ─────────────────────────────────────
        const keywordScore = (0, text_analyser_1.analyseText)(normalizedText);
        const keywordConfidence = this.keywordConfidence(normalizedText, keywordScore);
        if (normalizedText.length < MIN_TEXT_LENGTH) {
            return this.result(keywordScore, keywordConfidence, true, performance.now() - t0, "ok");
        }
        if (keywordScore > PREFILTER_HIGH || keywordScore < PREFILTER_LOW) {
            return this.result(keywordScore, keywordConfidence, true, performance.now() - t0, "ok");
        }
        // ── Urgency detection ────────────────────────────────────────────────
        const hasUrgency = (0, distress_phrases_1.hasUrgencySignal)(normalizedText);
        // ── ML semantic scoring ──────────────────────────────────────────────
        const embedder = await this.loadEmbedder();
        if (!embedder) {
            return this.result(keywordScore, keywordConfidence * 0.8, true, performance.now() - t0, "ok");
        }
        try {
            const phraseEmbeds = await this.getPhraseEmbeddings(embedder);
            if (!phraseEmbeds) {
                return this.result(keywordScore, keywordConfidence, true, performance.now() - t0, "ok");
            }
            const textEmbedOutput = await embedder([normalizedText], {
                pooling: "mean",
                normalize: true,
            });
            const textEmbed = textEmbedOutput[0]?.data ?? null;
            if (!textEmbed) {
                return this.result(keywordScore, keywordConfidence, true, performance.now() - t0, "ok");
            }
            // Max cosine similarity to any distress phrase
            const maxSimilarity = this.maxCosineSimilarity(textEmbed, phraseEmbeds);
            // Map similarity [0, 1] → risk score
            // similarity ≥ 0.85 → high risk (≥80), ≤ 0.3 → low risk (≤30)
            const semanticScore = (0, semantic_text_scoring_1.mapSimilarityToRiskScore)(maxSimilarity);
            // Blend semantic and keyword scores — semantic is primary
            const blended = Math.round(semanticScore * 0.65 + keywordScore * 0.35);
            // Urgency bump: known time-critical phrases → floor at 75
            const finalScore = hasUrgency ? Math.max(blended, 75) : blended;
            // Confidence: driven by similarity strength
            const confidence = (0, semantic_text_scoring_1.similarityToConfidence)(maxSimilarity);
            return this.result(finalScore, confidence, true, performance.now() - t0, "ok");
        }
        catch {
            return this.result(keywordScore, keywordConfidence, true, performance.now() - t0, "ok");
        }
    }
    // ─── Embedding utilities ────────────────────────────────────────────────
    maxCosineSimilarity(queryEmbed, phraseEmbeds) {
        let max = 0;
        for (const phraseEmbed of phraseEmbeds) {
            const sim = cosineSimilarity(queryEmbed, phraseEmbed);
            if (sim > max)
                max = sim;
        }
        return max;
    }
    /**
     * Returns cached phrase embeddings or computes them on first call.
     */
    async getPhraseEmbeddings(embedder) {
        if (this.phraseEmbeddings)
            return this.phraseEmbeddings;
        // Try loading from persistent cache first
        const cached = await this.loadPhraseCache();
        if (cached) {
            this.phraseEmbeddings = cached;
            return cached;
        }
        // Compute embeddings for all 50 distress phrases
        try {
            const outputs = await embedder(distress_phrases_1.ALL_DISTRESS_PHRASES, {
                pooling: "mean",
                normalize: true,
            });
            const embeds = outputs.map((o) => new Float32Array(o.data));
            this.phraseEmbeddings = embeds;
            await this.savePhraseCache(embeds);
            return embeds;
        }
        catch {
            return null;
        }
    }
    // ─── Model loading ──────────────────────────────────────────────────────
    async loadEmbedder() {
        if (this.embedder)
            return this.embedder;
        if (this.modelLoading || this.modelLoadAttempted)
            return null;
        this.modelLoading = true;
        this.modelLoadAttempted = true;
        try {
            const { pipeline, env } = await Promise.resolve().then(() => __importStar(require("@xenova/transformers")));
            // Point Transformers.js at bundled models — no remote downloads
            env.allowRemoteModels = false;
            env.localModelPath = chrome.runtime.getURL("models/");
            const pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
            // The Transformers.js pipeline call signature matches EmbedderPipeline
            this.embedder = pipe;
            console.log("[Sentinel] MiniLM-L6 loaded");
            return this.embedder;
        }
        catch {
            // Model files not bundled yet — silent fallback to keywords
            return null;
        }
        finally {
            this.modelLoading = false;
        }
    }
    // ─── Cache helpers ──────────────────────────────────────────────────────
    async loadPhraseCache() {
        try {
            const result = await chrome.storage.local.get(PHRASE_CACHE_KEY);
            const entry = result[PHRASE_CACHE_KEY];
            if (!entry || entry.version !== PHRASE_LIST_VERSION)
                return null;
            return entry.data.map((arr) => new Float32Array(arr));
        }
        catch {
            return null;
        }
    }
    async savePhraseCache(embeds) {
        try {
            await chrome.storage.local.set({
                [PHRASE_CACHE_KEY]: {
                    version: PHRASE_LIST_VERSION,
                    data: embeds.map((e) => Array.from(e)),
                },
            });
        }
        catch {
            // cache failure is non-critical
        }
    }
    // ─── Helpers ────────────────────────────────────────────────────────────
    keywordConfidence(text, score) {
        if (!text || text.trim().length === 0)
            return 0;
        const polarity = Math.abs(score - 50);
        if (polarity > 30)
            return 0.7;
        if (polarity > 15)
            return 0.5;
        return 0.3;
    }
    result(score, confidence, available, inferenceTimeMs, status) {
        return {
            modality: "text",
            score,
            confidence,
            available,
            inferenceTimeMs,
            status,
        };
    }
    dispose() {
        this.embedder = null;
        this.phraseEmbeddings = null;
        this.modelLoadAttempted = false;
    }
}
exports.SemanticTextAnalyser = SemanticTextAnalyser;
function cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += (a[i] ?? 0) * (b[i] ?? 0);
        normA += (a[i] ?? 0) ** 2;
        normB += (b[i] ?? 0) ** 2;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}
