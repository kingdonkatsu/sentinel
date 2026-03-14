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
        // ── Build score payload (only numbers, zero content) ─────────────────
        const modalityScores = {};
        for (const r of modalityResults) {
            if (r.available)
                modalityScores[r.modality] = r.score;
        }
        const score = {
            composite,
            textScore: Math.round(textResult.score),
            imageScore: Math.round(visualResult.available ? visualResult.score : videoResult.score),
            timestamp: Date.now(),
            username,
        };
        console.log("[Sentinel] Score v2:", {
            username,
            composite,
            confidence: overallConfidence.toFixed(2),
            textStatus: textResult.status ?? (textResult.available ? "ok" : "missing"),
            modalities: Object.fromEntries(modalityResults
                .filter((r) => r.available)
                .map((r) => [r.modality, `${r.score}@${r.confidence.toFixed(2)}`])),
            weights: Object.fromEntries(Object.entries(effectiveWeights).map(([k, v]) => [k, (v ?? 0).toFixed(3)])),
            drivers: modalityResults
                .filter((r) => r.available)
                .map((r) => ({
                modality: r.modality,
                deltaFromNeutral: Math.round((r.score - 50) * (effectiveWeights[r.modality] ?? 0)),
                score: r.score,
                confidence: r.confidence,
            }))
                .sort((a, b) => Math.abs(b.deltaFromNeutral) - Math.abs(a.deltaFromNeutral))
                .slice(0, 3),
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
}
exports.AnalysisPipeline = AnalysisPipeline;
