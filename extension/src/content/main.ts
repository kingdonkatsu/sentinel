import { AnalysisPipeline } from "./analysis-pipeline";
import { StoryDetector } from "./story-detector";

let detector: StoryDetector | null = null;

async function init() {
  if (detector) {
    return;
  }

  console.log("[Sentinel] Initialising on Instagram...");

  const pipeline = new AnalysisPipeline();
  await pipeline.init();

  detector = new StoryDetector(pipeline);
  detector.start();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "MANUAL_ANALYSE_STORY" || !detector) {
      return false;
    }

    void detector.analyseVisibleStory().then(sendResponse);
    return true;
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
