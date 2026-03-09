const test = require("node:test");
const assert = require("node:assert/strict");

const {
  VideoAnalyser,
  aggregateFrameResults,
} = require("../.test-dist/content/analysers/video-analyser.js");

test("frame aggregation uses the median instead of the maximum", () => {
  const aggregate = aggregateFrameResults([
    { score: 30, confidence: 0.4 },
    { score: 95, confidence: 0.9 },
    { score: 32, confidence: 0.6 },
  ]);

  assert.equal(aggregate.score, 32);
  assert.equal(aggregate.confidence, 0.6);
});

test("video analyser reuses the seeded first frame and only captures later frames", async () => {
  const captureTimes = [];
  const scorer = {
    async scoreCapturedFrame(imageData) {
      return {
        score: imageData.data[0],
        confidence: imageData.data[1] / 100,
      };
    },
    dispose() {},
  };
  const analyser = new VideoAnalyser(
    (video) => {
      captureTimes.push(video.currentTime);
      if (Math.abs(video.currentTime - 1.5) < 0.01) {
        return makeImageData(90, 0.9);
      }
      return makeImageData(20, 0.6);
    },
    scorer
  );

  const video = createFakeVideo(1);
  const viewer = {
    querySelector(selector) {
      return selector === "video" ? video : null;
    },
  };

  const result = await analyser.analyse(viewer, {
    initialTime: 1,
    initialFrame: makeImageData(10, 0.4),
  });

  assert.equal(result.score, 20);
  assert.equal(result.confidence, 0.6);
  assert.deepEqual(captureTimes, [1.5, 2.5]);
});

function makeImageData(score, confidence) {
  return {
    data: new Uint8ClampedArray([score, Math.round(confidence * 100), 0, 255]),
    width: 1,
    height: 1,
  };
}

function createFakeVideo(initialTime) {
  let currentTime = initialTime;
  let seekedHandler = null;

  return {
    readyState: 2,
    duration: 4,
    paused: false,
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    addEventListener(type, handler) {
      if (type === "seeked") {
        seekedHandler = handler;
      }
    },
    removeEventListener(type, handler) {
      if (type === "seeked" && seekedHandler === handler) {
        seekedHandler = null;
      }
    },
    get currentTime() {
      return currentTime;
    },
    set currentTime(value) {
      currentTime = value;
      if (seekedHandler) {
        const handler = seekedHandler;
        setImmediate(() => {
          if (handler) {
            handler();
          }
        });
      }
    },
  };
}
