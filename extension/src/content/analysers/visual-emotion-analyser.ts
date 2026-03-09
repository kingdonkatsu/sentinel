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

import type { Analyser, ModalityResult } from "../../shared/types";
import {
  analyseImage,
  captureStoryImage,
  findPrimaryStoryMedia,
} from "../image-analyser";
import { zeroImageData, destroyCanvas } from "../privacy/secure-cleanup";
import type * as FaceApiType from "@vladmandic/face-api";

/**
 * Risk weights for each FER expression class.
 * face-api.js returns: angry, disgusted, fearful, happy, neutral, sad, surprised
 */
const EXPRESSION_RISK_WEIGHTS: Record<string, number> = {
  angry:     0.70,
  disgusted: 0.60,
  fearful:   0.85,
  happy:     0.00,
  neutral:   0.05,
  sad:       0.90,
  surprised: 0.35,
};

let faceApiModule: typeof FaceApiType | null = null;
let modelsLoaded = false;

async function loadFaceApi(): Promise<typeof FaceApiType | null> {
  if (faceApiModule && modelsLoaded) return faceApiModule;
  try {
    const faceapi = await import("@vladmandic/face-api");

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
  } catch {
    // Model files not present — will use fallback
    return null;
  }
}

function getModelsUrl(): string {
  return chrome.runtime.getURL("models/faceapi");
}

export interface CapturedFrameScore {
  score: number;
  confidence: number;
}

export class VisualEmotionAnalyser implements Analyser {
  readonly modality = "visual" as const;

  isAvailable(viewer: HTMLElement): boolean {
    return findPrimaryStoryMedia(viewer) !== null;
  }

  async analyse(viewer: HTMLElement): Promise<ModalityResult> {
    const t0 = performance.now();
    const imageData = await captureStoryImage(viewer);

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

  async scoreCapturedFrame(imageData: ImageData): Promise<CapturedFrameScore> {
    const canvas = document.createElement("canvas");
    canvas.width = 224;
    canvas.height = 224;

    try {
      const heuristicScore = analyseImage(imageData);

      // Attempt ML-based scoring
      const mlResult = await this.scoreWithFaceApi(imageData, canvas);
      if (mlResult !== null) {
        const mlWeight = mlResult.faceCount >= 2 ? 0.5 : 0.7;
        const blendedScore = Math.round(
          mlResult.score * mlWeight + heuristicScore * (1 - mlWeight)
        );
        const blendedConfidence =
          Math.abs(mlResult.score - heuristicScore) >= 30
            ? Math.max(0.55, mlResult.confidence - 0.1)
            : mlResult.confidence;

        return {
          score: blendedScore,
          confidence: blendedConfidence,
        };
      }

      // Fallback: colour histogram heuristic
      return {
        score: heuristicScore,
        confidence: 0.3,
      };
    } finally {
      zeroImageData(imageData);
      destroyCanvas(canvas);
    }
  }

  private async scoreWithFaceApi(
    imageData: ImageData,
    canvas: HTMLCanvasElement
  ): Promise<{ score: number; confidence: number; faceCount: number } | null> {
    const faceapi = await loadFaceApi();
    if (!faceapi) return null;

    try {
      const ctx = canvas.getContext("2d")!;
      ctx.putImageData(imageData, 0, 0);

      const detections = await faceapi
        .detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions())
        .withFaceExpressions();

      if (!detections.length) return null;

      let weightedRiskSum = 0;
      let weightedMaxProbSum = 0;
      let weightTotal = 0;

      for (const detection of detections) {
        const expressions =
          detection.expressions as unknown as Record<string, number>;
        const box = detection.detection.box;
        const faceWeight =
          Math.max(1, box.width * box.height) * detection.detection.score;

        let faceRisk = 0;
        let faceMaxProb = 0;
        for (const [label, prob] of Object.entries(expressions)) {
          const weight = EXPRESSION_RISK_WEIGHTS[label] ?? 0;
          faceRisk += prob * weight;
          if (prob > faceMaxProb) faceMaxProb = prob;
        }

        weightedRiskSum += faceRisk * faceWeight;
        weightedMaxProbSum += faceMaxProb * faceWeight;
        weightTotal += faceWeight;
      }

      if (weightTotal === 0) return null;

      const averageRisk = weightedRiskSum / weightTotal;
      const averageMaxProb = weightedMaxProbSum / weightTotal;

      return {
        score: Math.round(Math.min(100, averageRisk * 100)),
        confidence: Math.min(0.9, 0.58 + averageMaxProb * 0.27),
        faceCount: detections.length,
      };
    } catch {
      return null;
    }
  }

  private unavailableResult(inferenceTimeMs: number): ModalityResult {
    return {
      modality: "visual",
      score: 50,
      confidence: 0,
      available: false,
      inferenceTimeMs,
    };
  }

  dispose(): void {
    modelsLoaded = false;
    faceApiModule = null;
  }
}
