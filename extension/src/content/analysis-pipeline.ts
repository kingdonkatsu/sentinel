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

import type {
  AnalysisResult,
  ModalityResult,
  ModalityType,
  RiskScore,
  ScoreReasoning,
  ScoreReasoningDriver,
} from "../shared/types";
import { captureStoryImage } from "./image-analyser";
import { OverlayRenderer } from "./overlay-renderer";
import { ScoreTransmitter } from "./score-transmitter";
import { VisualEmotionAnalyser } from "./analysers/visual-emotion-analyser";
import { SemanticTextAnalyser } from "./analysers/semantic-text-analyser";
import { TemporalAnalyser } from "./analysers/temporal-analyser";
import { VideoAnalyser, type VideoAnalysisSeed } from "./analysers/video-analyser";
import { MetadataAnalyser } from "./analysers/metadata-analyser";
import { compositeScorer } from "./scoring/composite-scorer";
import { weightCalibrator } from "./scoring/weight-calibrator";
import { memoryMonitor } from "./privacy/memory-monitor";
import { cloneImageData, zeroImageData } from "./privacy/secure-cleanup";

type OverlayLike = Pick<OverlayRenderer, "show" | "dismiss">;
type TransmitterLike = Pick<ScoreTransmitter, "init" | "send">;
type VisualAnalyserLike = Pick<
  VisualEmotionAnalyser,
  "analyse" | "scoreCapturedFrame" | "dispose"
>;
type TextAnalyserLike = Pick<SemanticTextAnalyser, "analyse" | "dispose">;
type TemporalAnalyserLike = Pick<
  TemporalAnalyser,
  "analyse" | "dispose" | "record" | "setUsername"
>;
type VideoAnalyserLike = Pick<VideoAnalyser, "isAvailable" | "analyse" | "dispose">;
type MetadataAnalyserLike = Pick<MetadataAnalyser, "analyse" | "dispose">;
type WeightCalibratorLike = Pick<typeof weightCalibrator, "load" | "getWeights">;
type MemoryMonitorLike = Pick<typeof memoryMonitor, "startMonitoring" | "stopMonitoring">;

interface AnalysisPipelineDeps {
  overlay: OverlayLike;
  transmitter: TransmitterLike;
  visualAnalyser: VisualAnalyserLike;
  textAnalyser: TextAnalyserLike;
  temporalAnalyser: TemporalAnalyserLike;
  videoAnalyser: VideoAnalyserLike;
  metadataAnalyser: MetadataAnalyserLike;
  weightCalibrator: WeightCalibratorLike;
  memoryMonitor: MemoryMonitorLike;
  captureStoryImage: typeof captureStoryImage;
}

export class AnalysisPipeline {
  private overlay: OverlayLike;
  private transmitter: TransmitterLike;
  private threshold = 70;

  private visualAnalyser: VisualAnalyserLike;
  private textAnalyser: TextAnalyserLike;
  private temporalAnalyser: TemporalAnalyserLike;
  private videoAnalyser: VideoAnalyserLike;
  private metadataAnalyser: MetadataAnalyserLike;
  private calibrator: WeightCalibratorLike;
  private memoryMonitor: MemoryMonitorLike;
  private captureStoryImage: typeof captureStoryImage;

  constructor(deps: Partial<AnalysisPipelineDeps> = {}) {
    this.overlay = deps.overlay ?? new OverlayRenderer();
    this.transmitter = deps.transmitter ?? new ScoreTransmitter();
    this.visualAnalyser = deps.visualAnalyser ?? new VisualEmotionAnalyser();
    this.textAnalyser = deps.textAnalyser ?? new SemanticTextAnalyser();
    this.temporalAnalyser = deps.temporalAnalyser ?? new TemporalAnalyser();
    this.videoAnalyser = deps.videoAnalyser ?? new VideoAnalyser();
    this.metadataAnalyser = deps.metadataAnalyser ?? new MetadataAnalyser();
    this.calibrator = deps.weightCalibrator ?? weightCalibrator;
    this.memoryMonitor = deps.memoryMonitor ?? memoryMonitor;
    this.captureStoryImage = deps.captureStoryImage ?? captureStoryImage;
  }

  async init(): Promise<void> {
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

  async analyse(
    viewer: HTMLElement,
    username: string
  ): Promise<AnalysisResult> {
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

    const modalityResults: ModalityResult[] = [
      textResult,
      visualResult,
      temporalResult,
      metadataResult,
      videoResult,
    ];

    // ── Fuse with calibrated weights ─────────────────────────────────────
    const calibratedWeights = this.calibrator.getWeights();
    const { composite, overallConfidence, effectiveWeights } =
      compositeScorer.fuse(modalityResults, calibratedWeights);
    const compositeDrivers = this.computeCompositeDrivers(
      modalityResults,
      effectiveWeights
    );
    const imageScore = Math.round(
      visualResult.available ? visualResult.score : videoResult.score
    );
    const reasoning = this.buildImageReasoning(
      visualResult,
      videoResult,
      imageScore
    );
    const imageScoreSource =
      visualResult.available ? "visual" : videoResult.available ? "video" : "neutral-default";
    const imageScoreRaw =
      imageScoreSource === "visual"
        ? visualResult.score
        : imageScoreSource === "video"
          ? videoResult.score
          : 50;
    const imageConfidenceRaw =
      imageScoreSource === "visual"
        ? visualResult.confidence
        : imageScoreSource === "video"
          ? videoResult.confidence
          : 0;
    const imageScoreAdjusted = this.confidenceAdjustedImageScore(
      imageScoreRaw,
      imageConfidenceRaw
    );

    // ── Build score payload (only numbers, zero content) ─────────────────
    const modalityScores: Partial<Record<ModalityType, number>> = {};
    for (const r of modalityResults) {
      if (r.available) modalityScores[r.modality] = r.score;
    }

    const score: RiskScore = {
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
      modalities: Object.fromEntries(
        modalityResults
          .filter((r) => r.available)
          .map((r) => [r.modality, `${r.score}@${r.confidence.toFixed(2)}`])
      ),
      unavailableModalities: modalityResults
        .filter((r) => !r.available)
        .map((r) => r.modality),
      inferenceMs: Object.fromEntries(
        modalityResults.map((r) => [r.modality, Math.round(r.inferenceTimeMs)])
      ),
      weights: Object.fromEntries(
        Object.entries(effectiveWeights).map(([k, v]) => [k, (v ?? 0).toFixed(3)])
      ),
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

  private unavailableResult(modality: ModalityType): ModalityResult {
    return {
      modality,
      score: 50,
      confidence: 0,
      available: false,
      inferenceTimeMs: 0,
    };
  }

  dispose(): void {
    this.visualAnalyser.dispose();
    this.textAnalyser.dispose();
    this.temporalAnalyser.dispose();
    this.videoAnalyser.dispose();
    this.metadataAnalyser.dispose();
    this.memoryMonitor.stopMonitoring();
  }

  private async analyseVideoStory(
    viewer: HTMLElement
  ): Promise<{ visualResult: ModalityResult; videoResult: ModalityResult }> {
    const video = viewer.querySelector("video") as HTMLVideoElement | null;
    const initialTime = video?.currentTime;
    const initialFrame = await this.captureStoryImage(viewer);

    try {
      const visualResult = initialFrame
        ? await this.visualResultFromCapturedFrame(cloneImageData(initialFrame))
        : await this.visualAnalyser.analyse(viewer);

      const seed: VideoAnalysisSeed = {
        initialTime,
        initialFrame: initialFrame ? cloneImageData(initialFrame) : null,
      };
      const videoResult = await this.videoAnalyser.analyse(viewer, seed);

      return { visualResult, videoResult };
    } finally {
      if (initialFrame) {
        zeroImageData(initialFrame);
      }
    }
  }

  private async visualResultFromCapturedFrame(
    imageData: ImageData
  ): Promise<ModalityResult> {
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

  private computeCompositeDrivers(
    modalityResults: ModalityResult[],
    effectiveWeights: Partial<Record<ModalityType, number>>
  ): ScoreReasoningDriver[] {
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

  private buildImageReasoning(
    visualResult: ModalityResult,
    videoResult: ModalityResult,
    imageScore: number
  ): ScoreReasoning {
    const imageModalities: ModalityResult[] = [visualResult, videoResult].filter(
      (result) => result.available
    );
    const chosen =
      visualResult.available
        ? visualResult
        : videoResult.available
          ? videoResult
          : null;
    const chosenConfidence = chosen?.confidence ?? 0;
    const confidenceBand =
      chosenConfidence >= 0.65
        ? "high"
        : chosenConfidence >= 0.4
          ? "medium"
          : "low";

    const caveats: string[] = [];
    if (!visualResult.available && !videoResult.available) {
      caveats.push("No visual or video modality was available.");
    }
    if (confidenceBand === "low") {
      caveats.push("Low visual confidence; image signal is weak.");
    }

    const topDrivers: ScoreReasoningDriver[] = imageModalities
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
        caveats.push(
          `Visual and video signals disagree by ${disagreement} points.`
        );
      }
    }

    if (chosen && chosen.confidence <= 0.35) {
      caveats.push("Likely heuristic fallback or low-quality frame capture.");
    }

    if (!chosen) {
      return {
        summary:
          "Image/visual reasoning only: no image modality available, so imageScore = 50 (neutral default).",
        confidenceBand: "low",
        topDrivers: [],
        caveats,
      };
    }

    const secondary =
      chosen.modality === "visual"
        ? imageModalities.find((result) => result.modality === "video")
        : imageModalities.find((result) => result.modality === "visual");

    const secondaryNote = secondary
      ? ` Secondary ${secondary.modality} scored ${Math.round(
          secondary.score
        )}/100 (${secondary.confidence.toFixed(2)}).`
      : "";

    return {
      summary: `Image/visual reasoning only: imageScore = round(${chosen.modality}.score ${chosen.score.toFixed(
        2
      )}) = ${imageScore}. Source confidence ${chosen.confidence.toFixed(
        2
      )}.${secondaryNote}`,
      confidenceBand,
      topDrivers: topDrivers.slice(0, 3),
      caveats,
    };
  }

  private confidenceAdjustedImageScore(score: number, confidence: number): number {
    const c = Math.max(0, Math.min(1, confidence));
    // Pull uncertain scores toward neutral (50); retain strong scores when confidence is high.
    return Math.round(50 + (score - 50) * c);
  }
}
