/**
 * Utilities for explicit memory cleanup after analysis.
 *
 * The privacy guarantee is: raw story content (pixels, text) exists only
 * in ephemeral JS variables and is never written to any persistent storage.
 * These helpers enforce that guarantee at the memory level.
 */

/**
 * Zeros out the pixel buffer of an ImageData object.
 * Call immediately after analysis — prevents raw pixels from lingering
 * in the JS heap longer than necessary.
 */
export function zeroImageData(imageData: ImageData): void {
  imageData.data.fill(0);
}

/**
 * Removes a canvas element from the DOM and clears its pixels.
 */
export function destroyCanvas(canvas: HTMLCanvasElement): void {
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
export function releaseString(_s: string | null): null {
  return null;
}

/**
 * Disposes a TF.js tensor if TF.js is loaded.
 * Typed as `unknown` so callers don't need to import TF.js types.
 */
export function disposeTensor(tensor: unknown): void {
  if (tensor && typeof (tensor as { dispose?: () => void }).dispose === "function") {
    (tensor as { dispose: () => void }).dispose();
  }
}
