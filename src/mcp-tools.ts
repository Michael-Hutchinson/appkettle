// Shared MCP server wiring used by both the stdio entry (mcp.ts) and the HTTP entry (mcp-http.ts).
// Holds the KettleManager (the long-lived TCP connection) and the tool registration logic.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KettleClient } from "./client.js";
import { loadKettleConfig, type KettleConfig } from "./config.js";
import { discoverKettle } from "./discovery.js";
import { type Logger } from "./logger.js";
import { VERSION } from "./version.js";

/**
 * Owns the single KettleClient shared across MCP tool invocations and the cached config.
 * Made module-scoped at the entry point so multiple HTTP sessions share one TCP connection
 * to the kettle.
 */
export class KettleManager {
  private client: KettleClient | null = null;
  private cachedConfig: KettleConfig | null = null;
  // Deduplicate concurrent ensure() calls so a tool invocation landing during
  // pre-warm (or another in-flight ensure) doesn't race and open a second TCP socket.
  private connecting: Promise<KettleClient> | null = null;

  constructor(private readonly log: Logger) {}

  async ensure(): Promise<KettleClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = this.doEnsure();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async doEnsure(): Promise<KettleClient> {
    const initial = this.cachedConfig ?? (await loadKettleConfig());
    try {
      this.client = await this.tryConnect(initial);
      this.cachedConfig = initial;
      return this.client;
    } catch (e) {
      this.log.warn(
        `Initial connect failed (${e instanceof Error ? e.message : e}); rediscovering...`,
      );
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

  /** Snapshot for /healthz. Doesn't trigger a connection; returns whatever's cached. */
  snapshot(): {
    connected: boolean;
    ip: string | null;
    lastSeenAt: string | null;
  } {
    if (!this.client)
      return {
        connected: false,
        ip: this.cachedConfig?.ip ?? null,
        lastSeenAt: null,
      };
    const { updatedAt } = this.client.getCachedStatus();
    return {
      connected: true,
      ip: this.cachedConfig?.ip ?? null,
      lastSeenAt: updatedAt > 0 ? new Date(updatedAt).toISOString() : null,
    };
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

// ---------- response shaping ----------

const asText = (data: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    },
  ],
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

/**
 * Build a fresh MCP server with all kettle tools registered. Both transports call this:
 * stdio uses one server for the process lifetime, HTTP creates one per session.
 */
export const buildKettleServer = (manager: KettleManager): McpServer => {
  const server = new McpServer({ name: "appkettle", version: VERSION });

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

  server.registerTool(
    "kettle_status",
    {
      description:
        "Get the current status of the kettle (state, current and target temperature, water volume in ml).",
      inputSchema: {
        fresh: z
          .boolean()
          .optional()
          .describe(
            "If true, force a poll instead of returning the cached heartbeat status.",
          ),
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
      description:
        "Start boiling water. Optionally specify target temperature and keep-warm duration.",
      inputSchema: {
        target_temp: z
          .number()
          .int()
          .min(40)
          .max(100)
          .optional()
          .describe("Target temperature in °C (40–100, default 100)."),
        keep_warm_minutes: z
          .number()
          .int()
          .min(0)
          .max(30)
          .optional()
          .describe(
            "Keep-warm duration after boil in minutes (0–30, default 0).",
          ),
      },
    },
    async ({ target_temp, keep_warm_minutes }) =>
      wrap(async () => {
        const c = await manager.ensure();
        await c.boil({
          targetTemp: target_temp,
          keepWarmMinutes: keep_warm_minutes,
        });
        return `Boiling${target_temp ? ` to ${target_temp}°C` : ""}${keep_warm_minutes ? `, keep warm ${keep_warm_minutes}m` : ""}.`;
      }),
  );

  registerSimpleAction(
    "kettle_on",
    "Wake the kettle from Standby. Boiling auto-wakes already; use this only if you want to explicitly bring the display back without starting a boil.",
    (c) => c.kettleOn(),
    "Awake.",
  );
  registerSimpleAction(
    "kettle_stop",
    "Stop the kettle (cancel an active boil or keep-warm cycle).",
    (c) => c.stop(),
    "Stopped.",
  );
  registerSimpleAction(
    "kettle_standby",
    "Put the kettle into standby mode (display off).",
    (c) => c.standby(),
    "Standby.",
  );
  registerSimpleAction(
    "kettle_keep_warm_start",
    "Engage keep-warm at the current target temperature. Use after a boil if you want to maintain temp without re-boiling.",
    (c) => c.startKeepWarm(),
    "Keep-warm started.",
  );
  registerSimpleAction(
    "kettle_keep_warm_stop",
    "Cancel an active keep-warm cycle.",
    (c) => c.stopKeepWarm(),
    "Keep-warm stopped.",
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
          .describe(
            "If set, return as soon as the current temperature reaches this value.",
          ),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(900_000)
          .optional()
          .describe(
            "Max time to wait in milliseconds (default 300000 = 5 min).",
          ),
      },
    },
    async ({ target_temp, timeout_ms }) =>
      wrap(async () => {
        const c = await manager.ensure();
        return await c.waitUntilReady({
          targetTemp: target_temp,
          timeoutMs: timeout_ms,
        });
      }),
  );

  server.registerTool(
    "kettle_discover",
    {
      description:
        "Re-discover the kettle on the local network via UDP broadcast. Useful if its IP changed.",
      inputSchema: {},
    },
    async () =>
      wrap(async () => {
        const k = await discoverKettle();
        manager.setConfig({ ip: k.ip, imei: k.imei });
        return k;
      }),
  );

  return server;
};
