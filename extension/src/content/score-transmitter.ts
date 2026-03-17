import type { ModalityType, RiskScore, TransmissionResult } from "../shared/types";

export class ScoreTransmitter {
  private initialized = false;

  async init(): Promise<void> {
    this.initialized = true;
  }

  async send(
    score: RiskScore,
    modalityScores?: Partial<Record<ModalityType, number>>
  ): Promise<TransmissionResult> {
    if (!this.initialized) {
      await this.init();
    }

    try {
      const result = (await chrome.runtime.sendMessage({
        type: "SUBMIT_SCORE",
        score,
        modalityScores,
      })) as TransmissionResult;

      if (!result?.ok) {
        const error = result?.error || "Unknown transmission failure";
        console.warn("[Sentinel] Score transmission failed:", error);
      }

      return result || { ok: false, error: "No response from service worker" };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Score transmission failed";
      console.warn("[Sentinel] Score transmission failed:", message);
      return { ok: false, error: message };
    }
  }
}
