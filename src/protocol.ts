// AppKettle "Across" protocol — reverse-engineered from com.ifavine.appkettle 1.3.9 APK
// (AcrossGetTool, HexUtils, AcrossUtils) and tinaught/appkettleapi.
//
// Wire format:
//   outer: ##00<2-hex-len>{json}&&            (## + plaintext flag + length + body + terminator)
//   json:  {"app_cmd":"62","imei":"…","SubDev":"","data2":"<across-hex>"}
//   data2: AA + frameLen(4) + prefix(4) + msgUnique(12) + serial(2) + api(2) + retain(4) + content + sign(2)
//          (with 0xAA bytes byte-stuffed to AA55)

const PLAIN_HEADER = "##00";
const TERM = "&&";
const MSG_HEAD = "AA";
const MSG_UNIQUE_DEFAULT = "000000000000";
const MSG_RETAIN = "0000";

// Setup-time commands (pairing, scan) use prefix "0100"; operational commands use "0000".
export const PREFIX_SETUP = "0100";
export const PREFIX_OPERATIONAL = "0000";

// Across API codes (subset). See AcrossApi.java in the decompiled APK for the full list.
export const API = {
  GET_HEART: "31",
  GET_AUTH: "32",
  GET_DEV_INFOS: "33",
  RELEASE_AUTH: "34",
  SET_UNIQUE_CODE: "35",
  GET_STATUS: "36",
  SET_START_BOIL: "39",
  SET_STOP_BOIL: "3A",
  SET_START_KEEP_WARM: "3B",
  SET_STOP_KEEP_WARM: "3C",
  GET_SEARCH_WIFI: "3D",
  SET_UPPER_WIFI: "3E",
  SET_KETTLE_ADDRESS: "3F",
  SET_KETTLE_ON: "41",
  SET_KETTLE_STANDBY: "42",
} as const;

// ---------- low-level hex helpers ----------

const u8hex = (n: number): string => n.toString(16).padStart(2, "0").toUpperCase();
const u16hex4 = (n: number): string => n.toString(16).padStart(4, "0").toUpperCase();

export const strToHex = (s: string): string =>
  Buffer.from(s, "utf8").toString("hex").toUpperCase();

export const hexToStr = (h: string): string => Buffer.from(h, "hex").toString("utf8");

const lenAsHexByte = (hexStr: string): string => u8hex(hexStr.length / 2);
const lenAsHex2Bytes = (hexStr: string): string => u16hex4(hexStr.length / 2 + 1);

const sign = (hexStr: string): string => {
  let total = 0;
  for (let i = 0; i < hexStr.length; i += 2) total += parseInt(hexStr.slice(i, i + 2), 16);
  return u8hex((total ^ 0xff) & 0xff);
};

const stuff = (hexStr: string): string => {
  let out = "";
  for (let i = 0; i < hexStr.length; i += 2) {
    const b = hexStr.slice(i, i + 2).toUpperCase();
    out += b === "AA" ? "AA55" : b;
  }
  return out;
};

const unstuff = (hexStr: string): string => {
  let out = "";
  let head = false;
  for (let i = 0; i < hexStr.length; i += 2) {
    const b = hexStr.slice(i, i + 2).toUpperCase();
    if (b === "AA") {
      out += "AA";
      head = true;
    } else {
      if (!(head && b === "55")) out += b;
      head = false;
    }
  }
  return out;
};

// ---------- Across frame builders ----------

export interface FrameOpts {
  api: string;
  content?: string;
  serial: number;
  prefix?: string;
  msgUnique?: string;
}

export const buildAcrossFrame = ({
  api,
  content = "",
  serial,
  prefix = PREFIX_OPERATIONAL,
  msgUnique = MSG_UNIQUE_DEFAULT,
}: FrameOpts): string => {
  const msg = prefix + msgUnique + u8hex(serial) + api + MSG_RETAIN + content;
  const frameLen = lenAsHex2Bytes(msg);
  const stuffed = stuff(frameLen + msg);
  const sig = sign(stuffed);
  return (MSG_HEAD + stuffed + stuff(sig)).toUpperCase();
};

// ---------- Outer JSON + ## frame ----------

export const wrapJson = (imei: string, data2: string): string =>
  JSON.stringify({ app_cmd: "62", imei, SubDev: "", data2 });

export const wireFrame = (jsonBody: string): string =>
  PLAIN_HEADER + u8hex(jsonBody.length) + jsonBody + TERM;

export const buildWire = (imei: string, frame: FrameOpts): string =>
  wireFrame(wrapJson(imei, buildAcrossFrame(frame)));

// ---------- High-level command builders ----------

export const cmdGetSearchWifiLists = (serial: number) =>
  ({ api: API.GET_SEARCH_WIFI, serial, prefix: PREFIX_SETUP }) satisfies FrameOpts;

export const cmdSetUpperWifi = (serial: number, essidHex: string, password: string): FrameOpts => {
  const pwdHex = strToHex(password);
  const content = lenAsHexByte(essidHex) + essidHex + lenAsHexByte(pwdHex) + pwdHex;
  return { api: API.SET_UPPER_WIFI, serial, prefix: PREFIX_SETUP, content };
};

export const cmdGetStatus = (serial: number) =>
  ({ api: API.GET_STATUS, serial }) satisfies FrameOpts;

// setStartBoil format from APK: boilType(1) + targetTemp(1) + keepWarmTime(1) + brewTime(1) + delayTime(1)
export interface BoilArgs {
  targetTemp?: number;
  keepWarmMinutes?: number;
  brewTime?: number;
  delayTime?: number;
  boilType?: number;
}
export const cmdSetStartBoil = (serial: number, args: BoilArgs = {}): FrameOpts => {
  const { boilType = 0, targetTemp = 100, keepWarmMinutes = 0, brewTime = 0, delayTime = 0 } = args;
  const content = u8hex(boilType) + u8hex(targetTemp) + u8hex(keepWarmMinutes) + u8hex(brewTime) + u8hex(delayTime);
  return { api: API.SET_START_BOIL, serial, content };
};

export const cmdSetStopBoil = (serial: number) =>
  ({ api: API.SET_STOP_BOIL, serial }) satisfies FrameOpts;

export const cmdSetStartKeepWarm = (serial: number) =>
  ({ api: API.SET_START_KEEP_WARM, serial }) satisfies FrameOpts;

export const cmdSetStopKeepWarm = (serial: number) =>
  ({ api: API.SET_STOP_KEEP_WARM, serial }) satisfies FrameOpts;

export const cmdSetKettleStandby = (serial: number) =>
  ({ api: API.SET_KETTLE_STANDBY, serial }) satisfies FrameOpts;

// ---------- Reply parsing ----------

export interface AcrossReply {
  head: string;
  frameLen: number;
  prefix: string;
  msgUnique: string;
  serial: number;
  api: string;
  retain: string;
  content: string;
  sign: string;
}

export const parseAcross = (data3Hex: string): AcrossReply | null => {
  const u = unstuff(data3Hex.toUpperCase());
  if (u.length < 32) return null;
  return {
    head: u.slice(0, 2),
    frameLen: parseInt(u.slice(2, 6), 16),
    prefix: u.slice(6, 10),
    msgUnique: u.slice(10, 22),
    serial: parseInt(u.slice(22, 24), 16),
    api: u.slice(24, 26),
    retain: u.slice(26, 30),
    content: u.slice(30, -2),
    sign: u.slice(-2),
  };
};

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
  temperature: number;     // °C, current
  targetTemperature: number; // °C, last setpoint
  volume: number;          // ml in kettle
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

export const parseScanList = (contentHex: string): { ok: true; entries: ScanEntry[] } | { ok: false; error: string } => {
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

// Extract data3 hex blob from a wire frame (utility for callers parsing raw socket bytes).
export const extractData3 = (wireFrame: string): string | null => {
  const m = wireFrame.match(/"data3":"([0-9a-fA-F]+)"/);
  return m ? m[1] : null;
};
