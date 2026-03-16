"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractVisualContextCues = extractVisualContextCues;
exports.applyVisualContextCues = applyVisualContextCues;
function extractVisualContextCues(imageData) {
    const sample = sampleImage(imageData, 2);
    const sampleCount = Math.max(1, sample.width * sample.height);
    const brightLowSatRatio = sample.brightLowSatCount / sampleCount;
    const coolClinicalRatio = sample.coolClinicalCount / sampleCount;
    const deepRedRatio = sample.deepRedCount / sampleCount;
    const darkRedRatio = sample.darkRedCount / sampleCount;
    const isolatedBrightDotRatio = sample.isolatedBrightDotCount / sampleCount;
    const edgeDensity = sample.edgeDensity;
    const bloodCueScore = clamp01(normalize(darkRedRatio, 0.01, 0.09)) * 0.7 +
        clamp01(normalize(deepRedRatio, 0.02, 0.15)) * 0.3;
    const medicalCueScore = clamp01(normalize(brightLowSatRatio, 0.15, 0.65)) * 0.65 +
        clamp01(normalize(coolClinicalRatio, 0.05, 0.35)) * 0.35;
    const pillCueScore = clamp01(normalize(isolatedBrightDotRatio, 0.0015, 0.02)) * 0.85 +
        clamp01(normalize(brightLowSatRatio, 0.03, 0.28)) * 0.15;
    const injuryCueScore = bloodCueScore * 0.55 +
        clamp01(normalize(edgeDensity, 0.12, 0.35)) * 0.45;
    const bloodLike = bloodCueScore >= 0.52;
    const medicalSettingLike = medicalCueScore >= 0.52;
    const pillLike = pillCueScore >= 0.5 && sample.isolatedBrightDotCount >= 18;
    const injuryChaosLike = injuryCueScore >= 0.56 && edgeDensity >= 0.14;
    const reasons = [];
    let scoreBoost = 0;
    let confidenceBoost = 0;
    if (bloodLike) {
        reasons.push("blood-like red pattern");
        scoreBoost += 7;
        confidenceBoost += 0.06;
    }
    if (pillLike) {
        reasons.push("pill-like bright micro-objects");
        scoreBoost += 5;
        confidenceBoost += 0.04;
    }
    if (medicalSettingLike) {
        reasons.push("medical-setting palette cue");
        scoreBoost += 4;
        confidenceBoost += 0.03;
    }
    if (injuryChaosLike) {
        reasons.push("injury/chaos structural cue");
        scoreBoost += 6;
        confidenceBoost += 0.05;
    }
    if (bloodLike && (pillLike || medicalSettingLike || injuryChaosLike)) {
        reasons.push("combined acute visual context");
        scoreBoost += 3;
        confidenceBoost += 0.03;
    }
    const cueScore = clampScore(Math.round((bloodCueScore * 0.35 +
        pillCueScore * 0.2 +
        medicalCueScore * 0.2 +
        injuryCueScore * 0.25) *
        100));
    return {
        bloodLike,
        pillLike,
        medicalSettingLike,
        injuryChaosLike,
        reasons,
        scoreBoost,
        confidenceBoost,
        cueScore,
    };
}
function applyVisualContextCues(score, confidence, cues) {
    const adjustedScore = clampScore(Math.round(score + cues.scoreBoost));
    const adjustedConfidence = clamp(confidence + cues.confidenceBoost, 0, 0.95);
    return {
        score: adjustedScore,
        confidence: Number(adjustedConfidence.toFixed(3)),
    };
}
function sampleImage(imageData, step) {
    const width = Math.max(2, Math.floor(imageData.width / step));
    const height = Math.max(2, Math.floor(imageData.height / step));
    const luminance = new Uint8Array(width * height);
    const brightMask = new Uint8Array(width * height);
    let brightLowSatCount = 0;
    let coolClinicalCount = 0;
    let deepRedCount = 0;
    let darkRedCount = 0;
    for (let y = 0; y < height; y += 1) {
        const sourceY = Math.min(imageData.height - 1, y * step);
        for (let x = 0; x < width; x += 1) {
            const sourceX = Math.min(imageData.width - 1, x * step);
            const index = (sourceY * imageData.width + sourceX) * 4;
            const red = imageData.data[index] ?? 0;
            const green = imageData.data[index + 1] ?? 0;
            const blue = imageData.data[index + 2] ?? 0;
            const max = Math.max(red, green, blue);
            const min = Math.min(red, green, blue);
            const value = max / 255;
            const saturation = max === 0 ? 0 : (max - min) / max;
            const luma = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
            const flatIndex = y * width + x;
            luminance[flatIndex] = luma;
            const brightLowSat = value >= 0.74 && saturation <= 0.2;
            if (brightLowSat) {
                brightMask[flatIndex] = 1;
                brightLowSatCount += 1;
            }
            if (value >= 0.5 && saturation <= 0.32 && blue - red >= 12 && green >= red) {
                coolClinicalCount += 1;
            }
            const deepRed = red >= 110 && red > green * 1.32 && red > blue * 1.32;
            if (deepRed) {
                deepRedCount += 1;
                if (value <= 0.5) {
                    darkRedCount += 1;
                }
            }
        }
    }
    let isolatedBrightDotCount = 0;
    for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
            const index = y * width + x;
            if (brightMask[index] === 0)
                continue;
            let brightNeighbors = 0;
            let neighborLumaSum = 0;
            let neighborCount = 0;
            for (let oy = -1; oy <= 1; oy += 1) {
                for (let ox = -1; ox <= 1; ox += 1) {
                    if (ox === 0 && oy === 0)
                        continue;
                    const neighborIndex = (y + oy) * width + (x + ox);
                    if (brightMask[neighborIndex] === 1) {
                        brightNeighbors += 1;
                    }
                    neighborLumaSum += luminance[neighborIndex] ?? 0;
                    neighborCount += 1;
                }
            }
            const avgNeighborLuma = neighborCount > 0 ? neighborLumaSum / neighborCount : 0;
            if (brightNeighbors <= 2 && (luminance[index] ?? 0) - avgNeighborLuma >= 16) {
                isolatedBrightDotCount += 1;
            }
        }
    }
    let edgeCount = 0;
    let edgeChecks = 0;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            const current = luminance[index] ?? 0;
            if (x + 1 < width) {
                const right = luminance[index + 1] ?? 0;
                if (Math.abs(current - right) >= 28)
                    edgeCount += 1;
                edgeChecks += 1;
            }
            if (y + 1 < height) {
                const below = luminance[index + width] ?? 0;
                if (Math.abs(current - below) >= 28)
                    edgeCount += 1;
                edgeChecks += 1;
            }
        }
    }
    return {
        width,
        height,
        brightLowSatCount,
        coolClinicalCount,
        deepRedCount,
        darkRedCount,
        isolatedBrightDotCount,
        edgeDensity: edgeChecks > 0 ? edgeCount / edgeChecks : 0,
    };
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function clamp01(value) {
    return clamp(value, 0, 1);
}
function clampScore(score) {
    return Math.round(clamp(score, 0, 100));
}
function normalize(value, low, high) {
    if (high <= low) {
        return 0;
    }
    return (value - low) / (high - low);
}
