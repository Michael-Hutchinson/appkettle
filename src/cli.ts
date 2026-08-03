#!/usr/bin/env node
// Tiny CLI for sanity-testing the kettle without going through MCP.
//
// Usage:
//   tsx src/cli.ts status
//   tsx src/cli.ts boil [temp] [keep_warm_minutes]
//   tsx src/cli.ts stop
//   tsx src/cli.ts standby
//   tsx src/cli.ts discover
//   tsx src/cli.ts setup       # interactive Wi-Fi pairing (must be on kettle's AP)
import * as readline from "node:readline/promises";
import { loadKettleConfig } from "./config.js";
import { KettleClient } from "./client.js";
import { discoverKettle } from "./discovery.js";
import { validateEnv } from "./env.js";
import { isConnectionLossError } from "./errors.js";
import { NAME, VERSION } from "./version.js";

const USAGE = `${NAME} ${VERSION}

Usage: appkettle <command> [args]

Commands:
  status                                Print current temp / state / volume
  boil [target_temp] [keep_warm_min]    Start a boil (defaults: 100°C, 0 min)
  stop                                  Cancel an active boil or keep-warm
  standby                               Put the kettle into standby
  discover                              Find the kettle on the LAN via UDP broadcast
  setup                                 Interactive Wi-Fi pairing (laptop must be on kettle's AP)

Options:
  -h, --help                            Show this help and exit
  -v, --version                         Show version and exit

Environment:
  KETTLE_IP, KETTLE_IMEI                Skip discovery; talk to this kettle directly
  LOG_LEVEL                             debug | info | warn | error (default info)
`;

const runSetup = async (client: KettleClient): Promise<void> => {
  console.error("");
  console.error("This walks the kettle through joining a Wi-Fi network.");
  console.error(
    "Your laptop must be connected to the kettle's pairing AP (typically AK_Kettle).",
  );
  console.error("");

  const networks = await client.scanWifi();
  if (networks.length === 0) {
    console.error(
      "Kettle saw no Wi-Fi networks. Move it closer to the router and retry.",
    );
    return;
  }

  console.log("Networks the kettle can see:");
  networks.forEach((n, i) => {
    console.log(
      `  [${i + 1}] ${n.ssid || "(hidden)"}  signal=${n.signal}  bssid=${n.essidHex}`,
    );
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const choice = await rl.question("\nNumber of the network to join: ");
    const idx = Number(choice) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= networks.length) {
      throw new Error(`Invalid choice: ${choice}`);
    }
    const target = networks[idx];
    const password = await rl.question(`Password for ${target.ssid}: `);

    console.error("\nSending Wi-Fi credentials to kettle...");
    try {
      await client.setUpperWifi(target.essidHex, password);
      console.log("OK: kettle accepted credentials.");
    } catch (e) {
      if (isConnectionLossError(e)) {
        console.log(
          "Kettle dropped the connection. That's expected; it's bouncing onto your network.",
        );
      } else {
        throw e;
      }
    }
    console.log(
      "\nReconnect your laptop to your home Wi-Fi, then run `npm run cli discover` to confirm.",
    );
  } finally {
    rl.close();
  }
};

const main = async (): Promise<void> => {
  const cmd = process.argv[2];

  // Handle -h / -v BEFORE env validation or any I/O. These flags must work even
  // if the env is misconfigured.
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === "-v" || cmd === "--version") {
    console.log(VERSION);
    process.exit(0);
  }

  validateEnv();

  if (cmd === "discover") {
    const k = await discoverKettle();
    console.log(JSON.stringify(k, null, 2));
    return;
  }

  const cfg = await loadKettleConfig();
  console.error(`Connecting to kettle ${cfg.imei} at ${cfg.ip}:6002 ...`);
  const client = new KettleClient(cfg);
  client.on("error", (e) => console.error("client error:", e.message));

  try {
    await client.connectAndWait();

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
        console.log(
          `OK: boiling to ${targetTemp}°C${keepWarmMinutes ? `, keep warm ${keepWarmMinutes}m` : ""}`,
        );
        break;
      }
      case "stop":
        await client.stop();
        console.log("OK: stopped");
        break;
      case "standby":
        await client.standby();
        console.log("OK: standby");
        break;
      case "setup":
        await runSetup(client);
        break;
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  } finally {
    client.close();
  }
};

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
