import { test } from "node:test";
import assert from "node:assert/strict";
import { KettleManager } from "./mcp-tools.js";
import { createLogger } from "./logger.js";

test("release is safe before any connection and idempotent", () => {
  const m = new KettleManager(createLogger("error"));
  assert.doesNotThrow(() => m.release());
  assert.doesNotThrow(() => m.release());
});
