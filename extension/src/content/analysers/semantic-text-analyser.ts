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
import type { OcrResult } from "../ocr/story-ocr";
import { storyOcr } from "../ocr/story-ocr";
import { findPrimaryStoryMedia } from "../image-analyser";
import { analyseText } from "../text-analyser";
import { releaseString } from "../privacy/secure-cleanup";
import {
  SEMANTIC_MODEL_TIMEOUT_MS,
  getSemanticTextModelHost,
  type SemanticScorerLike,
} from "../semantic/semantic-host-client";
import { hasUrgencySignal } from "./distress-phrases";
import {
  mapSimilarityToRiskScore,
  similarityToConfidence,
} from "./semantic-text-scoring";

// Bump this when the phrase list changes — forces cache invalidation
// Minimum text length to bother running the model
const MIN_TEXT_LENGTH = 10;
const OCR_TIMEOUT_MS = 3000;

// Keyword pre-filter thresholds
const PREFILTER_HIGH = 78;
const PREFILTER_LOW = 22;

interface StoryOcrRunnerLike {
  recognizeViewer(viewer: HTMLElement, timeoutMs?: number): Promise<OcrResult>;
}

interface SemanticTextAnalyserDeps {
  ocrRunner?: StoryOcrRunnerLike;
  semanticScorer?: SemanticScorerLike;
}

type TextScoringPath =
  | "keyword-short-text"
  | "keyword-prefilter"
  | "keyword-fallback-no-model"
  | "keyword-fallback-no-phrase-cache"
  | "keyword-fallback-no-embedding"
  | "keyword-fallback-model-error"
  | "minilm";

interface TextScoreDebug {
  keywordScore: number;
  maxSimilarity?: number;
  minilmRan: boolean;
  scoringPath: TextScoringPath;
  semanticScore?: number;
  urgencyBoostApplied: boolean;
}

interface TextScoreOutcome {
  debug: TextScoreDebug;
  result: ModalityResult;
}

export class SemanticTextAnalyser implements Analyser {
  readonly modality = "text" as const;

  private readonly ocrRunner: StoryOcrRunnerLike;
  private readonly semanticScorer: SemanticScorerLike;

  constructor(deps: SemanticTextAnalyserDeps = {}) {
    this.ocrRunner = deps.ocrRunner ?? storyOcr;
    this.semanticScorer = deps.semanticScorer ?? getSemanticTextModelHost();
  }

  isAvailable(viewer: HTMLElement): boolean {
    return findPrimaryStoryMedia(viewer) !== null;
  }

  async analyse(viewer: HTMLElement): Promise<ModalityResult> {
    const t0 = performance.now();
    const ocrResult = await this.ocrRunner.recognizeViewer(viewer, OCR_TIMEOUT_MS);

    if (ocrResult.status !== "ok") {
      const status = ocrResult.status === "no_text" ? "missing" : "uncertain";
      console.log("[Sentinel][Story OCR]", {
        latencyMs: ocrResult.latencyMs,
        ocrConfidence: ocrResult.confidence ?? null,
        status: ocrResult.status,
        strategy: ocrResult.strategy,
        textScoringRan: false,
      });
      return this.result(
        50,
        0,
        false,
        performance.now() - t0,
        status
      );
    }

    let rawText: string | null = ocrResult.text;
    try {
      const { result, debug } = await this.analyseProvidedText(rawText);
      const finalResult = {
        ...result,
        inferenceTimeMs: performance.now() - t0,
        status: "ok" as const,
      };

      console.log("[Sentinel][Story OCR]", {
        latencyMs: ocrResult.latencyMs,
        ocrConfidence: ocrResult.confidence ?? null,
        status: ocrResult.status,
        strategy: ocrResult.strategy,
        textScoringRan: true,
      });
      console.log("[Sentinel][Story Text]", {
        ocrText: rawText,
        textScore: finalResult.score,
        textConfidence: finalResult.confidence,
        scoringPath: debug.scoringPath,
        minilmRan: debug.minilmRan,
        keywordScore: debug.keywordScore,
        semanticScore: debug.semanticScore ?? null,
        maxSimilarity: debug.maxSimilarity ?? null,
        urgencyBoostApplied: debug.urgencyBoostApplied,
      });

      return finalResult;
    } finally {
      rawText = releaseString(rawText);
    }
  }

  private async analyseProvidedText(rawText: string): Promise<TextScoreOutcome> {
    const t0 = performance.now();
    const normalizedText = rawText.trim();
    if (!normalizedText) {
      return {
        debug: {
          keywordScore: 50,
          minilmRan: false,
          scoringPath: "keyword-short-text",
          urgencyBoostApplied: false,
        },
        result: this.result(50, 0, false, performance.now() - t0, "missing"),
      };
    }

    // ── Fast-path keyword pre-filter ─────────────────────────────────────
    const keywordScore = analyseText(normalizedText);
    const keywordConfidence = this.keywordConfidence(normalizedText, keywordScore);

    if (normalizedText.length < MIN_TEXT_LENGTH) {
      return {
        debug: {
          keywordScore,
          minilmRan: false,
          scoringPath: "keyword-short-text",
          urgencyBoostApplied: false,
        },
        result: this.result(
          keywordScore,
          keywordConfidence,
          true,
          performance.now() - t0,
          "ok"
        ),
      };
    }

    if (keywordScore > PREFILTER_HIGH || keywordScore < PREFILTER_LOW) {
      return {
        debug: {
          keywordScore,
          minilmRan: false,
          scoringPath: "keyword-prefilter",
          urgencyBoostApplied: false,
        },
        result: this.result(
          keywordScore,
          keywordConfidence,
          true,
          performance.now() - t0,
          "ok"
        ),
      };
    }

    // ── Urgency detection ────────────────────────────────────────────────
    const hasUrgency = hasUrgencySignal(normalizedText);

    // ── ML semantic scoring ──────────────────────────────────────────────
    try {
      const semanticResult = await this.semanticScorer.scoreText(
        normalizedText,
        SEMANTIC_MODEL_TIMEOUT_MS
      );
      const maxSimilarity = semanticResult.maxSimilarity;

      // Map similarity [0, 1] → risk score
      // similarity ≥ 0.85 → high risk (≥80), ≤ 0.3 → low risk (≤30)
      const semanticScore = mapSimilarityToRiskScore(maxSimilarity);

      // Blend semantic and keyword scores — semantic is primary
      const blended = Math.round(semanticScore * 0.65 + keywordScore * 0.35);

      // Urgency bump: known time-critical phrases → floor at 75
      const finalScore = hasUrgency ? Math.max(blended, 75) : blended;

      // Confidence: driven by similarity strength
      const confidence = similarityToConfidence(maxSimilarity);

      return {
        debug: {
          keywordScore,
          maxSimilarity,
          minilmRan: true,
          scoringPath: "minilm",
          semanticScore,
          urgencyBoostApplied: hasUrgency,
        },
        result: this.result(
          finalScore,
          confidence,
          true,
          performance.now() - t0,
          "ok"
        ),
      };
    } catch (error) {
      console.warn("[Sentinel] MiniLM-L6 scoring failed", error);
      return {
        debug: {
          keywordScore,
          minilmRan: false,
          scoringPath: "keyword-fallback-model-error",
          urgencyBoostApplied: false,
        },
        result: this.result(
          keywordScore,
          keywordConfidence,
          true,
          performance.now() - t0,
          "ok"
        ),
      };
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
    inferenceTimeMs: number,
    status?: ModalityResult["status"]
  ): ModalityResult {
    return {
      modality: "text",
      score,
      confidence,
      available,
      inferenceTimeMs,
      status,
    };
  }

  dispose(): void {
    this.semanticScorer.dispose();
  }
}
