#!/usr/bin/env node
// Combined entry: HTTP MCP server plus, when MQTT_URL is set, the Home
// Assistant MQTT bridge, on one shared KettleManager.
import { validateEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { KettleManager } from "./mcp-tools.js";
import { MqttBridge } from "./mqtt-bridge.js";
import { startHttpServer } from "./mcp-http.js";

const env = validateEnv();
const log = createLogger("appkettle-bridge");
const manager = new KettleManager(log);

const bridge = env.MQTT_URL
  ? new MqttBridge(manager, log, {
      url: env.MQTT_URL,
      idlePollMs: env.BRIDGE_IDLE_POLL_MS,
      activePollMs: env.BRIDGE_ACTIVE_POLL_MS,
    })
  : undefined;
// Guards against stopping a client that never finished connecting.
let bridgeStarted = false;

startHttpServer(manager, log, {
  beforeExit: async () => {
    if (bridge && bridgeStarted) await bridge.stop();
  },
});

if (bridge) {
  bridge
    .start()
    .then(() => {
      bridgeStarted = true;
    })
    .catch((e) => {
      log.error(`MQTT bridge failed to start: ${String(e)}`);
      process.exit(1);
    });
} else {
  log.info("MQTT_URL not set, MQTT bridge disabled");
}
