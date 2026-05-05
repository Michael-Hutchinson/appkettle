#!/usr/bin/env node
// Tiny CLI for sanity-testing the kettle without going through MCP.
//
// Usage:
//   tsx src/cli.ts status
//   tsx src/cli.ts boil [temp] [keep_warm_minutes]
//   tsx src/cli.ts stop
//   tsx src/cli.ts standby
//   tsx src/cli.ts discover
import { loadKettleConfig } from "./config.js";
import { KettleClient } from "./client.js";
import { discoverKettle } from "./discovery.js";

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const cmd = process.argv[2] ?? die("usage: status | boil [temp] [kw] | stop | standby | discover");

if (cmd === "discover") {
  const k = await discoverKettle();
  console.log(JSON.stringify(k, null, 2));
  process.exit(0);
}

const cfg = await loadKettleConfig();
console.error(`Connecting to kettle ${cfg.imei} at ${cfg.ip}:6002 ...`);
const client = new KettleClient(cfg);
client.on("error", (e) => console.error("client error:", e.message));
client.connect();

await new Promise((r) => client.once("connect", r));
await client.whenReady();

try {
  switch (cmd) {
    case "status": {
      const s = await client.pollStatus();
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    case "boil": {
      const targetTemp = process.argv[3] ? Number(process.argv[3]) : 100;
      const keepWarmMinutes = process.argv[4] ? Number(process.argv[4]) : 0;
      await client.boil({ targetTemp, keepWarmMinutes });
      console.log(`OK — boiling to ${targetTemp}°C${keepWarmMinutes ? `, keep warm ${keepWarmMinutes}m` : ""}`);
      break;
    }
    case "stop":
      await client.stop();
      console.log("OK — stopped");
      break;
    case "standby":
      await client.standby();
      console.log("OK — standby");
      break;
    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
} finally {
  client.close();
}
