const test = require("node:test");
const assert = require("node:assert/strict");

const { analyseText } = require("../.test-dist/content/text-analyser.js");
const {
  hasUrgencySignal,
} = require("../.test-dist/content/analysers/distress-phrases.js");
const {
  similarityToConfidence,
} = require("../.test-dist/content/analysers/semantic-text-scoring.js");
const {
  extractTextContextCues,
  applyTextContextCues,
} = require("../.test-dist/content/analysers/text-context-cues.js");

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

test("context cues lift explicit self-harm with stressor context", () => {
  const text =
    "I got 43% on my exam, I'm so stupid, maybe I should kill myself";
  const cues = extractTextContextCues(text);
  assert.equal(cues.explicitSelfHarm, true);
  assert.equal(cues.selfDeprecation, true);
  assert.equal(cues.academicStress, true);
  assert.equal(cues.lowAcademicPerformance, true);

  const adjusted = applyTextContextCues(72, 0.7, cues);
  assert.ok(adjusted.score >= 90);
  assert.ok(adjusted.confidence > 0.8);
});

test("low-performance parsing supports fractions and percentages", () => {
  const percentCues = extractTextContextCues("failed my test, got 43% today");
  assert.equal(percentCues.lowAcademicPerformance, true);

  const fractionCues = extractTextContextCues("results came back: 15/35 for finals");
  assert.equal(fractionCues.lowAcademicPerformance, true);
});
