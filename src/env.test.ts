import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "./env.js";

test("parseEnv accepts an empty environment (all fields optional)", () => {
  const r = parseEnv({});
  assert.equal(r.success, true);
});

test("parseEnv accepts well-formed values and coerces port to number", () => {
  const r = parseEnv({
    KETTLE_IP: "192.168.1.202",
    KETTLE_IMEI: "GD0-12900-7a00",
    LOG_LEVEL: "debug",
    MCP_HTTP_HOST: "0.0.0.0",
    MCP_HTTP_PORT: "8080",
    MCP_AUTH_TOKEN: "0123456789abcdef0123456789abcdef",
  });
  assert.equal(r.success, true);
  if (r.success) {
    assert.equal(r.data.MCP_HTTP_PORT, 8080);
    assert.equal(typeof r.data.MCP_HTTP_PORT, "number");
  }
});

test("parseEnv rejects an out-of-range port", () => {
  const r = parseEnv({ MCP_HTTP_PORT: "99999" });
  assert.equal(r.success, false);
});

test("parseEnv rejects an invalid LOG_LEVEL", () => {
  const r = parseEnv({ LOG_LEVEL: "verbose" });
  assert.equal(r.success, false);
});

test("parseEnv rejects a too-short MCP_AUTH_TOKEN", () => {
  const r = parseEnv({ MCP_AUTH_TOKEN: "short" });
  assert.equal(r.success, false);
});
