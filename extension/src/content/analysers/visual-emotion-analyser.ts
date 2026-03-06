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
import { analyseImage, captureStoryImage } from "../image-analyser";
import { zeroImageData, destroyCanvas } from "../privacy/secure-cleanup";
import type * as FaceApiType from "@vladmandic/face-api";

const MODELS_URL = chrome.runtime.getURL("models/faceapi");

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
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL),
        faceapi.nets.faceExpressionNet.loadFromUri(MODELS_URL),
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

export class VisualEmotionAnalyser implements Analyser {
  readonly modality = "visual" as const;

  isAvailable(viewer: HTMLElement): boolean {
    const img = viewer.querySelector('img[draggable="false"]') as HTMLImageElement | null;
    const video = viewer.querySelector("video") as HTMLVideoElement | null;
    return (
      (img !== null && img.complete && img.naturalWidth > 0) ||
      (video !== null && video.readyState >= 2)
    );
  }

  async analyse(viewer: HTMLElement): Promise<ModalityResult> {
    const t0 = performance.now();
    const canvas = document.createElement("canvas");
    canvas.width = 224;
    canvas.height = 224;

    try {
      const imageData = await captureStoryImage(viewer);

      if (!imageData) {
        return this.unavailableResult(performance.now() - t0);
      }

      // Attempt ML-based scoring
      const mlResult = await this.scoreWithFaceApi(imageData, canvas);
      if (mlResult !== null) {
        zeroImageData(imageData);
        return {
          modality: "visual",
          score: mlResult.score,
          confidence: mlResult.confidence,
          available: true,
          inferenceTimeMs: performance.now() - t0,
        };
      }

      // Fallback: colour histogram heuristic
      const heuristicScore = analyseImage(imageData);
      zeroImageData(imageData);
      return {
        modality: "visual",
        score: heuristicScore,
        confidence: 0.3,
        available: true,
        inferenceTimeMs: performance.now() - t0,
      };
    } finally {
      destroyCanvas(canvas);
    }
  }

  private async scoreWithFaceApi(
    imageData: ImageData,
    canvas: HTMLCanvasElement
  ): Promise<{ score: number; confidence: number } | null> {
    const faceapi = await loadFaceApi();
    if (!faceapi) return null;

    try {
      const ctx = canvas.getContext("2d")!;
      ctx.putImageData(imageData, 0, 0);

      const detections = await faceapi
        .detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions())
        .withFaceExpressions();

      if (!detections.length) return null;

      // Use the detection with highest confidence face score
      const best = detections.reduce((a, b) =>
        a.detection.score > b.detection.score ? a : b
      );

      const expressions = best.expressions as unknown as Record<string, number>;

      let riskScore = 0;
      let maxProb = 0;
      for (const [label, prob] of Object.entries(expressions)) {
        const weight = EXPRESSION_RISK_WEIGHTS[label] ?? 0;
        riskScore += prob * weight;
        if (prob > maxProb) maxProb = prob;
      }

      return {
        score: Math.round(Math.min(100, riskScore * 100)),
        confidence: Math.min(0.9, 0.6 + maxProb * 0.3),
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
