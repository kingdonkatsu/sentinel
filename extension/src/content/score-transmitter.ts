import type { RiskScore } from "../shared/types";

export class ScoreTransmitter {
  private apiUrl: string = "";
  private apiKey: string = "";
  private initialized = false;

  async init(): Promise<void> {
    const config = await chrome.storage.local.get([
      "sentinel_api_url",
      "sentinel_api_key",
    ]);
    this.apiUrl = config.sentinel_api_url || "http://localhost:8000";
    this.apiKey = config.sentinel_api_key || "sentinel-hackathon-key";
    this.initialized = true;
  }

  async send(score: RiskScore): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }

    if (!this.apiKey) return;

    try {
      await fetch(`${this.apiUrl}/api/v1/scores`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sentinel-Key": this.apiKey,
        },
        body: JSON.stringify({
          username: score.username,
          composite_score: score.composite,
          text_score: score.textScore,
          image_score: score.imageScore,
          timestamp: score.timestamp,
        }),
      });
    } catch (err) {
      console.warn("[Sentinel] Score transmission failed:", err);
    }
  }
}
