#!/usr/bin/env node
// MCP server (stdio transport) exposing the kettle to Claude Code / Desktop.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadKettleConfig, type KettleConfig } from "./config.js";
import { KettleClient } from "./client.js";
import { discoverKettle } from "./discovery.js";
import { createLogger } from "./logger.js";

const log = createLogger("appkettle");

let client: KettleClient | null = null;
let cachedConfig: KettleConfig | null = null;

const tryConnect = async (cfg: KettleConfig): Promise<KettleClient> => {
  log.info(`Connecting to ${cfg.imei} at ${cfg.ip}:6002`);
  const c = new KettleClient(cfg);
  c.on("error", (e) => log.error("client error:", e.message));
  c.on("connect", () => log.info("connected"));
  c.on("close", () => log.info("disconnected (will auto-reconnect)"));
  c.connect();
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("connect timeout")), 8000);
      c.once("connect", () => {
        clearTimeout(t);
        resolve();
      });
      c.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    await c.whenReady();
    return c;
  } catch (e) {
    c.close();
    throw e;
  }
};

const ensureClient = async (): Promise<KettleClient> => {
  if (client) return client;

  // 1. Try cached/env config first
  const initial = cachedConfig ?? (await loadKettleConfig());
  try {
    const c = await tryConnect(initial);
    cachedConfig = initial;
    client = c;
    return c;
  } catch (e) {
    log.warn(`Initial connect failed (${e instanceof Error ? e.message : e}); rediscovering...`);
  }

  // 2. Fall back to UDP discovery (kettle's IP may have changed)
  const discovered = await discoverKettle();
  const cfg: KettleConfig = { ip: discovered.ip, imei: discovered.imei };
  log.info(`Discovered kettle at ${cfg.ip}, retrying`);
  const c = await tryConnect(cfg);
  cachedConfig = cfg;
  client = c;
  return c;
};

const asText = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

const asError = (e: unknown) => {
  const name = e instanceof Error ? e.constructor.name : "Error";
  const msg = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: "text" as const, text: `${name}: ${msg}` }],
    isError: true,
  };
};

const wrap = async <T>(fn: () => Promise<T>) => {
  try {
    return asText(await fn());
  } catch (e) {
    return asError(e);
  }
};

const server = new McpServer({ name: "appkettle", version: "0.1.0" });

server.registerTool(
  "kettle_status",
  {
    description: "Get the current status of the kettle (state, current and target temperature, water volume in ml).",
    inputSchema: {
      fresh: z.boolean().optional().describe("If true, force a poll instead of returning the cached heartbeat status."),
    },
  },
  async ({ fresh }) =>
    wrap(async () => {
      const c = await ensureClient();
      if (fresh) return await c.pollStatus();
      const cached = c.getCachedStatus();
      return cached.status ?? (await c.pollStatus());
    }),
);

server.registerTool(
  "kettle_boil",
  {
    description: "Start boiling water. Optionally specify target temperature and keep-warm duration.",
    inputSchema: {
      target_temp: z.number().int().min(40).max(100).optional().describe("Target temperature in °C (40–100, default 100)."),
      keep_warm_minutes: z.number().int().min(0).max(30).optional().describe("Keep-warm duration after boil in minutes (0–30, default 0)."),
    },
  },
  async ({ target_temp, keep_warm_minutes }) =>
    wrap(async () => {
      const c = await ensureClient();
      await c.boil({ targetTemp: target_temp, keepWarmMinutes: keep_warm_minutes });
      return `Boiling${target_temp ? ` to ${target_temp}°C` : ""}${keep_warm_minutes ? `, keep warm ${keep_warm_minutes}m` : ""}.`;
    }),
);

server.registerTool(
  "kettle_stop",
  {
    description: "Stop the kettle (cancel an active boil or keep-warm cycle).",
    inputSchema: {},
  },
  async () =>
    wrap(async () => {
      const c = await ensureClient();
      await c.stop();
      return "Stopped.";
    }),
);

server.registerTool(
  "kettle_standby",
  {
    description: "Put the kettle into standby mode (display off).",
    inputSchema: {},
  },
  async () =>
    wrap(async () => {
      const c = await ensureClient();
      await c.standby();
      return "Standby.";
    }),
);

server.registerTool(
  "kettle_keep_warm_start",
  {
    description: "Engage keep-warm at the current target temperature. Use after a boil if you want to maintain temp without re-boiling.",
    inputSchema: {},
  },
  async () =>
    wrap(async () => {
      const c = await ensureClient();
      await c.startKeepWarm();
      return "Keep-warm started.";
    }),
);

server.registerTool(
  "kettle_keep_warm_stop",
  {
    description: "Cancel an active keep-warm cycle.",
    inputSchema: {},
  },
  async () =>
    wrap(async () => {
      const c = await ensureClient();
      await c.stopKeepWarm();
      return "Keep-warm stopped.";
    }),
);

server.registerTool(
  "kettle_wait_until_ready",
  {
    description:
      "Block until the kettle finishes heating (state leaves 'Heating') or the optional target temperature is reached. Returns the final status.",
    inputSchema: {
      target_temp: z
        .number()
        .int()
        .min(40)
        .max(100)
        .optional()
        .describe("If set, return as soon as the current temperature reaches this value."),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(900_000)
        .optional()
        .describe("Max time to wait in milliseconds (default 300000 = 5 min)."),
    },
  },
  async ({ target_temp, timeout_ms }) =>
    wrap(async () => {
      const c = await ensureClient();
      return await c.waitUntilReady({ targetTemp: target_temp, timeoutMs: timeout_ms });
    }),
);

server.registerTool(
  "kettle_discover",
  {
    description: "Re-discover the kettle on the local network via UDP broadcast. Useful if its IP changed.",
    inputSchema: {},
  },
  async () =>
    wrap(async () => {
      const k = await discoverKettle();
      // Force reconnect on next call so we pick up any IP change.
      if (client) client.close();
      client = null;
      cachedConfig = { ip: k.ip, imei: k.imei };
      return k;
    }),
);

const main = async (): Promise<void> => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server ready on stdio");
};

main().catch((e) => {
  log.error("fatal:", e);
  process.exit(1);
});
