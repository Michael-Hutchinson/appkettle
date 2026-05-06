// High-level command builders. See AcrossApi.java in the decompiled APK for the full list.

import { lenAsHexByte, strToHex, u8hex } from "./hex.js";
import { PREFIX_SETUP, type FrameOpts } from "./frames.js";

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

// Wake the kettle from standby. Required before SET_START_BOIL on some firmware:
// a kettle that's been idle in Standby will reject 39 with ack=00 until woken.
export const cmdSetKettleOn = (serial: number) =>
  ({ api: API.SET_KETTLE_ON, serial }) satisfies FrameOpts;
