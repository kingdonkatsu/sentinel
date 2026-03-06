/**
 * Video frame analyser.
 *
 * Samples up to 3 frames from video stories and runs each through the
 * VisualEmotionAnalyser. Returns the maximum risk score across frames —
 * this prevents brief moments of acute distress from being averaged away.
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
import { VisualEmotionAnalyser } from "./visual-emotion-analyser";
import { destroyCanvas } from "../privacy/secure-cleanup";

const SEEK_OFFSETS_S = [0, 0.5, 1.5];

export class VideoAnalyser implements Analyser {
  readonly modality = "video" as const;
  private visualAnalyser = new VisualEmotionAnalyser();

  isAvailable(viewer: HTMLElement): boolean {
    const video = viewer.querySelector("video") as HTMLVideoElement | null;
    return video !== null && video.readyState >= 2 && video.duration > 0;
  }

  async analyse(viewer: HTMLElement): Promise<ModalityResult> {
    const t0 = performance.now();
    const video = viewer.querySelector("video") as HTMLVideoElement | null;

    if (!video || video.readyState < 2 || video.duration <= 0) {
      return this.unavailableResult(performance.now() - t0);
    }

    const frameResults: ModalityResult[] = [];
    const originalTime = video.currentTime;
    const wasPaused = video.paused;

    for (const offsetS of SEEK_OFFSETS_S) {
      const targetTime = Math.min(originalTime + offsetS, video.duration - 0.1);
      const frame = await this.captureAtTime(viewer, video, targetTime);
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

    // Return max score across all sampled frames (worst-case / most concerning)
    const maxResult = frameResults.reduce((best, r) =>
      r.score > best.score ? r : best
    );

    return {
      modality: "video",
      score: maxResult.score,
      confidence: maxResult.confidence,
      available: true,
      inferenceTimeMs: performance.now() - t0,
    };
  }

  private async captureAtTime(
    viewer: HTMLElement,
    video: HTMLVideoElement,
    targetTime: number
  ): Promise<ModalityResult | null> {
    try {
      const seeked = await this.seekTo(video, targetTime);
      if (!seeked) return null;

      const canvas = document.createElement("canvas");
      canvas.width = 224;
      canvas.height = 224;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        destroyCanvas(canvas);
        return null;
      }

      ctx.drawImage(video, 0, 0, 224, 224);
      // Run the visual analyser on this viewer (it will re-capture from the
      // video at its current seek position)
      const result = await this.visualAnalyser.analyse(viewer);
      destroyCanvas(canvas);
      return result;
    } catch {
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
