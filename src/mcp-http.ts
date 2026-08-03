#!/usr/bin/env node
// MCP server (HTTP/streamable transport).
//
// One process, one shared TCP connection to the kettle (via KettleManager), many
// concurrent MCP sessions. Designed to run on a Raspberry Pi or any always-on host
// reachable from your MCP clients (e.g. via Tailscale).
//
// Config (env vars):
//   MCP_HTTP_HOST     bind address (default 127.0.0.1, local only; set to 0.0.0.0
//                     or your Tailscale IP to expose on the network)
//   MCP_HTTP_PORT     port (default 8080)
//   MCP_AUTH_TOKEN    if set, requests must send Authorization: Bearer <token>;
//                     if unset, the endpoint is unauthenticated (fine on a tailnet
//                     that's already private, NOT fine on the open internet)
//   KETTLE_IP         see README; same as the stdio server
//   KETTLE_IMEI       same
//   LOG_LEVEL         debug | info | warn | error (default info)
import { randomUUID } from "node:crypto";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { validateEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { KettleManager, buildKettleServer } from "./mcp-tools.js";
import { VERSION } from "./version.js";

const startedAt = Date.now();

const env = validateEnv();
const log = createLogger("appkettle-http");
const manager = new KettleManager(log);

const host = env.MCP_HTTP_HOST ?? "127.0.0.1";
const port = env.MCP_HTTP_PORT ?? 8080;
const authToken = env.MCP_AUTH_TOKEN;

const app = express();
app.use(express.json());

if (authToken) {
  app.use((req: Request, res: Response, next: NextFunction): void => {
    if (req.headers.authorization === `Bearer ${authToken}`) {
      next();
      return;
    }
    res.status(401).json({ error: "Unauthorized" });
  });
}

// Active sessions, keyed by mcp-session-id header.
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Health endpoint. Outside the auth middleware would be cleaner for prod monitoring,
// but for a tailnet-only service requiring the same token everywhere is fine.
app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    sessions: Object.keys(transports).length,
    kettle: manager.snapshot(),
  });
});

app.post("/mcp", async (req: Request, res: Response): Promise<void> => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  let transport: StreamableHTTPServerTransport;
  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
        log.debug(`session ${sid} initialized`);
      },
    });
    transport.onclose = (): void => {
      const sid = transport.sessionId;
      if (sid && transports[sid]) {
        delete transports[sid];
        log.debug(`session ${sid} closed`);
      }
    };
    const server = buildKettleServer(manager);
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: no valid session ID provided",
      },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// SSE streams (server → client notifications) and DELETE (client-driven session termination)
// both flow through the same transport object once the session is established.
const handleSessionRequest = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
};

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const httpServer = app.listen(port, host, () => {
  log.info(`MCP HTTP server ready on http://${host}:${port}/mcp`);
  if (!authToken)
    log.warn("MCP_AUTH_TOKEN not set: endpoint is unauthenticated");

  // Pre-warm so the first tool call from any session is fast.
  manager
    .ensure()
    .catch((e) =>
      log.warn(`pre-warm failed: ${e instanceof Error ? e.message : e}`),
    );
});

const shutdown = async (signal: string): Promise<void> => {
  log.info(
    `received ${signal}, draining sessions and closing kettle connection`,
  );
  // Stop accepting new HTTP connections.
  httpServer.close();
  // Close active MCP sessions so clients see a clean disconnect.
  for (const t of Object.values(transports)) {
    try {
      await t.close();
    } catch (e) {
      log.warn("transport close error:", e instanceof Error ? e.message : e);
    }
  }
  // Drop the TCP connection to the kettle.
  manager.reset();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
