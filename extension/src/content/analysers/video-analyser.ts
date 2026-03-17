/**
 * Video frame analyser.
 *
 * Samples up to 3 frames from video stories and runs each through the
 * visual frame scorer. Returns the median risk score across frames to avoid
 * letting one outlier frame dominate the result.
 *
 * Sampling strategy (non-disruptive):
 *   Frame 1: current playback position (no seeking)
 *   Frame 2: current position + 0.5s (temporary seek, immediately restored)
 *   Frame 3: current position + 1.5s (temporary seek, immediately restored)
 *
 * If the video is too short for offset frames, only captured frames are used.
 * Falls back to single-frame if seeking throws (cross-origin, DRM, etc.)
 */

import type { Analyser, ModalityResult } from "../../shared/types";
import { captureVideoFrame } from "../image-analyser";
import { cloneImageData, zeroImageData } from "../privacy/secure-cleanup";
import { VisualEmotionAnalyser } from "./visual-emotion-analyser";

const SEEK_OFFSETS_S = [0, 0.5, 1.5];

export interface VideoAnalysisSeed {
  initialFrame?: ImageData | null;
  initialTime?: number;
}

interface FrameScorer {
  scoreCapturedFrame(imageData: ImageData): Promise<{ score: number; confidence: number }>;
  dispose(): void;
}

export class VideoAnalyser implements Analyser {
  readonly modality = "video" as const;
  private visualAnalyser: FrameScorer;

  constructor(
    private readonly captureFrame: (video: HTMLVideoElement) => ImageData | null = captureVideoFrame,
    visualAnalyser: FrameScorer = new VisualEmotionAnalyser()
  ) {
    this.visualAnalyser = visualAnalyser;
  }

  isAvailable(viewer: HTMLElement): boolean {
    const video = viewer.querySelector("video") as HTMLVideoElement | null;
    return video !== null && video.readyState >= 2 && video.duration > 0;
  }

  async analyse(
    viewer: HTMLElement,
    seed: VideoAnalysisSeed = {}
  ): Promise<ModalityResult> {
    const t0 = performance.now();
    const video = viewer.querySelector("video") as HTMLVideoElement | null;

    if (!video || video.readyState < 2 || video.duration <= 0) {
      return this.unavailableResult(performance.now() - t0);
    }

    const frameResults: ModalityResult[] = [];
    const originalTime = seed.initialTime ?? video.currentTime;
    const wasPaused = video.paused;

    video.pause();

    for (const offsetS of SEEK_OFFSETS_S) {
      const targetTime = Math.min(originalTime + offsetS, video.duration - 0.1);
      const initialFrame =
        offsetS === 0 && seed.initialFrame ? cloneImageData(seed.initialFrame) : null;
      const frame = await this.captureAtTime(video, targetTime, initialFrame);
      if (frame !== null) frameResults.push(frame);
    }

    // Restore video state
    try {
      video.currentTime = originalTime;
      if (!wasPaused) video.play().catch(() => {});
    } catch {
      // restore failure is non-critical
    }

    if (frameResults.length === 0) {
      return this.unavailableResult(performance.now() - t0);
    }

    const aggregate = aggregateFrameResults(frameResults);

    return {
      modality: "video",
      score: aggregate.score,
      confidence: aggregate.confidence,
      available: true,
      inferenceTimeMs: performance.now() - t0,
    };
  }

  private async captureAtTime(
    video: HTMLVideoElement,
    targetTime: number,
    initialFrame: ImageData | null
  ): Promise<ModalityResult | null> {
    try {
      let imageData = initialFrame;
      if (!imageData) {
        const seeked = await this.seekTo(video, targetTime);
        if (!seeked) return null;
        imageData = this.captureFrame(video);
      }

      if (!imageData) {
        return null;
      }

      const result = await this.visualAnalyser.scoreCapturedFrame(imageData);
      return {
        modality: "video",
        score: result.score,
        confidence: result.confidence,
        available: true,
        inferenceTimeMs: 0,
      };
    } catch {
      if (initialFrame) {
        zeroImageData(initialFrame);
      }
      return null;
    }
  }

  /**
   * Seeks video to targetTime and waits for the seeked event.
   * Times out after 300ms to stay within the 500ms total analysis budget.
   */
  private seekTo(video: HTMLVideoElement, targetTime: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (Math.abs(video.currentTime - targetTime) < 0.05) {
        resolve(true);
        return;
      }

      const timeout = setTimeout(() => {
        video.removeEventListener("seeked", onSeeked);
        resolve(false);
      }, 300);

      const onSeeked = () => {
        clearTimeout(timeout);
        video.removeEventListener("seeked", onSeeked);
        resolve(true);
      };

      video.addEventListener("seeked", onSeeked, { once: true });
      try {
        video.currentTime = targetTime;
      } catch {
        clearTimeout(timeout);
        video.removeEventListener("seeked", onSeeked);
        resolve(false);
      }
    });
  }

  private unavailableResult(inferenceTimeMs: number): ModalityResult {
    return {
      modality: "video",
      score: 50,
      confidence: 0,
      available: false,
      inferenceTimeMs,
    };
  }

  dispose(): void {
    this.visualAnalyser.dispose();
  }
}

export function aggregateFrameResults(
  frameResults: ReadonlyArray<Pick<ModalityResult, "score" | "confidence">>
): { score: number; confidence: number } {
  if (frameResults.length === 0) {
    return { score: 50, confidence: 0 };
  }

  const scoreValues = frameResults.map((result) => result.score);
  const confidenceValues = frameResults.map((result) => result.confidence);

  return {
    score: Math.round(median(scoreValues)),
    confidence: median(confidenceValues),
  };
}

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }

  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
