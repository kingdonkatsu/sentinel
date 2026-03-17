/**
 * Analyses a frame with lightweight heuristics.
 *
 * The active score remains the original tone-driven heuristic. This module
 * also exposes a richer shadow breakdown with structural scene cues for
 * non-face stories.
 */
export function analyseImage(imageData: ImageData): number {
  const data = imageData.data;
  let totalBrightness = 0;
  let totalSaturation = 0;
  let redDominance = 0;
  const pixelCount = data.length / 4;

  for (let i = 0; i < data.length; i += 16) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;

    const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    totalBrightness += brightness;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    totalSaturation += saturation;

    if (r > g + 30 && r > b + 30) {
      redDominance += 1;
    }
  }

  const sampledPixels = Math.max(1, pixelCount / 4);
  const avgBrightness = totalBrightness / sampledPixels;
  const avgSaturation = totalSaturation / sampledPixels;
  const redRatio = redDominance / sampledPixels;

  const darknessScore = (1 - avgBrightness) * 100;
  const desaturationScore = (1 - avgSaturation) * 100;
  const redScore = redRatio * 100;
  const score = darknessScore * 0.5 + desaturationScore * 0.3 + redScore * 0.2;
  return clampScore(score);
}

export interface ImageHeuristicBreakdown {
  score: number;
  toneScore: number;
  sceneCueScore: number;
  darknessScore: number;
  desaturationScore: number;
  redScore: number;
  avgBrightness: number;
  avgSaturation: number;
}

export function analyseImageDetailed(
  imageData: ImageData
): ImageHeuristicBreakdown {
  const data = imageData.data;
  let totalBrightness = 0;
  let totalSaturation = 0;
  let redDominance = 0;
  const pixelCount = data.length / 4;

  for (let i = 0; i < data.length; i += 16) {
    // Sample every 4th pixel for performance.
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;

    const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    totalBrightness += brightness;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    totalSaturation += saturation;

    if (r > g + 30 && r > b + 30) {
      redDominance += 1;
    }
  }

  const sampledPixels = Math.max(1, pixelCount / 4);
  const avgBrightness = totalBrightness / sampledPixels;
  const avgSaturation = totalSaturation / sampledPixels;
  const redRatio = redDominance / sampledPixels;

  const darknessScore = (1 - avgBrightness) * 100;
  const desaturationScore = (1 - avgSaturation) * 100;
  const redScore = redRatio * 100;
  const toneScore = darknessScore * 0.5 + desaturationScore * 0.3 + redScore * 0.2;
  const sceneCueScore = computeSceneCueScore(
    imageData,
    avgBrightness,
    avgSaturation
  );

  const score = clampScore(toneScore * 0.75 + sceneCueScore * 0.25);
  return {
    score,
    toneScore: clampScore(toneScore),
    sceneCueScore: clampScore(sceneCueScore),
    darknessScore: clampScore(darknessScore),
    desaturationScore: clampScore(desaturationScore),
    redScore: clampScore(redScore),
    avgBrightness: Number(avgBrightness.toFixed(3)),
    avgSaturation: Number(avgSaturation.toFixed(3)),
  };
}

function computeSceneCueScore(
  imageData: ImageData,
  avgBrightness: number,
  avgSaturation: number
): number {
  const sourceWidth = imageData.width;
  const sourceHeight = imageData.height;
  if (sourceWidth < 6 || sourceHeight < 6) {
    return 0;
  }

  const sampleStep = 2;
  const width = Math.max(3, Math.floor(sourceWidth / sampleStep));
  const height = Math.max(3, Math.floor(sourceHeight / sampleStep));
  const luminance = new Uint8Array(width * height);
  const edgeMask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, y * sampleStep);
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, x * sampleStep);
      const index = (sourceY * sourceWidth + sourceX) * 4;
      const red = imageData.data[index] ?? 0;
      const green = imageData.data[index + 1] ?? 0;
      const blue = imageData.data[index + 2] ?? 0;
      luminance[y * width + x] = Math.round(
        red * 0.299 + green * 0.587 + blue * 0.114
      );
    }
  }

  let edgeCount = 0;
  let darkEdgeCount = 0;
  let thinEdgeCount = 0;
  const totalCorePixels = Math.max(1, (width - 2) * (height - 2));

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const gx =
        (luminance[index + 1] ?? 0) -
        (luminance[index - 1] ?? 0) +
        ((luminance[index + width + 1] ?? 0) - (luminance[index + width - 1] ?? 0)) +
        ((luminance[index - width + 1] ?? 0) - (luminance[index - width - 1] ?? 0));
      const gy =
        (luminance[index + width] ?? 0) -
        (luminance[index - width] ?? 0) +
        ((luminance[index + width + 1] ?? 0) - (luminance[index - width + 1] ?? 0)) +
        ((luminance[index + width - 1] ?? 0) - (luminance[index - width - 1] ?? 0));
      const gradient = Math.abs(gx) + Math.abs(gy);

      if (gradient >= 110) {
        edgeMask[index] = 1;
        edgeCount += 1;
        if ((luminance[index] ?? 0) <= 118) {
          darkEdgeCount += 1;
        }
      }
    }
  }

  if (edgeCount > 0) {
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (edgeMask[index] === 0) {
          continue;
        }

        let neighbors = 0;
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            if (ox === 0 && oy === 0) {
              continue;
            }
            if (edgeMask[(y + oy) * width + (x + ox)] === 1) {
              neighbors += 1;
            }
          }
        }

        if (neighbors <= 2) {
          thinEdgeCount += 1;
        }
      }
    }
  }

  const blockSize = 4;
  let highVarianceBlocks = 0;
  let totalBlocks = 0;

  for (let y = 0; y + blockSize <= height; y += blockSize) {
    for (let x = 0; x + blockSize <= width; x += blockSize) {
      totalBlocks += 1;
      let sum = 0;
      let sumSquares = 0;

      for (let by = 0; by < blockSize; by += 1) {
        for (let bx = 0; bx < blockSize; bx += 1) {
          const value = luminance[(y + by) * width + (x + bx)] ?? 0;
          sum += value;
          sumSquares += value * value;
        }
      }

      const n = blockSize * blockSize;
      const mean = sum / n;
      const variance = sumSquares / n - mean * mean;
      if (variance >= 520) {
        highVarianceBlocks += 1;
      }
    }
  }

  const edgeDensity = edgeCount / totalCorePixels;
  const darkEdgeRatio = edgeCount > 0 ? darkEdgeCount / edgeCount : 0;
  const thinEdgeRatio = edgeCount > 0 ? thinEdgeCount / edgeCount : 0;
  const highVarianceRatio = totalBlocks > 0 ? highVarianceBlocks / totalBlocks : 0;

  const edgeScore = normalize(edgeDensity, 0.08, 0.28) * 100;
  const darkEdgeScore = darkEdgeRatio * 100;
  const thinEdgeScore = thinEdgeRatio * 100;
  const clutterScore = normalize(highVarianceRatio, 0.18, 0.62) * 100;

  let score =
    edgeScore * 0.4 +
    darkEdgeScore * 0.2 +
    thinEdgeScore * 0.15 +
    clutterScore * 0.25;

  if (avgBrightness < 0.45 && avgSaturation < 0.48 && edgeDensity > 0.12) {
    score += 8;
  }

  if (avgBrightness > 0.62 && avgSaturation > 0.62) {
    score *= 0.78;
  }

  return clampScore(score);
}

function normalize(value: number, low: number, high: number): number {
  if (high <= low) {
    return 0;
  }

  return Math.max(0, Math.min(1, (value - low) / (high - low)));
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export interface MediaCaptureOptions {
  maxWidth: number;
  maxHeight: number;
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

export async function captureMediaCanvas(
  media: HTMLImageElement | HTMLVideoElement,
  options: MediaCaptureOptions
): Promise<HTMLCanvasElement | null> {
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
    } catch {
      return null;
    }
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
    } catch {
      return null;
    }
  } finally {
    canvas.remove();
  }
}

function getCaptureDimensions(
  media: HTMLImageElement | HTMLVideoElement,
  options: MediaCaptureOptions
): { width: number; height: number } | null {
  const sourceWidth =
    media instanceof HTMLImageElement ? media.naturalWidth : media.videoWidth;
  const sourceHeight =
    media instanceof HTMLImageElement ? media.naturalHeight : media.videoHeight;

  if (sourceWidth < 1 || sourceHeight < 1) {
    return null;
  }

  const scale = Math.min(
    options.maxWidth / sourceWidth,
    options.maxHeight / sourceHeight,
    1
  );

  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function drawMediaToCanvas(
  media: HTMLImageElement | HTMLVideoElement,
  dimensions: { width: number; height: number }
): HTMLCanvasElement | null {
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
  } catch {
    canvas.remove();
    return null;
  }
}

async function captureRemoteImageCanvas(
  image: HTMLImageElement,
  dimensions: { width: number; height: number }
): Promise<HTMLCanvasElement | null> {
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
  } catch {
    return null;
  }
}
