"use strict";
/**
 * Semantic text analyser.
 *
 * Uses MiniLM-L6-v2 embeddings with keyword fallback, then applies a local
 * context-cue layer (explicit self-harm + stressor context) to better match
 * high-signal moderation behavior.
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
const text_analyser_1 = require("../text-analyser");
const secure_cleanup_1 = require("../privacy/secure-cleanup");
const distress_phrases_1 = require("./distress-phrases");
const semantic_text_scoring_1 = require("./semantic-text-scoring");
const text_context_cues_1 = require("./text-context-cues");
const PHRASE_LIST_VERSION = 1;
const PHRASE_CACHE_KEY = "sentinel_phrase_embeddings_v1";
const MIN_TEXT_LENGTH = 10;
const PREFILTER_HIGH = 78;
const PREFILTER_LOW = 22;
class SemanticTextAnalyser {
    modality = "text";
    embedder = null;
    modelLoading = false;
    modelLoadAttempted = false;
    phraseEmbeddings = null;
    isAvailable(viewer) {
        const text = (0, text_analyser_1.extractText)(viewer);
        return text.trim().length >= MIN_TEXT_LENGTH;
    }
    async analyse(viewer) {
        const t0 = performance.now();
        let rawText = (0, text_analyser_1.extractText)(viewer);
        if (!rawText || rawText.trim().length < MIN_TEXT_LENGTH) {
            rawText = (0, secure_cleanup_1.releaseString)(rawText);
            return this.result(50, 0, false, performance.now() - t0);
        }
        const keywordScore = (0, text_analyser_1.analyseText)(rawText);
        const keywordConfidence = this.keywordConfidence(rawText, keywordScore);
        const contextCues = (0, text_context_cues_1.extractTextContextCues)(rawText);
        if (keywordScore > PREFILTER_HIGH || keywordScore < PREFILTER_LOW) {
            const adjusted = (0, text_context_cues_1.applyTextContextCues)(keywordScore, keywordConfidence, contextCues);
            this.logContextCues(contextCues, keywordScore, adjusted.score);
            rawText = (0, secure_cleanup_1.releaseString)(rawText);
            return this.result(adjusted.score, adjusted.confidence, true, performance.now() - t0);
        }
        const hasUrgency = (0, distress_phrases_1.hasUrgencySignal)(rawText);
        const embedder = await this.loadEmbedder();
        if (!embedder) {
            const adjusted = (0, text_context_cues_1.applyTextContextCues)(keywordScore, keywordConfidence * 0.8, contextCues);
            this.logContextCues(contextCues, keywordScore, adjusted.score);
            rawText = (0, secure_cleanup_1.releaseString)(rawText);
            return this.result(adjusted.score, adjusted.confidence, true, performance.now() - t0);
        }
        try {
            const phraseEmbeds = await this.getPhraseEmbeddings(embedder);
            if (!phraseEmbeds) {
                const adjusted = (0, text_context_cues_1.applyTextContextCues)(keywordScore, keywordConfidence, contextCues);
                this.logContextCues(contextCues, keywordScore, adjusted.score);
                rawText = (0, secure_cleanup_1.releaseString)(rawText);
                return this.result(adjusted.score, adjusted.confidence, true, performance.now() - t0);
            }
            const textEmbedOutput = await embedder([rawText], {
                pooling: "mean",
                normalize: true,
            });
            const textEmbed = textEmbedOutput[0]?.data ?? null;
            rawText = (0, secure_cleanup_1.releaseString)(rawText);
            if (!textEmbed) {
                const adjusted = (0, text_context_cues_1.applyTextContextCues)(keywordScore, keywordConfidence, contextCues);
                this.logContextCues(contextCues, keywordScore, adjusted.score);
                return this.result(adjusted.score, adjusted.confidence, true, performance.now() - t0);
            }
            const maxSimilarity = this.maxCosineSimilarity(textEmbed, phraseEmbeds);
            const semanticScore = (0, semantic_text_scoring_1.mapSimilarityToRiskScore)(maxSimilarity);
            const blended = Math.round(semanticScore * 0.65 + keywordScore * 0.35);
            const urgencyAdjustedScore = hasUrgency ? Math.max(blended, 75) : blended;
            const semanticConfidence = (0, semantic_text_scoring_1.similarityToConfidence)(maxSimilarity);
            const adjusted = (0, text_context_cues_1.applyTextContextCues)(urgencyAdjustedScore, semanticConfidence, contextCues);
            this.logContextCues(contextCues, urgencyAdjustedScore, adjusted.score);
            return this.result(adjusted.score, adjusted.confidence, true, performance.now() - t0);
        }
        catch {
            const adjusted = (0, text_context_cues_1.applyTextContextCues)(keywordScore, keywordConfidence, contextCues);
            this.logContextCues(contextCues, keywordScore, adjusted.score);
            rawText = (0, secure_cleanup_1.releaseString)(rawText);
            return this.result(adjusted.score, adjusted.confidence, true, performance.now() - t0);
        }
    }
    maxCosineSimilarity(queryEmbed, phraseEmbeds) {
        let max = 0;
        for (const phraseEmbed of phraseEmbeds) {
            const similarity = cosineSimilarity(queryEmbed, phraseEmbed);
            if (similarity > max) {
                max = similarity;
            }
        }
        return max;
    }
    async getPhraseEmbeddings(embedder) {
        if (this.phraseEmbeddings) {
            return this.phraseEmbeddings;
        }
        const cached = await this.loadPhraseCache();
        if (cached) {
            this.phraseEmbeddings = cached;
            return cached;
        }
        try {
            const outputs = await embedder(distress_phrases_1.ALL_DISTRESS_PHRASES, {
                pooling: "mean",
                normalize: true,
            });
            const embeddings = outputs.map((output) => new Float32Array(output.data));
            this.phraseEmbeddings = embeddings;
            await this.savePhraseCache(embeddings);
            return embeddings;
        }
        catch {
            return null;
        }
    }
    async loadEmbedder() {
        if (this.embedder) {
            return this.embedder;
        }
        if (this.modelLoading || this.modelLoadAttempted) {
            return null;
        }
        this.modelLoading = true;
        this.modelLoadAttempted = true;
        try {
            const { pipeline, env } = await Promise.resolve().then(() => __importStar(require("@xenova/transformers")));
            env.allowRemoteModels = false;
            env.localModelPath = chrome.runtime.getURL("models/");
            const pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
            this.embedder = pipe;
            console.log("[Sentinel] MiniLM-L6 loaded");
            return this.embedder;
        }
        catch {
            return null;
        }
        finally {
            this.modelLoading = false;
        }
    }
    async loadPhraseCache() {
        try {
            const result = await chrome.storage.local.get(PHRASE_CACHE_KEY);
            const entry = result[PHRASE_CACHE_KEY];
            if (!entry || entry.version !== PHRASE_LIST_VERSION) {
                return null;
            }
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
                    data: embeds.map((embed) => Array.from(embed)),
                },
            });
        }
        catch {
            // non-critical cache failure
        }
    }
    keywordConfidence(text, score) {
        if (!text || text.trim().length === 0) {
            return 0;
        }
        const polarity = Math.abs(score - 50);
        if (polarity > 30) {
            return 0.7;
        }
        if (polarity > 15) {
            return 0.5;
        }
        return 0.3;
    }
    result(score, confidence, available, inferenceTimeMs) {
        return { modality: "text", score, confidence, available, inferenceTimeMs };
    }
    logContextCues(cues, baseScore, adjustedScore) {
        if (cues.reasons.length === 0) {
            return;
        }
        console.log("[Sentinel][Text Context]", {
            reasons: cues.reasons,
            flags: {
                explicitSelfHarm: cues.explicitSelfHarm,
                selfDeprecation: cues.selfDeprecation,
                hopelessness: cues.hopelessness,
                socialIsolation: cues.socialIsolation,
                academicStress: cues.academicStress,
                lowAcademicPerformance: cues.lowAcademicPerformance,
            },
            scoreBoost: cues.scoreBoost,
            floorScore: cues.floorScore,
            confidenceBoost: cues.confidenceBoost,
            baseScore,
            adjustedScore,
        });
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
    for (let i = 0; i < a.length; i += 1) {
        dot += (a[i] ?? 0) * (b[i] ?? 0);
        normA += (a[i] ?? 0) ** 2;
        normB += (b[i] ?? 0) ** 2;
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dot / denominator;
}
