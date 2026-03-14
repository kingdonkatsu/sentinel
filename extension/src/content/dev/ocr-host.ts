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
  const candidates = buildOcrCandidates(sourceCanvas);
  let best: CandidateSummary | null = null;
  let bestRaw: CandidateSummary | null = null;

  for (const candidate of candidates) {
    const elapsedMs = performance.now() - startedAt;
    const remainingMs = Math.max(200, Math.round(timeoutMs - elapsedMs));
    if (remainingMs <= 200) {
      break;
    }

    await ocrWorker.setParameters({
      tessedit_pageseg_mode: candidate.psm,
    });

    const recognition = await recognizeWithTimeout(
      ocrWorker,
      candidate.canvas,
      remainingMs
    );
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

  applyBinaryPreprocessing(canvas);

  return {
    canvas,
    label: config.label,
    psm: config.psm,
  };
}

function applyBinaryPreprocessing(canvas: HTMLCanvasElement): void {
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
    .filter((word) => word.confidence >= 55)
    .map((word) => normalizeWhitespace(word.text ?? ""))
    .filter((word) => /[A-Za-z0-9]/.test(word));
  const filteredText = normalizeWhitespace(confidentWords.join(" "));
  const confidence =
    typeof result.data.confidence === "number"
      ? Math.round(result.data.confidence * 10) / 10
      : null;
  const text =
    filteredText.length > 0
      ? filteredText
      : (confidence ?? 0) >= 70
        ? rawText
        : "";

  return {
    confidence,
    confidentWordCount: confidentWords.length,
    qualityScore: computeQualityScore(
      text || rawText,
      confidence,
      confidentWords.length
    ),
    strategy,
    text,
    totalWordCount: words.length,
  };
}

function computeQualityScore(
  text: string,
  confidence: number | null,
  confidentWordCount: number
): number {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return 0;
  }

  const allowedChars = normalized.replace(/[A-Za-z0-9\s.,!?'"():;%&/+_-]/g, "");
  const weirdCharPenalty =
    normalized.length > 0 ? (allowedChars.length / normalized.length) * 80 : 0;
  const score =
    (confidence ?? 0) +
    confidentWordCount * 14 +
    normalized.length * 0.6 +
    (/\s/.test(normalized) ? 10 : 0) -
    weirdCharPenalty;

  return Math.max(0, Math.round(score));
}

function scoreUsefulText(summary: CandidateSummary): number {
  return summary.text
    ? summary.qualityScore + summary.confidentWordCount * 10
    : summary.qualityScore;
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
