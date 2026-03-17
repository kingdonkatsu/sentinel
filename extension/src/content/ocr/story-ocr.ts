import { findPrimaryStoryMedia } from "../image-analyser";
import {
  OCR_HOST_REQUEST_TYPE,
  OCR_HOST_RESPONSE_TYPE,
  type OcrHostMedia,
  type OcrHostRequest,
  type OcrHostResponse,
  type OcrHostResult,
} from "../dev/ocr-spike-bridge";

const OCR_HOST_PAGE = "src/content/dev/ocr-host.html";
export const OCR_DEFAULT_TIMEOUT_MS = 3000;
export const OCR_MAX_WIDTH = 1080;
export const OCR_MAX_HEIGHT = 1920;

interface OcrMetadata {
  captureHeight?: number;
  captureWidth?: number;
  confidence?: number;
  confidentWordCount?: number;
  sourceHeight?: number;
  sourceWidth?: number;
  strategy?: string;
  totalWordCount?: number;
}

interface OcrResultBase extends OcrMetadata {
  latencyMs: number;
}

export type OcrResult =
  | ({ status: "ok"; text: string } & OcrResultBase)
  | ({ status: "no_text" } & OcrResultBase)
  | ({ status: "timeout"; error?: string } & OcrResultBase)
  | ({ status: "error"; error?: string } & OcrResultBase);

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (result: OcrHostResult) => void;
};

type StoryOcrRunnerLike = {
  dispose(): void;
  recognizeViewer(viewer: HTMLElement, timeoutMs?: number): Promise<OcrResult>;
};

class StoryOcrRunner implements StoryOcrRunnerLike {
  private readonly host = new OcrHostClient();
  private queue: Promise<void> = Promise.resolve();

  async recognizeViewer(
    viewer: HTMLElement,
    timeoutMs = OCR_DEFAULT_TIMEOUT_MS
  ): Promise<OcrResult> {
    const task = this.queue.then(() => this.runRecognize(viewer, timeoutMs));
    this.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  dispose(): void {
    this.host.stop();
    this.queue = Promise.resolve();
  }

  private async runRecognize(
    viewer: HTMLElement,
    timeoutMs: number
  ): Promise<OcrResult> {
    const startedAt = performance.now();

    try {
      const media = findPrimaryStoryMedia(viewer);
      if (!media) {
        throw new Error("No renderable story media found");
      }

      const summary = await this.host.recognize(
        buildHostMediaRequest(media, OCR_MAX_WIDTH, OCR_MAX_HEIGHT),
        timeoutMs
      );

      return mapOcrHostSuccess(
        summary,
        Math.round(performance.now() - startedAt)
      );
    } catch (error) {
      return mapOcrFailure(error, Math.round(performance.now() - startedAt));
    }
  }
}

class OcrHostClient {
  private iframe: HTMLIFrameElement | null = null;
  private frameReady: Promise<Window> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly hostUrl: string;
  private readonly hostOrigin: string;
  private started = false;

  constructor() {
    if (!chrome?.runtime?.id) {
      throw new Error("Extension context invalidated");
    }
    this.hostUrl = chrome.runtime.getURL(OCR_HOST_PAGE);
    this.hostOrigin = new URL(this.hostUrl).origin;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    window.addEventListener("message", this.onMessage);
  }

  stop(): void {
    this.started = false;
    window.removeEventListener("message", this.onMessage);

    for (const { reject } of this.pending.values()) {
      reject(new Error("OCR host shut down"));
    }
    this.pending.clear();

    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }

    this.frameReady = null;
  }

  async recognize(
    media: OcrHostMedia,
    timeoutMs: number
  ): Promise<OcrHostResult> {
    this.start();

    const targetWindow = await this.ensureFrame();
    const requestId = crypto.randomUUID();

    return new Promise<OcrHostResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });

      const request: OcrHostRequest = {
        type: OCR_HOST_REQUEST_TYPE,
        requestId,
        media,
        timeoutMs,
      };

      targetWindow.postMessage(request, this.hostOrigin);
    });
  }

  private async ensureFrame(): Promise<Window> {
    if (this.iframe?.contentWindow) {
      return this.iframe.contentWindow;
    }

    if (this.frameReady) {
      return this.frameReady;
    }

    this.frameReady = new Promise<Window>((resolve, reject) => {
      const iframe = document.createElement("iframe");
      iframe.id = "sentinel-ocr-host-frame";
      iframe.src = this.hostUrl;
      iframe.style.display = "none";
      iframe.setAttribute("aria-hidden", "true");

      iframe.addEventListener(
        "load",
        () => {
          if (!iframe.contentWindow) {
            reject(new Error("OCR host iframe loaded without contentWindow"));
            return;
          }

          this.iframe = iframe;
          resolve(iframe.contentWindow);
        },
        { once: true }
      );

      iframe.addEventListener(
        "error",
        () => {
          this.frameReady = null;
          reject(new Error("Failed to load OCR host iframe"));
        },
        { once: true }
      );

      (document.documentElement || document.body || document.head).appendChild(
        iframe
      );
    }).catch((error) => {
      this.frameReady = null;
      if (this.iframe) {
        this.iframe.remove();
        this.iframe = null;
      }
      throw error;
    });

    return this.frameReady;
  }

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    if (
      event.origin !== this.hostOrigin ||
      !event.data ||
      typeof event.data !== "object" ||
      (event.data as { type?: unknown }).type !== OCR_HOST_RESPONSE_TYPE
    ) {
      return;
    }

    const response = event.data as OcrHostResponse;
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      return;
    }

    this.pending.delete(response.requestId);

    if (!response.ok || !response.result) {
      pending.reject(new Error(response.error || "OCR host failed"));
      return;
    }

    pending.resolve(response.result);
  };
}

export function normalizeOcrText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isUsableOcrText(text: string): boolean {
  const normalized = normalizeOcrText(text);
  if (!normalized) {
    return false;
  }

  if (!/[A-Za-z0-9]/.test(normalized)) {
    return false;
  }

  const compact = normalized.replace(/[^A-Za-z0-9]/g, "");
  if (compact.length < 4) {
    return false;
  }

  const tokens = tokenizeOcrText(normalized);
  if (tokens.length === 0) {
    return false;
  }

  if (tokens.every((token) => token.length <= 1 || /^\d+$/.test(token))) {
    return false;
  }

  const hasStrongAlphaToken = tokens.some(
    (token) => /[A-Za-z]/.test(token) && token.length >= 4
  );
  const hasMultipleMediumAlphaTokens =
    tokens.filter((token) => /[A-Za-z]/.test(token) && token.length >= 3).length >= 2;
  const hasTimeLikeSignal =
    /\b\d{1,2}:\d{2}\b/.test(normalized) &&
    tokens.some((token) => /[A-Za-z]/.test(token) && token.length >= 2);
  if (!hasStrongAlphaToken && !hasMultipleMediumAlphaTokens && !hasTimeLikeSignal) {
    return false;
  }

  const artifactLikeTokens = tokens.filter(
    (token) =>
      token.length <= 1 ||
      /^\d+$/.test(token) ||
      (/^[A-Za-z]+$/.test(token) &&
        token.length <= 2 &&
        !/[aeiouy]/i.test(token))
  );
  if (tokens.length >= 3 && artifactLikeTokens.length / tokens.length >= 0.75) {
    return false;
  }

  return true;
}

export function mapOcrHostSuccess(
  result: OcrHostResult,
  latencyMs: number
): OcrResult {
  const metadata: OcrMetadata = {
    captureHeight: result.captureHeight,
    captureWidth: result.captureWidth,
    confidence: result.confidence ?? undefined,
    confidentWordCount: result.confidentWordCount,
    sourceHeight: result.sourceHeight,
    sourceWidth: result.sourceWidth,
    strategy: result.strategy,
    totalWordCount: result.totalWordCount,
  };

  if (result.strategy === "no-text-timeout") {
    return {
      status: "timeout",
      latencyMs,
      strategy: result.strategy,
      ...metadata,
    };
  }

  const text = normalizeOcrText(result.text ?? "");
  if (!isUsableOcrText(text)) {
    return {
      status: "no_text",
      latencyMs,
      ...metadata,
    };
  }

  return {
    status: "ok",
    latencyMs,
    text,
    ...metadata,
  };
}

export function mapOcrFailure(error: unknown, latencyMs: number): OcrResult {
  const message = normalizeError(error);
  if (/timed out/i.test(message)) {
    return {
      status: "timeout",
      error: message,
      latencyMs,
    };
  }

  return {
    status: "error",
    error: message,
    latencyMs,
  };
}

function buildHostMediaRequest(
  media: HTMLImageElement | HTMLVideoElement,
  maxWidth: number,
  maxHeight: number
): OcrHostMedia {
  const sourceUrl =
    media instanceof HTMLImageElement
      ? media.currentSrc || media.src
      : media.currentSrc || media.src;

  if (!sourceUrl) {
    throw new Error("Story media URL is missing");
  }

  if (media instanceof HTMLImageElement) {
    return {
      kind: "image",
      maxHeight,
      maxWidth,
      url: sourceUrl,
    };
  }

  return {
    currentTime: media.currentTime,
    kind: "video",
    maxHeight,
    maxWidth,
    url: sourceUrl,
  };
}

function tokenizeOcrText(text: string): string[] {
  return normalizeOcrText(text)
    .split(/\s+/)
    .map((token) =>
      token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    )
    .filter(Boolean);
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
    return "OCR failed unexpectedly";
  }
}

let sharedStoryOcr: StoryOcrRunnerLike | null = null;

function getSharedStoryOcr(): StoryOcrRunnerLike {
  if (!sharedStoryOcr) {
    sharedStoryOcr = new StoryOcrRunner();
  }

  return sharedStoryOcr;
}

export const storyOcr: StoryOcrRunnerLike = {
  dispose(): void {
    sharedStoryOcr?.dispose();
    sharedStoryOcr = null;
  },

  recognizeViewer(
    viewer: HTMLElement,
    timeoutMs = OCR_DEFAULT_TIMEOUT_MS
  ): Promise<OcrResult> {
    return getSharedStoryOcr().recognizeViewer(viewer, timeoutMs);
  },
};
