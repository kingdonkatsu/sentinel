/**
 * Monitors JS heap pressure and triggers model unloading when needed.
 * Prevents the extension from consuming excessive memory on low-end devices.
 */

import { modelManager } from "../models/model-manager";

const PRESSURE_THRESHOLD_MB = 500;

export class MemoryMonitor {
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  /** Returns current JS heap usage in MB, or 0 if the API is unavailable. */
  getUsedMB(): number {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    if (!mem) return 0;
    return Math.round(mem.usedJSHeapSize / (1024 * 1024));
  }

  isUnderPressure(): boolean {
    return this.getUsedMB() > PRESSURE_THRESHOLD_MB;
  }

  /**
   * Starts periodic pressure checks every intervalMs.
   * When pressure is detected, all loaded models are unloaded so the
   * analyser falls back to lightweight heuristics.
   */
  startMonitoring(intervalMs = 30_000): void {
    if (this.checkInterval) return;
    this.checkInterval = setInterval(() => {
      if (this.isUnderPressure()) {
        console.warn(
          `[Sentinel] Memory pressure (${this.getUsedMB()} MB) — unloading models`
        );
        modelManager.unloadAll();
      }
    }, intervalMs);
  }

  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}

export const memoryMonitor = new MemoryMonitor();
