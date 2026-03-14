import { OEM, PSM, createWorker } from "tesseract.js";
import {
  OCR_HOST_REQUEST_TYPE,
  OCR_HOST_RESPONSE_TYPE,
  type OcrHostMedia,
  type OcrHostRequest,
  type OcrHostResponse,
  type OcrHostResult,
} from "./ocr-spike-bridge";

type OcrWorker = Awaited<ReturnType<typeof createWorker>>;
type RecognizeResult = Awaited<ReturnType<OcrWorker["recognize"]>>;

interface DecodedCanvas {
  canvas: HTMLCanvasElement;
  sourceHeight: number;
  sourceWidth: number;
}

interface OcrCandidate {
  canvas: HTMLCanvasElement;
  label: string;
  metrics: CandidateMetrics;
  psm: PSM;
}

interface CandidateSummary {
  confidence: number | null;
  confidentWordCount: number;
  qualityScore: number;
  strategy: string;
  text: string;
  totalWordCount: number;
}

interface CandidateMetrics {
  darkPixelRatio: number;
  horizontalTransitionRatio: number;
  occupiedColumnRatio: number;
  occupiedRowRatio: number;
  textLikelihood: number;
  verticalTransitionRatio: number;
}

let worker: OcrWorker | null = null;
let workerPromise: Promise<OcrWorker> | null = null;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = event.data;

  if (
    event.source !== window.parent ||
    !request ||
    typeof request !== "object" ||
    (request as { type?: unknown }).type !== OCR_HOST_REQUEST_TYPE
  ) {
    return;
  }

  void handleRequest(event.origin, request as OcrHostRequest);
});

async function handleRequest(
  targetOrigin: string,
  request: OcrHostRequest
): Promise<void> {
  try {
    const decoded = await captureCanvasForOcr(request.media);
    const ocrWorker = await getWorker();
    const result = await runBestEffortOcr(
      ocrWorker,
      decoded.canvas,
      request.timeoutMs
    );

    postResponse(targetOrigin, {
      type: OCR_HOST_RESPONSE_TYPE,
      requestId: request.requestId,
      ok: true,
      result: summarize(result, decoded),
    });
  } catch (error) {
    const normalized = normalizeError(error);
    if (/timeout/i.test(normalized)) {
      await resetWorker();
    }

    postResponse(targetOrigin, {
      type: OCR_HOST_RESPONSE_TYPE,
      requestId: request.requestId,
      ok: false,
      error: normalized,
    });
  }
}

async function getWorker(): Promise<OcrWorker> {
  if (worker) {
    return worker;
  }

  if (workerPromise) {
    return workerPromise;
  }

  workerPromise = createWorker("eng", OEM.LSTM_ONLY, {
    cacheMethod: "none",
    corePath: chrome.runtime.getURL("models/tesseract"),
    langPath: chrome.runtime.getURL("models/tesseract/lang-data/4.0.0_best_int"),
    workerBlobURL: false,
    workerPath: chrome.runtime.getURL("models/tesseract/worker.min.js"),
  })
    .then(async (createdWorker) => {
      await createdWorker.setParameters({
        preserve_interword_spaces: "1",
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        user_defined_dpi: "150",
      });
      worker = createdWorker;
      return createdWorker;
    })
    .catch((error) => {
      workerPromise = null;
      throw error;
    });

  return workerPromise;
}

async function resetWorker(): Promise<void> {
  const currentWorker = worker;
  worker = null;
  workerPromise = null;

  if (!currentWorker) {
    return;
  }

  try {
    await currentWorker.terminate();
  } catch {
    // Ignore worker shutdown failures for the dev spike.
  }
}

function recognizeWithTimeout(
  ocrWorker: OcrWorker,
  image: HTMLCanvasElement,
  timeoutMs: number
): Promise<RecognizeResult> {
  let timer: number | null = null;

  return Promise.race([
    ocrWorker.recognize(
      image,
      {},
      {
        blocks: true,
        text: true,
      }
    ),
    new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => {
        reject(new Error(`OCR timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  }) as Promise<RecognizeResult>;
}

function summarize(
  result: CandidateSummary,
  decoded: DecodedCanvas
): OcrHostResult {
  return {
    captureHeight: decoded.canvas.height,
    captureWidth: decoded.canvas.width,
    confidence: result.confidence,
    confidentWordCount: result.confidentWordCount,
    sourceHeight: decoded.sourceHeight,
    sourceWidth: decoded.sourceWidth,
    strategy: result.strategy,
    text: result.text,
    totalWordCount: result.totalWordCount,
  };
}

function postResponse(targetOrigin: string, response: OcrHostResponse): void {
  window.parent.postMessage(response, targetOrigin);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function runBestEffortOcr(
  ocrWorker: OcrWorker,
  sourceCanvas: HTMLCanvasElement,
  timeoutMs: number
): Promise<CandidateSummary> {
  const startedAt = performance.now();
  const candidates = buildOcrCandidates(sourceCanvas)
    .filter((candidate) => candidate.metrics.textLikelihood >= 12)
    .sort(
      (left, right) => right.metrics.textLikelihood - left.metrics.textLikelihood
    )
    .slice(0, 2);
  const strongestCandidate = candidates[0] ?? null;
  let best: CandidateSummary | null = null;
  let bestRaw: CandidateSummary | null = null;
  let timedOutCandidates = 0;

  if (candidates.length === 0) {
    return {
      confidence: null,
      confidentWordCount: 0,
      qualityScore: 0,
      strategy: "no-text-short-circuit",
      text: "",
      totalWordCount: 0,
    };
  }

  for (const candidate of candidates) {
    const elapsedMs = performance.now() - startedAt;
    const remainingMs = Math.max(200, Math.round(timeoutMs - elapsedMs));
    if (remainingMs <= 200) {
      break;
    }

    const candidateTimeoutMs = Math.max(350, Math.min(remainingMs, 1100));

    await ocrWorker.setParameters({
      tessedit_pageseg_mode: candidate.psm,
    });

    let recognition: RecognizeResult;
    try {
      recognition = await recognizeWithTimeout(
        ocrWorker,
        candidate.canvas,
        candidateTimeoutMs
      );
    } catch (error) {
      if (/timed out/i.test(normalizeError(error))) {
        timedOutCandidates += 1;
        continue;
      }

      throw error;
    }
    const summary = summarizeCandidate(recognition, candidate.label);

    if (!bestRaw || summary.qualityScore > bestRaw.qualityScore) {
      bestRaw = summary;
    }
    if (!best || scoreUsefulText(summary) > scoreUsefulText(best)) {
      best = summary;
    }

    if (
      summary.text.length >= 12 &&
      summary.confidentWordCount >= 3 &&
      (summary.confidence ?? 0) >= 70
    ) {
      break;
    }
  }

  const winner = best ?? bestRaw;
  if (!winner) {
    if (timedOutCandidates > 0 && (strongestCandidate?.metrics.textLikelihood ?? 0) < 55) {
      return {
        confidence: null,
        confidentWordCount: 0,
        qualityScore: 0,
        strategy: "no-text-timeout",
        text: "",
        totalWordCount: 0,
      };
    }

    throw new Error("OCR returned no candidate result");
  }

  if (winner.qualityScore < 65) {
    return {
      ...winner,
      text: "",
    };
  }

  return winner;
}

async function captureCanvasForOcr(
  media: OcrHostMedia
): Promise<DecodedCanvas> {
  const blob = await fetchMediaBlob(media.url);

  if (media.kind === "image") {
    const bitmap = await createImageBitmap(blob);

    try {
      return drawToCanvas(bitmap, media.maxWidth, media.maxHeight);
    } finally {
      bitmap.close();
    }
  }

  return captureVideoFrame(blob, media);
}

async function fetchMediaBlob(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`Media fetch failed with status ${response.status}`);
  }

  return response.blob();
}

async function captureVideoFrame(
  blob: Blob,
  media: Extract<OcrHostMedia, { kind: "video" }>
): Promise<DecodedCanvas> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  const objectUrl = URL.createObjectURL(blob);
  video.src = objectUrl;

  try {
    await waitForEvent(video, "loadedmetadata");

    const targetTime = clampTime(media.currentTime, video.duration);
    if (Number.isFinite(targetTime) && targetTime > 0) {
      video.currentTime = targetTime;
      await waitForEvent(video, "seeked");
    }

    if (video.videoWidth < 1 || video.videoHeight < 1) {
      throw new Error("Decoded video frame is empty");
    }

    return drawToCanvas(video, media.maxWidth, media.maxHeight);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

function drawToCanvas(
  source: ImageBitmap | HTMLVideoElement,
  maxWidth: number,
  maxHeight: number
): DecodedCanvas {
  const sourceWidth =
    source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const sourceHeight =
    source instanceof HTMLVideoElement ? source.videoHeight : source.height;

  if (sourceWidth < 1 || sourceHeight < 1) {
    throw new Error("Decoded media dimensions are empty");
  }

  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to create OCR canvas context");
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, sourceHeight, sourceWidth };
}

function buildOcrCandidates(sourceCanvas: HTMLCanvasElement): OcrCandidate[] {
  return [
    makeCandidate(sourceCanvas, {
      heightRatio: 1,
      label: "full-frame-binary",
      psm: PSM.SPARSE_TEXT,
      scale: 1,
      widthRatio: 1,
      xRatio: 0,
      yRatio: 0,
    }),
    makeCandidate(sourceCanvas, {
      heightRatio: 0.3,
      label: "mid-band-binary",
      psm: PSM.SINGLE_BLOCK,
      scale: 2,
      widthRatio: 0.84,
      xRatio: 0.08,
      yRatio: 0.28,
    }),
    makeCandidate(sourceCanvas, {
      heightRatio: 0.28,
      label: "lower-band-binary",
      psm: PSM.SINGLE_BLOCK,
      scale: 2,
      widthRatio: 0.84,
      xRatio: 0.08,
      yRatio: 0.62,
    }),
  ];
}

function makeCandidate(
  sourceCanvas: HTMLCanvasElement,
  config: {
    heightRatio: number;
    label: string;
    psm: PSM;
    scale: number;
    widthRatio: number;
    xRatio: number;
    yRatio: number;
  }
): OcrCandidate {
  const cropX = Math.round(sourceCanvas.width * config.xRatio);
  const cropY = Math.round(sourceCanvas.height * config.yRatio);
  const cropWidth = Math.max(1, Math.round(sourceCanvas.width * config.widthRatio));
  const cropHeight = Math.max(1, Math.round(sourceCanvas.height * config.heightRatio));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cropWidth * config.scale));
  canvas.height = Math.max(1, Math.round(cropHeight * config.scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to create OCR candidate canvas");
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    sourceCanvas,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    canvas.width,
    canvas.height
  );

  return {
    canvas,
    label: config.label,
    metrics: applyBinaryPreprocessing(canvas),
    psm: config.psm,
  };
}

function applyBinaryPreprocessing(canvas: HTMLCanvasElement): CandidateMetrics {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to access OCR candidate context");
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const luminances = new Uint8Array(canvas.width * canvas.height);
  const histogram = new Uint32Array(256);

  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel += 1) {
    const luminance = Math.round(
      data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    );
    luminances[pixel] = luminance;
    histogram[luminance] += 1;
  }

  const threshold = computeOtsuThreshold(histogram, luminances.length);
  let darkPixels = 0;

  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel += 1) {
    const value = luminances[pixel] >= threshold ? 255 : 0;
    if (value === 0) {
      darkPixels += 1;
    }

    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }

  if (darkPixels > luminances.length / 2) {
    for (let i = 0; i < data.length; i += 4) {
      const value = 255 - data[i];
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return analyzeBinaryImageData(imageData, canvas.width, canvas.height);
}

function analyzeBinaryImageData(
  imageData: ImageData,
  width: number,
  height: number
): CandidateMetrics {
  const { data } = imageData;
  const totalPixels = Math.max(1, width * height);
  const rowHasDark = new Uint8Array(height);
  const columnHasDark = new Uint8Array(width);
  let darkPixels = 0;
  let horizontalTransitions = 0;
  let verticalTransitions = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = (y * width + x) * 4;
      const value = data[pixelIndex];
      const isDark = value === 0;

      if (isDark) {
        darkPixels += 1;
        rowHasDark[y] = 1;
        columnHasDark[x] = 1;
      }

      if (x > 0 && value !== data[pixelIndex - 4]) {
        horizontalTransitions += 1;
      }
      if (y > 0 && value !== data[pixelIndex - width * 4]) {
        verticalTransitions += 1;
      }
    }
  }

  const occupiedRowRatio =
    rowHasDark.reduce((count, value) => count + value, 0) / Math.max(1, height);
  const occupiedColumnRatio =
    columnHasDark.reduce((count, value) => count + value, 0) / Math.max(1, width);
  const darkPixelRatio = darkPixels / totalPixels;
  const horizontalTransitionRatio =
    horizontalTransitions / Math.max(1, height * (width - 1));
  const verticalTransitionRatio =
    verticalTransitions / Math.max(1, width * (height - 1));

  return {
    darkPixelRatio,
    horizontalTransitionRatio,
    occupiedColumnRatio,
    occupiedRowRatio,
    textLikelihood: computeTextLikelihood({
      darkPixelRatio,
      horizontalTransitionRatio,
      occupiedColumnRatio,
      occupiedRowRatio,
      textLikelihood: 0,
      verticalTransitionRatio,
    }),
    verticalTransitionRatio,
  };
}

function computeTextLikelihood(metrics: CandidateMetrics): number {
  const transitionDensity =
    metrics.horizontalTransitionRatio + metrics.verticalTransitionRatio;

  if (metrics.darkPixelRatio < 0.004 || metrics.darkPixelRatio > 0.92) {
    return 0;
  }

  if (
    transitionDensity < 0.01 &&
    metrics.occupiedRowRatio < 0.12 &&
    metrics.occupiedColumnRatio < 0.12
  ) {
    return 0;
  }

  const inkScore =
    metrics.darkPixelRatio < 0.015
      ? 8
      : metrics.darkPixelRatio < 0.4
        ? 24
        : 12;
  const transitionScore = Math.min(55, Math.round(transitionDensity * 1200));
  const coverageScore = Math.min(
    35,
    Math.round(
      metrics.occupiedRowRatio * 16 + metrics.occupiedColumnRatio * 18
    )
  );

  return inkScore + transitionScore + coverageScore;
}

function computeOtsuThreshold(
  histogram: Uint32Array,
  totalPixels: number
): number {
  let sum = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    sum += i * histogram[i];
  }

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = -1;
  let threshold = 127;

  for (let i = 0; i < histogram.length; i += 1) {
    weightBackground += histogram[i];
    if (weightBackground === 0) {
      continue;
    }

    const weightForeground = totalPixels - weightBackground;
    if (weightForeground === 0) {
      break;
    }

    sumBackground += i * histogram[i];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance =
      weightBackground *
      weightForeground *
      (meanBackground - meanForeground) *
      (meanBackground - meanForeground);

    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = i;
    }
  }

  return threshold;
}

function summarizeCandidate(
  result: RecognizeResult,
  strategy: string
): CandidateSummary {
  const rawText = normalizeWhitespace(result.data.text ?? "");
  const words = Array.isArray(result.data.words) ? result.data.words : [];
  const confidentWords = words
    .filter((word) => word.confidence >= 60)
    .map((word) => normalizeWhitespace(word.text ?? ""))
    .filter((word) => /[A-Za-z0-9]/.test(word));
  const filteredText = normalizeWhitespace(confidentWords.join(" "));
  const filteredTokens = tokenizeOcrText(filteredText);
  const plausibleTokens = filteredTokens.filter(isPlausibleOcrToken);
  const plausibleTokenCount = plausibleTokens.length;
  const shortTokenCount = filteredTokens.filter((token) => token.length <= 1).length;
  const confidence =
    typeof result.data.confidence === "number"
      ? Math.round(result.data.confidence * 10) / 10
      : null;
  const candidateText =
    filteredText.length > 0
      ? filteredText
      : (confidence ?? 0) >= 72
        ? rawText
        : "";
  const text = shouldAcceptCandidateText({
    confidence,
    filteredTokenCount: filteredTokens.length,
    hasLongPlausibleToken: plausibleTokens.some((token) => token.length >= 4),
    plausibleTokenCount,
    shortTokenCount,
    text: candidateText,
    totalWordCount: words.length,
  })
    ? candidateText
    : "";

  return {
    confidence,
    confidentWordCount: plausibleTokenCount,
    qualityScore: computeQualityScore(
      text || candidateText || rawText,
      confidence,
      plausibleTokenCount,
      filteredTokens.length,
      shortTokenCount,
      words.length
    ),
    strategy,
    text,
    totalWordCount: words.length,
  };
}

function computeQualityScore(
  text: string,
  confidence: number | null,
  plausibleTokenCount: number,
  filteredTokenCount: number,
  shortTokenCount: number,
  totalWordCount: number
): number {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return 0;
  }

  const allowedChars = normalized.replace(/[A-Za-z0-9\s.,!?'"():;%&/+_-]/g, "");
  const weirdCharPenalty =
    normalized.length > 0 ? (allowedChars.length / normalized.length) * 80 : 0;
  const shortTokenPenalty =
    filteredTokenCount > 0 ? (shortTokenCount / filteredTokenCount) * 50 : 0;
  const sparseSignalPenalty =
    totalWordCount > plausibleTokenCount * 3 + 6 ? 25 : 0;
  const score =
    (confidence ?? 0) +
    plausibleTokenCount * 16 +
    normalized.length * 0.6 +
    (/\s/.test(normalized) ? 10 : 0) -
    weirdCharPenalty -
    shortTokenPenalty -
    sparseSignalPenalty;

  return Math.max(0, Math.round(score));
}

function scoreUsefulText(summary: CandidateSummary): number {
  return summary.text
    ? summary.qualityScore + summary.confidentWordCount * 10
    : summary.qualityScore;
}

function tokenizeOcrText(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/\s+/)
    .map((token) =>
      token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    )
    .filter(Boolean);
}

function isPlausibleOcrToken(token: string): boolean {
  if (/^\d+$/.test(token)) {
    return token.length >= 2;
  }

  const lower = token.toLowerCase();
  if (lower.length >= 4) {
    return true;
  }

  if (lower.length === 3) {
    return /[aeiouy]/.test(lower);
  }

  if (lower.length === 2) {
    return /^[a-z]{2}$/.test(lower) && /[aeiou]/.test(lower);
  }

  return false;
}

function shouldAcceptCandidateText(params: {
  confidence: number | null;
  filteredTokenCount: number;
  hasLongPlausibleToken: boolean;
  plausibleTokenCount: number;
  shortTokenCount: number;
  text: string;
  totalWordCount: number;
}): boolean {
  if (!params.text) {
    return false;
  }

  if (params.plausibleTokenCount === 0) {
    return false;
  }

  const shortTokenRatio =
    params.filteredTokenCount > 0
      ? params.shortTokenCount / params.filteredTokenCount
      : 1;
  const confidence = params.confidence ?? 0;
  const sparseSignal =
    params.totalWordCount > params.plausibleTokenCount * 3 + 6;

  if (confidence >= 72 && shortTokenRatio < 0.5 && !sparseSignal) {
    return true;
  }

  if (
    params.plausibleTokenCount >= 2 &&
    (params.hasLongPlausibleToken || confidence >= 65) &&
    shortTokenRatio < 0.45 &&
    !sparseSignal
  ) {
    return true;
  }

  if (
    params.plausibleTokenCount >= 3 &&
    confidence >= 48 &&
    shortTokenRatio < 0.34
  ) {
    return true;
  }

  return false;
}

function waitForEvent(
  target: HTMLVideoElement,
  type: "loadedmetadata" | "seeked"
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Video ${type} failed`));
    };
    const cleanup = () => {
      target.removeEventListener(type, onSuccess);
      target.removeEventListener("error", onError);
    };

    target.addEventListener(type, onSuccess, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function clampTime(currentTime: number, duration: number): number {
  if (!Number.isFinite(currentTime) || currentTime < 0) {
    return 0;
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    return currentTime;
  }

  return Math.min(currentTime, Math.max(duration - 0.05, 0));
}

function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "OCR host failed unexpectedly";
  }
}
