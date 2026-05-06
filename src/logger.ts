// Tiny logger abstraction. Writes to stderr so MCP stdio-on-stdout stays clean.
// Level controlled by LOG_LEVEL env var (debug | info | warn | error). Default: info.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const resolveLevel = (): LogLevel => {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw in LEVELS ? (raw as LogLevel) : "info";
};

export const createLogger = (name: string): Logger => {
  const min = LEVELS[resolveLevel()];
  const make =
    (lvl: LogLevel) =>
    (...args: unknown[]): void => {
      if (LEVELS[lvl] < min) return;
      console.error(`[${name}]`, ...args);
    };
  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
  };
};

/** No-op logger for tests or callers that want silence. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
