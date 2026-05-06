#!/usr/bin/env node
// MCP server (stdio transport) — Claude Code/Desktop spawn this as a subprocess.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { validateEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { KettleManager, buildKettleServer } from "./mcp-tools.js";

validateEnv();
const log = createLogger("appkettle");
const manager = new KettleManager(log);
const server = buildKettleServer(manager);

const shutdown = (signal: string): void => {
  log.info(`received ${signal}, closing kettle connection`);
  manager.reset();
  process.exit(0);
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const main = async (): Promise<void> => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server ready on stdio");
};

main().catch((e) => {
  log.error("fatal:", e);
  process.exit(1);
});
