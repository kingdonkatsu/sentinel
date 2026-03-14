import type { ModalityType } from "../shared/types";
import { AnalysisPipeline } from "./analysis-pipeline";
import { DevOcrSpike } from "./dev/ocr-spike";
import { StoryDetector } from "./story-detector";
import { weightCalibrator } from "./scoring/weight-calibrator";

let detector: StoryDetector | null = null;
let devOcrSpike: DevOcrSpike | null = null;

async function init() {
  if (detector) {
    return;
  }

  console.log("[Sentinel] Initialising on Instagram...");

  const pipeline = new AnalysisPipeline();
  await pipeline.init();

  detector = new StoryDetector(pipeline);
  detector.start();

  devOcrSpike = new DevOcrSpike({
    getViewer: () => detector?.getVisibleStoryViewer() ?? null,
  });
  devOcrSpike.start();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object" || !("type" in message)) {
      return false;
    }

    switch ((message as { type: unknown }).type) {
      case "MANUAL_ANALYSE_STORY": {
        if (!detector) return false;
        void detector.analyseVisibleStory().then(sendResponse);
        return true;
      }

      case "CALIBRATION_CONFIRM": {
        // Service worker forwarded a confirmed case — update weight calibrator
        const msg = message as {
          type: string;
          modalityScores?: Partial<Record<ModalityType, number>>;
        };
        if (msg.modalityScores) {
          void weightCalibrator.recordConfirmed(msg.modalityScores);
        }
        sendResponse({ ok: true });
        return false;
      }

      default:
        return false;
    }
  });

  console.log("[Sentinel] Ready - monitoring Story viewer for content analysis");
}

if (document.readyState === "complete") {
  void init();
} else {
  window.addEventListener("load", () => {
    void init();
  });
}
