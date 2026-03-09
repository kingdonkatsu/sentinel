"use strict";
/**
 * Video frame analyser.
 *
 * Samples up to 3 frames from video stories and runs each through the
 * visual frame scorer. Returns the median risk score across frames to avoid
 * letting one outlier frame dominate the result.
 *
 * Sampling strategy (non-disruptive):
 *   Frame 1: current playback position (no seeking)
 *   Frame 2: current position + 0.5s (temporary seek, immediately restored)
 *   Frame 3: current position + 1.5s (temporary seek, immediately restored)
 *
 * If the video is too short for offset frames, only captured frames are used.
 * Falls back to single-frame if seeking throws (cross-origin, DRM, etc.)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VideoAnalyser = void 0;
exports.aggregateFrameResults = aggregateFrameResults;
const image_analyser_1 = require("../image-analyser");
const secure_cleanup_1 = require("../privacy/secure-cleanup");
const visual_emotion_analyser_1 = require("./visual-emotion-analyser");
const SEEK_OFFSETS_S = [0, 0.5, 1.5];
class VideoAnalyser {
    captureFrame;
    modality = "video";
    visualAnalyser;
    constructor(captureFrame = image_analyser_1.captureVideoFrame, visualAnalyser = new visual_emotion_analyser_1.VisualEmotionAnalyser()) {
        this.captureFrame = captureFrame;
        this.visualAnalyser = visualAnalyser;
    }
    isAvailable(viewer) {
        const video = viewer.querySelector("video");
        return video !== null && video.readyState >= 2 && video.duration > 0;
    }
    async analyse(viewer, seed = {}) {
        const t0 = performance.now();
        const video = viewer.querySelector("video");
        if (!video || video.readyState < 2 || video.duration <= 0) {
            return this.unavailableResult(performance.now() - t0);
        }
        const frameResults = [];
        const originalTime = seed.initialTime ?? video.currentTime;
        const wasPaused = video.paused;
        video.pause();
        for (const offsetS of SEEK_OFFSETS_S) {
            const targetTime = Math.min(originalTime + offsetS, video.duration - 0.1);
            const initialFrame = offsetS === 0 && seed.initialFrame ? (0, secure_cleanup_1.cloneImageData)(seed.initialFrame) : null;
            const frame = await this.captureAtTime(video, targetTime, initialFrame);
            if (frame !== null)
                frameResults.push(frame);
        }
        // Restore video state
        try {
            video.currentTime = originalTime;
            if (!wasPaused)
                video.play().catch(() => { });
        }
        catch {
            // restore failure is non-critical
        }
        if (frameResults.length === 0) {
            return this.unavailableResult(performance.now() - t0);
        }
        const aggregate = aggregateFrameResults(frameResults);
        return {
            modality: "video",
            score: aggregate.score,
            confidence: aggregate.confidence,
            available: true,
            inferenceTimeMs: performance.now() - t0,
        };
    }
    async captureAtTime(video, targetTime, initialFrame) {
        try {
            let imageData = initialFrame;
            if (!imageData) {
                const seeked = await this.seekTo(video, targetTime);
                if (!seeked)
                    return null;
                imageData = this.captureFrame(video);
            }
            if (!imageData) {
                return null;
            }
            const result = await this.visualAnalyser.scoreCapturedFrame(imageData);
            return {
                modality: "video",
                score: result.score,
                confidence: result.confidence,
                available: true,
                inferenceTimeMs: 0,
            };
        }
        catch {
            if (initialFrame) {
                (0, secure_cleanup_1.zeroImageData)(initialFrame);
            }
            return null;
        }
    }
    /**
     * Seeks video to targetTime and waits for the seeked event.
     * Times out after 300ms to stay within the 500ms total analysis budget.
     */
    seekTo(video, targetTime) {
        return new Promise((resolve) => {
            if (Math.abs(video.currentTime - targetTime) < 0.05) {
                resolve(true);
                return;
            }
            const timeout = setTimeout(() => {
                video.removeEventListener("seeked", onSeeked);
                resolve(false);
            }, 300);
            const onSeeked = () => {
                clearTimeout(timeout);
                video.removeEventListener("seeked", onSeeked);
                resolve(true);
            };
            video.addEventListener("seeked", onSeeked, { once: true });
            try {
                video.currentTime = targetTime;
            }
            catch {
                clearTimeout(timeout);
                video.removeEventListener("seeked", onSeeked);
                resolve(false);
            }
        });
    }
    unavailableResult(inferenceTimeMs) {
        return {
            modality: "video",
            score: 50,
            confidence: 0,
            available: false,
            inferenceTimeMs,
        };
    }
    dispose() {
        this.visualAnalyser.dispose();
    }
}
exports.VideoAnalyser = VideoAnalyser;
function aggregateFrameResults(frameResults) {
    if (frameResults.length === 0) {
        return { score: 50, confidence: 0 };
    }
    const scoreValues = frameResults.map((result) => result.score);
    const confidenceValues = frameResults.map((result) => result.confidence);
    return {
        score: Math.round(median(scoreValues)),
        confidence: median(confidenceValues),
    };
}
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle] ?? 0;
    }
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
