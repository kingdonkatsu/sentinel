/**
 * Contextual metadata analyser.
 *
 * Extracts platform-level signals from the Instagram Story DOM without
 * analysing any media content. No model required — purely DOM scraping.
 *
 * Signals extracted:
 *   - Close-friends-only story indicator (clinically more significant)
 *   - Reply disabled (social withdrawal signal)
 *   - Music/sticker overlays (mood correlates)
 *   - Story filter/effect presence (aesthetic mood signal)
 *   - Mention count (social isolation if zero in context)
 *   - Posting time (late-night 00:00–05:00 = elevated risk multiplier)
 *
 * Confidence is always 0.5 — this modality provides supplementary context
 * only and should never dominate the composite score.
 */

import type { Analyser, ModalityResult } from "../../shared/types";

interface MetadataSignals {
  isCloseFriends: boolean;
  isReplyDisabled: boolean;
  hasMusicOverlay: boolean;
  hasFilterEffect: boolean;
  mentionCount: number;
  isLateNightPost: boolean;
  emojiOnlyText: boolean;
}

export class MetadataAnalyser implements Analyser {
  readonly modality = "metadata" as const;

  isAvailable(_viewer: HTMLElement): boolean {
    return true; // metadata analysis is always attempted
  }

  async analyse(viewer: HTMLElement): Promise<ModalityResult> {
    const t0 = performance.now();
    const signals = this.extractSignals(viewer);
    const score = this.computeScore(signals);

    return {
      modality: "metadata",
      score,
      confidence: 0.5,
      available: true,
      inferenceTimeMs: performance.now() - t0,
    };
  }

  private extractSignals(viewer: HTMLElement): MetadataSignals {
    return {
      isCloseFriends: this.detectCloseFriends(viewer),
      isReplyDisabled: this.detectReplyDisabled(viewer),
      hasMusicOverlay: this.detectMusicOverlay(viewer),
      hasFilterEffect: this.detectFilterEffect(viewer),
      mentionCount: this.countMentions(viewer),
      isLateNightPost: this.isLateNight(),
      emojiOnlyText: this.isEmojiOnly(viewer),
    };
  }

  private computeScore(s: MetadataSignals): number {
    let score = 50; // neutral baseline

    // Close-friends stories with distress content are clinically more significant
    if (s.isCloseFriends) score += 10;

    // Disabling replies is a social withdrawal signal
    if (s.isReplyDisabled) score += 8;

    // Late-night posting correlates with insomnia and acute distress
    if (s.isLateNightPost) score += 12;

    // Music overlays often signal emotional processing (positive or negative)
    // Slight positive nudge toward risk as it indicates emotional content
    if (s.hasMusicOverlay) score += 3;

    // Filter/effect usage can indicate mood-alteration intent — small signal
    if (s.hasFilterEffect) score += 2;

    // Emoji-only text is ambiguous (could be distress or joy)
    // Slight upward nudge since it avoids direct expression
    if (s.emojiOnlyText) score += 5;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // ─── Signal detectors ────────────────────────────────────────────────────

  private detectCloseFriends(viewer: HTMLElement): boolean {
    // Instagram renders a green ring around close-friends stories
    const greenRing = viewer.querySelector(
      '[style*="rgb(74, 230, 140)"], [style*="#4AE68C"], [aria-label*="Close Friends"]'
    );
    if (greenRing) return true;

    // Look for text cues in accessible labels
    const allLabels = Array.from(viewer.querySelectorAll("[aria-label]")).map(
      (el) => (el as HTMLElement).getAttribute("aria-label")?.toLowerCase() ?? ""
    );
    return allLabels.some(
      (l) => l.includes("close friends") || l.includes("green ring")
    );
  }

  private detectReplyDisabled(viewer: HTMLElement): boolean {
    // Treat reply-disabled as an explicit signal only. Many story variants
    // simply omit the composer, and assuming that means "disabled" is noisy.
    const replyArea = viewer.querySelector(
      '[data-testid="reply-composer"], [aria-label*="Reply"], input[placeholder*="Reply"], textarea[placeholder*="Reply"]'
    );
    if (
      replyArea instanceof HTMLElement &&
      replyArea.getAttribute("aria-disabled") === "true"
    ) {
      return true;
    }

    const textContent = viewer.textContent?.toLowerCase() ?? "";
    return (
      textContent.includes("replies are turned off") ||
      textContent.includes("cannot reply to this story")
    );
  }

  private detectMusicOverlay(viewer: HTMLElement): boolean {
    // Instagram renders a music sticker with a spinning disc animation
    const musicSticker = viewer.querySelector(
      '[data-testid*="music"], [aria-label*="music"], [aria-label*="song"], [class*="music"]'
    );
    if (musicSticker) return true;

    // Spinning animation element often indicates music sticker
    const spinners = viewer.querySelectorAll('[style*="animation"]');
    return Array.from(spinners).some((el) => {
      const style = (el as HTMLElement).style.animation;
      return style.includes("rotate") || style.includes("spin");
    });
  }

  private detectFilterEffect(viewer: HTMLElement): boolean {
    // Instagram shows filter name in a small overlay text
    const filterLabel = viewer.querySelector(
      '[data-testid*="filter"], [aria-label*="filter"], [aria-label*="effect"]'
    );
    return filterLabel !== null;
  }

  private countMentions(viewer: HTMLElement): number {
    const textContent = viewer.textContent ?? "";
    const matches = textContent.match(/@[\w.]+/g);
    return matches ? matches.length : 0;
  }

  private isLateNight(): boolean {
    const hour = new Date().getHours();
    return hour >= 0 && hour < 5;
  }

  private isEmojiOnly(viewer: HTMLElement): boolean {
    const textElements = viewer.querySelectorAll(
      'span[dir="auto"], div[dir="auto"]'
    );
    const texts = Array.from(textElements)
      .map((el) => el.textContent?.trim() ?? "")
      .filter((t) => t.length > 0);

    if (texts.length === 0) return false;

    const combined = texts.join("").replace(/\s/g, "");
    if (combined.length === 0) return false;

    // Remove emoji code points — if nothing remains, it's emoji-only
    const withoutEmoji = combined.replace(
      /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FEFF}]/gu,
      ""
    );
    return withoutEmoji.length === 0;
  }

  dispose(): void {
    // No models to release
  }
}
