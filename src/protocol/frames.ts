// Across frame builders, parsers, and the outer JSON/wire envelope.
//
// Wire format:
//   outer: ##00<2-hex-len>{json}&&            (## + plaintext flag + length + body + terminator)
//   json:  {"app_cmd":"62","imei":"…","SubDev":"","data2":"<across-hex>"}
//   data2: AA + frameLen(4) + prefix(4) + msgUnique(12) + serial(2) + api(2) + retain(4) + content + sign(2)
//          (with 0xAA bytes byte-stuffed to AA55)

import { lenAsHex2Bytes, sign, stuff, u8hex, unstuff } from "./hex.js";

const PLAIN_HEADER = "##00";
const TERM = "&&";
const MSG_HEAD = "AA";
const MSG_UNIQUE_DEFAULT = "000000000000";
const MSG_RETAIN = "0000";

// Setup-time commands (pairing, scan) use prefix "0100"; operational commands use "0000".
export const PREFIX_SETUP = "0100";
export const PREFIX_OPERATIONAL = "0000";

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

export const wrapJson = (imei: string, data2: string): string =>
  JSON.stringify({ app_cmd: "62", imei, SubDev: "", data2 });

export const wireFrame = (jsonBody: string): string =>
  PLAIN_HEADER + u8hex(jsonBody.length) + jsonBody + TERM;

export const buildWire = (imei: string, frame: FrameOpts): string =>
  wireFrame(wrapJson(imei, buildAcrossFrame(frame)));

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

// Extract data3 hex blob from a wire frame (utility for callers parsing raw socket bytes).
// Loose regex; works because data3 is pure hex and the JSON has no escape sequences.
export const extractData3 = (wire: string): string | null => {
  const m = wire.match(/"data3":"([0-9a-fA-F]+)"/);
  return m ? m[1] : null;
};
