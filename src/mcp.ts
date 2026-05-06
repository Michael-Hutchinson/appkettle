#!/usr/bin/env node
// MCP server (stdio transport) exposing the kettle to Claude Code / Desktop.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadKettleConfig, type KettleConfig } from "./config.js";
import { KettleClient } from "./client.js";
import { discoverKettle } from "./discovery.js";
import { createLogger, type Logger } from "./logger.js";

/**
 * Owns the single KettleClient shared across MCP tool invocations and the cached config.
 * Encapsulating these used to be module globals — this makes mcp.ts unit-testable in
 * principle and gives one place to evolve the connection lifecycle (e.g. for HTTP transport).
 */
class KettleManager {
  private client: KettleClient | null = null;
  private cachedConfig: KettleConfig | null = null;

  constructor(private readonly log: Logger) {}

  async ensure(): Promise<KettleClient> {
    if (this.client) return this.client;

    const initial = this.cachedConfig ?? (await loadKettleConfig());
    try {
      this.client = await this.tryConnect(initial);
      this.cachedConfig = initial;
      return this.client;
    } catch (e) {
      this.log.warn(`Initial connect failed (${e instanceof Error ? e.message : e}); rediscovering...`);
    }

    const discovered = await discoverKettle();
    const cfg: KettleConfig = { ip: discovered.ip, imei: discovered.imei };
    this.log.info(`Discovered kettle at ${cfg.ip}, retrying`);
    this.client = await this.tryConnect(cfg);
    this.cachedConfig = cfg;
    return this.client;
  }

  /** Replace the cached config and force the next ensure() to reconnect. */
  setConfig(cfg: KettleConfig): void {
    this.cachedConfig = cfg;
    this.reset();
  }

  /** Close any active client; next ensure() will reconnect. */
  reset(): void {
    this.client?.close();
    this.client = null;
  }

  private async tryConnect(cfg: KettleConfig): Promise<KettleClient> {
    this.log.info(`Connecting to ${cfg.imei} at ${cfg.ip}:6002`);
    const c = new KettleClient(cfg);
    c.on("error", (e) => this.log.error("client error:", e.message));
    c.on("connect", () => this.log.info("connected"));
    c.on("close", () => this.log.info("disconnected (will auto-reconnect)"));
    c.on("unmatched", (reply) => this.log.debug("unmatched reply:", reply.api));
    try {
      await c.connectAndWait();
      return c;
    } catch (e) {
      c.close();
      throw e;
    }
  }
}

const log = createLogger("appkettle");
const manager = new KettleManager(log);
const server = new McpServer({ name: "appkettle", version: "0.1.0" });

// ---------- response shaping ----------

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

/** Register a tool that takes no inputs and returns a fixed success message. */
const registerSimpleAction = (
  name: string,
  description: string,
  action: (c: KettleClient) => Promise<void>,
  okMessage: string,
): void => {
  server.registerTool(name, { description, inputSchema: {} }, async () =>
    wrap(async () => {
      const c = await manager.ensure();
      await action(c);
      return okMessage;
    }),
  );
};

// ---------- tools ----------

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
      const c = await manager.ensure();
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
      const c = await manager.ensure();
      await c.boil({ targetTemp: target_temp, keepWarmMinutes: keep_warm_minutes });
      return `Boiling${target_temp ? ` to ${target_temp}°C` : ""}${keep_warm_minutes ? `, keep warm ${keep_warm_minutes}m` : ""}.`;
    }),
);

registerSimpleAction("kettle_stop", "Stop the kettle (cancel an active boil or keep-warm cycle).", (c) => c.stop(), "Stopped.");
registerSimpleAction("kettle_standby", "Put the kettle into standby mode (display off).", (c) => c.standby(), "Standby.");
registerSimpleAction(
  "kettle_keep_warm_start",
  "Engage keep-warm at the current target temperature. Use after a boil if you want to maintain temp without re-boiling.",
  (c) => c.startKeepWarm(),
  "Keep-warm started.",
);
registerSimpleAction("kettle_keep_warm_stop", "Cancel an active keep-warm cycle.", (c) => c.stopKeepWarm(), "Keep-warm stopped.");

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
      const c = await manager.ensure();
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
      manager.setConfig({ ip: k.ip, imei: k.imei });
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
