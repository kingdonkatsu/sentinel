/**
 * Manages lazy loading, lifecycle, and disposal of TF.js models.
 *
 * Models are loaded on first use and reference-counted. A model is
 * unloaded after INACTIVITY_MS of non-use, or immediately when
 * memory pressure is detected.
 */

import type * as TFType from "@tensorflow/tfjs";

const INACTIVITY_MS = 60_000;

type TFModel =
  | TFType.GraphModel
  | TFType.LayersModel;

interface ModelEntry {
  model: TFModel;
  lastUsed: number;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
}

class ModelManager {
  private tf: typeof TFType | null = null;
  private models = new Map<string, ModelEntry>();
  private backendReady = false;

  /** Lazy-loads TF.js and selects the best available backend. */
  async init(): Promise<typeof TFType | null> {
    if (this.tf) return this.tf;
    try {
      const tf = await import("@tensorflow/tfjs");
      await this.selectBackend(tf);
      this.tf = tf;
      this.backendReady = true;
      return tf;
    } catch {
      return null;
    }
  }

  private async selectBackend(tf: typeof TFType): Promise<void> {
    // Prefer GPU backends; fall back to CPU without WASM path issues
    const backends = ["webgpu", "webgl", "cpu"] as const;
    for (const backend of backends) {
      try {
        await tf.setBackend(backend);
        await tf.ready();
        console.log(`[Sentinel] TF.js backend: ${backend}`);
        return;
      } catch {
        // try next
      }
    }
  }

  /**
   * Loads (or returns cached) a TF.js model from the extension bundle.
   * modelPath must be a key recognisable by chrome.runtime.getURL,
   * e.g. "models/blazeface/model.json".
   *
   * Returns null if TF.js is unavailable or the model file is not bundled.
   */
  async load(modelPath: string): Promise<TFModel | null> {
    if (this.models.has(modelPath)) {
      const entry = this.models.get(modelPath)!;
      entry.lastUsed = Date.now();
      this.resetInactivityTimer(modelPath, entry);
      return entry.model;
    }

    const tf = await this.init();
    if (!tf) return null;

    const url = chrome.runtime.getURL(modelPath);
    try {
      const model = await tf.loadGraphModel(url);
      const entry: ModelEntry = {
        model,
        lastUsed: Date.now(),
        inactivityTimer: null,
      };
      this.resetInactivityTimer(modelPath, entry);
      this.models.set(modelPath, entry);
      console.log(`[Sentinel] Loaded model: ${modelPath}`);
      return model;
    } catch {
      // Model file not bundled yet — silent fallback
      return null;
    }
  }

  private resetInactivityTimer(path: string, entry: ModelEntry): void {
    if (entry.inactivityTimer) clearTimeout(entry.inactivityTimer);
    entry.inactivityTimer = setTimeout(() => {
      this.unload(path);
    }, INACTIVITY_MS);
  }

  unload(modelPath: string): void {
    const entry = this.models.get(modelPath);
    if (!entry) return;
    if (entry.inactivityTimer) clearTimeout(entry.inactivityTimer);
    try {
      entry.model.dispose();
    } catch {
      // ignore disposal errors
    }
    this.models.delete(modelPath);
  }

  unloadAll(): void {
    for (const path of [...this.models.keys()]) {
      this.unload(path);
    }
    // Also clear any Transformers.js pipeline reference
    this.transformersPipeline = null;
  }

  get isReady(): boolean {
    return this.backendReady;
  }

  get tf_(): typeof TFType | null {
    return this.tf;
  }

  // ─── Transformers.js support ─────────────────────────────────────────────

  private transformersPipeline: unknown | null = null;
  private transformersLoading = false;

  /**
   * Returns the Transformers.js `env` object so callers can configure
   * model paths and remote-access flags before the first pipeline call.
   * Returns null if @xenova/transformers is not installed.
   */
  async getTransformersEnv(): Promise<Record<string, unknown> | null> {
    try {
      const { env } = await import("@xenova/transformers");
      return env as unknown as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Clears the cached Transformers.js pipeline (e.g. under memory pressure).
   */
  unloadTransformers(): void {
    this.transformersPipeline = null;
    this.transformersLoading = false;
  }
}

// Singleton shared across all analysers in the content script
export const modelManager = new ModelManager();
