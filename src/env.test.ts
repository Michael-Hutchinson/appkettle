import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "./env.js";

test("parseEnv accepts an empty environment (all fields optional)", () => {
  const r = parseEnv({});
  assert.equal(r.success, true);
});

test("parseEnv accepts well-formed values and coerces port to number", () => {
  const r = parseEnv({
    KETTLE_IP: "10.0.0.1",
    KETTLE_IMEI: "TEST-IMEI-000",
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

test("accepts bridge vars", () => {
  const r = parseEnv({
    MQTT_URL: "mqtt://hub:pw@mosquitto:1883",
    BRIDGE_IDLE_POLL_MS: "90000",
    BRIDGE_ACTIVE_POLL_MS: "5000",
  });
  assert.ok(r.success);
  assert.equal(r.data?.MQTT_URL, "mqtt://hub:pw@mosquitto:1883");
  assert.equal(r.data?.BRIDGE_IDLE_POLL_MS, 90000);
});

test("rejects malformed bridge vars", () => {
  assert.equal(parseEnv({ MQTT_URL: "not a url" }).success, false);
  assert.equal(parseEnv({ BRIDGE_IDLE_POLL_MS: "50" }).success, false);
});
