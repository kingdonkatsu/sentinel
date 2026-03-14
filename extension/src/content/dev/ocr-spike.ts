import { findPrimaryStoryMedia } from "../image-analyser";
import {
  OCR_HOST_REQUEST_TYPE,
  OCR_HOST_RESPONSE_TYPE,
  type OcrHostMedia,
  type OcrHostRequest,
  type OcrHostResponse,
} from "./ocr-spike-bridge";

const OCR_TRIGGER_EVENT = "sentinel:ocr-spike";
const OCR_TIMEOUT_MS = 3000;
const OCR_MAX_WIDTH = 1080;
const OCR_MAX_HEIGHT = 1920;
const LOG_PREFIX = "[Sentinel][OCR Spike]";
const OCR_HOST_PAGE = "src/content/dev/ocr-host.html";

type OverlayState = "running" | "success" | "empty" | "error";

interface DevOcrSpikeOptions {
  getViewer: () => HTMLElement | null;
}

interface OverlayPayload {
  state: OverlayState;
  title: string;
  detail: string;
  text?: string;
  latencyMs?: number;
  confidence?: number | null;
}

interface OcrSummary {
  captureHeight: number;
  captureWidth: number;
  confidence: number | null;
  confidentWordCount: number;
  sourceHeight: number;
  sourceWidth: number;
  strategy: string;
  text: string;
  totalWordCount: number;
}

export class DevOcrSpike {
  private readonly getViewer: () => HTMLElement | null;
  private readonly overlay = new OcrSpikeOverlay();
  private readonly host = new OcrHostClient();
  private isRunning = false;
  private lastProgress = "idle";

  constructor(options: DevOcrSpikeOptions) {
    this.getViewer = options.getViewer;
  }

  start(): void {
    this.host.start();
    document.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener(OCR_TRIGGER_EVENT, this.onCustomTrigger as EventListener);
  }

  stop(): void {
    this.host.stop();
    document.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener(
      OCR_TRIGGER_EVENT,
      this.onCustomTrigger as EventListener
    );
    this.overlay.dismiss();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (
      !event.altKey ||
      !event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.code !== "KeyO"
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void this.run("keyboard");
  };

  private readonly onCustomTrigger = (): void => {
    void this.run("custom-event");
  };

  private async run(trigger: "keyboard" | "custom-event"): Promise<void> {
    if (this.isRunning) {
      this.overlay.render({
        state: "running",
        title: "OCR spike already running",
        detail: this.lastProgress,
      });
      console.warn(`${LOG_PREFIX} Trigger ignored; OCR is already running`);
      return;
    }

    this.isRunning = true;
    const startedAt = performance.now();

    try {
      const viewer = this.getViewer();
      if (!viewer) {
        throw new Error("No Instagram story viewer detected");
      }

      const media = findPrimaryStoryMedia(viewer);
      if (!media) {
        throw new Error("No renderable story media found");
      }

      this.overlay.render({
        state: "running",
        title: "OCR spike running",
        detail: "Inspecting story media",
      });

      const mediaRequest = buildHostMediaRequest(
        media,
        OCR_MAX_WIDTH,
        OCR_MAX_HEIGHT
      );
      this.overlay.render({
        state: "running",
        title: "OCR spike running",
        detail: `Fetching ${mediaRequest.kind} media in extension OCR host`,
      });

      this.lastProgress = "running OCR";
      const summary = await this.host.recognize(mediaRequest, OCR_TIMEOUT_MS);
      const latencyMs = Math.round(performance.now() - startedAt);
      const mediaType = media instanceof HTMLImageElement ? "image" : "video";
      const sourceDimensions = `${summary.sourceWidth}x${summary.sourceHeight}`;
      const captureDimensions = `${summary.captureWidth}x${summary.captureHeight}`;

      console.groupCollapsed(
        `${LOG_PREFIX} ${summary.text ? "result" : "empty"} (${latencyMs}ms)`
      );
      console.log("trigger", trigger);
      console.log("capture", {
        mediaType,
        sourceDimensions,
        captureDimensions,
      });
      console.log("ocr", {
        latencyMs,
        confidence: summary.confidence,
        totalWordCount: summary.totalWordCount,
        confidentWordCount: summary.confidentWordCount,
        strategy: summary.strategy,
        text: summary.text || "(empty)",
      });
      console.groupEnd();

      this.overlay.render({
        state: summary.text ? "success" : "empty",
        title: summary.text ? "OCR spike result" : "OCR spike empty",
        detail: `${mediaType} ${captureDimensions} via ${summary.strategy}`,
        latencyMs,
        confidence: summary.confidence,
        text: summary.text || "(empty)",
      });
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startedAt);
      const message = normalizeError(error);

      console.warn(`${LOG_PREFIX} failed`, {
        latencyMs,
        error: message,
        rawError: error,
      });

      this.overlay.render({
        state: "error",
        title: "OCR spike failed",
        detail: message,
        latencyMs,
      });
    } finally {
      this.isRunning = false;
    }
  }
}

class OcrHostClient {
  private iframe: HTMLIFrameElement | null = null;
  private frameReady: Promise<Window> | null = null;
  private readonly pending = new Map<
    string,
    {
      reject: (error: Error) => void;
      resolve: (result: OcrSummary) => void;
    }
  >();
  private readonly hostUrl = chrome.runtime.getURL(OCR_HOST_PAGE);
  private readonly hostOrigin = new URL(this.hostUrl).origin;

  start(): void {
    window.addEventListener("message", this.onMessage);
  }

  stop(): void {
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
  ): Promise<OcrSummary> {
    const targetWindow = await this.ensureFrame();
    const requestId = crypto.randomUUID();

    return new Promise<OcrSummary>((resolve, reject) => {
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
}

class OcrSpikeOverlay {
  private shadowHost: HTMLElement | null = null;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;

  render(payload: OverlayPayload): void {
    if (!document.body) {
      return;
    }

    this.ensureHost();
    if (!this.shadowHost?.shadowRoot) {
      return;
    }

    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }

    const { accent, background } = paletteForState(payload.state);
    const text = escapeHtml(payload.text ?? "");
    const latency =
      typeof payload.latencyMs === "number" ? `${payload.latencyMs}ms` : "n/a";
    const confidence =
      typeof payload.confidence === "number"
        ? `${payload.confidence.toFixed(1)}`
        : "n/a";

    this.shadowHost.shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        .panel {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          width: min(360px, calc(100vw - 24px));
          box-sizing: border-box;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: ${background};
          color: #f8fafc;
          box-shadow: 0 18px 45px rgba(0, 0, 0, 0.35);
          font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          overflow: hidden;
          backdrop-filter: blur(10px);
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 14px 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        }
        .title {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .dot {
          width: 9px;
          height: 9px;
          border-radius: 999px;
          flex: none;
          background: ${accent};
          box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.08);
        }
        .detail {
          padding: 10px 14px 0;
          color: rgba(248, 250, 252, 0.82);
        }
        .meta {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          padding: 12px 14px 0;
        }
        .meta-card {
          border-radius: 10px;
          background: rgba(15, 23, 42, 0.28);
          padding: 8px 10px;
        }
        .meta-label {
          font-size: 10px;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          color: rgba(248, 250, 252, 0.62);
        }
        .meta-value {
          margin-top: 2px;
          font-size: 13px;
          font-weight: 600;
        }
        .text {
          margin: 12px 14px 14px;
          padding: 10px 11px;
          border-radius: 10px;
          background: rgba(15, 23, 42, 0.35);
          color: #f8fafc;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 190px;
          overflow: auto;
        }
      </style>
      <div class="panel" role="status" aria-live="polite">
        <div class="header">
          <div class="title">${escapeHtml(payload.title)}</div>
          <div class="dot"></div>
        </div>
        <div class="detail">${escapeHtml(payload.detail)}</div>
        <div class="meta">
          <div class="meta-card">
            <div class="meta-label">Latency</div>
            <div class="meta-value">${latency}</div>
          </div>
          <div class="meta-card">
            <div class="meta-label">Confidence</div>
            <div class="meta-value">${confidence}</div>
          </div>
        </div>
        <div class="text">${text || "(empty)"}</div>
      </div>
    `;

    if (payload.state !== "running") {
      this.dismissTimer = window.setTimeout(() => this.dismiss(), 12000);
    }
  }

  dismiss(): void {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }

    if (this.shadowHost) {
      this.shadowHost.remove();
      this.shadowHost = null;
    }
  }

  private ensureHost(): void {
    if (this.shadowHost?.isConnected) {
      return;
    }

    this.shadowHost = document.createElement("div");
    this.shadowHost.id = "sentinel-ocr-spike-host";
    this.shadowHost.attachShadow({ mode: "open" });
    document.body.appendChild(this.shadowHost);
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paletteForState(state: OverlayState): {
  accent: string;
  background: string;
} {
  switch (state) {
    case "success":
      return {
        accent: "#38bdf8",
        background: "linear-gradient(160deg, rgba(14, 116, 144, 0.96), rgba(15, 23, 42, 0.96))",
      };
    case "empty":
      return {
        accent: "#fbbf24",
        background: "linear-gradient(160deg, rgba(133, 77, 14, 0.96), rgba(15, 23, 42, 0.96))",
      };
    case "error":
      return {
        accent: "#fb7185",
        background: "linear-gradient(160deg, rgba(127, 29, 29, 0.96), rgba(15, 23, 42, 0.96))",
      };
    case "running":
    default:
      return {
        accent: "#a78bfa",
        background: "linear-gradient(160deg, rgba(49, 46, 129, 0.96), rgba(15, 23, 42, 0.96))",
      };
  }
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
    return "OCR spike failed unexpectedly";
  }
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
