import { test } from "node:test";
import assert from "node:assert/strict";
import { nextBackoffDelay } from "./client.js";

test("nextBackoffDelay doubles when below max", () => {
  assert.equal(nextBackoffDelay(1000, 30_000), 2000);
  assert.equal(nextBackoffDelay(2000, 30_000), 4000);
  assert.equal(nextBackoffDelay(8000, 30_000), 16_000);
});

test("nextBackoffDelay caps at max", () => {
  assert.equal(nextBackoffDelay(16_000, 30_000), 30_000);
  assert.equal(nextBackoffDelay(30_000, 30_000), 30_000);
});

test("nextBackoffDelay clamps when current already exceeds max", () => {
  assert.equal(nextBackoffDelay(60_000, 30_000), 30_000);
});
