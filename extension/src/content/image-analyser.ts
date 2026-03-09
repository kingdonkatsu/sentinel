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

export function findPrimaryStoryMedia(
  viewer: HTMLElement
): HTMLImageElement | HTMLVideoElement | null {
  const mediaElements = Array.from(
    viewer.querySelectorAll("video, img[src]")
  ).filter((el): el is HTMLImageElement | HTMLVideoElement => {
    if (el instanceof HTMLImageElement) {
      return (
        el.complete &&
        el.naturalWidth > 0 &&
        isLargeEnough(el) &&
        isRenderable(el)
      );
    }
    return (
      el instanceof HTMLVideoElement &&
      el.readyState >= 2 &&
      el.videoWidth > 0 &&
      el.videoHeight > 0 &&
      isLargeEnough(el) &&
      isRenderable(el)
    );
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
export async function captureStoryImage(
  viewer: HTMLElement
): Promise<ImageData | null> {
  const media = findPrimaryStoryMedia(viewer);
  if (!media) {
    return null;
  }

  return captureMediaImage(media);
}

export function captureVideoFrame(video: HTMLVideoElement): ImageData | null {
  return captureMediaImageSync(video);
}

async function captureMediaImage(
  media: HTMLImageElement | HTMLVideoElement
): Promise<ImageData | null> {
  if (media instanceof HTMLImageElement) {
    const localImageData = captureMediaImageSync(media);
    if (localImageData) {
      return localImageData;
    }

    return captureRemoteImage(media);
  }

  return captureMediaImageSync(media);
}

function captureMediaImageSync(
  media: HTMLImageElement | HTMLVideoElement
): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = 224;
  canvas.height = 224;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  try {
    ctx.drawImage(media, 0, 0, 224, 224);
    return ctx.getImageData(0, 0, 224, 224);
  } catch {
    return null;
  } finally {
    canvas.remove();
  }
}

function isLargeEnough(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width >= 80 && rect.height >= 80;
}

function isRenderable(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number.parseFloat(style.opacity || "1") < 0.05
  ) {
    return false;
  }

  const intersectionWidth =
    Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
  const intersectionHeight =
    Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);

  return intersectionWidth > 24 && intersectionHeight > 24;
}

function renderPriority(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const intersectionWidth = Math.max(
    0,
    Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
  );
  const visibleArea = intersectionWidth * intersectionHeight;

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const viewportCenterX = window.innerWidth / 2;
  const viewportCenterY = window.innerHeight / 2;
  const distancePenalty =
    Math.abs(centerX - viewportCenterX) + Math.abs(centerY - viewportCenterY);

  return visibleArea - distancePenalty;
}

async function captureRemoteImage(
  image: HTMLImageElement
): Promise<ImageData | null> {
  const source = image.currentSrc || image.src;
  if (!source) {
    return null;
  }

  try {
    const response = (await chrome.runtime.sendMessage({
      type: "FETCH_MEDIA_BYTES",
      url: source,
    })) as
      | { ok: true; bytes: ArrayBuffer; contentType: string }
      | { ok: false; error?: string };

    if (!response?.ok || !(response.bytes instanceof ArrayBuffer)) {
      return null;
    }

    const blob = new Blob([response.bytes], {
      type: response.contentType || "image/jpeg",
    });
    const bitmap = await createImageBitmap(blob);

    const canvas = document.createElement("canvas");
    canvas.width = 224;
    canvas.height = 224;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      canvas.remove();
      return null;
    }

    ctx.drawImage(bitmap, 0, 0, 224, 224);
    const imageData = ctx.getImageData(0, 0, 224, 224);
    bitmap.close();
    canvas.remove();
    return imageData;
  } catch {
    return null;
  }
}
