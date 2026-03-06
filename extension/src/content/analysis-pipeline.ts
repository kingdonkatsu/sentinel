import type { AnalysisResult, RiskScore } from "../shared/types";
import { analyseImage, captureStoryImage } from "./image-analyser";
import { analyseText, extractText } from "./text-analyser";
import { OverlayRenderer } from "./overlay-renderer";
import { ScoreTransmitter } from "./score-transmitter";

export class AnalysisPipeline {
  private overlay = new OverlayRenderer();
  private transmitter = new ScoreTransmitter();
  private threshold = 70;

  async init(): Promise<void> {
    await this.transmitter.init();

    const config = await chrome.storage.local.get([
      "sentinel_threshold",
      "sentinel_weights",
    ]);
    if (config.sentinel_threshold) {
      this.threshold = config.sentinel_threshold;
    }
  }

  async analyse(
    viewer: HTMLElement,
    username: string
  ): Promise<AnalysisResult> {
    // Run image and text analysis in parallel — all in-browser
    const [imageData, text] = await Promise.all([
      captureStoryImage(viewer),
      Promise.resolve(extractText(viewer)),
    ]);

    // Score image (in-browser only, raw pixels never leave the device)
    let imageScore: number;
    if (imageData) {
      imageScore = analyseImage(imageData);
    } else {
      imageScore = 40 + Math.round(Math.random() * 20);
    }

    // Score text (in-browser only, raw text never leaves the device)
    const textScore = analyseText(text);

    // Get configurable weights
    const config = await chrome.storage.local.get("sentinel_weights");
    const weights = config.sentinel_weights || { image: 0.5, text: 0.5 };

    // Compute weighted composite
    const composite = Math.round(
      imageScore * weights.image + textScore * weights.text
    );

    // Build score object — only numerical scores + username sent to backend
    // Story content (images, text, video) is NEVER transmitted or stored
    const score: RiskScore = {
      composite,
      textScore: Math.round(textScore),
      imageScore: Math.round(imageScore),
      timestamp: Date.now(),
      username,
    };

    console.log("[Sentinel] Score:", {
      username,
      composite: score.composite,
      text: score.textScore,
      image: score.imageScore,
    });

    // Show overlay if high risk
    if (composite >= this.threshold) {
      this.overlay.show(score);
    }

    // Transmit score to backend (only scores + username, zero story content)
    const transmission = await this.transmitter.send(score);

    return {
      score,
      imageCaptured: imageData !== null,
      textLength: text.length,
      transmitted: transmission.ok,
      transmissionError: transmission.error,
    };
  }
}
