const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WeightCalibrator,
  CALIBRATION_RESET_INTERVAL_MS,
  CALIBRATION_STORAGE_KEY,
} = require("../.test-dist/content/scoring/weight-calibrator.js");
const {
  BASE_WEIGHTS,
} = require("../.test-dist/content/scoring/composite-scorer.js");

test("calibration persists across reloads and resets after seven days", async () => {
  const storage = createStorageArea();
  const baseTime = 1_700_000_000_000;

  const calibrator = new WeightCalibrator(storage, () => baseTime);
  await calibrator.load();
  await calibrator.recordConfirmed({ text: 80 });
  await calibrator.recordConfirmed({ text: 85 });
  await calibrator.recordConfirmed({ text: 90 });

  const stored = await storage.get(CALIBRATION_STORAGE_KEY);
  assert.ok(stored[CALIBRATION_STORAGE_KEY]);
  assert.ok(calibrator.getWeights().text > BASE_WEIGHTS.text);

  const reloaded = new WeightCalibrator(
    storage,
    () => baseTime + CALIBRATION_RESET_INTERVAL_MS - 1
  );
  await reloaded.load();
  assert.equal(reloaded.getWeights().text, calibrator.getWeights().text);

  const expired = new WeightCalibrator(
    storage,
    () => baseTime + CALIBRATION_RESET_INTERVAL_MS + 1
  );
  await expired.load();
  assert.equal(expired.getWeights().text, BASE_WEIGHTS.text);
});

function createStorageArea() {
  const store = new Map();

  return {
    async get(key) {
      if (typeof key === "string") {
        return { [key]: store.get(key) };
      }
      return Object.fromEntries(store.entries());
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value);
      }
    },
  };
}
