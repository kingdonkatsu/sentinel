/**
 * Phase 2 analysis pipeline.
 *
 * Orchestrates 5 modality analysers in parallel, then fuses results using
 * the Bayesian confidence-weighted compositor and calibrated base weights.
 *
 * Modalities:
 *   - text     SemanticTextAnalyser  (MiniLM-L6 embeddings + keyword fallback)
 *   - visual   VisualEmotionAnalyser (BlazeFace + MobileNetV2 + histogram fallback)
 *   - temporal TemporalAnalyser      (ring buffer + posting pattern detection)
 *   - video    VideoAnalyser         (multi-frame sampling, video stories only)
 *   - metadata MetadataAnalyser      (DOM-based platform signals)
 *
 * Privacy guarantees (unchanged from Phase 1):
 *   - Raw story content (pixels, text, audio) never leaves the browser
 *   - Only numerical scores + username are transmitted to the backend
 *   - All tensor/string references are explicitly released after scoring
 */

import type { AnalysisResult, ModalityResult, ModalityType, RiskScore } from "../shared/types";
import { OverlayRenderer } from "./overlay-renderer";
import { ScoreTransmitter } from "./score-transmitter";
import { VisualEmotionAnalyser } from "./analysers/visual-emotion-analyser";
import { SemanticTextAnalyser } from "./analysers/semantic-text-analyser";
import { TemporalAnalyser } from "./analysers/temporal-analyser";
import { VideoAnalyser } from "./analysers/video-analyser";
import { MetadataAnalyser } from "./analysers/metadata-analyser";
import { compositeScorer } from "./scoring/composite-scorer";
import { weightCalibrator } from "./scoring/weight-calibrator";
import { memoryMonitor } from "./privacy/memory-monitor";

export class AnalysisPipeline {
  private overlay = new OverlayRenderer();
  private transmitter = new ScoreTransmitter();
  private threshold = 70;

  private visualAnalyser = new VisualEmotionAnalyser();
  private textAnalyser = new SemanticTextAnalyser();
  private temporalAnalyser = new TemporalAnalyser();
  private videoAnalyser = new VideoAnalyser();
  private metadataAnalyser = new MetadataAnalyser();

  async init(): Promise<void> {
    await this.transmitter.init();
    await weightCalibrator.load();

    const config = await chrome.storage.local.get([
      "sentinel_threshold",
    ]);
    if (config.sentinel_threshold) {
      this.threshold = config.sentinel_threshold;
    }

    memoryMonitor.startMonitoring();
  }

  async analyse(
    viewer: HTMLElement,
    username: string
  ): Promise<AnalysisResult> {
    // ── Set username for temporal analyser (needs it before analyse()) ──
    this.temporalAnalyser.setUsername(username);

    // ── Determine which modalities are applicable ────────────────────────
    const hasVideo = this.videoAnalyser.isAvailable(viewer);

    // ── Run all modalities in parallel ───────────────────────────────────
    const [textResult, visualResult, temporalResult, metadataResult, videoResult] =
      await Promise.all([
        this.textAnalyser.analyse(viewer),
        this.visualAnalyser.analyse(viewer),
        this.temporalAnalyser.analyse(viewer),
        this.metadataAnalyser.analyse(viewer),
        hasVideo
          ? this.videoAnalyser.analyse(viewer)
          : Promise.resolve(this.unavailableResult("video")),
      ]);

    const modalityResults: ModalityResult[] = [
      textResult,
      visualResult,
      temporalResult,
      metadataResult,
      videoResult,
    ];

    // ── Fuse with calibrated weights ─────────────────────────────────────
    const calibratedWeights = weightCalibrator.getWeights();
    const { composite, overallConfidence, effectiveWeights } =
      compositeScorer.fuse(modalityResults, calibratedWeights);

    // ── Build score payload (only numbers, zero content) ─────────────────
    const modalityScores: Partial<Record<ModalityType, number>> = {};
    for (const r of modalityResults) {
      if (r.available) modalityScores[r.modality] = r.score;
    }

    const score: RiskScore = {
      composite,
      textScore: Math.round(textResult.score),
      imageScore: Math.round(
        visualResult.available ? visualResult.score : videoResult.score
      ),
      timestamp: Date.now(),
      username,
    };

    console.log("[Sentinel] Score v2:", {
      username,
      composite,
      confidence: overallConfidence.toFixed(2),
      modalities: Object.fromEntries(
        modalityResults
          .filter((r) => r.available)
          .map((r) => [r.modality, `${r.score}@${r.confidence.toFixed(2)}`])
      ),
      weights: Object.fromEntries(
        Object.entries(effectiveWeights).map(([k, v]) => [k, (v ?? 0).toFixed(3)])
      ),
      drivers: modalityResults
        .filter((r) => r.available)
        .map((r) => ({
          modality: r.modality,
          deltaFromNeutral: Math.round(
            (r.score - 50) * (effectiveWeights[r.modality] ?? 0)
          ),
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
    memoryMonitor.stopMonitoring();
  }
}
