/**
 * Analyses an image's visual tone using colour histogram heuristics.
 * Dark, desaturated images score higher risk.
 *
 * This is a deliberate hackathon simplification. The architecture supports
 * swapping in a real TF.js MobileNet model via the analyseImage() interface.
 */
export function analyseImage(imageData: ImageData): number {
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

/**
 * Captures image data from a Story viewer element.
 * Returns a 224x224 ImageData suitable for analysis.
 */
export async function captureStoryImage(
  viewer: HTMLElement
): Promise<ImageData | null> {
  const img = viewer.querySelector(
    'img[draggable="false"]'
  ) as HTMLImageElement | null;
  const video = viewer.querySelector("video") as HTMLVideoElement | null;

  const canvas = document.createElement("canvas");
  canvas.width = 224;
  canvas.height = 224;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  try {
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, 0, 0, 224, 224);
    } else if (video && video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, 224, 224);
    } else {
      return null;
    }
    return ctx.getImageData(0, 0, 224, 224);
  } catch {
    // Cross-origin image — fall back to simulated score
    return null;
  }
}
