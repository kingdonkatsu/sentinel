"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEMANTIC_CONFIDENCE_MAX_SIMILARITY = exports.SEMANTIC_CONFIDENCE_MAX = exports.SEMANTIC_CONFIDENCE_MIN = exports.SEMANTIC_SCORE_MAX_SIMILARITY = exports.SEMANTIC_SCORE_MIN_SIMILARITY = void 0;
exports.mapSimilarityToRiskScore = mapSimilarityToRiskScore;
exports.similarityToConfidence = similarityToConfidence;
exports.SEMANTIC_SCORE_MIN_SIMILARITY = 0.3;
exports.SEMANTIC_SCORE_MAX_SIMILARITY = 0.85;
exports.SEMANTIC_CONFIDENCE_MIN = 0.5;
exports.SEMANTIC_CONFIDENCE_MAX = 0.9;
exports.SEMANTIC_CONFIDENCE_MAX_SIMILARITY = 0.8;
function mapSimilarityToRiskScore(similarity) {
    const normalized = (similarity - exports.SEMANTIC_SCORE_MIN_SIMILARITY) /
        (exports.SEMANTIC_SCORE_MAX_SIMILARITY - exports.SEMANTIC_SCORE_MIN_SIMILARITY);
    return Math.round(clamp(normalized, 0, 1) * 100);
}
function similarityToConfidence(similarity) {
    const normalized = (similarity - exports.SEMANTIC_SCORE_MIN_SIMILARITY) /
        (exports.SEMANTIC_CONFIDENCE_MAX_SIMILARITY - exports.SEMANTIC_SCORE_MIN_SIMILARITY);
    const confidence = exports.SEMANTIC_CONFIDENCE_MIN +
        clamp(normalized, 0, 1) *
            (exports.SEMANTIC_CONFIDENCE_MAX - exports.SEMANTIC_CONFIDENCE_MIN);
    return roundTo(confidence, 3);
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function roundTo(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
