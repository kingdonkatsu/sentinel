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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SemanticTextAnalyser = void 0;
const story_ocr_1 = require("../ocr/story-ocr");
const image_analyser_1 = require("../image-analyser");
const text_analyser_1 = require("../text-analyser");
const secure_cleanup_1 = require("../privacy/secure-cleanup");
const semantic_host_client_1 = require("../semantic/semantic-host-client");
const distress_phrases_1 = require("./distress-phrases");
const semantic_text_scoring_1 = require("./semantic-text-scoring");
// Bump this when the phrase list changes — forces cache invalidation
// Minimum text length to bother running the model
const MIN_TEXT_LENGTH = 10;
const OCR_TIMEOUT_MS = 3000;
// Keyword pre-filter thresholds
const PREFILTER_HIGH = 78;
const PREFILTER_LOW = 22;
class SemanticTextAnalyser {
    modality = "text";
    ocrRunner;
    semanticScorer;
    constructor(deps = {}) {
        this.ocrRunner = deps.ocrRunner ?? story_ocr_1.storyOcr;
        this.semanticScorer = deps.semanticScorer ?? (0, semantic_host_client_1.getSemanticTextModelHost)();
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
            const { result, debug } = await this.analyseProvidedText(rawText);
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
            console.log("[Sentinel][Story Text]", {
                ocrText: rawText,
                textScore: finalResult.score,
                textConfidence: finalResult.confidence,
                scoringPath: debug.scoringPath,
                minilmRan: debug.minilmRan,
                keywordScore: debug.keywordScore,
                semanticScore: debug.semanticScore ?? null,
                maxSimilarity: debug.maxSimilarity ?? null,
                urgencyBoostApplied: debug.urgencyBoostApplied,
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
            return {
                debug: {
                    keywordScore: 50,
                    minilmRan: false,
                    scoringPath: "keyword-short-text",
                    urgencyBoostApplied: false,
                },
                result: this.result(50, 0, false, performance.now() - t0, "missing"),
            };
        }
        // ── Fast-path keyword pre-filter ─────────────────────────────────────
        const keywordScore = (0, text_analyser_1.analyseText)(normalizedText);
        const keywordConfidence = this.keywordConfidence(normalizedText, keywordScore);
        if (normalizedText.length < MIN_TEXT_LENGTH) {
            return {
                debug: {
                    keywordScore,
                    minilmRan: false,
                    scoringPath: "keyword-short-text",
                    urgencyBoostApplied: false,
                },
                result: this.result(keywordScore, keywordConfidence, true, performance.now() - t0, "ok"),
            };
        }
        if (keywordScore > PREFILTER_HIGH || keywordScore < PREFILTER_LOW) {
            return {
                debug: {
                    keywordScore,
                    minilmRan: false,
                    scoringPath: "keyword-prefilter",
                    urgencyBoostApplied: false,
                },
                result: this.result(keywordScore, keywordConfidence, true, performance.now() - t0, "ok"),
            };
        }
        // ── Urgency detection ────────────────────────────────────────────────
        const hasUrgency = (0, distress_phrases_1.hasUrgencySignal)(normalizedText);
        // ── ML semantic scoring ──────────────────────────────────────────────
        try {
            const semanticResult = await this.semanticScorer.scoreText(normalizedText, semantic_host_client_1.SEMANTIC_MODEL_TIMEOUT_MS);
            const maxSimilarity = semanticResult.maxSimilarity;
            // Map similarity [0, 1] → risk score
            // similarity ≥ 0.85 → high risk (≥80), ≤ 0.3 → low risk (≤30)
            const semanticScore = (0, semantic_text_scoring_1.mapSimilarityToRiskScore)(maxSimilarity);
            // Blend semantic and keyword scores — semantic is primary
            const blended = Math.round(semanticScore * 0.65 + keywordScore * 0.35);
            // Urgency bump: known time-critical phrases → floor at 75
            const finalScore = hasUrgency ? Math.max(blended, 75) : blended;
            // Confidence: driven by similarity strength
            const confidence = (0, semantic_text_scoring_1.similarityToConfidence)(maxSimilarity);
            return {
                debug: {
                    keywordScore,
                    maxSimilarity,
                    minilmRan: true,
                    scoringPath: "minilm",
                    semanticScore,
                    urgencyBoostApplied: hasUrgency,
                },
                result: this.result(finalScore, confidence, true, performance.now() - t0, "ok"),
            };
        }
        catch (error) {
            console.warn("[Sentinel] MiniLM-L6 scoring failed", error);
            return {
                debug: {
                    keywordScore,
                    minilmRan: false,
                    scoringPath: "keyword-fallback-model-error",
                    urgencyBoostApplied: false,
                },
                result: this.result(keywordScore, keywordConfidence, true, performance.now() - t0, "ok"),
            };
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
        this.semanticScorer.dispose();
    }
}
exports.SemanticTextAnalyser = SemanticTextAnalyser;
