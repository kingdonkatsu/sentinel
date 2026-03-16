/**
 * Semantic text analyser.
 *
 * Uses MiniLM-L6-v2 embeddings with keyword fallback, then applies a local
 * context-cue layer (explicit self-harm + stressor context) to better match
 * high-signal moderation behavior.
 */

import type { Analyser, ModalityResult } from "../../shared/types";
import { analyseText, extractText } from "../text-analyser";
import { releaseString } from "../privacy/secure-cleanup";
import { ALL_DISTRESS_PHRASES, hasUrgencySignal } from "./distress-phrases";
import {
  mapSimilarityToRiskScore,
  similarityToConfidence,
} from "./semantic-text-scoring";
import {
  applyTextContextCues,
  extractTextContextCues,
  type TextContextCues,
} from "./text-context-cues";

const PHRASE_LIST_VERSION = 1;
const PHRASE_CACHE_KEY = "sentinel_phrase_embeddings_v1";
const MIN_TEXT_LENGTH = 10;
const PREFILTER_HIGH = 78;
const PREFILTER_LOW = 22;

type EmbedderPipeline = {
  (texts: string[], options: Record<string, unknown>): Promise<
    { data: Float32Array }[]
  >;
};

export class SemanticTextAnalyser implements Analyser {
  readonly modality = "text" as const;

  private embedder: EmbedderPipeline | null = null;
  private modelLoading = false;
  private modelLoadAttempted = false;
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

    const keywordScore = analyseText(rawText);
    const keywordConfidence = this.keywordConfidence(rawText, keywordScore);
    const contextCues = extractTextContextCues(rawText);

    if (keywordScore > PREFILTER_HIGH || keywordScore < PREFILTER_LOW) {
      const adjusted = applyTextContextCues(
        keywordScore,
        keywordConfidence,
        contextCues
      );
      this.logContextCues(contextCues, keywordScore, adjusted.score);
      rawText = releaseString(rawText);
      return this.result(
        adjusted.score,
        adjusted.confidence,
        true,
        performance.now() - t0
      );
    }

    const hasUrgency = hasUrgencySignal(rawText);
    const embedder = await this.loadEmbedder();

    if (!embedder) {
      const adjusted = applyTextContextCues(
        keywordScore,
        keywordConfidence * 0.8,
        contextCues
      );
      this.logContextCues(contextCues, keywordScore, adjusted.score);
      rawText = releaseString(rawText);
      return this.result(
        adjusted.score,
        adjusted.confidence,
        true,
        performance.now() - t0
      );
    }

    try {
      const phraseEmbeds = await this.getPhraseEmbeddings(embedder);
      if (!phraseEmbeds) {
        const adjusted = applyTextContextCues(
          keywordScore,
          keywordConfidence,
          contextCues
        );
        this.logContextCues(contextCues, keywordScore, adjusted.score);
        rawText = releaseString(rawText);
        return this.result(
          adjusted.score,
          adjusted.confidence,
          true,
          performance.now() - t0
        );
      }

      const textEmbedOutput = await embedder([rawText], {
        pooling: "mean",
        normalize: true,
      });
      const textEmbed = textEmbedOutput[0]?.data ?? null;
      rawText = releaseString(rawText);

      if (!textEmbed) {
        const adjusted = applyTextContextCues(
          keywordScore,
          keywordConfidence,
          contextCues
        );
        this.logContextCues(contextCues, keywordScore, adjusted.score);
        return this.result(
          adjusted.score,
          adjusted.confidence,
          true,
          performance.now() - t0
        );
      }

      const maxSimilarity = this.maxCosineSimilarity(textEmbed, phraseEmbeds);
      const semanticScore = mapSimilarityToRiskScore(maxSimilarity);
      const blended = Math.round(semanticScore * 0.65 + keywordScore * 0.35);
      const urgencyAdjustedScore = hasUrgency ? Math.max(blended, 75) : blended;
      const semanticConfidence = similarityToConfidence(maxSimilarity);

      const adjusted = applyTextContextCues(
        urgencyAdjustedScore,
        semanticConfidence,
        contextCues
      );
      this.logContextCues(contextCues, urgencyAdjustedScore, adjusted.score);

      return this.result(
        adjusted.score,
        adjusted.confidence,
        true,
        performance.now() - t0
      );
    } catch {
      const adjusted = applyTextContextCues(
        keywordScore,
        keywordConfidence,
        contextCues
      );
      this.logContextCues(contextCues, keywordScore, adjusted.score);
      rawText = releaseString(rawText);
      return this.result(
        adjusted.score,
        adjusted.confidence,
        true,
        performance.now() - t0
      );
    }
  }

  private maxCosineSimilarity(
    queryEmbed: Float32Array,
    phraseEmbeds: Float32Array[]
  ): number {
    let max = 0;
    for (const phraseEmbed of phraseEmbeds) {
      const similarity = cosineSimilarity(queryEmbed, phraseEmbed);
      if (similarity > max) {
        max = similarity;
      }
    }
    return max;
  }

  private async getPhraseEmbeddings(
    embedder: EmbedderPipeline
  ): Promise<Float32Array[] | null> {
    if (this.phraseEmbeddings) {
      return this.phraseEmbeddings;
    }

    const cached = await this.loadPhraseCache();
    if (cached) {
      this.phraseEmbeddings = cached;
      return cached;
    }

    try {
      const outputs = await embedder(
        ALL_DISTRESS_PHRASES as unknown as string[],
        {
          pooling: "mean",
          normalize: true,
        }
      );
      const embeddings = outputs.map((output) => new Float32Array(output.data));
      this.phraseEmbeddings = embeddings;
      await this.savePhraseCache(embeddings);
      return embeddings;
    } catch {
      return null;
    }
  }

  private async loadEmbedder(): Promise<EmbedderPipeline | null> {
    if (this.embedder) {
      return this.embedder;
    }
    if (this.modelLoading || this.modelLoadAttempted) {
      return null;
    }

    this.modelLoading = true;
    this.modelLoadAttempted = true;

    try {
      const { pipeline, env } = await import("@xenova/transformers");
      env.allowRemoteModels = false;
      env.localModelPath = chrome.runtime.getURL("models/");

      const pipe = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2"
      );
      this.embedder = pipe as unknown as EmbedderPipeline;
      console.log("[Sentinel] MiniLM-L6 loaded");
      return this.embedder;
    } catch {
      return null;
    } finally {
      this.modelLoading = false;
    }
  }

  private async loadPhraseCache(): Promise<Float32Array[] | null> {
    try {
      const result = await chrome.storage.local.get(PHRASE_CACHE_KEY);
      const entry = result[PHRASE_CACHE_KEY] as
        | { version: number; data: number[][] }
        | undefined;
      if (!entry || entry.version !== PHRASE_LIST_VERSION) {
        return null;
      }
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
          data: embeds.map((embed) => Array.from(embed)),
        },
      });
    } catch {
      // non-critical cache failure
    }
  }

  private keywordConfidence(text: string, score: number): number {
    if (!text || text.trim().length === 0) {
      return 0;
    }
    const polarity = Math.abs(score - 50);
    if (polarity > 30) {
      return 0.7;
    }
    if (polarity > 15) {
      return 0.5;
    }
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

  private logContextCues(
    cues: TextContextCues,
    baseScore: number,
    adjustedScore: number
  ): void {
    if (cues.reasons.length === 0) {
      return;
    }

    console.log("[Sentinel][Text Context]", {
      reasons: cues.reasons,
      flags: {
        explicitSelfHarm: cues.explicitSelfHarm,
        selfDeprecation: cues.selfDeprecation,
        hopelessness: cues.hopelessness,
        socialIsolation: cues.socialIsolation,
        academicStress: cues.academicStress,
        lowAcademicPerformance: cues.lowAcademicPerformance,
      },
      scoreBoost: cues.scoreBoost,
      floorScore: cues.floorScore,
      confidenceBoost: cues.confidenceBoost,
      baseScore,
      adjustedScore,
    });
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
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
