import type { AnalysisResult } from "../shared/types";
import { AnalysisPipeline } from "./analysis-pipeline";
import { findPrimaryStoryMedia } from "./image-analyser";
import { extractText } from "./text-analyser";

const RESERVED_PATHS = new Set([
  "",
  "activity",
  "accounts",
  "archive",
  "direct",
  "home",
  "inbox",
  "messages",
  "notifications",
  "explore",
  "p",
  "reel",
  "reels",
  "search",
  "stories",
]);

const SPONSORED_LABEL_PATTERNS = [
  /\bsponsored\b/i,
  /\bpaid partnership\b/i,
  /\bpromoted\b/i,
];

const SPONSORED_CTA_PATTERNS = [
  /\blearn more\b/i,
  /\bshop now\b/i,
  /\bview shop\b/i,
  /\bbook now\b/i,
  /\bget quote\b/i,
  /\bget tickets\b/i,
  /\binstall now\b/i,
  /\bdownload\b/i,
  /\border now\b/i,
  /\bsign up\b/i,
  /\bcontact us\b/i,
  /\bwatch more\b/i,
  /\bvisit (site|website)\b/i,
  /\bswipe up\b/i,
];

const HEADER_AD_LABEL_PATTERNS = [/^ad$/i, /^sponsored$/i];

export class StoryDetector {
  private observer: MutationObserver;
  private mutationTimer: number | null = null;
  private pollTimer: number | null = null;
  private isProcessing = false;
  private queuedScanReason: string | null = null;
  private lastAutoOcrSpikeSignature = "";
  private lastProcessedAt = 0;
  private lastProcessedSignature = "";
  private processedSignatures = new Map<string, number>();
  private pipeline: AnalysisPipeline;
  private readonly THROTTLE_MS = 1500;
  private readonly POLL_MS = 700;
  private readonly MUTATION_DEBOUNCE_MS = 120;
  private readonly DUPLICATE_WINDOW_MS = 10000;
  private readonly SIGNATURE_TTL_MS = 120000;
  private scanSequence = 0;

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
    if (this.mutationTimer !== null) {
      window.clearTimeout(this.mutationTimer);
      this.mutationTimer = null;
    }
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

    const username = this.extractUsername(viewer);
    const signature = this.buildStorySignature(viewer, username);
    const sponsoredEvidence = this.getSponsoredEvidence(viewer);
    if (sponsoredEvidence) {
      this.markSignatureProcessed(signature);
      return {
        ok: false,
        message: `Sponsored stories are ignored (${sponsoredEvidence}).`,
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
    if (this.mutationTimer !== null) {
      window.clearTimeout(this.mutationTimer);
    }

    this.mutationTimer = window.setTimeout(() => {
      this.mutationTimer = null;
      void this.scanForStory("mutation");
    }, this.MUTATION_DEBOUNCE_MS);
  }

  private async scanForStory(reason: string): Promise<void> {
    if (this.isProcessing) {
      this.queuedScanReason = reason;
      return;
    }

    const viewer = this.findStoryViewer();
    if (!viewer) {
      return;
    }

    await this.processCurrentFrame(viewer, reason, false);

    if (!this.isProcessing && this.queuedScanReason) {
      const queuedReason = this.queuedScanReason;
      this.queuedScanReason = null;
      const catchupReason = queuedReason === "mutation" ? "catchup" : queuedReason;
      void this.scanForStory(catchupReason);
    }
  }

  private findStoryViewer(): HTMLElement | null {
    const isStoryRoute = this.isStoryRouteActive();
    if (isStoryRoute) {
      const routeViewer = this.findStoryRouteViewer();
      if (routeViewer) {
        return routeViewer;
      }
    }

    const candidates = new Set<HTMLElement>();
    const selectors = ["div[role='dialog']"];

    if (isStoryRoute) {
      selectors.push("main", "section", "article");
    }

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

    return bestScore >= (isStoryRoute ? 5 : 8) ? bestCandidate : null;
  }

  private findStoryRouteViewer(): HTMLElement | null {
    const mediaCandidates = Array.from(
      document.querySelectorAll("video, img[src]")
    )
      .filter((el): el is HTMLVideoElement | HTMLImageElement => {
        return el instanceof HTMLVideoElement || el instanceof HTMLImageElement;
      })
      .filter((el) => this.isVisibleMedia(el))
      .sort((a, b) => this.mediaArea(b) - this.mediaArea(a));

    for (const media of mediaCandidates) {
      const container = this.findContainerForMedia(media);
      if (container) {
        return container;
      }
    }

    return null;
  }

  private findContainerForMedia(
    media: HTMLVideoElement | HTMLImageElement
  ): HTMLElement | null {
    let current: HTMLElement | null = media.parentElement;

    while (current && current !== document.body) {
      const rect = current.getBoundingClientRect();
      if (
        rect.width > window.innerWidth * 0.45 &&
        rect.height > window.innerHeight * 0.45
      ) {
        return current;
      }

      current = current.parentElement;
    }

    return media.parentElement ?? media;
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

    const isDialog = el.matches("div[role='dialog']");
    const isStoryRoute = this.isStoryRouteActive();
    const hasProgressBar =
      el.querySelectorAll('div[style*="scaleX"]').length > 0 ||
      el.querySelectorAll('div[role="progressbar"]').length > 0;
    const hasNavigationButtons =
      el.querySelector(
        'button[aria-label*="Next"], button[aria-label*="Previous"], button[aria-label*="Pause"], button[aria-label*="Close"]'
      ) !== null;
    const hasReplyComposer =
      el.querySelector(
        'input[placeholder*="Reply"], textarea[placeholder*="Reply"], [data-testid="reply-composer"], [aria-label*="Reply"]'
      ) !== null;
    const hasUserHeader = this.findUsernameLink(el) !== null;
    const fillsViewport =
      rect.width > window.innerWidth * 0.5 &&
      rect.height > window.innerHeight * 0.5;
    const hasStoryChrome =
      hasProgressBar || hasNavigationButtons || hasReplyComposer;

    const hasStoryRouteStructure =
      isStoryRoute && fillsViewport && hasUserHeader;

    if (!hasStoryChrome && !(isStoryRoute && isDialog) && !hasStoryRouteStructure) {
      return 0;
    }

    let score = 0;
    score += 3; // has media
    if (fillsViewport) {
      score += 2;
    }
    if (isDialog) {
      score += 3;
    }
    if (isStoryRoute) {
      score += 2;
    }
    if (hasProgressBar) {
      score += 4;
    }
    if (hasUserHeader) {
      score += 1;
    }
    if (hasNavigationButtons) {
      score += 2;
    }
    if (hasReplyComposer) {
      score += 2;
    }

    return score;
  }

  private async processCurrentFrame(
    viewer: HTMLElement,
    reason: string,
    force: boolean
  ): Promise<AnalysisResult | null> {
    const now = Date.now();
    const username = this.extractUsername(viewer);
    const signature = this.buildStorySignature(viewer, username);
    const isSameAsLast = signature === this.lastProcessedSignature;

    if (!force && isSameAsLast && now - this.lastProcessedAt < this.THROTTLE_MS) {
      return null;
    }
    if (
      !force &&
      isSameAsLast &&
      now - this.lastProcessedAt < this.DUPLICATE_WINDOW_MS
    ) {
      return null;
    }
    if (!force && this.wasRecentlyProcessed(signature, now)) {
      return null;
    }

    if (!force && !this.hasRenderableStoryContent(viewer)) {
      return null;
    }

    const sponsoredEvidence = this.getSponsoredEvidence(viewer);
    if (sponsoredEvidence) {
      this.markSignatureProcessed(signature, now);
      console.log("[Sentinel] Sponsored story skipped", {
        username,
        reason,
        evidence: sponsoredEvidence,
      });
      return null;
    }

    this.triggerAutoOcrSpike(signature, reason, force);

    this.isProcessing = true;
    const scanId = ++this.scanSequence;
    const startedAt = performance.now();

    try {
      const result = await this.pipeline.analyse(viewer, username);
      const elapsedMs = Math.round(performance.now() - startedAt);
      this.lastProcessedAt = now;
      this.lastProcessedSignature = signature;
      this.markSignatureProcessed(signature, now);

      console.log("[Sentinel] Story analysed", {
        scanId,
        reason,
        username: result.score.username,
        signature: signature.slice(0, 96),
        elapsedMs,
        composite: result.score.composite,
        text: result.score.textScore,
        image: result.score.imageScore,
        transmitted: result.transmitted,
        transmissionError: result.transmissionError,
      });

      return result;
    } catch (error) {
      console.warn("[Sentinel] Analysis error:", error);
      return null;
    } finally {
      this.isProcessing = false;
    }
  }

  private triggerAutoOcrSpike(
    signature: string,
    reason: string,
    force: boolean
  ): void {
    if (force || reason === "manual") {
      return;
    }

    if (signature === this.lastAutoOcrSpikeSignature) {
      return;
    }

    this.lastAutoOcrSpikeSignature = signature;
    document.dispatchEvent(new CustomEvent("sentinel:ocr-spike"));
    console.log("[Sentinel] Auto OCR spike triggered", {
      reason,
      signature: signature.slice(0, 96),
    });
  }

  private buildStorySignature(viewer: HTMLElement, username: string): string {
    const mediaSource = this.getPrimaryMediaSource(viewer);
    const routeKey = this.isStoryRouteActive() ? window.location.pathname : "";
    const textSignature = extractText(viewer)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);

    return `${username}|${routeKey}|${mediaSource}|${textSignature || ""}`;
  }

  private hasRenderableStoryContent(viewer: HTMLElement): boolean {
    if (findPrimaryStoryMedia(viewer) !== null) {
      return true;
    }

    return extractText(viewer).trim().length >= 2;
  }

  private getPrimaryMediaSource(viewer: HTMLElement): string {
    const media = findPrimaryStoryMedia(viewer);
    if (media instanceof HTMLImageElement && (media.currentSrc || media.src)) {
      return this.normalizeMediaSourceKey(media.currentSrc || media.src);
    }

    if (
      media instanceof HTMLVideoElement &&
      (media.currentSrc || media.src || media.poster)
    ) {
      return this.normalizeMediaSourceKey(
        media.currentSrc || media.src || media.poster
      );
    }

    return "no-media";
  }

  private normalizeMediaSourceKey(value: string): string {
    if (!value) {
      return "no-media";
    }

    try {
      const parsed = new URL(value, window.location.origin);
      return parsed.pathname || value;
    } catch {
      return value;
    }
  }

  private extractUsername(viewer: HTMLElement): string {
    const link = this.findUsernameLink(viewer);
    if (link) {
      const username = this.parseUsernameFromHref(link.getAttribute("href"));
      if (username) {
        return username;
      }
    }

    const routeUsername = this.parseUsernameFromStoryRoute();
    if (routeUsername) {
      return routeUsername;
    }

    const textCandidates = viewer.querySelectorAll(
      "header span, header a, span[dir='auto']"
    );
    for (const candidate of textCandidates) {
      const text = candidate.textContent?.trim();
      if (
        text &&
        /^[A-Za-z0-9._]{1,30}$/.test(text) &&
        !RESERVED_PATHS.has(text.toLowerCase())
      ) {
        return text;
      }
    }

    return "unknown_story";
  }

  private wasRecentlyProcessed(signature: string, now: number): boolean {
    this.pruneProcessedSignatures(now);
    const processedAt = this.processedSignatures.get(signature);
    return processedAt !== undefined && now - processedAt < this.SIGNATURE_TTL_MS;
  }

  private markSignatureProcessed(signature: string, now = Date.now()): void {
    this.lastProcessedAt = now;
    this.lastProcessedSignature = signature;
    this.processedSignatures.set(signature, now);
  }

  private pruneProcessedSignatures(now: number): void {
    for (const [signature, processedAt] of this.processedSignatures) {
      if (now - processedAt >= this.SIGNATURE_TTL_MS) {
        this.processedSignatures.delete(signature);
      }
    }
  }

  private isStoryRouteActive(): boolean {
    const segments = window.location.pathname.split("/").filter(Boolean);
    return segments[0]?.toLowerCase() === "stories";
  }

  private parseUsernameFromStoryRoute(): string | null {
    const segments = window.location.pathname.split("/").filter(Boolean);
    if (segments[0]?.toLowerCase() !== "stories") {
      return null;
    }

    return this.parseUsernameFromHref(`/${segments[1] ?? ""}/`);
  }

  private getSponsoredEvidence(viewer: HTMLElement): string | null {
    for (const root of this.getSponsoredScanRoots(viewer)) {
      const headerEvidence = this.findHeaderAdLabel(root);
      if (headerEvidence) {
        return headerEvidence;
      }

      const textEvidence = this.findSponsoredText(root);
      if (textEvidence) {
        return textEvidence;
      }

      const ctaEvidence = this.findSponsoredCta(root);
      if (ctaEvidence) {
        return ctaEvidence;
      }
    }

    return null;
  }

  private findHeaderAdLabel(root: HTMLElement): string | null {
    const selector = "header span, header div, header a";

    for (const el of root.querySelectorAll(selector)) {
      if (!(el instanceof HTMLElement)) {
        continue;
      }

      const text = el.textContent?.trim();
      if (
        text &&
        HEADER_AD_LABEL_PATTERNS.some((pattern) => pattern.test(text))
      ) {
        return text;
      }
    }

    return null;
  }

  private getSponsoredScanRoots(viewer: HTMLElement): HTMLElement[] {
    const roots: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();

    const addRoot = (root: HTMLElement | null) => {
      if (!root || seen.has(root)) {
        return;
      }
      seen.add(root);
      roots.push(root);
    };

    addRoot(viewer);

    let current: HTMLElement | null = viewer.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < 6) {
      addRoot(current);
      current = current.parentElement;
      depth += 1;
    }

    if (this.isStoryRouteActive()) {
      addRoot(document.querySelector("main"));
      addRoot(document.body);
    }

    return roots;
  }

  private findSponsoredText(root: HTMLElement): string | null {
    const selector =
      "span, div, a, button, [aria-label], [role='button'], [data-testid]";

    for (const el of root.querySelectorAll(selector)) {
      if (!(el instanceof HTMLElement)) {
        continue;
      }

      const candidates = [
        el.textContent?.trim(),
        el.getAttribute("aria-label")?.trim(),
      ].filter((value): value is string => Boolean(value));

      for (const candidate of candidates) {
        if (
          SPONSORED_LABEL_PATTERNS.some((pattern) => pattern.test(candidate))
        ) {
          return candidate;
        }
      }
    }

    return null;
  }

  private findSponsoredCta(root: HTMLElement): string | null {
    const selector = "a, button, [role='button']";

    for (const el of root.querySelectorAll(selector)) {
      if (!(el instanceof HTMLElement)) {
        continue;
      }

      const candidates = [
        el.textContent?.trim(),
        el.getAttribute("aria-label")?.trim(),
      ].filter((value): value is string => Boolean(value));

      for (const candidate of candidates) {
        if (SPONSORED_CTA_PATTERNS.some((pattern) => pattern.test(candidate))) {
          return candidate;
        }
      }
    }

    return null;
  }

  private isVisibleMedia(media: HTMLVideoElement | HTMLImageElement): boolean {
    const rect = media.getBoundingClientRect();
    if (rect.width < window.innerWidth * 0.25) {
      return false;
    }
    if (rect.height < window.innerHeight * 0.25) {
      return false;
    }

    if (media instanceof HTMLImageElement) {
      return media.complete && media.naturalWidth > 0;
    }

    return media.readyState >= 2;
  }

  private mediaArea(media: HTMLVideoElement | HTMLImageElement): number {
    const rect = media.getBoundingClientRect();
    return rect.width * rect.height;
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
