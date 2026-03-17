const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyseImage,
  analyseImageDetailed,
} = require("../.test-dist/content/image-analyser.js");

test("scene-cue heuristic scores fractured texture above smooth texture", () => {
  const smooth = createUniformImage(224, 224, 120, 120, 120);
  const fractured = createFracturedImage(224, 224);

  const smoothScore = analyseImageDetailed(smooth).score;
  const fracturedScore = analyseImageDetailed(fractured).score;

  assert.ok(
    fracturedScore >= smoothScore + 8,
    `expected fractured (${fracturedScore}) to exceed smooth (${smoothScore})`
  );
});

test("active analyseImage path stays close to the original tone-only heuristic", () => {
  const smooth = createUniformImage(224, 224, 120, 120, 120);
  const fractured = createFracturedImage(224, 224);

  const smoothActive = analyseImage(smooth);
  const fracturedActive = analyseImage(fractured);
  const smoothShadow = analyseImageDetailed(smooth).score;
  const fracturedShadow = analyseImageDetailed(fractured).score;

  assert.ok(
    fracturedShadow - smoothShadow >= 8,
    `expected shadow separation (${fracturedShadow - smoothShadow}) to be material`
  );
  assert.ok(
    fracturedActive - smoothActive < fracturedShadow - smoothShadow,
    `expected active separation (${fracturedActive - smoothActive}) to stay below shadow separation (${fracturedShadow - smoothShadow})`
  );
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

function createFracturedImage(width, height) {
  const image = createUniformImage(width, height, 112, 108, 104);
  const { data } = image;

  for (let x = 0; x < width; x += 1) {
    const y1 = (x * 3 + 17) % height;
    const y2 = (x * 5 + 83) % height;
    paintPixel(data, width, x, y1, 26, 24, 22);
    paintPixel(data, width, x, y2, 32, 28, 26);
  }

  for (let y = 10; y < height - 10; y += 14) {
    for (let x = 8; x < width - 8; x += 19) {
      const darkPatch = ((x + y) / 7) % 2 < 1;
      for (let oy = 0; oy < 3; oy += 1) {
        for (let ox = 0; ox < 3; ox += 1) {
          const px = x + ox;
          const py = y + oy;
          if (darkPatch) {
            paintPixel(data, width, px, py, 44, 40, 38);
          } else {
            paintPixel(data, width, px, py, 164, 156, 148);
          }
        }
      }
    }
  }

  return image;
}

function paintPixel(data, width, x, y, red, green, blue) {
  const index = (y * width + x) * 4;
  data[index] = red;
  data[index + 1] = green;
  data[index + 2] = blue;
  data[index + 3] = 255;
}
