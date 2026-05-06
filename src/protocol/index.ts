// Public surface of the AppKettle "Across" protocol library.
// Reverse-engineered from com.ifavine.appkettle 1.3.9 APK and the
// tinaught/appkettleapi project.

export { hexToStr, strToHex } from "./hex.js";
export {
  PREFIX_OPERATIONAL,
  PREFIX_SETUP,
  buildAcrossFrame,
  buildWire,
  extractData3,
  parseAcross,
  wireFrame,
  wrapJson,
  type AcrossReply,
  type FrameOpts,
} from "./frames.js";
export {
  API,
  cmdGetSearchWifiLists,
  cmdGetStatus,
  cmdSetKettleOn,
  cmdSetKettleStandby,
  cmdSetStartBoil,
  cmdSetStartKeepWarm,
  cmdSetStopBoil,
  cmdSetStopKeepWarm,
  cmdSetUpperWifi,
  type BoilArgs,
} from "./commands.js";
export {
  KETTLE_STATES,
  parseScanList,
  parseStatus,
  type KettleState,
  type KettleStatus,
  type ScanEntry,
} from "./parsers.js";
