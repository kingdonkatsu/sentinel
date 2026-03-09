const test = require("node:test");
const assert = require("node:assert/strict");

const { analyseText } = require("../.test-dist/content/text-analyser.js");
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
