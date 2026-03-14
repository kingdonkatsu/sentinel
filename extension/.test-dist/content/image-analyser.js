"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyseImage = analyseImage;
exports.findPrimaryStoryMedia = findPrimaryStoryMedia;
exports.captureStoryImage = captureStoryImage;
exports.captureVideoFrame = captureVideoFrame;
exports.captureMediaCanvas = captureMediaCanvas;
/**
 * Analyses an image's visual tone using colour histogram heuristics.
 * Dark, desaturated images score higher risk.
 *
 * This is a deliberate hackathon simplification. The architecture supports
 * swapping in a real TF.js MobileNet model via the analyseImage() interface.
 */
function analyseImage(imageData) {
    const data = imageData.data;
    let totalBrightness = 0;
    let totalSaturation = 0;
    let redDominance = 0;
    const pixelCount = data.length / 4;
    for (let i = 0; i < data.length; i += 16) {
        // Sample every 4th pixel for performance
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        // Perceived luminance
        const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        totalBrightness += brightness;
        // Simple saturation approximation
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const saturation = max === 0 ? 0 : (max - min) / max;
        totalSaturation += saturation;
        // Red dominance (associated with intense emotions)
        if (r > g + 30 && r > b + 30) {
            redDominance++;
        }
    }
    const sampledPixels = pixelCount / 4;
    const avgBrightness = totalBrightness / sampledPixels;
    const avgSaturation = totalSaturation / sampledPixels;
    const redRatio = redDominance / sampledPixels;
    // Heuristic: dark + desaturated = higher distress signal
    const darknessScore = (1 - avgBrightness) * 100;
    const desaturationScore = (1 - avgSaturation) * 100;
    const redScore = redRatio * 100;
    const score = darknessScore * 0.5 + desaturationScore * 0.3 + redScore * 0.2;
    return Math.max(0, Math.min(100, Math.round(score)));
}
function findPrimaryStoryMedia(viewer) {
    const mediaElements = Array.from(viewer.querySelectorAll("video, img[src]")).filter((el) => {
        if (el instanceof HTMLImageElement) {
            return (el.complete &&
                el.naturalWidth > 0 &&
                isLargeEnough(el) &&
                isRenderable(el));
        }
        return (el instanceof HTMLVideoElement &&
            el.readyState >= 2 &&
            el.videoWidth > 0 &&
            el.videoHeight > 0 &&
            isLargeEnough(el) &&
            isRenderable(el));
    });
    if (mediaElements.length === 0) {
        return null;
    }
    mediaElements.sort((a, b) => renderPriority(b) - renderPriority(a));
    return mediaElements[0] ?? null;
}
/**
 * Captures image data from a Story viewer element.
 * Returns a 224x224 ImageData suitable for analysis.
 */
async function captureStoryImage(viewer) {
    const media = findPrimaryStoryMedia(viewer);
    if (!media) {
        return null;
    }
    return captureMediaImage(media);
}
function captureVideoFrame(video) {
    return captureMediaImageSync(video);
}
async function captureMediaCanvas(media, options) {
    const dimensions = getCaptureDimensions(media, options);
    if (!dimensions) {
        return null;
    }
    if (media instanceof HTMLImageElement) {
        const localCanvas = drawMediaToCanvas(media, dimensions);
        if (localCanvas) {
            return localCanvas;
        }
        return captureRemoteImageCanvas(media, dimensions);
    }
    return drawMediaToCanvas(media, dimensions);
}
async function captureMediaImage(media) {
    if (media instanceof HTMLImageElement) {
        const localImageData = captureMediaImageSync(media);
        if (localImageData) {
            return localImageData;
        }
        return captureRemoteImage(media);
    }
    return captureMediaImageSync(media);
}
function captureMediaImageSync(media) {
    const canvas = drawMediaToCanvas(media, { width: 224, height: 224 });
    if (!canvas) {
        return null;
    }
    try {
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return null;
        }
        try {
            return ctx.getImageData(0, 0, 224, 224);
        }
        catch {
            return null;
        }
    }
    finally {
        canvas.remove();
    }
}
function isLargeEnough(element) {
    const rect = element.getBoundingClientRect();
    return rect.width >= 80 && rect.height >= 80;
}
function isRenderable(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
        return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity || "1") < 0.05) {
        return false;
    }
    const intersectionWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
    const intersectionHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    return intersectionWidth > 24 && intersectionHeight > 24;
}
function renderPriority(element) {
    const rect = element.getBoundingClientRect();
    const intersectionWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const intersectionHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    const visibleArea = intersectionWidth * intersectionHeight;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const viewportCenterX = window.innerWidth / 2;
    const viewportCenterY = window.innerHeight / 2;
    const distancePenalty = Math.abs(centerX - viewportCenterX) + Math.abs(centerY - viewportCenterY);
    return visibleArea - distancePenalty;
}
async function captureRemoteImage(image) {
    const canvas = await captureRemoteImageCanvas(image, {
        width: 224,
        height: 224,
    });
    if (!canvas) {
        return null;
    }
    try {
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return null;
        }
        try {
            return ctx.getImageData(0, 0, 224, 224);
        }
        catch {
            return null;
        }
    }
    finally {
        canvas.remove();
    }
}
function getCaptureDimensions(media, options) {
    const sourceWidth = media instanceof HTMLImageElement ? media.naturalWidth : media.videoWidth;
    const sourceHeight = media instanceof HTMLImageElement ? media.naturalHeight : media.videoHeight;
    if (sourceWidth < 1 || sourceHeight < 1) {
        return null;
    }
    const scale = Math.min(options.maxWidth / sourceWidth, options.maxHeight / sourceHeight, 1);
    return {
        width: Math.max(1, Math.round(sourceWidth * scale)),
        height: Math.max(1, Math.round(sourceHeight * scale)),
    };
}
function drawMediaToCanvas(media, dimensions) {
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        canvas.remove();
        return null;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    try {
        ctx.drawImage(media, 0, 0, dimensions.width, dimensions.height);
        return canvas;
    }
    catch {
        canvas.remove();
        return null;
    }
}
async function captureRemoteImageCanvas(image, dimensions) {
    const source = image.currentSrc || image.src;
    if (!source) {
        return null;
    }
    try {
        const response = (await chrome.runtime.sendMessage({
            type: "FETCH_MEDIA_BYTES",
            url: source,
        }));
        if (!response?.ok || !(response.bytes instanceof ArrayBuffer)) {
            return null;
        }
        const blob = new Blob([response.bytes], {
            type: response.contentType || "image/jpeg",
        });
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = dimensions.width;
        canvas.height = dimensions.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            bitmap.close();
            canvas.remove();
            return null;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
        bitmap.close();
        return canvas;
    }
    catch {
        return null;
    }
}
