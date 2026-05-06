// Parsers for kettle status (API 36) and Wi-Fi scan results (API 3D).

import { hexToStr } from "./hex.js";

export const KETTLE_STATES = [
  "Not on base", // 0
  "TBD",         // 1
  "Standby",     // 2
  "Ready",       // 3
  "Heating",     // 4
  "Keep Warm",   // 5
] as const;

export type KettleState = (typeof KETTLE_STATES)[number];

export interface KettleStatus {
  state: KettleState;
  power: "ON" | "OFF";
  temperature: number;        // °C, current
  targetTemperature: number;  // °C, last setpoint
  volume: number;             // ml in kettle
  keepWarmSecondsLeft: number;
}

// API_36 status content: pad(1) + status(1) + keep_warm_secs(2) + temp(1) + target_temp(1) + volume(2) + pad(2)
// We may also see a leading C8 ack for poll responses — handle both.
export const parseStatus = (contentHex: string): KettleStatus | null => {
  let h = contentHex.toUpperCase();
  if (h.length === 22 && h.startsWith("C8")) h = h.slice(2); // strip ack if present
  if (h.length < 16) return null;
  const stateByte = parseInt(h.slice(2, 4), 16);
  const state = KETTLE_STATES[stateByte] ?? "Not on base";
  const keepWarmSecondsLeft = parseInt(h.slice(4, 8), 16);
  const temperature = parseInt(h.slice(8, 10), 16);
  const targetTemperature = parseInt(h.slice(10, 12), 16);
  const volume = parseInt(h.slice(12, 16), 16);
  return {
    state,
    power: state === "Heating" || state === "Keep Warm" ? "ON" : "OFF",
    temperature,
    targetTemperature,
    volume,
    keepWarmSecondsLeft,
  };
};

// Scan-list parsing (API_3D): C8 + count + entries.
// Each entry: unk(1) + len_SSID(1) + SSID_hex(L1) + len_ESSID(1) + ESSID_hex(L2) + enc(1) + sig(1)
// ESSID is the AP's BSSID (MAC) as ASCII-hex — not the SSID name. Send this exact value back to setUpperWifi.
export interface ScanEntry {
  ssid: string;
  essidHex: string;
  encryption: string;
  signal: number;
}

export const parseScanList = (
  contentHex: string,
): { ok: true; entries: ScanEntry[] } | { ok: false; error: string } => {
  const c = contentHex.toUpperCase();
  if (c.length < 4) return { ok: false, error: "too short" };
  if (c.slice(0, 2) !== "C8") return { ok: false, error: `status not C8: ${c.slice(0, 2)}` };
  const count = parseInt(c.slice(2, 4), 16);
  let rest = c.slice(4);
  const entries: ScanEntry[] = [];
  while (rest.length > 6 && entries.length < count + 5) {
    const L1 = parseInt(rest.slice(2, 4), 16) * 2;
    if (L1 <= 0 || 4 + L1 > rest.length) break;
    const ssidHex = rest.slice(4, 4 + L1);
    const L2 = parseInt(rest.slice(4 + L1, 6 + L1), 16) * 2;
    if (6 + L1 + L2 > rest.length) break;
    const essidHex = rest.slice(6 + L1, 6 + L1 + L2);
    const enc = rest.slice(6 + L1 + L2, 8 + L1 + L2);
    const sig = parseInt(rest.slice(8 + L1 + L2, 10 + L1 + L2), 16);
    entries.push({ ssid: hexToStr(ssidHex), essidHex, encryption: enc, signal: sig });
    rest = rest.slice(10 + L1 + L2);
  }
  return { ok: true, entries };
};
