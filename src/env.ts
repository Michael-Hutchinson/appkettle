// Validate environment configuration at startup. Call validateEnv() at the top of every
// entry point (cli.ts, mcp.ts, mcp-http.ts). Exits the process with a clear, listed
// error if anything's malformed.
//
// All fields are optional: the existing fallbacks (auto-discovery, default ports, etc.)
// kick in when the var is unset.
import { z } from "zod";

const envSchema = z.object({
  // Allow IPs or hostnames (the kettle's home address can be either after pairing).
  KETTLE_IP: z.string().min(1).optional(),
  KETTLE_IMEI: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  MCP_HTTP_HOST: z.string().min(1).optional(),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  // Bearer token must be at least 16 chars when set, to discourage weak secrets.
  MCP_AUTH_TOKEN: z.string().min(16).optional(),
  // Bridge (MQTT) settings. MQTT_URL switches the MQTT bridge on in bridge.ts.
  MQTT_URL: z.string().url().optional(),
  BRIDGE_IDLE_POLL_MS: z.coerce.number().int().min(1000).optional(),
  BRIDGE_ACTIVE_POLL_MS: z.coerce.number().int().min(1000).optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Pure parser: testable, no side effects. */
export const parseEnv = (raw: Record<string, unknown>) =>
  envSchema.safeParse(raw);

let cached: Env | null = null;

export const validateEnv = (): Env => {
  if (cached) return cached;
  const result = parseEnv(process.env);
  if (!result.success) {
    console.error("Invalid environment configuration:");
    for (const issue of result.error.issues) {
      const path = issue.path.join(".") || "<env>";
      console.error(`  ${path}: ${issue.message}`);
    }
    process.exit(1);
  }
  cached = result.data;
  return cached;
};
