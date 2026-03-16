"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const analysis_pipeline_1 = require("./analysis-pipeline");
const ocr_spike_1 = require("./dev/ocr-spike");
const story_detector_1 = require("./story-detector");
const weight_calibrator_1 = require("./scoring/weight-calibrator");
let detector = null;
async function init() {
    if (detector) {
        return;
    }
    console.log("[Sentinel] Build stamp:", __SENTINEL_BUILD_STAMP__);
    console.log("[Sentinel] Initialising on Instagram...");
    const pipeline = new analysis_pipeline_1.AnalysisPipeline();
    await pipeline.init();
    detector = new story_detector_1.StoryDetector(pipeline);
    detector.start();
    (0, ocr_spike_1.initOcrSpike)();
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || typeof message !== "object" || !("type" in message)) {
            return false;
        }
        switch (message.type) {
            case "MANUAL_ANALYSE_STORY": {
                if (!detector)
                    return false;
                void detector.analyseVisibleStory().then(sendResponse);
                return true;
            }
            case "CALIBRATION_CONFIRM": {
                // Service worker forwarded a confirmed case — update weight calibrator
                const msg = message;
                if (msg.modalityScores) {
                    void weight_calibrator_1.weightCalibrator.recordConfirmed(msg.modalityScores);
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
}
else {
    window.addEventListener("load", () => {
        void init();
    });
}
