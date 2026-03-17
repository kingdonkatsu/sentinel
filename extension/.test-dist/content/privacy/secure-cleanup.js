"use strict";
/**
 * Utilities for explicit memory cleanup after analysis.
 *
 * The privacy guarantee is: raw story content (pixels, text) exists only
 * in ephemeral JS variables and is never written to any persistent storage.
 * These helpers enforce that guarantee at the memory level.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.zeroImageData = zeroImageData;
exports.cloneImageData = cloneImageData;
exports.destroyCanvas = destroyCanvas;
exports.releaseString = releaseString;
exports.disposeTensor = disposeTensor;
/**
 * Zeros out the pixel buffer of an ImageData object.
 * Call immediately after analysis — prevents raw pixels from lingering
 * in the JS heap longer than necessary.
 */
function zeroImageData(imageData) {
    imageData.data.fill(0);
}
function cloneImageData(imageData) {
    const data = new Uint8ClampedArray(imageData.data);
    if (typeof ImageData === "function") {
        return new ImageData(data, imageData.width, imageData.height);
    }
    return {
        data,
        width: imageData.width,
        height: imageData.height,
    };
}
/**
 * Removes a canvas element from the DOM and clears its pixels.
 */
function destroyCanvas(canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    canvas.remove();
}
/**
 * Zeroes a string variable by replacing all chars — JS strings are immutable
 * so we cannot truly zero them, but we release the reference and note this
 * in the docstring. The GC will reclaim the memory after this call.
 *
 * Usage:
 *   let text: string | null = extractText(viewer);
 *   const score = await analyseText(text);
 *   text = releaseString(text);  // text is now null
 */
function releaseString(_s) {
    return null;
}
/**
 * Disposes a TF.js tensor if TF.js is loaded.
 * Typed as `unknown` so callers don't need to import TF.js types.
 */
function disposeTensor(tensor) {
    if (tensor && typeof tensor.dispose === "function") {
        tensor.dispose();
    }
}
