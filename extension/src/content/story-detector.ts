import { AnalysisPipeline } from "./analysis-pipeline";

/**
 * Detects when Instagram Stories are being viewed and triggers analysis.
 * Uses MutationObserver to watch for Story viewer DOM changes.
 * Only processes content the worker is actively viewing — no scraping.
 */
export class StoryDetector {
  private observer: MutationObserver;
  private isProcessing = false;
  private lastProcessedTime = 0;
  private pipeline: AnalysisPipeline;
  private readonly THROTTLE_MS = 2000;

  constructor(pipeline: AnalysisPipeline) {
    this.pipeline = pipeline;
    this.observer = new MutationObserver(this.onMutation.bind(this));
  }

  start(): void {
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    console.log("[Sentinel] Story detector started");
  }

  stop(): void {
    this.observer.disconnect();
  }

  private onMutation(_mutations: MutationRecord[]): void {
    const storyViewer = this.findStoryViewer();
    if (storyViewer && !this.isProcessing) {
      this.processCurrentFrame(storyViewer);
    }
  }

  /**
   * Finds the Instagram Story viewer element using structural heuristics.
   * Avoids relying on specific class names (Instagram uses hashed CSS modules).
   */
  private findStoryViewer(): HTMLElement | null {
    // Strategy 1: Look for section with role="dialog" (Story modal)
    const dialogs = document.querySelectorAll(
      'div[role="dialog"], section[role="presentation"]'
    );
    for (const el of dialogs) {
      if (this.isLikelyStoryViewer(el as HTMLElement)) {
        return el as HTMLElement;
      }
    }

    // Strategy 2: Look for full-viewport overlay with image/video
    const fullScreenSections = document.querySelectorAll("section");
    for (const section of fullScreenSections) {
      const rect = section.getBoundingClientRect();
      if (
        rect.width > window.innerWidth * 0.5 &&
        rect.height > window.innerHeight * 0.5
      ) {
        if (this.isLikelyStoryViewer(section as HTMLElement)) {
          return section as HTMLElement;
        }
      }
    }

    return null;
  }

  private isLikelyStoryViewer(el: HTMLElement): boolean {
    // Must contain an image or video
    const hasMedia =
      el.querySelector('img[draggable="false"]') !== null ||
      el.querySelector("video") !== null;

    // Check for progress bar pattern (thin elements at the top)
    const hasProgressBar =
      el.querySelectorAll('div[style*="scaleX"]').length > 0 ||
      el.querySelectorAll('div[role="progressbar"]').length > 0;

    // Must have a user header (link to profile)
    const hasUserHeader = el.querySelector('a[href^="/"]') !== null;

    return hasMedia && (hasProgressBar || hasUserHeader);
  }

  private async processCurrentFrame(viewer: HTMLElement): Promise<void> {
    const now = Date.now();
    if (now - this.lastProcessedTime < this.THROTTLE_MS) return;

    this.isProcessing = true;
    this.lastProcessedTime = now;

    try {
      const username = this.extractUsername(viewer);
      await this.pipeline.analyse(viewer, username);
    } catch (err) {
      console.warn("[Sentinel] Analysis error:", err);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Extracts Instagram username from the Story header.
   * This is the visible username the worker is already seeing on screen.
   */
  private extractUsername(viewer: HTMLElement): string {
    // Look for the profile link in the Story header
    const links = viewer.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute("href");
      if (href && href !== "/" && !href.includes("/p/") && !href.includes("/explore/")) {
        return href.replace(/^\//, "").replace(/\/$/, "");
      }
    }

    // Fallback: look for header text (username displayed at top of Story)
    const headerSpan = viewer.querySelector("header span");
    if (headerSpan?.textContent) {
      return headerSpan.textContent.trim();
    }

    return "unknown_" + Date.now();
  }
}
