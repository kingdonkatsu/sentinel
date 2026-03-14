const test = require("node:test");
const assert = require("node:assert/strict");

const { analyseText } = require("../.test-dist/content/text-analyser.js");
const {
  mapOcrFailure,
  mapOcrHostSuccess,
} = require("../.test-dist/content/ocr/story-ocr.js");
const {
  SemanticTextAnalyser,
} = require("../.test-dist/content/analysers/semantic-text-analyser.js");
const {
  hasUrgencySignal,
} = require("../.test-dist/content/analysers/distress-phrases.js");
const {
  similarityToConfidence,
} = require("../.test-dist/content/analysers/semantic-text-scoring.js");

test("keyword analysis uses word and phrase boundaries", () => {
  assert.equal(analyseText("skill issue"), 50);
  assert.equal(analyseText("killer playlist"), 50);
  assert.equal(analyseText("diet starts Monday"), 50);
  assert.equal(analyseText("diesel jeans"), 50);
  assert.equal(analyseText("audience"), 50);
  assert.ok(analyseText("I want to die") > 50);
});

test("urgency patterns avoid broad today-done matches", () => {
  assert.equal(hasUrgencySignal("today I'm done with my homework"), false);
  assert.equal(hasUrgencySignal("I'm going to end it tonight"), true);
});

test("semantic confidence is continuous across similarity values", () => {
  assert.equal(similarityToConfidence(0.3), 0.5);
  assert.equal(similarityToConfidence(0.55), 0.7);
  assert.equal(similarityToConfidence(0.8), 0.9);
});

test("story OCR maps usable text to ok", () => {
  const result = mapOcrHostSuccess(
    {
      captureHeight: 1920,
      captureWidth: 1080,
      confidence: 81,
      confidentWordCount: 5,
      sourceHeight: 1920,
      sourceWidth: 1080,
      strategy: "lower-band-binary",
      text: " Morning   grind. No days off! ",
      totalWordCount: 6,
    },
    812
  );

  assert.equal(result.status, "ok");
  assert.equal(result.text, "Morning grind. No days off!");
  assert.equal(result.latencyMs, 812);
});

test("story OCR maps empty and garbage text to no_text", () => {
  const empty = mapOcrHostSuccess(
    {
      captureHeight: 1920,
      captureWidth: 1080,
      confidence: 0,
      confidentWordCount: 0,
      sourceHeight: 1920,
      sourceWidth: 1080,
      strategy: "no-text-short-circuit",
      text: "",
      totalWordCount: 0,
    },
    120
  );
  const garbage = mapOcrHostSuccess(
    {
      captureHeight: 1920,
      captureWidth: 1080,
      confidence: 33,
      confidentWordCount: 1,
      sourceHeight: 1920,
      sourceWidth: 1080,
      strategy: "mid-band-binary",
      text: "j py pos wy M 4",
      totalWordCount: 12,
    },
    642
  );

  assert.equal(empty.status, "no_text");
  assert.equal(garbage.status, "no_text");
});

test("story OCR maps timeout outcomes distinctly from generic errors", () => {
  const timeoutFromHost = mapOcrHostSuccess(
    {
      captureHeight: 1920,
      captureWidth: 1080,
      confidence: null,
      confidentWordCount: 0,
      sourceHeight: 1920,
      sourceWidth: 1080,
      strategy: "no-text-timeout",
      text: "",
      totalWordCount: 0,
    },
    3001
  );
  const timeoutFromFailure = mapOcrFailure(
    new Error("OCR timed out after 3000ms"),
    3000
  );
  const genericFailure = mapOcrFailure(new Error("Media fetch failed"), 44);

  assert.equal(timeoutFromHost.status, "timeout");
  assert.equal(timeoutFromFailure.status, "timeout");
  assert.equal(genericFailure.status, "error");
});

test("semantic text analyser maps OCR statuses and scores OCR text locally", async () => {
  const okAnalyser = new SemanticTextAnalyser({
    ocrRunner: {
      async recognizeViewer() {
        return {
          status: "ok",
          text: "I want to die",
          latencyMs: 94,
          confidence: 82,
          strategy: "lower-band-binary",
        };
      },
    },
    semanticScorer: {
      dispose() {},
      async scoreText() {
        return { maxSimilarity: 0.78 };
      },
    },
  });
  const noTextAnalyser = new SemanticTextAnalyser({
    ocrRunner: {
      async recognizeViewer() {
        return { status: "no_text", latencyMs: 51 };
      },
    },
  });
  const timeoutAnalyser = new SemanticTextAnalyser({
    ocrRunner: {
      async recognizeViewer() {
        return { status: "timeout", latencyMs: 3000, error: "OCR timed out" };
      },
    },
  });
  const errorAnalyser = new SemanticTextAnalyser({
    ocrRunner: {
      async recognizeViewer() {
        return { status: "error", latencyMs: 12, error: "Failed to fetch" };
      },
    },
  });

  const okResult = await okAnalyser.analyse({});
  const noTextResult = await noTextAnalyser.analyse({});
  const timeoutResult = await timeoutAnalyser.analyse({});
  const errorResult = await errorAnalyser.analyse({});

  assert.equal(okResult.available, true);
  assert.equal(okResult.status, "ok");
  assert.ok(okResult.score > 50);

  assert.equal(noTextResult.available, false);
  assert.equal(noTextResult.status, "missing");
  assert.equal(noTextResult.score, 50);

  assert.equal(timeoutResult.available, false);
  assert.equal(timeoutResult.status, "uncertain");
  assert.equal(timeoutResult.score, 50);

  assert.equal(errorResult.available, false);
  assert.equal(errorResult.status, "uncertain");
  assert.equal(errorResult.score, 50);
});

test("semantic text analyser uses the semantic scorer for neutral OCR text", async () => {
  let semanticCalls = 0;

  const analyser = new SemanticTextAnalyser({
    ocrRunner: {
      async recognizeViewer() {
        return {
          status: "ok",
          text: "Sometimes I feel like I'm already a ghost.",
          latencyMs: 101,
          confidence: 93,
          strategy: "mid-band-binary",
        };
      },
    },
    semanticScorer: {
      dispose() {},
      async scoreText(text) {
        semanticCalls += 1;
        assert.equal(text, "Sometimes I feel like I'm already a ghost.");
        return { maxSimilarity: 0.82 };
      },
    },
  });

  const result = await analyser.analyse({});

  assert.equal(semanticCalls, 1);
  assert.equal(result.available, true);
  assert.equal(result.status, "ok");
  assert.ok(result.score > 50);
  assert.ok(result.confidence > 0.5);
});
