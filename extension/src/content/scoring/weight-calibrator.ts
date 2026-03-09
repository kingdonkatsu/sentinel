/**
 * Manages the calibration feedback loop that gently nudges base weights
 * toward modalities that historically correlated with confirmed cases.
 *
 * State lives in chrome.storage.local so calibration survives browser restart.
 * Calibration still resets every 7 days to prevent runaway drift.
 *
 * When a social worker marks a case as actionable on the dashboard,
 * the dashboard can send a message to the extension:
 *   { type: "SENTINEL_CONFIRMED", username, modalityScores }
 * The calibrator records which modalities had high scores for that case.
 *
 * Weight adjustment is capped at ±5% from base to stay conservative.
 */

import type { CalibrationState, ModalityType } from "../../shared/types";
import { BASE_WEIGHTS } from "./composite-scorer";

export const CALIBRATION_STORAGE_KEY = "sentinel_calibration";
export const CALIBRATION_RESET_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_ADJUSTMENT = 0.05; // ±5% from base weight

export interface StorageAreaLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class WeightCalibrator {
  private state: CalibrationState | null = null;
  private storageArea: StorageAreaLike;
  private now: () => number;

  constructor(
    storageArea?: StorageAreaLike,
    now: () => number = () => Date.now()
  ) {
    this.storageArea = storageArea ?? getDefaultStorageArea();
    this.now = now;
  }

  async load(): Promise<void> {
    try {
      const result = await this.storageArea.get(CALIBRATION_STORAGE_KEY);
      const stored = result[CALIBRATION_STORAGE_KEY] as CalibrationState | undefined;

      if (stored && this.now() - stored.lastCalibrated < CALIBRATION_RESET_INTERVAL_MS) {
        this.state = stored;
      } else {
        this.state = this.defaultState();
        await this.persist();
      }
    } catch {
      this.state = this.defaultState();
    }
  }

  /**
   * Records a "confirmed" signal for the given modality scores.
   * Called when a social worker acts on a flagged account.
   */
  async recordConfirmed(
    modalityScores: Partial<Record<ModalityType, number>>
  ): Promise<void> {
    if (!this.state) await this.load();

    for (const [modality, score] of Object.entries(modalityScores) as [
      ModalityType,
      number
    ][]) {
      const acc = this.state!.modalityAccuracy[modality] ?? { hits: 0, total: 0 };
      acc.total += 1;
      // Count as a "hit" if this modality had a high score (>= 70)
      if (score >= 70) acc.hits += 1;
      this.state!.modalityAccuracy[modality] = acc;
    }

    this.recalculateWeights();
    await this.persist();
  }

  /**
   * Returns calibrated base weights. Falls back to defaults if not loaded.
   */
  getWeights(): Record<ModalityType, number> {
    if (!this.state?.adjustedWeights) return { ...BASE_WEIGHTS };

    const weights = { ...BASE_WEIGHTS };
    for (const [modality, adjusted] of Object.entries(
      this.state.adjustedWeights
    ) as [ModalityType, number][]) {
      weights[modality] = adjusted;
    }
    return weights;
  }

  private recalculateWeights(): void {
    if (!this.state) return;
    const adjusted: Partial<Record<ModalityType, number>> = {};

    for (const [modality, acc] of Object.entries(
      this.state.modalityAccuracy
    ) as [ModalityType, { hits: number; total: number }][]) {
      if (acc.total < 3) continue; // not enough data to calibrate

      const accuracy = acc.hits / acc.total;
      const base = BASE_WEIGHTS[modality] ?? 0;
      // Nudge: positive when accuracy > 0.5, negative when below
      const nudge = base * 0.1 * (accuracy - 0.5);
      const clamped = Math.max(
        base - MAX_ADJUSTMENT,
        Math.min(base + MAX_ADJUSTMENT, base + nudge)
      );
      adjusted[modality] = clamped;
    }

    this.state.adjustedWeights = adjusted;
  }

  private defaultState(): CalibrationState {
    return {
      modalityAccuracy: {},
      lastCalibrated: this.now(),
      adjustedWeights: undefined,
    };
  }

  private async persist(): Promise<void> {
    try {
      await this.storageArea.set({ [CALIBRATION_STORAGE_KEY]: this.state });
    } catch {
      // storage unavailable — degrade gracefully
    }
  }
}

export const weightCalibrator = new WeightCalibrator();

function getDefaultStorageArea(): StorageAreaLike {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return chrome.storage.local;
  }

  return {
    async get() {
      return {};
    },
    async set() {
      // no-op in non-extension environments
    },
  };
}
