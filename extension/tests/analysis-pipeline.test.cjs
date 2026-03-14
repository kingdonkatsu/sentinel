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

test("pipeline transmits text score only when text modality is available", async () => {
  let transmittedScores = null;

  const pipeline = new AnalysisPipeline({
    overlay: { show() {}, dismiss() {} },
    transmitter: {
      async init() {},
      async send(_score, modalityScores) {
        transmittedScores = modalityScores;
        return { ok: true };
      },
    },
    textAnalyser: {
      async analyse() {
        return makeResult("text", 88, 0.8, {
          status: "ok",
        });
      },
      dispose() {},
    },
    temporalAnalyser: makeStaticAnalyser("temporal", 50, 0.5),
    metadataAnalyser: makeStaticAnalyser("metadata", 52, 0.5),
    visualAnalyser: makeVisualAnalyser(48, 0.5),
    videoAnalyser: makeVideoUnavailable(),
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
      return null;
    },
  });

  await pipeline.analyse({}, "alice");

  assert.equal(typeof transmittedScores.text, "number");
  assert.equal(transmittedScores.text, 88);
});

test("pipeline keeps missing text out of transmitted modality scores", async () => {
  let transmittedScores = null;

  const pipeline = new AnalysisPipeline({
    overlay: { show() {}, dismiss() {} },
    transmitter: {
      async init() {},
      async send(_score, modalityScores) {
        transmittedScores = modalityScores;
        return { ok: true };
      },
    },
    textAnalyser: {
      async analyse() {
        return makeResult("text", 50, 0, {
          available: false,
          status: "missing",
        });
      },
      dispose() {},
    },
    temporalAnalyser: makeStaticAnalyser("temporal", 50, 0.5),
    metadataAnalyser: makeStaticAnalyser("metadata", 52, 0.5),
    visualAnalyser: makeVisualAnalyser(48, 0.5),
    videoAnalyser: makeVideoUnavailable(),
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
      return null;
    },
  });

  const result = await pipeline.analyse({}, "alice");
  const textResult = result.modalityResults.find((entry) => entry.modality === "text");

  assert.equal(textResult.available, false);
  assert.equal(textResult.status, "missing");
  assert.equal("text" in transmittedScores, false);
});

test("pipeline survives uncertain text and still transmits other modalities", async () => {
  let transmittedScores = null;

  const pipeline = new AnalysisPipeline({
    overlay: { show() {}, dismiss() {} },
    transmitter: {
      async init() {},
      async send(_score, modalityScores) {
        transmittedScores = modalityScores;
        return { ok: true };
      },
    },
    textAnalyser: {
      async analyse() {
        return makeResult("text", 50, 0, {
          available: false,
          status: "uncertain",
        });
      },
      dispose() {},
    },
    temporalAnalyser: makeStaticAnalyser("temporal", 72, 0.7),
    metadataAnalyser: makeStaticAnalyser("metadata", 52, 0.5),
    visualAnalyser: makeVisualAnalyser(81, 0.8),
    videoAnalyser: makeVideoUnavailable(),
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
      return null;
    },
  });

  const result = await pipeline.analyse({}, "alice");
  const textResult = result.modalityResults.find((entry) => entry.modality === "text");

  assert.equal(result.transmitted, true);
  assert.equal(textResult.available, false);
  assert.equal(textResult.status, "uncertain");
  assert.equal("text" in transmittedScores, false);
  assert.equal(typeof transmittedScores.visual, "number");
  assert.equal(typeof transmittedScores.temporal, "number");
});

function makeResult(modality, score, confidence, overrides = {}) {
  return {
    modality,
    score,
    confidence,
    available: true,
    inferenceTimeMs: 0,
    ...overrides,
  };
}

function makeImageData(score, confidence) {
  return {
    data: new Uint8ClampedArray([score, Math.round(confidence * 100), 0, 255]),
    width: 1,
    height: 1,
  };
}

function makeStaticAnalyser(modality, score, confidence) {
  return {
    setUsername() {},
    async analyse() {
      return makeResult(modality, score, confidence);
    },
    async record() {},
    dispose() {},
  };
}

function makeVisualAnalyser(score, confidence) {
  return {
    async analyse() {
      return makeResult("visual", score, confidence);
    },
    async scoreCapturedFrame() {
      return { score, confidence };
    },
    dispose() {},
  };
}

function makeVideoUnavailable() {
  return {
    isAvailable() {
      return false;
    },
    async analyse() {
      throw new Error("video analyser should not run");
    },
    dispose() {},
  };
}
