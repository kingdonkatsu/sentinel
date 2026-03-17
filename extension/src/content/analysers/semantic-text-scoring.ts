export const SEMANTIC_SCORE_MIN_SIMILARITY = 0.3;
export const SEMANTIC_SCORE_MAX_SIMILARITY = 0.85;
export const SEMANTIC_CONFIDENCE_MIN = 0.5;
export const SEMANTIC_CONFIDENCE_MAX = 0.9;
export const SEMANTIC_CONFIDENCE_MAX_SIMILARITY = 0.8;

export function mapSimilarityToRiskScore(similarity: number): number {
  const normalized =
    (similarity - SEMANTIC_SCORE_MIN_SIMILARITY) /
    (SEMANTIC_SCORE_MAX_SIMILARITY - SEMANTIC_SCORE_MIN_SIMILARITY);
  return Math.round(clamp(normalized, 0, 1) * 100);
}

export function similarityToConfidence(similarity: number): number {
  const normalized =
    (similarity - SEMANTIC_SCORE_MIN_SIMILARITY) /
    (SEMANTIC_CONFIDENCE_MAX_SIMILARITY - SEMANTIC_SCORE_MIN_SIMILARITY);
  const confidence =
    SEMANTIC_CONFIDENCE_MIN +
    clamp(normalized, 0, 1) *
      (SEMANTIC_CONFIDENCE_MAX - SEMANTIC_CONFIDENCE_MIN);
  return roundTo(confidence, 3);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
