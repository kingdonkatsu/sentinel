import {
  SEMANTIC_HOST_REQUEST_TYPE,
  SEMANTIC_HOST_RESPONSE_TYPE,
  type SemanticHostRequest,
  type SemanticHostResponse,
  type SemanticHostResult,
} from "./semantic-host-bridge";

const SEMANTIC_HOST_PAGE = "src/content/semantic/semantic-host.html";
export const SEMANTIC_MODEL_TIMEOUT_MS = 5000;

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (result: SemanticHostResult) => void;
};

export interface SemanticScorerLike {
  dispose(): void;
  scoreText(text: string, timeoutMs?: number): Promise<SemanticHostResult>;
}

class SemanticHostClient implements SemanticScorerLike {
  private iframe: HTMLIFrameElement | null = null;
  private frameReady: Promise<Window> | null = null;
  private readonly hostOrigin: string;
  private readonly hostUrl: string;
  private readonly pending = new Map<string, PendingRequest>();
  private queue: Promise<void> = Promise.resolve();
  private started = false;

  constructor() {
    if (!chrome?.runtime?.id) {
      throw new Error("Extension context invalidated");
    }
    this.hostUrl = chrome.runtime.getURL(SEMANTIC_HOST_PAGE);
    this.hostOrigin = new URL(this.hostUrl).origin;
  }

  async scoreText(
    text: string,
    timeoutMs = SEMANTIC_MODEL_TIMEOUT_MS
  ): Promise<SemanticHostResult> {
    const task = this.queue.then(() => this.runScoreText(text, timeoutMs));
    this.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  dispose(): void {
    this.started = false;
    window.removeEventListener("message", this.onMessage);

    for (const { reject } of this.pending.values()) {
      reject(new Error("MiniLM host shut down"));
    }
    this.pending.clear();

    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }

    this.frameReady = null;
    this.queue = Promise.resolve();
  }

  private start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    window.addEventListener("message", this.onMessage);
  }

  private async runScoreText(
    text: string,
    timeoutMs: number
  ): Promise<SemanticHostResult> {
    this.start();
    const targetWindow = await this.ensureFrame();
    const requestId = crypto.randomUUID();

    return new Promise<SemanticHostResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });

      const request: SemanticHostRequest = {
        type: SEMANTIC_HOST_REQUEST_TYPE,
        requestId,
        text,
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
      iframe.id = "sentinel-semantic-host-frame";
      iframe.src = this.hostUrl;
      iframe.style.display = "none";
      iframe.setAttribute("aria-hidden", "true");

      iframe.addEventListener(
        "load",
        () => {
          if (!iframe.contentWindow) {
            reject(new Error("MiniLM host iframe loaded without contentWindow"));
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
          reject(new Error("Failed to load MiniLM host iframe"));
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
      (event.data as { type?: unknown }).type !== SEMANTIC_HOST_RESPONSE_TYPE
    ) {
      return;
    }

    const response = event.data as SemanticHostResponse;
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      return;
    }

    this.pending.delete(response.requestId);

    if (!response.ok || !response.result) {
      pending.reject(new Error(response.error || "MiniLM host failed"));
      return;
    }

    pending.resolve(response.result);
  };
}

class UnavailableSemanticScorer implements SemanticScorerLike {
  dispose(): void {
    // No-op outside the extension runtime.
  }

  async scoreText(): Promise<SemanticHostResult> {
    throw new Error("MiniLM host is unavailable outside the extension runtime");
  }
}

let sharedSemanticTextModelHost: SemanticScorerLike | null = null;

export function getSemanticTextModelHost(): SemanticScorerLike {
  if (sharedSemanticTextModelHost) {
    return sharedSemanticTextModelHost;
  }

  const runtime = typeof chrome !== "undefined" ? chrome.runtime : undefined;
  sharedSemanticTextModelHost =
    runtime?.getURL && typeof document !== "undefined"
      ? new SemanticHostClient()
      : new UnavailableSemanticScorer();
  return sharedSemanticTextModelHost;
}
