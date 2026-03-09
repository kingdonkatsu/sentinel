/**
 * Temporal pattern analyser.
 *
 * Maintains a per-username ring buffer (last 20 composite scores + timestamps)
 * in chrome.storage.session (cleared on browser close — zero persistence).
 *
 * Signals detected:
 *   - Rising score trend across recent stories
 *   - Rapid burst posting (>3 stories within 15 minutes)
 *   - Sustained high scores (≥70) across multiple consecutive stories
 *
 * Late-night posting is intentionally disabled until the pipeline has access
 * to an actual story-post timestamp rather than viewer-time metadata.
 *
 * Confidence scales with buffer depth:
 *   0 pts → 0.0 (no data)
 *   1 pt  → 0.1
 *   2-4   → 0.3
 *   5-9   → 0.5
 *   10+   → 0.8
 */

import type { Analyser, ModalityResult } from "../../shared/types";

const RING_BUFFER_SIZE = 20;
const BURST_WINDOW_MS = 15 * 60 * 1000;  // 15 minutes
const BURST_THRESHOLD = 3;               // >3 stories in the window

interface TemporalEntry {
  score: number;
  timestamp: number;
}

interface TemporalBuffer {
  entries: TemporalEntry[];
}

export class TemporalAnalyser implements Analyser {
  readonly modality = "temporal" as const;
  private currentUsername = "";

  isAvailable(_viewer: HTMLElement): boolean {
    return true;
  }

  /**
   * Must be called before analyse() to set the active username.
   */
  setUsername(username: string): void {
    this.currentUsername = username;
  }

  async analyse(_viewer: HTMLElement): Promise<ModalityResult> {
    const t0 = performance.now();

    if (!this.currentUsername) {
      return this.result(50, 0, true, performance.now() - t0);
    }

    const buffer = await this.loadBuffer(this.currentUsername);
    const score = this.computeScore(buffer.entries);
    const confidence = this.computeConfidence(buffer.entries.length);

    return this.result(score, confidence, true, performance.now() - t0);
  }

  /**
   * Records the composite score for the current story into the ring buffer.
   * Call this AFTER a full analysis completes so that the next run can see it.
   */
  async record(username: string, compositeScore: number): Promise<void> {
    const buffer = await this.loadBuffer(username);

    buffer.entries.push({ score: compositeScore, timestamp: Date.now() });

    // Trim to ring buffer size
    if (buffer.entries.length > RING_BUFFER_SIZE) {
      buffer.entries = buffer.entries.slice(-RING_BUFFER_SIZE);
    }

    await this.saveBuffer(username, buffer);
  }

  // ─── Score computation ───────────────────────────────────────────────────

  private computeScore(entries: TemporalEntry[]): number {
    if (entries.length === 0) return 50;

    let score = 50;

    // Rising trend: last 3 scores consistently higher than previous 3
    if (entries.length >= 6) {
      const recent = entries.slice(-3).map((e) => e.score);
      const prior = entries.slice(-6, -3).map((e) => e.score);
      const recentAvg = avg(recent);
      const priorAvg = avg(prior);
      if (recentAvg > priorAvg + 10) score += 15;
    }

    // Burst detection: >BURST_THRESHOLD stories in BURST_WINDOW_MS
    const now = Date.now();
    const recentBurst = entries.filter(
      (e) => now - e.timestamp < BURST_WINDOW_MS
    );
    if (recentBurst.length > BURST_THRESHOLD) {
      score += 10;
    }

    // Sustained high scores: ≥3 consecutive scores above 70
    const recentScores = entries.slice(-5).map((e) => e.score);
    const sustainedHigh = recentScores.filter((s) => s >= 70).length;
    if (sustainedHigh >= 3) score += 15;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private computeConfidence(bufferLength: number): number {
    if (bufferLength === 0) return 0.0;
    if (bufferLength === 1) return 0.1;
    if (bufferLength <= 4) return 0.3;
    if (bufferLength <= 9) return 0.5;
    return 0.8;
  }

  // ─── Storage ─────────────────────────────────────────────────────────────

  private storageKey(username: string): string {
    return `sentinel_temporal_${username}`;
  }

  private async loadBuffer(username: string): Promise<TemporalBuffer> {
    try {
      const result = await chrome.storage.session.get(this.storageKey(username));
      return (result[this.storageKey(username)] as TemporalBuffer | undefined) ??
        { entries: [] };
    } catch {
      return { entries: [] };
    }
  }

  private async saveBuffer(
    username: string,
    buffer: TemporalBuffer
  ): Promise<void> {
    try {
      await chrome.storage.session.set({
        [this.storageKey(username)]: buffer,
      });
    } catch {
      // session storage unavailable
    }
  }

  private result(
    score: number,
    confidence: number,
    available: boolean,
    inferenceTimeMs: number
  ): ModalityResult {
    return { modality: "temporal", score, confidence, available, inferenceTimeMs };
  }

  dispose(): void {
    // No models to release
  }
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
