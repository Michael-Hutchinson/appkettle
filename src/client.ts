// TCP client for AppKettle on TCP/6002.
// Auto-reconnect, status caching from heartbeat, command/response correlation by API code.
import net from "node:net";
import { EventEmitter } from "node:events";
import {
  buildWire,
  cmdGetSearchWifiLists,
  cmdGetStatus,
  cmdSetKettleStandby,
  cmdSetStartBoil,
  cmdSetStartKeepWarm,
  cmdSetStopBoil,
  cmdSetStopKeepWarm,
  cmdSetUpperWifi,
  extractData3,
  parseAcross,
  parseScanList,
  parseStatus,
  type AcrossReply,
  type BoilArgs,
  type KettleStatus,
  type ScanEntry,
} from "./protocol.js";

export interface KettleClientOpts {
  ip: string;
  imei: string;
  port?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  heartbeatIntervalMs?: number;
}

/** Next reconnect delay: double the current, capped at max. Pure for testability. */
export const nextBackoffDelay = (current: number, max: number): number =>
  Math.min(current * 2, max);

interface PendingResponse {
  api: string;
  resolve: (reply: AcrossReply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const COMMAND_TIMEOUT_MS = 5000;

export class KettleClient extends EventEmitter {
  readonly ip: string;
  readonly imei: string;
  readonly port: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private currentReconnectDelay: number;
  private sock: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private serial = 1;
  private pending: PendingResponse[] = [];
  private status: KettleStatus | null = null;
  private statusUpdatedAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private wantOpen = false;
  private ready = false;

  constructor(opts: KettleClientOpts) {
    super();
    this.ip = opts.ip;
    this.imei = opts.imei;
    this.port = opts.port ?? 6002;
    this.reconnectInitialMs = opts.reconnectInitialMs ?? 1000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30_000;
    this.currentReconnectDelay = this.reconnectInitialMs;
  }

  connect(): void {
    this.wantOpen = true;
    if (this.sock) return;
    const sock = net.createConnection({ host: this.ip, port: this.port });
    this.sock = sock;

    sock.on("connect", () => {
      sock.write("##000bKeepConnect&&");
      this.keepAliveTimer = setInterval(() => {
        if (sock.writable) sock.write("##000bKeepConnect&&");
      }, 25_000);
      this.emit("connect");
    });

    sock.on("data", (chunk) => this.onData(chunk));

    sock.on("error", (err) => this.emit("error", err));

    sock.on("close", () => {
      this.cleanup();
      if (this.wantOpen) this.scheduleReconnect();
      this.emit("close");
    });
  }

  close(): void {
    this.wantOpen = false;
    this.cleanup();
    this.sock?.end();
    this.sock = null;
  }

  /** Latest status from heartbeat or explicit poll. Null until first message arrives. */
  getCachedStatus(): { status: KettleStatus | null; updatedAt: number } {
    return { status: this.status, updatedAt: this.statusUpdatedAt };
  }

  /** Force a fresh status by sending API_36. Resolves to parsed status. */
  async pollStatus(): Promise<KettleStatus> {
    const reply = await this.send(cmdGetStatus(this.nextSerial()));
    const s = parseStatus(reply.content);
    if (!s) throw new Error(`Unparseable status: ${reply.content}`);
    this.updateStatus(s);
    return s;
  }

  async boil(args: BoilArgs = {}): Promise<void> {
    const reply = await this.send(cmdSetStartBoil(this.nextSerial(), args));
    this.assertOk(reply);
  }

  async stop(): Promise<void> {
    const reply = await this.send(cmdSetStopBoil(this.nextSerial()));
    this.assertOk(reply);
  }

  async startKeepWarm(): Promise<void> {
    const reply = await this.send(cmdSetStartKeepWarm(this.nextSerial()));
    this.assertOk(reply);
  }

  async stopKeepWarm(): Promise<void> {
    const reply = await this.send(cmdSetStopKeepWarm(this.nextSerial()));
    this.assertOk(reply);
  }

  async standby(): Promise<void> {
    const reply = await this.send(cmdSetKettleStandby(this.nextSerial()));
    this.assertOk(reply);
  }

  /** Ask the kettle (in pairing mode) to scan nearby Wi-Fi networks, sorted by signal desc. */
  async scanWifi(): Promise<ScanEntry[]> {
    const reply = await this.send(cmdGetSearchWifiLists(this.nextSerial()));
    const r = parseScanList(reply.content);
    if (!r.ok) throw new Error(`Wi-Fi scan failed: ${r.error}`);
    return [...r.entries].sort((a, b) => b.signal - a.signal);
  }

  /** Tell the kettle to join a Wi-Fi network. essidHex is the BSSID from a scan entry. */
  async setUpperWifi(essidHex: string, password: string): Promise<void> {
    const reply = await this.send(cmdSetUpperWifi(this.nextSerial(), essidHex, password));
    this.assertOk(reply);
  }

  /**
   * Resolve when the kettle leaves the Heating state, or (if targetTemp is given) when its
   * current temperature reaches that target — whichever happens first. Rejects on timeout.
   */
  waitUntilReady(opts: { targetTemp?: number; timeoutMs?: number } = {}): Promise<KettleStatus> {
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const isReady = (s: KettleStatus): boolean => {
      if (s.state === "Ready" || s.state === "Keep Warm" || s.state === "Standby") return true;
      if (opts.targetTemp != null && s.temperature >= opts.targetTemp) return true;
      return false;
    };

    const cached = this.getCachedStatus().status;
    if (cached && isReady(cached)) return Promise.resolve(cached);

    return new Promise<KettleStatus>((resolve, reject) => {
      const onStatus = (s: KettleStatus): void => {
        if (!isReady(s)) return;
        clearTimeout(timer);
        this.off("status", onStatus);
        resolve(s);
      };
      const timer = setTimeout(() => {
        this.off("status", onStatus);
        reject(new Error(`Kettle not ready after ${timeoutMs}ms`));
      }, timeoutMs);
      this.on("status", onStatus);
    });
  }

  // ---------- internals ----------

  private nextSerial(): number {
    const s = this.serial;
    this.serial = (this.serial + 1) & 0xff;
    if (this.serial === 0) this.serial = 1;
    return s;
  }

  private assertOk(reply: AcrossReply): void {
    const ack = reply.content.slice(0, 2).toUpperCase();
    if (ack !== "C8") throw new Error(`Kettle rejected ${reply.api}: ack=${ack}`);
  }

  private send(frame: { api: string; content?: string; serial: number; prefix?: string; msgUnique?: string }): Promise<AcrossReply> {
    if (!this.sock || !this.sock.writable) return Promise.reject(new Error("Not connected"));
    const wire = buildWire(this.imei, frame);
    return new Promise<AcrossReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p !== entry);
        reject(new Error(`Timeout waiting for API ${frame.api}`));
      }, COMMAND_TIMEOUT_MS);
      const entry: PendingResponse = { api: frame.api.toUpperCase(), resolve, reject, timer };
      this.pending.push(entry);
      this.sock!.write(wire, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending = this.pending.filter((p) => p !== entry);
          reject(err);
        }
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const i = this.buf.indexOf("&&");
      if (i < 0) break;
      const wire = this.buf.subarray(0, i + 2).toString("ascii");
      this.buf = this.buf.subarray(i + 2);
      this.handleWire(wire);
    }
  }

  private handleWire(wire: string): void {
    const data3 = extractData3(wire);
    if (!data3) return;
    const reply = parseAcross(data3);
    if (!reply) return;

    // First message from the kettle (typically an INIT api=A4) marks the link ready for commands.
    if (!this.ready) {
      this.ready = true;
      this.currentReconnectDelay = this.reconnectInitialMs;
      this.emit("ready");
    }

    if (reply.api === "36") {
      const s = parseStatus(reply.content);
      if (s) this.updateStatus(s);
    }

    // Match to oldest pending request with this API code
    const idx = this.pending.findIndex((p) => p.api === reply.api.toUpperCase());
    if (idx >= 0) {
      const [pending] = this.pending.splice(idx, 1);
      clearTimeout(pending.timer);
      pending.resolve(reply);
    }
  }

  /** Resolves once the kettle has sent its first message (signals it's ready for commands). */
  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => this.once("ready", () => resolve()));
  }

  private updateStatus(s: KettleStatus): void {
    this.status = s;
    this.statusUpdatedAt = Date.now();
    this.emit("status", s);
  }

  private cleanup(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    for (const p of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Connection closed"));
    }
    this.pending = [];
    this.buf = Buffer.alloc(0);
    this.sock = null;
    this.ready = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.currentReconnectDelay;
    this.emit("reconnecting", { delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantOpen) this.connect();
    }, delay);
    this.currentReconnectDelay = nextBackoffDelay(this.currentReconnectDelay, this.reconnectMaxMs);
  }
}
