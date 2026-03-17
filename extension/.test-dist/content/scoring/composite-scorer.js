"use strict";
/**
 * Bayesian confidence-weighted fusion of modality results.
 *
 * Algorithm (per the plan):
 *   1. effective_w_i = base_w_i × confidence_i × availability_i
 *   2. Normalise so weights sum to 1.0
 *   3. composite = Σ(score_i × norm_w_i)
 *   4. Confidence dampening: if overall_confidence < 0.5, pull toward midpoint
 *   5. Critical signal override: any score ≥ 90 with confidence ≥ 0.8
 *      → floor composite at 75 to prevent dilution of acute distress signals
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.compositeScorer = exports.CompositeScorer = exports.BASE_WEIGHTS = void 0;
exports.BASE_WEIGHTS = {
    text: 0.35,
    visual: 0.25,
    temporal: 0.20,
    video: 0.15,
    audio: 0.10,
    metadata: 0.05,
};
class CompositeScorer {
    /**
     * Fuses all available modality results into a single composite risk score.
     * @param results  All modality results from the current analysis run.
     * @param baseWeights  Optionally override the default base weights (e.g. from calibration).
     */
    fuse(results, baseWeights = exports.BASE_WEIGHTS) {
        const available = results.filter((r) => r.available);
        if (available.length === 0) {
            return { composite: 50, overallConfidence: 0, effectiveWeights: {} };
        }
        // Step 1: effective weights
        const effectiveWeights = {};
        let weightSum = 0;
        for (const r of available) {
            const ew = (baseWeights[r.modality] ?? 0) * r.confidence;
            effectiveWeights[r.modality] = ew;
            weightSum += ew;
        }
        // Step 2: normalise
        if (weightSum === 0) {
            // All confidences are 0 — equal weight fallback
            for (const r of available) {
                effectiveWeights[r.modality] = 1 / available.length;
            }
            weightSum = 1;
        }
        else {
            for (const key of Object.keys(effectiveWeights)) {
                effectiveWeights[key] = effectiveWeights[key] / weightSum;
            }
        }
        // Step 3: weighted composite
        let composite = 0;
        for (const r of available) {
            composite += r.score * (effectiveWeights[r.modality] ?? 0);
        }
        // Step 4: confidence dampening — low overall confidence pulls toward 50
        const contributing = available.filter((r) => (effectiveWeights[r.modality] ?? 0) > 0);
        const overallConfidence = contributing.length === 0
            ? 0
            : contributing.reduce((sum, r) => {
                const weight = effectiveWeights[r.modality] ?? 0;
                return sum + r.confidence * weight;
            }, 0);
        if (overallConfidence < 0.5) {
            const midpointPull = 0.5 + overallConfidence;
            composite = 50 + (composite - 50) * midpointPull;
        }
        // Step 5: critical signal override
        // A single high-confidence, high-score signal must not be diluted
        const hasCriticalSignal = available.some((r) => r.score >= 90 && r.confidence >= 0.8);
        if (hasCriticalSignal) {
            composite = Math.max(composite, 75);
        }
        return {
            composite: Math.round(Math.max(0, Math.min(100, composite))),
            overallConfidence,
            effectiveWeights,
        };
    }
}
exports.CompositeScorer = CompositeScorer;
exports.compositeScorer = new CompositeScorer();
