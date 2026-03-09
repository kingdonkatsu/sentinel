const test = require("node:test");
const assert = require("node:assert/strict");

const { AnalysisPipeline } = require("../.test-dist/content/analysis-pipeline.js");
const {
  BASE_WEIGHTS,
} = require("../.test-dist/content/scoring/composite-scorer.js");

test("video stories share the captured first frame and sequence visual before video", async () => {
  const callOrder = [];
  let captureCount = 0;

  const pipeline = new AnalysisPipeline({
    overlay: { show() {}, dismiss() {} },
    transmitter: {
      async init() {},
      async send() {
        return { ok: true };
      },
    },
    textAnalyser: {
      async analyse() {
        return makeResult("text", 55, 0.7);
      },
      dispose() {},
    },
    temporalAnalyser: {
      setUsername() {},
      async analyse() {
        return makeResult("temporal", 50, 0.5);
      },
      async record() {},
      dispose() {},
    },
    metadataAnalyser: {
      async analyse() {
        return makeResult("metadata", 52, 0.5);
      },
      dispose() {},
    },
    visualAnalyser: {
      async analyse() {
        callOrder.push("visual-fallback");
        return makeResult("visual", 10, 0.1);
      },
      async scoreCapturedFrame(imageData) {
        callOrder.push(`visual:${imageData.data[0]}`);
        return { score: imageData.data[0], confidence: 0.8 };
      },
      dispose() {},
    },
    videoAnalyser: {
      isAvailable() {
        return true;
      },
      async analyse(_viewer, seed) {
        callOrder.push(`video:${seed.initialTime}:${seed.initialFrame.data[0]}`);
        return makeResult("video", 70, 0.7);
      },
      dispose() {},
    },
    weightCalibrator: {
      async load() {},
      getWeights() {
        return BASE_WEIGHTS;
      },
    },
    memoryMonitor: {
      startMonitoring() {},
      stopMonitoring() {},
    },
    async captureStoryImage() {
      captureCount += 1;
      return makeImageData(64, 0.5);
    },
  });

  const viewer = {
    querySelector(selector) {
      if (selector === "video") {
        return { currentTime: 12 };
      }
      return null;
    },
  };

  const result = await pipeline.analyse(viewer, "alice");

  assert.equal(captureCount, 1);
  assert.deepEqual(callOrder, ["visual:64", "video:12:64"]);
  assert.equal(result.transmitted, true);
  assert.equal(result.modalityResults.find((entry) => entry.modality === "visual").score, 64);
  assert.equal(result.modalityResults.find((entry) => entry.modality === "video").score, 70);
});

function makeResult(modality, score, confidence) {
  return {
    modality,
    score,
    confidence,
    available: true,
    inferenceTimeMs: 0,
  };
}

function makeImageData(score, confidence) {
  return {
    data: new Uint8ClampedArray([score, Math.round(confidence * 100), 0, 255]),
    width: 1,
    height: 1,
  };
}
