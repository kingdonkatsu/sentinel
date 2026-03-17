const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractVisualContextCues,
  applyVisualContextCues,
} = require("../.test-dist/content/analysers/visual-context-cues.js");

test("blood-like context cue boosts visual score", () => {
  const image = createUniformImage(224, 224, 68, 66, 64);

  paintRect(image, 28, 36, 96, 72, 124, 22, 22);
  paintRect(image, 118, 110, 64, 58, 132, 28, 24);

  const cues = extractVisualContextCues(image);
  assert.equal(cues.bloodLike, true);
  assert.ok(cues.scoreBoost >= 7);

  const adjusted = applyVisualContextCues(42, 0.3, cues);
  assert.ok(adjusted.score > 42);
  assert.ok(adjusted.confidence > 0.3);
});

test("medical-setting cue is detected on cool bright scene", () => {
  const image = createUniformImage(224, 224, 196, 214, 228);
  const cues = extractVisualContextCues(image);
  assert.equal(cues.medicalSettingLike, true);
  assert.ok(cues.scoreBoost >= 4);
});

test("pill-like cue is detected on clustered bright micro-objects", () => {
  const image = createUniformImage(224, 224, 72, 72, 72);

  for (let y = 10; y < 214; y += 8) {
    for (let x = 8; x < 214; x += 8) {
      paintRect(image, x, y, 2, 2, 246, 246, 246);
    }
  }

  const cues = extractVisualContextCues(image);
  assert.equal(cues.pillLike, true);
  assert.ok(cues.reasons.length >= 1);
});

function createUniformImage(width, height, red, green, blue) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = red;
    data[i + 1] = green;
    data[i + 2] = blue;
    data[i + 3] = 255;
  }

  return { data, width, height };
}

function paintRect(image, x, y, width, height, red, green, blue) {
  for (let oy = 0; oy < height; oy += 1) {
    for (let ox = 0; ox < width; ox += 1) {
      const px = x + ox;
      const py = y + oy;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) {
        continue;
      }
      const index = (py * image.width + px) * 4;
      image.data[index] = red;
      image.data[index + 1] = green;
      image.data[index + 2] = blue;
      image.data[index + 3] = 255;
    }
  }
}
