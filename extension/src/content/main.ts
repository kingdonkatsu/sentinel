import { AnalysisPipeline } from "./analysis-pipeline";
import { StoryDetector } from "./story-detector";

async function init() {
  console.log("[Sentinel] Initialising on Instagram...");

  const pipeline = new AnalysisPipeline();
  await pipeline.init();

  const detector = new StoryDetector(pipeline);
  detector.start();

  console.log("[Sentinel] Ready — monitoring Story viewer for content analysis");
}

// Wait for page to be ready
if (document.readyState === "complete") {
  init();
} else {
  window.addEventListener("load", init);
}
