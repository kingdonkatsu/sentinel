"use strict";
/**
 * Phase 2 analysis pipeline.
 *
 * Orchestrates 5 modality analysers, then fuses results using
 * the Bayesian confidence-weighted compositor and calibrated base weights.
 *
 * Modalities:
 *   - text     SemanticTextAnalyser  (MiniLM-L6 embeddings + keyword fallback)
 *   - visual   VisualEmotionAnalyser (TinyFaceDetector + FaceExpressionNet + histogram fallback)
 *   - temporal TemporalAnalyser      (ring buffer + posting pattern detection)
 *   - video    VideoAnalyser         (multi-frame sampling, video stories only)
 *   - metadata MetadataAnalyser      (DOM-based platform signals)
 *
 * Privacy guarantees (unchanged from Phase 1):
 *   - Raw story content (pixels, text, audio) never leaves the browser
 *   - Only numerical scores + username are transmitted to the backend
 *   - All tensor/string references are explicitly released after scoring
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnalysisPipeline = void 0;
const image_analyser_1 = require("./image-analyser");
const overlay_renderer_1 = require("./overlay-renderer");
const score_transmitter_1 = require("./score-transmitter");
const visual_emotion_analyser_1 = require("./analysers/visual-emotion-analyser");
const semantic_text_analyser_1 = require("./analysers/semantic-text-analyser");
const temporal_analyser_1 = require("./analysers/temporal-analyser");
const video_analyser_1 = require("./analysers/video-analyser");
const metadata_analyser_1 = require("./analysers/metadata-analyser");
const composite_scorer_1 = require("./scoring/composite-scorer");
const weight_calibrator_1 = require("./scoring/weight-calibrator");
const memory_monitor_1 = require("./privacy/memory-monitor");
const secure_cleanup_1 = require("./privacy/secure-cleanup");
class AnalysisPipeline {
    overlay;
    transmitter;
    threshold = 70;
    visualAnalyser;
    textAnalyser;
    temporalAnalyser;
    videoAnalyser;
    metadataAnalyser;
    calibrator;
    memoryMonitor;
    captureStoryImage;
    constructor(deps = {}) {
        this.overlay = deps.overlay ?? new overlay_renderer_1.OverlayRenderer();
        this.transmitter = deps.transmitter ?? new score_transmitter_1.ScoreTransmitter();
        this.visualAnalyser = deps.visualAnalyser ?? new visual_emotion_analyser_1.VisualEmotionAnalyser();
        this.textAnalyser = deps.textAnalyser ?? new semantic_text_analyser_1.SemanticTextAnalyser();
        this.temporalAnalyser = deps.temporalAnalyser ?? new temporal_analyser_1.TemporalAnalyser();
        this.videoAnalyser = deps.videoAnalyser ?? new video_analyser_1.VideoAnalyser();
        this.metadataAnalyser = deps.metadataAnalyser ?? new metadata_analyser_1.MetadataAnalyser();
        this.calibrator = deps.weightCalibrator ?? weight_calibrator_1.weightCalibrator;
        this.memoryMonitor = deps.memoryMonitor ?? memory_monitor_1.memoryMonitor;
        this.captureStoryImage = deps.captureStoryImage ?? image_analyser_1.captureStoryImage;
    }
    async init() {
        await this.transmitter.init();
        await this.calibrator.load();
        const config = await chrome.storage.local.get([
            "sentinel_threshold",
        ]);
        if (config.sentinel_threshold) {
            this.threshold = config.sentinel_threshold;
        }
        this.memoryMonitor.startMonitoring();
    }
    async analyse(viewer, username) {
        // ── Set username for temporal analyser (needs it before analyse()) ──
        this.temporalAnalyser.setUsername(username);
        // ── Determine which modalities are applicable ────────────────────────
        const hasVideo = this.videoAnalyser.isAvailable(viewer);
        const [textResult, temporalResult, metadataResult] = await Promise.all([
            this.textAnalyser.analyse(viewer),
            this.temporalAnalyser.analyse(viewer),
            this.metadataAnalyser.analyse(viewer),
        ]);
        const { visualResult, videoResult } = hasVideo
            ? await this.analyseVideoStory(viewer)
            : {
                visualResult: await this.visualAnalyser.analyse(viewer),
                videoResult: this.unavailableResult("video"),
            };
        const modalityResults = [
            textResult,
            visualResult,
            temporalResult,
            metadataResult,
            videoResult,
        ];
        // ── Fuse with calibrated weights ─────────────────────────────────────
        const calibratedWeights = this.calibrator.getWeights();
        const { composite, overallConfidence, effectiveWeights } = composite_scorer_1.compositeScorer.fuse(modalityResults, calibratedWeights);
        const compositeDrivers = this.computeCompositeDrivers(modalityResults, effectiveWeights);
        const imageScore = Math.round(visualResult.available ? visualResult.score : videoResult.score);
        const reasoning = this.buildImageReasoning(visualResult, videoResult, imageScore);
        const imageScoreSource = visualResult.available ? "visual" : videoResult.available ? "video" : "neutral-default";
        const imageScoreRaw = imageScoreSource === "visual"
            ? visualResult.score
            : imageScoreSource === "video"
                ? videoResult.score
                : 50;
        const imageConfidenceRaw = imageScoreSource === "visual"
            ? visualResult.confidence
            : imageScoreSource === "video"
                ? videoResult.confidence
                : 0;
        const imageScoreAdjusted = this.confidenceAdjustedImageScore(imageScoreRaw, imageConfidenceRaw);
        // ── Build score payload (only numbers, zero content) ─────────────────
        const modalityScores = {};
        for (const r of modalityResults) {
            if (r.available)
                modalityScores[r.modality] = r.score;
        }
        const score = {
            composite,
            textScore: Math.round(textResult.score),
            imageScore,
            timestamp: Date.now(),
            username,
            reasoning,
        };
        console.log("[Sentinel] Score v2:", {
            username,
            timestamp: score.timestamp,
            composite,
            // Keep `confidence` aligned with image/visual confidence for easier
            // comparison against OCR spike diagnostics.
            confidence: imageConfidenceRaw.toFixed(2),
            overallConfidence: overallConfidence.toFixed(2),
            imageScore,
            imageScoreSource,
            imageScoreRaw: Number(imageScoreRaw.toFixed(2)),
            imageScoreAdjusted,
            imageConfidence: imageConfidenceRaw.toFixed(2),
            reasoning: reasoning.summary,
            confidenceBand: reasoning.confidenceBand,
            caveats: reasoning.caveats,
            modalities: Object.fromEntries(modalityResults
                .filter((r) => r.available)
                .map((r) => [r.modality, `${r.score}@${r.confidence.toFixed(2)}`])),
            unavailableModalities: modalityResults
                .filter((r) => !r.available)
                .map((r) => r.modality),
            inferenceMs: Object.fromEntries(modalityResults.map((r) => [r.modality, Math.round(r.inferenceTimeMs)])),
            weights: Object.fromEntries(Object.entries(effectiveWeights).map(([k, v]) => [k, (v ?? 0).toFixed(3)])),
            drivers: reasoning.topDrivers.map((driver) => ({
                modality: driver.modality,
                deltaFromNeutral: driver.impact,
                score: driver.score,
                confidence: driver.confidence,
                weight: driver.weight,
            })),
            compositeDrivers: compositeDrivers.slice(0, 3).map((driver) => ({
                modality: driver.modality,
                weightedDelta: driver.impact,
                score: driver.score,
                confidence: driver.confidence,
                weight: driver.weight,
            })),
        });
        // ── Show overlay and transmit ─────────────────────────────────────────
        if (composite >= this.threshold) {
            this.overlay.show(score, modalityResults);
        }
        const transmission = await this.transmitter.send(score, modalityScores);
        // ── Record score in temporal buffer (for next analysis run) ──────────
        await this.temporalAnalyser.record(username, composite);
        return {
            score,
            imageCaptured: visualResult.available || videoResult.available,
            textLength: textResult.available ? 1 : 0,
            transmitted: transmission.ok,
            transmissionError: transmission.error,
            modalityResults,
        };
    }
    unavailableResult(modality) {
        return {
            modality,
            score: 50,
            confidence: 0,
            available: false,
            inferenceTimeMs: 0,
        };
    }
    dispose() {
        this.visualAnalyser.dispose();
        this.textAnalyser.dispose();
        this.temporalAnalyser.dispose();
        this.videoAnalyser.dispose();
        this.metadataAnalyser.dispose();
        this.memoryMonitor.stopMonitoring();
    }
    async analyseVideoStory(viewer) {
        const video = viewer.querySelector("video");
        const initialTime = video?.currentTime;
        const initialFrame = await this.captureStoryImage(viewer);
        try {
            const visualResult = initialFrame
                ? await this.visualResultFromCapturedFrame((0, secure_cleanup_1.cloneImageData)(initialFrame))
                : await this.visualAnalyser.analyse(viewer);
            const seed = {
                initialTime,
                initialFrame: initialFrame ? (0, secure_cleanup_1.cloneImageData)(initialFrame) : null,
            };
            const videoResult = await this.videoAnalyser.analyse(viewer, seed);
            return { visualResult, videoResult };
        }
        finally {
            if (initialFrame) {
                (0, secure_cleanup_1.zeroImageData)(initialFrame);
            }
        }
    }
    async visualResultFromCapturedFrame(imageData) {
        const t0 = performance.now();
        const result = await this.visualAnalyser.scoreCapturedFrame(imageData);
        return {
            modality: "visual",
            score: result.score,
            confidence: result.confidence,
            available: true,
            inferenceTimeMs: performance.now() - t0,
        };
    }
    computeCompositeDrivers(modalityResults, effectiveWeights) {
        return modalityResults
            .filter((r) => r.available)
            .map((r) => {
            const weight = effectiveWeights[r.modality] ?? 0;
            const impact = (r.score - 50) * weight;
            return {
                modality: r.modality,
                score: Math.round(r.score),
                confidence: Number(r.confidence.toFixed(2)),
                weight: Number(weight.toFixed(3)),
                impact: Math.round(impact),
            };
        })
            .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
    }
    buildImageReasoning(visualResult, videoResult, imageScore) {
        const imageModalities = [visualResult, videoResult].filter((result) => result.available);
        const chosen = visualResult.available
            ? visualResult
            : videoResult.available
                ? videoResult
                : null;
        const chosenConfidence = chosen?.confidence ?? 0;
        const confidenceBand = chosenConfidence >= 0.65
            ? "high"
            : chosenConfidence >= 0.4
                ? "medium"
                : "low";
        const caveats = [];
        if (!visualResult.available && !videoResult.available) {
            caveats.push("No visual or video modality was available.");
        }
        if (confidenceBand === "low") {
            caveats.push("Low visual confidence; image signal is weak.");
        }
        const topDrivers = imageModalities
            .map((result) => ({
            modality: result.modality,
            score: Math.round(result.score),
            confidence: Number(result.confidence.toFixed(2)),
            weight: 1,
            impact: Math.round(result.score - 50),
        }))
            .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
        if (topDrivers.length >= 2) {
            const [first, second] = topDrivers;
            const disagreement = Math.abs(first.score - second.score);
            if (disagreement >= 12) {
                caveats.push(`Visual and video signals disagree by ${disagreement} points.`);
            }
        }
        if (chosen && chosen.confidence <= 0.35) {
            caveats.push("Likely heuristic fallback or low-quality frame capture.");
        }
        if (!chosen) {
            return {
                summary: "Image/visual reasoning only: no image modality available, so imageScore = 50 (neutral default).",
                confidenceBand: "low",
                topDrivers: [],
                caveats,
            };
        }
        const secondary = chosen.modality === "visual"
            ? imageModalities.find((result) => result.modality === "video")
            : imageModalities.find((result) => result.modality === "visual");
        const secondaryNote = secondary
            ? ` Secondary ${secondary.modality} scored ${Math.round(secondary.score)}/100 (${secondary.confidence.toFixed(2)}).`
            : "";
        return {
            summary: `Image/visual reasoning only: imageScore = round(${chosen.modality}.score ${chosen.score.toFixed(2)}) = ${imageScore}. Source confidence ${chosen.confidence.toFixed(2)}.${secondaryNote}`,
            confidenceBand,
            topDrivers: topDrivers.slice(0, 3),
            caveats,
        };
    }
    confidenceAdjustedImageScore(score, confidence) {
        const c = Math.max(0, Math.min(1, confidence));
        // Pull uncertain scores toward neutral (50); retain strong scores when confidence is high.
        return Math.round(50 + (score - 50) * c);
    }
}
exports.AnalysisPipeline = AnalysisPipeline;
