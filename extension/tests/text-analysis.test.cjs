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
  hasPassiveDeathIdeationSignal,
} = require("../.test-dist/content/analysers/distress-phrases.js");
const {
  similarityToConfidence,
} = require("../.test-dist/content/analysers/semantic-text-scoring.js");
const {
  BASE_WEIGHTS,
  CompositeScorer,
} = require("../.test-dist/content/scoring/composite-scorer.js");

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

test("passive death-ideation patterns catch tired-of-life phrasing without broad false positives", () => {
  assert.equal(hasPassiveDeathIdeationSignal("im just so tired of life"), true);
  assert.equal(hasPassiveDeathIdeationSignal("I'm tired of living"), true);
  assert.equal(hasPassiveDeathIdeationSignal("I'm done with my homework"), false);
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
  assert.ok(result.score > 65, `expected score > 65 for dissociation phrase, got ${result.score}`);
  assert.ok(result.confidence > 0.5);
});

test("dissociation multi-word patterns score above neutral on keyword path", () => {
  assert.ok(analyseText("sometimes i feel like a ghost") > 50, "feel like a ghost should score above neutral");
  assert.ok(analyseText("i don't feel real anymore") > 50, "don't feel real should score above neutral");
  assert.ok(analyseText("fading away from everyone") > 50, "fading away should score above neutral");
  assert.ok(analyseText("already a ghost") > 50, "already a ghost should score above neutral");
  assert.ok(analyseText("im just so tired of life") >= 65, "tired of life should score above mild distress");
});

test("dissociation single-word slang does not trigger false positives on keyword path", () => {
  assert.equal(analyseText("in ghost mode today"), 50, "ghost mode slang should be neutral");
  assert.equal(analyseText("invisible ink is a thing"), 50, "invisible ink should be neutral");
  assert.equal(analyseText("disappeared for a weekend trip"), 50, "disappeared for a weekend should be neutral");
  assert.equal(analyseText("that song just fades out"), 50, "fades out should be neutral");
});

test("positive caption stays at or below 55 on keyword path", () => {
  assert.ok(analyseText("Morning grind. No days off!") <= 55, "positive caption should not score high");
  assert.ok(analyseText("best day ever so grateful") <= 50, "positive caption should score neutral or below");
});

test("semantic text analyser floors passive death-ideation above low-60s outputs", async () => {
  const analyser = new SemanticTextAnalyser({
    ocrRunner: {
      async recognizeViewer() {
        return {
          status: "ok",
          text: "im just so tired of life",
          latencyMs: 84,
          confidence: 88,
          strategy: "lower-band-binary",
        };
      },
    },
    semanticScorer: {
      dispose() {},
      async scoreText() {
        return { maxSimilarity: 0.645 };
      },
    },
  });

  const result = await analyser.analyse({});

  assert.equal(result.available, true);
  assert.equal(result.status, "ok");
  assert.ok(result.score >= 72, `expected passive death-ideation floor, got ${result.score}`);
});

test("composite scorer excludes zero-weight modalities from overall confidence", () => {
  const scorer = new CompositeScorer();
  const result = scorer.fuse(
    [
      { modality: "text", score: 61, confidence: 0.776, available: true, inferenceTimeMs: 0 },
      { modality: "temporal", score: 50, confidence: 0, available: true, inferenceTimeMs: 0 },
      { modality: "metadata", score: 50, confidence: 0.5, available: true, inferenceTimeMs: 0 },
    ],
    BASE_WEIGHTS
  );

  assert.ok(result.overallConfidence > 0.7, `expected contributing-modality confidence, got ${result.overallConfidence}`);
  assert.equal(result.composite, 60);
});
