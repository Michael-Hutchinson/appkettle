// Typed error classes for kettle interactions. Callers can branch on instanceof
// rather than parsing error message strings.

export class KettleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class KettleTimeoutError extends KettleError {
  readonly api: string;
  readonly timeoutMs: number;
  constructor(api: string, timeoutMs: number) {
    super(`Timeout waiting for API ${api} after ${timeoutMs}ms`);
    this.api = api;
    this.timeoutMs = timeoutMs;
  }
}

export class KettleNotConnectedError extends KettleError {
  constructor() {
    super("Not connected");
  }
}

export class KettleConnectionClosedError extends KettleError {
  constructor() {
    super("Connection closed");
  }
}

export class KettleNackError extends KettleError {
  readonly api: string;
  readonly ack: string;
  constructor(api: string, ack: string) {
    super(`Kettle rejected ${api}: ack=${ack}`);
    this.api = api;
    this.ack = ack;
  }
}

export class KettleNotReadyError extends KettleError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Kettle not ready after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

/** True for the error classes that mean "the connection went away mid-flight". */
export const isConnectionLossError = (e: unknown): boolean =>
  e instanceof KettleTimeoutError ||
  e instanceof KettleConnectionClosedError ||
  e instanceof KettleNotConnectedError;
