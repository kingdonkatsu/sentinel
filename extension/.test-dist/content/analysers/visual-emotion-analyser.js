"use strict";
/**
 * Visual emotion analyser.
 *
 * Uses face-api.js (vladmandic fork) to:
 *   1. Detect faces with TinyFaceDetector (~190 KB model)
 *   2. Classify facial expressions into 7 classes (~330 KB model)
 *
 * Falls back to colour-histogram heuristic when:
 *   - Model files are absent
 *   - No face is detected in the frame
 *   - Any error occurs during inference
 *
 * Models loaded from extension bundle:
 *   public/models/faceapi/tiny_face_detector_model-weights_manifest.json
 *   public/models/faceapi/face_expression_model-weights_manifest.json
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
exports.VisualEmotionAnalyser = void 0;
const image_analyser_1 = require("../image-analyser");
const visual_context_cues_1 = require("./visual-context-cues");
const secure_cleanup_1 = require("../privacy/secure-cleanup");
/**
 * Risk weights for each FER expression class.
 * face-api.js returns: angry, disgusted, fearful, happy, neutral, sad, surprised
 */
const EXPRESSION_RISK_WEIGHTS = {
    angry: 0.70,
    disgusted: 0.60,
    fearful: 0.85,
    happy: 0.00,
    neutral: 0.05,
    sad: 0.90,
    surprised: 0.35,
};
let faceApiModule = null;
let modelsLoaded = false;
async function loadFaceApi() {
    if (faceApiModule && modelsLoaded)
        return faceApiModule;
    try {
        const faceapi = await Promise.resolve().then(() => __importStar(require("@vladmandic/face-api")));
        if (!modelsLoaded) {
            const modelsUrl = getModelsUrl();
            await Promise.all([
                faceapi.nets.tinyFaceDetector.loadFromUri(modelsUrl),
                faceapi.nets.faceExpressionNet.loadFromUri(modelsUrl),
            ]);
            modelsLoaded = true;
            console.log("[Sentinel] face-api.js models loaded");
        }
        faceApiModule = faceapi;
        return faceapi;
    }
    catch {
        // Model files not present — will use fallback
        return null;
    }
}
function getModelsUrl() {
    return chrome.runtime.getURL("models/faceapi");
}
class VisualEmotionAnalyser {
    modality = "visual";
    isAvailable(viewer) {
        return (0, image_analyser_1.findPrimaryStoryMedia)(viewer) !== null;
    }
    async analyse(viewer) {
        const t0 = performance.now();
        const imageData = await (0, image_analyser_1.captureStoryImage)(viewer);
        if (!imageData) {
            return this.unavailableResult(performance.now() - t0);
        }
        const frameScore = await this.scoreCapturedFrame(imageData);
        return {
            modality: "visual",
            score: frameScore.score,
            confidence: frameScore.confidence,
            available: true,
            inferenceTimeMs: performance.now() - t0,
        };
    }
    async scoreCapturedFrame(imageData) {
        const canvas = document.createElement("canvas");
        canvas.width = 224;
        canvas.height = 224;
        let normalizedFrame = null;
        try {
            const heuristicScore = (0, image_analyser_1.analyseImage)(imageData);
            normalizedFrame = this.normalizeToModelFrame(imageData, canvas);
            const shadowHeuristic = (0, image_analyser_1.analyseImageDetailed)(normalizedFrame);
            const shadowContextCues = (0, visual_context_cues_1.extractVisualContextCues)(normalizedFrame);
            // Attempt ML-based scoring
            const mlResult = await this.scoreWithFaceApi(imageData, canvas);
            let activeScore = heuristicScore;
            let activeConfidence = 0.3;
            let activeStrategy = "heuristic";
            if (mlResult !== null) {
                const mlWeight = mlResult.faceCount >= 2 ? 0.5 : 0.7;
                const blendedScore = Math.round(mlResult.score * mlWeight + heuristicScore * (1 - mlWeight));
                const blendedConfidence = Math.abs(mlResult.score - heuristicScore) >= 30
                    ? Math.max(0.55, mlResult.confidence - 0.1)
                    : mlResult.confidence;
                activeScore = blendedScore;
                activeConfidence = blendedConfidence;
                activeStrategy = "face-blend";
            }
            const shadowScoreResult = mlResult !== null
                ? (() => {
                    const mlWeight = mlResult.faceCount >= 2 ? 0.5 : 0.7;
                    const blendedScore = Math.round(mlResult.score * mlWeight +
                        shadowHeuristic.score * (1 - mlWeight));
                    const blendedConfidence = Math.abs(mlResult.score - shadowHeuristic.score) >= 30
                        ? Math.max(0.55, mlResult.confidence - 0.1)
                        : mlResult.confidence;
                    return {
                        ...(0, visual_context_cues_1.applyVisualContextCues)(blendedScore, blendedConfidence, shadowContextCues),
                        strategy: "face-blend",
                    };
                })()
                : {
                    ...(0, visual_context_cues_1.applyVisualContextCues)(shadowHeuristic.score, 0.3, shadowContextCues),
                    strategy: "heuristic",
                };
            const contextFlags = {
                bloodLike: shadowContextCues.bloodLike,
                pillLike: shadowContextCues.pillLike,
                medicalSettingLike: shadowContextCues.medicalSettingLike,
                injuryChaosLike: shadowContextCues.injuryChaosLike,
            };
            this.logShadowComparison({
                active: {
                    score: activeScore,
                    confidence: activeConfidence,
                    strategy: activeStrategy,
                    heuristicScore,
                },
                shadow: {
                    score: shadowScoreResult.score,
                    confidence: shadowScoreResult.confidence,
                    strategy: shadowScoreResult.strategy,
                    heuristic: shadowHeuristic,
                    contextCueScore: shadowContextCues.cueScore,
                    contextReasons: shadowContextCues.reasons,
                    contextFlags,
                },
                ml: {
                    score: mlResult?.score ?? null,
                    faceCount: mlResult?.faceCount ?? null,
                },
            });
            return {
                score: activeScore,
                confidence: activeConfidence,
                shadowScore: shadowScoreResult.score,
                shadowConfidence: shadowScoreResult.confidence,
                shadowStrategy: shadowScoreResult.strategy,
                shadowHeuristic,
                shadowContextCueScore: shadowContextCues.cueScore,
                shadowContextReasons: shadowContextCues.reasons,
                shadowContextFlags: contextFlags,
                faceCount: mlResult?.faceCount,
                mlScore: mlResult?.score,
            };
        }
        finally {
            if (normalizedFrame && normalizedFrame !== imageData) {
                (0, secure_cleanup_1.zeroImageData)(normalizedFrame);
            }
            (0, secure_cleanup_1.zeroImageData)(imageData);
            (0, secure_cleanup_1.destroyCanvas)(canvas);
        }
    }
    normalizeToModelFrame(imageData, targetCanvas) {
        if (imageData.width === 224 && imageData.height === 224) {
            return imageData;
        }
        const sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = imageData.width;
        sourceCanvas.height = imageData.height;
        const sourceContext = sourceCanvas.getContext("2d");
        const targetContext = targetCanvas.getContext("2d");
        if (!sourceContext || !targetContext) {
            sourceCanvas.remove();
            return imageData;
        }
        try {
            sourceContext.putImageData(imageData, 0, 0);
            targetContext.clearRect(0, 0, 224, 224);
            targetContext.drawImage(sourceCanvas, 0, 0, 224, 224);
            return targetContext.getImageData(0, 0, 224, 224);
        }
        finally {
            sourceCanvas.remove();
        }
    }
    async scoreWithFaceApi(imageData, canvas) {
        const faceapi = await loadFaceApi();
        if (!faceapi)
            return null;
        try {
            const ctx = canvas.getContext("2d");
            ctx.putImageData(imageData, 0, 0);
            const detections = await faceapi
                .detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions())
                .withFaceExpressions();
            if (!detections.length)
                return null;
            let weightedRiskSum = 0;
            let weightedMaxProbSum = 0;
            let weightTotal = 0;
            for (const detection of detections) {
                const expressions = detection.expressions;
                const box = detection.detection.box;
                const faceWeight = Math.max(1, box.width * box.height) * detection.detection.score;
                let faceRisk = 0;
                let faceMaxProb = 0;
                for (const [label, prob] of Object.entries(expressions)) {
                    const weight = EXPRESSION_RISK_WEIGHTS[label] ?? 0;
                    faceRisk += prob * weight;
                    if (prob > faceMaxProb)
                        faceMaxProb = prob;
                }
                weightedRiskSum += faceRisk * faceWeight;
                weightedMaxProbSum += faceMaxProb * faceWeight;
                weightTotal += faceWeight;
            }
            if (weightTotal === 0)
                return null;
            const averageRisk = weightedRiskSum / weightTotal;
            const averageMaxProb = weightedMaxProbSum / weightTotal;
            return {
                score: Math.round(Math.min(100, averageRisk * 100)),
                confidence: Math.min(0.9, 0.58 + averageMaxProb * 0.27),
                faceCount: detections.length,
            };
        }
        catch {
            return null;
        }
    }
    unavailableResult(inferenceTimeMs) {
        return {
            modality: "visual",
            score: 50,
            confidence: 0,
            available: false,
            inferenceTimeMs,
        };
    }
    logShadowComparison(payload) {
        console.log("[Sentinel][Visual Shadow]", {
            live: {
                score: payload.active.score,
                confidence: Number(payload.active.confidence.toFixed(3)),
                strategy: payload.active.strategy,
                heuristicScore: payload.active.heuristicScore,
            },
            shadow: {
                score: payload.shadow.score,
                confidence: Number(payload.shadow.confidence.toFixed(3)),
                strategy: payload.shadow.strategy,
                deltaFromLive: payload.shadow.score - payload.active.score,
                heuristicTone: payload.shadow.heuristic.toneScore,
                heuristicScene: payload.shadow.heuristic.sceneCueScore,
                heuristicComposite: payload.shadow.heuristic.score,
                contextCueScore: payload.shadow.contextCueScore,
                contextReasons: payload.shadow.contextReasons,
                contextFlags: payload.shadow.contextFlags,
            },
            ml: payload.ml,
        });
    }
    dispose() {
        modelsLoaded = false;
        faceApiModule = null;
    }
}
exports.VisualEmotionAnalyser = VisualEmotionAnalyser;
