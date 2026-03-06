/**
 * Semantic text analyser.
 *
 * Uses MiniLM-L6-v2 (via Transformers.js, ONNX int8, ~6 MB) to compute
 * sentence embeddings. Risk is measured by cosine similarity to the 50
 * reference distress phrases in distress-phrases.ts.
 *
 * Fast-path pre-filter: if the keyword analyser returns a very strong signal
 * (score > 80 or score < 20), skip model inference to save ~20-60 ms.
 *
 * Phrase embeddings are computed on first load and cached in
 * chrome.storage.local (persisted across sessions). They are re-computed
 * if the phrase list version changes.
 *
 * Privacy: the raw text string is passed only to the local ONNX model running
 * entirely in the content script. It is never stored or transmitted.
 *
 * Model path (bundled in extension):
 *   public/models/Xenova/all-MiniLM-L6-v2/
 *
 * See public/models/README.md for download instructions.
 */

import type { Analyser, ModalityResult } from "../../shared/types";
import { analyseText, extractText } from "../text-analyser";
import { releaseString } from "../privacy/secure-cleanup";
import { ALL_DISTRESS_PHRASES, URGENCY_PATTERNS } from "./distress-phrases";

// Bump this when the phrase list changes — forces cache invalidation
const PHRASE_LIST_VERSION = 1;
const PHRASE_CACHE_KEY = "sentinel_phrase_embeddings_v1";

// Minimum text length to bother running the model
const MIN_TEXT_LENGTH = 10;

// Keyword pre-filter thresholds
const PREFILTER_HIGH = 78;
const PREFILTER_LOW = 22;

type EmbedderPipeline = {
  (texts: string[], options: Record<string, unknown>): Promise<{ data: Float32Array }[]>;
};

export class SemanticTextAnalyser implements Analyser {
  readonly modality = "text" as const;

  private embedder: EmbedderPipeline | null = null;
  private modelLoading = false;
  private modelLoadAttempted = false;

  /** Pre-computed phrase embeddings — [phraseIndex][dim] */
  private phraseEmbeddings: Float32Array[] | null = null;

  isAvailable(viewer: HTMLElement): boolean {
    const text = extractText(viewer);
    return text.trim().length >= MIN_TEXT_LENGTH;
  }

  async analyse(viewer: HTMLElement): Promise<ModalityResult> {
    const t0 = performance.now();
    let rawText: string | null = extractText(viewer);

    if (!rawText || rawText.trim().length < MIN_TEXT_LENGTH) {
      rawText = releaseString(rawText);
      return this.result(50, 0, false, performance.now() - t0);
    }

    // ── Fast-path keyword pre-filter ─────────────────────────────────────
    const keywordScore = analyseText(rawText);
    const keywordConfidence = this.keywordConfidence(rawText, keywordScore);

    if (keywordScore > PREFILTER_HIGH || keywordScore < PREFILTER_LOW) {
      // Strong keyword signal — skip the ~50ms model inference
      rawText = releaseString(rawText);
      return this.result(keywordScore, keywordConfidence, true, performance.now() - t0);
    }

    // ── Urgency detection ────────────────────────────────────────────────
    const hasUrgency = URGENCY_PATTERNS.some((p) => p.test(rawText!));

    // ── ML semantic scoring ──────────────────────────────────────────────
    const embedder = await this.loadEmbedder();

    if (!embedder) {
      // Model unavailable — fall through to keyword result
      rawText = releaseString(rawText);
      return this.result(keywordScore, keywordConfidence * 0.8, true, performance.now() - t0);
    }

    try {
      const phraseEmbeds = await this.getPhraseEmbeddings(embedder);
      if (!phraseEmbeds) {
        rawText = releaseString(rawText);
        return this.result(keywordScore, keywordConfidence, true, performance.now() - t0);
      }

      const textEmbedOutput = await embedder([rawText], {
        pooling: "mean",
        normalize: true,
      });
      const textEmbed = textEmbedOutput[0]?.data ?? null;

      rawText = releaseString(rawText); // Release immediately after inference

      if (!textEmbed) {
        return this.result(keywordScore, keywordConfidence, true, performance.now() - t0);
      }

      // Max cosine similarity to any distress phrase
      const maxSimilarity = this.maxCosineSimilarity(textEmbed, phraseEmbeds);

      // Map similarity [0, 1] → risk score
      // similarity ≥ 0.85 → high risk (≥80), ≤ 0.3 → low risk (≤30)
      const semanticScore = Math.round(
        Math.max(0, Math.min(100, (maxSimilarity - 0.3) / 0.55 * 100))
      );

      // Blend semantic and keyword scores — semantic is primary
      const blended = Math.round(semanticScore * 0.65 + keywordScore * 0.35);

      // Urgency bump: known time-critical phrases → floor at 75
      const finalScore = hasUrgency ? Math.max(blended, 75) : blended;

      // Confidence: driven by similarity strength
      const confidence = maxSimilarity >= 0.7
        ? 0.9
        : maxSimilarity >= 0.5
        ? 0.7
        : 0.5;

      return this.result(finalScore, confidence, true, performance.now() - t0);
    } catch {
      rawText = releaseString(rawText);
      return this.result(keywordScore, keywordConfidence, true, performance.now() - t0);
    }
  }

  // ─── Embedding utilities ────────────────────────────────────────────────

  private maxCosineSimilarity(
    queryEmbed: Float32Array,
    phraseEmbeds: Float32Array[]
  ): number {
    let max = 0;
    for (const phraseEmbed of phraseEmbeds) {
      const sim = cosineSimilarity(queryEmbed, phraseEmbed);
      if (sim > max) max = sim;
    }
    return max;
  }

  /**
   * Returns cached phrase embeddings or computes them on first call.
   */
  private async getPhraseEmbeddings(
    embedder: EmbedderPipeline
  ): Promise<Float32Array[] | null> {
    if (this.phraseEmbeddings) return this.phraseEmbeddings;

    // Try loading from persistent cache first
    const cached = await this.loadPhraseCache();
    if (cached) {
      this.phraseEmbeddings = cached;
      return cached;
    }

    // Compute embeddings for all 50 distress phrases
    try {
      const outputs = await embedder(ALL_DISTRESS_PHRASES as unknown as string[], {
        pooling: "mean",
        normalize: true,
      });
      const embeds = outputs.map((o) => new Float32Array(o.data));
      this.phraseEmbeddings = embeds;
      await this.savePhraseCache(embeds);
      return embeds;
    } catch {
      return null;
    }
  }

  // ─── Model loading ──────────────────────────────────────────────────────

  private async loadEmbedder(): Promise<EmbedderPipeline | null> {
    if (this.embedder) return this.embedder;
    if (this.modelLoading || this.modelLoadAttempted) return null;

    this.modelLoading = true;
    this.modelLoadAttempted = true;

    try {
      const { pipeline, env } = await import("@xenova/transformers");

      // Point Transformers.js at bundled models — no remote downloads
      env.allowRemoteModels = false;
      env.localModelPath = chrome.runtime.getURL("models/");

      const pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      // The Transformers.js pipeline call signature matches EmbedderPipeline
      this.embedder = pipe as unknown as EmbedderPipeline;
      console.log("[Sentinel] MiniLM-L6 loaded");
      return this.embedder;
    } catch {
      // Model files not bundled yet — silent fallback to keywords
      return null;
    } finally {
      this.modelLoading = false;
    }
  }

  // ─── Cache helpers ──────────────────────────────────────────────────────

  private async loadPhraseCache(): Promise<Float32Array[] | null> {
    try {
      const result = await chrome.storage.local.get(PHRASE_CACHE_KEY);
      const entry = result[PHRASE_CACHE_KEY] as
        | { version: number; data: number[][] }
        | undefined;
      if (!entry || entry.version !== PHRASE_LIST_VERSION) return null;
      return entry.data.map((arr) => new Float32Array(arr));
    } catch {
      return null;
    }
  }

  private async savePhraseCache(embeds: Float32Array[]): Promise<void> {
    try {
      await chrome.storage.local.set({
        [PHRASE_CACHE_KEY]: {
          version: PHRASE_LIST_VERSION,
          data: embeds.map((e) => Array.from(e)),
        },
      });
    } catch {
      // cache failure is non-critical
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private keywordConfidence(text: string, score: number): number {
    if (!text || text.trim().length === 0) return 0;
    const polarity = Math.abs(score - 50);
    if (polarity > 30) return 0.7;
    if (polarity > 15) return 0.5;
    return 0.3;
  }

  private result(
    score: number,
    confidence: number,
    available: boolean,
    inferenceTimeMs: number
  ): ModalityResult {
    return { modality: "text", score, confidence, available, inferenceTimeMs };
  }

  dispose(): void {
    this.embedder = null;
    this.phraseEmbeddings = null;
    this.modelLoadAttempted = false;
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
