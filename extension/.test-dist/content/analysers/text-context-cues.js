"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractTextContextCues = extractTextContextCues;
exports.applyTextContextCues = applyTextContextCues;
const EXPLICIT_SELF_HARM_PATTERNS = [
    /\bkill myself\b/i,
    /\bend my life\b/i,
    /\btake my life\b/i,
    /\bwant to die\b/i,
    /\bgoing to die\b/i,
    /\bcommit suicide\b/i,
    /\bsuicidal\b/i,
    /\bkys\b/i,
];
const SELF_DEPRECATION_PATTERNS = [
    /\bi(?:'m| am)?\s*so\s*stupid\b/i,
    /\bi(?:'m| am)\s*worthless\b/i,
    /\bi hate myself\b/i,
    /\bi(?:'m| am)\s*a failure\b/i,
    /\bi(?:'m| am)\s*such a loser\b/i,
];
const HOPELESSNESS_PATTERNS = [
    /\bno point\b/i,
    /\bcan't go on\b/i,
    /\bcan'?t do this anymore\b/i,
    /\bnothing matters\b/i,
    /\bgive up\b/i,
    /\bend everything\b/i,
];
const SOCIAL_ISOLATION_PATTERNS = [
    /\bno one cares\b/i,
    /\bno one likes me\b/i,
    /\bno one responds\b/i,
    /\bi(?:'m| am)\s*alone\b/i,
    /\blonely\b/i,
];
const ACADEMIC_STRESS_PATTERNS = [
    /\bexam\b/i,
    /\btest\b/i,
    /\bgrade\b/i,
    /\bresult\b/i,
    /\bscore\b/i,
    /\bmarks?\b/i,
    /\bpaper\b/i,
    /\bfailed?\b/i,
    /\bfailing\b/i,
];
const PERCENT_PATTERN = /(?:^|[^\d])(\d{1,3})(?:\s?%)/g;
const FRACTION_PATTERN = /(?:^|[^\d])(\d{1,3}(?:\.\d+)?)\s*\/\s*(\d{1,3}(?:\.\d+)?)/g;
function extractTextContextCues(text) {
    const explicitSelfHarm = hasAny(text, EXPLICIT_SELF_HARM_PATTERNS);
    const selfDeprecation = hasAny(text, SELF_DEPRECATION_PATTERNS);
    const hopelessness = hasAny(text, HOPELESSNESS_PATTERNS);
    const socialIsolation = hasAny(text, SOCIAL_ISOLATION_PATTERNS);
    const academicStress = hasAny(text, ACADEMIC_STRESS_PATTERNS);
    const lowAcademicPerformance = hasLowAcademicPerformanceSignal(text);
    const reasons = [];
    let scoreBoost = 0;
    let floorScore;
    let confidenceBoost = 0;
    if (explicitSelfHarm) {
        reasons.push("explicit self-harm language");
        scoreBoost += 14;
        floorScore = 90;
        confidenceBoost += 0.15;
    }
    if (selfDeprecation) {
        reasons.push("self-deprecating language");
        scoreBoost += 6;
        confidenceBoost += 0.05;
    }
    if (hopelessness) {
        reasons.push("hopelessness language");
        scoreBoost += 7;
        confidenceBoost += 0.06;
    }
    if (socialIsolation) {
        reasons.push("social isolation cues");
        scoreBoost += 5;
        confidenceBoost += 0.04;
    }
    if (academicStress && lowAcademicPerformance) {
        reasons.push("academic-failure stress context");
        scoreBoost += 6;
        confidenceBoost += 0.05;
    }
    else if (academicStress) {
        reasons.push("academic stress context");
        scoreBoost += 3;
        confidenceBoost += 0.02;
    }
    if (explicitSelfHarm && (selfDeprecation || hopelessness || lowAcademicPerformance)) {
        reasons.push("combined acute-risk context");
        scoreBoost += 4;
        floorScore = Math.max(floorScore ?? 0, 94);
        confidenceBoost += 0.05;
    }
    return {
        explicitSelfHarm,
        selfDeprecation,
        hopelessness,
        socialIsolation,
        academicStress,
        lowAcademicPerformance,
        reasons,
        scoreBoost,
        floorScore,
        confidenceBoost,
    };
}
function applyTextContextCues(score, confidence, cues) {
    let adjustedScore = clamp(score + cues.scoreBoost, 0, 100);
    if (typeof cues.floorScore === "number") {
        adjustedScore = Math.max(adjustedScore, cues.floorScore);
    }
    const adjustedConfidence = clamp(confidence + cues.confidenceBoost, 0, 0.95);
    return {
        score: Math.round(adjustedScore),
        confidence: Number(adjustedConfidence.toFixed(3)),
    };
}
function hasLowAcademicPerformanceSignal(text) {
    const percentages = extractPercentages(text);
    if (percentages.some((value) => value <= 55)) {
        return true;
    }
    const fractions = extractFractions(text);
    if (fractions.some((ratio) => ratio <= 0.6)) {
        return true;
    }
    return false;
}
function extractPercentages(text) {
    const values = [];
    let match;
    const pattern = new RegExp(PERCENT_PATTERN.source, PERCENT_PATTERN.flags);
    while ((match = pattern.exec(text)) !== null) {
        const value = Number.parseInt(match[1] ?? "", 10);
        if (!Number.isNaN(value) && value >= 0 && value <= 100) {
            values.push(value);
        }
    }
    return values;
}
function extractFractions(text) {
    const ratios = [];
    let match;
    const pattern = new RegExp(FRACTION_PATTERN.source, FRACTION_PATTERN.flags);
    while ((match = pattern.exec(text)) !== null) {
        const numerator = Number.parseFloat(match[1] ?? "");
        const denominator = Number.parseFloat(match[2] ?? "");
        if (Number.isFinite(numerator) &&
            Number.isFinite(denominator) &&
            denominator > 0 &&
            numerator >= 0) {
            ratios.push(numerator / denominator);
        }
    }
    return ratios;
}
function hasAny(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
