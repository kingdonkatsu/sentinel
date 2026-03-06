import type { AnalysisResult } from "../shared/types";
import { AnalysisPipeline } from "./analysis-pipeline";

const RESERVED_PATHS = new Set([
  "accounts",
  "direct",
  "explore",
  "p",
  "reel",
  "reels",
  "stories",
]);

export class StoryDetector {
  private observer: MutationObserver;
  private pollTimer: number | null = null;
  private isProcessing = false;
  private lastProcessedAt = 0;
  private lastProcessedSignature = "";
  private pipeline: AnalysisPipeline;
  private readonly THROTTLE_MS = 1500;
  private readonly POLL_MS = 1500;
  private readonly DUPLICATE_WINDOW_MS = 10000;

  constructor(pipeline: AnalysisPipeline) {
    this.pipeline = pipeline;
    this.observer = new MutationObserver(this.onMutation.bind(this));
  }

  start(): void {
    if (document.body) {
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    this.pollTimer = window.setInterval(() => {
      void this.scanForStory("poll");
    }, this.POLL_MS);

    void this.scanForStory("startup");
    console.log("[Sentinel] Story detector started");
  }

  stop(): void {
    this.observer.disconnect();
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async analyseVisibleStory(): Promise<{
    ok: boolean;
    message: string;
    result?: AnalysisResult;
  }> {
    const viewer = this.findStoryViewer();
    if (!viewer) {
      return {
        ok: false,
        message: "No Story viewer detected. Open an Instagram Story first.",
      };
    }

    const result = await this.processCurrentFrame(viewer, "manual", true);
    if (!result) {
      return {
        ok: false,
        message: "Story analysis was skipped. Try changing stories and retrying.",
      };
    }

    return {
      ok: true,
      message: `Analysed @${result.score.username} (${result.score.composite}/100)`,
      result,
    };
  }

  private onMutation(): void {
    void this.scanForStory("mutation");
  }

  private async scanForStory(reason: string): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    const viewer = this.findStoryViewer();
    if (!viewer) {
      return;
    }

    await this.processCurrentFrame(viewer, reason, false);
  }

  private findStoryViewer(): HTMLElement | null {
    const candidates = new Set<HTMLElement>();
    const selectors = ["div[role='dialog']", "section", "main", "article"];

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((el) => {
        if (el instanceof HTMLElement) {
          candidates.add(el);
        }
      });
    }

    let bestCandidate: HTMLElement | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const score = this.scoreCandidate(candidate);
      if (score > bestScore) {
        bestCandidate = candidate;
        bestScore = score;
      }
    }

    return bestScore >= 5 ? bestCandidate : null;
  }

  private scoreCandidate(el: HTMLElement): number {
    const rect = el.getBoundingClientRect();
    if (rect.width < window.innerWidth * 0.35) {
      return 0;
    }
    if (rect.height < window.innerHeight * 0.35) {
      return 0;
    }

    const hasMedia =
      el.querySelector('img[draggable="false"], img[src], video') !== null;
    if (!hasMedia) {
      return 0;
    }

    const hasProgressBar =
      el.querySelectorAll('div[style*="scaleX"]').length > 0 ||
      el.querySelectorAll('div[role="progressbar"]').length > 0;
    const hasNavigationButtons =
      el.querySelector(
        'button[aria-label*="Next"], button[aria-label*="Previous"], button[aria-label*="Pause"]'
      ) !== null;
    const hasUserHeader = this.findUsernameLink(el) !== null;
    const fillsViewport =
      rect.width > window.innerWidth * 0.5 &&
      rect.height > window.innerHeight * 0.5;

    let score = 0;
    score += 3; // has media
    if (fillsViewport) {
      score += 2;
    }
    if (hasProgressBar) {
      score += 2;
    }
    if (hasUserHeader) {
      score += 2;
    }
    if (hasNavigationButtons) {
      score += 1;
    }

    return score;
  }

  private async processCurrentFrame(
    viewer: HTMLElement,
    reason: string,
    force: boolean
  ): Promise<AnalysisResult | null> {
    const now = Date.now();
    if (!force && now - this.lastProcessedAt < this.THROTTLE_MS) {
      return null;
    }

    const username = this.extractUsername(viewer);
    const signature = this.buildStorySignature(viewer, username);
    if (
      !force &&
      signature === this.lastProcessedSignature &&
      now - this.lastProcessedAt < this.DUPLICATE_WINDOW_MS
    ) {
      return null;
    }

    this.isProcessing = true;

    try {
      const result = await this.pipeline.analyse(viewer, username);
      this.lastProcessedAt = now;
      this.lastProcessedSignature = signature;

      console.log("[Sentinel] Story analysed", {
        reason,
        username: result.score.username,
        composite: result.score.composite,
        text: result.score.textScore,
        image: result.score.imageScore,
        transmitted: result.transmitted,
      });

      return result;
    } catch (error) {
      console.warn("[Sentinel] Analysis error:", error);
      return null;
    } finally {
      this.isProcessing = false;
    }
  }

  private buildStorySignature(viewer: HTMLElement, username: string): string {
    const mediaSource = this.getPrimaryMediaSource(viewer);
    const textSignature = viewer.textContent
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);

    return `${username}|${mediaSource}|${textSignature || ""}`;
  }

  private getPrimaryMediaSource(viewer: HTMLElement): string {
    const image = viewer.querySelector("img[src]") as HTMLImageElement | null;
    if (image?.currentSrc || image?.src) {
      return image.currentSrc || image.src;
    }

    const video = viewer.querySelector("video") as HTMLVideoElement | null;
    if (video?.currentSrc || video?.src || video?.poster) {
      return video.currentSrc || video.src || video.poster;
    }

    return "no-media";
  }

  private extractUsername(viewer: HTMLElement): string {
    const link = this.findUsernameLink(viewer);
    if (link) {
      const username = this.parseUsernameFromHref(link.getAttribute("href"));
      if (username) {
        return username;
      }
    }

    const textCandidates = viewer.querySelectorAll(
      "header span, header a, span[dir='auto']"
    );
    for (const candidate of textCandidates) {
      const text = candidate.textContent?.trim();
      if (text && /^[A-Za-z0-9._]{1,30}$/.test(text)) {
        return text;
      }
    }

    return `unknown_${Date.now()}`;
  }

  private findUsernameLink(viewer: HTMLElement): HTMLAnchorElement | null {
    const links = viewer.querySelectorAll("a[href]");
    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement)) {
        continue;
      }

      if (this.parseUsernameFromHref(link.getAttribute("href"))) {
        return link;
      }
    }

    return null;
  }

  private parseUsernameFromHref(href: string | null): string | null {
    if (!href) {
      return null;
    }

    try {
      const url = new URL(href, window.location.origin);
      if (url.origin !== window.location.origin) {
        return null;
      }

      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length !== 1) {
        return null;
      }

      const candidate = segments[0];
      if (RESERVED_PATHS.has(candidate.toLowerCase())) {
        return null;
      }

      if (!/^[A-Za-z0-9._]{1,30}$/.test(candidate)) {
        return null;
      }

      return candidate;
    } catch {
      return null;
    }
  }
}
