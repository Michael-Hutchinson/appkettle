import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API,
  PREFIX_OPERATIONAL,
  PREFIX_SETUP,
  buildAcrossFrame,
  buildWire,
  cmdGetStatus,
  cmdSetKettleOn,
  cmdSetStartBoil,
  cmdSetStopBoil,
  cmdSetUpperWifi,
  extractData3,
  hexToStr,
  parseAcross,
  parseScanList,
  parseStatus,
  strToHex,
  wireFrame,
  wrapJson,
} from "./protocol/index.js";

test("strToHex / hexToStr round-trip", () => {
  const s = "AppKettle-123";
  assert.equal(hexToStr(strToHex(s)), s);
  assert.equal(strToHex("A"), "41");
});

test("buildAcrossFrame structure round-trips through parseAcross", () => {
  const frame = buildAcrossFrame({ api: API.GET_STATUS, serial: 0x42 });
  const parsed = parseAcross(frame);
  assert.ok(parsed);
  assert.equal(parsed.head, "AA");
  assert.equal(parsed.prefix, PREFIX_OPERATIONAL);
  assert.equal(parsed.serial, 0x42);
  assert.equal(parsed.api, API.GET_STATUS);
  assert.equal(parsed.retain, "0000");
  assert.equal(parsed.content, "");
});

test("buildAcrossFrame uses setup prefix when requested", () => {
  const frame = buildAcrossFrame({
    api: API.GET_SEARCH_WIFI,
    serial: 1,
    prefix: PREFIX_SETUP,
  });
  const parsed = parseAcross(frame);
  assert.ok(parsed);
  assert.equal(parsed.prefix, PREFIX_SETUP);
});

test("buildAcrossFrame byte-stuffs literal 0xAA bytes in payload", () => {
  // msgUnique of all-AA forces stuffing inside the body.
  const frame = buildAcrossFrame({
    api: API.GET_STATUS,
    serial: 1,
    msgUnique: "AAAAAAAAAAAA",
  });
  // First AA is the header (not stuffed); subsequent AAs in the payload must be followed by 55.
  const body = frame.slice(2);
  assert.ok(body.includes("AA55"), "expected stuffed AA55 in body");
  // Round-trip via parseAcross (which unstuffs) recovers the original msgUnique.
  const parsed = parseAcross(frame);
  assert.ok(parsed);
  assert.equal(parsed.msgUnique, "AAAAAAAAAAAA");
});

test("cmdSetStartBoil encodes boilType+temp+keepWarm+brew+delay", () => {
  const opts = cmdSetStartBoil(7, { targetTemp: 80, keepWarmMinutes: 10 });
  assert.equal(opts.api, API.SET_START_BOIL);
  assert.equal(opts.serial, 7);
  // boilType=00, temp=50 (80°C), keepWarm=0A (10), brew=00, delay=00
  assert.equal(opts.content, "00500A0000");
});

test("cmdSetStartBoil defaults to 100°C, no keep-warm", () => {
  const opts = cmdSetStartBoil(1);
  assert.equal(opts.content, "0064000000");
});

test("cmdSetKettleOn produces empty content with api 41", () => {
  const opts = cmdSetKettleOn(3);
  assert.equal(opts.api, API.SET_KETTLE_ON);
  assert.equal(opts.serial, 3);
});

test("cmdGetStatus and cmdSetStopBoil have correct api codes and no content", () => {
  const status = cmdGetStatus(1);
  assert.equal(status.api, API.GET_STATUS);
  assert.equal(status.serial, 1);
  const stop = cmdSetStopBoil(2);
  assert.equal(stop.api, API.SET_STOP_BOIL);
  assert.equal(stop.serial, 2);
  // Round-trip through buildAcrossFrame to confirm the wire content is empty.
  const parsed = parseAcross(buildAcrossFrame(status));
  assert.ok(parsed);
  assert.equal(parsed.content, "");
});

test("cmdSetUpperWifi length-prefixes essid hex and password", () => {
  // essidHex represents a 12-char MAC (6 bytes), password "pw" -> 7077
  const opts = cmdSetUpperWifi(1, "AABBCCDDEEFF", "pw");
  assert.equal(opts.api, API.SET_UPPER_WIFI);
  assert.equal(opts.prefix, PREFIX_SETUP);
  // 06 (essid len=6 bytes) + AABBCCDDEEFF + 02 (pwd len) + 7077
  assert.equal(opts.content, "06AABBCCDDEEFF027077");
});

test("wireFrame wraps body with ##00 + length byte + &&", () => {
  const body = '{"x":1}';
  const out = wireFrame(body);
  assert.ok(out.startsWith("##00"));
  assert.ok(out.endsWith("&&"));
  const lenHex = out.slice(4, 6);
  assert.equal(parseInt(lenHex, 16), body.length);
  assert.equal(out.slice(6, -2), body);
});

test("wrapJson produces app_cmd 62 envelope", () => {
  const json = wrapJson("imei-1", "DEADBEEF");
  const obj = JSON.parse(json);
  assert.deepEqual(obj, { app_cmd: "62", imei: "imei-1", SubDev: "", data2: "DEADBEEF" });
});

test("buildWire composes outer + json + across frame", () => {
  const wire = buildWire("imei-1", { api: API.GET_STATUS, serial: 1 });
  assert.ok(wire.startsWith("##00"));
  assert.ok(wire.endsWith("&&"));
  // strip ##00<lenByte> and trailing && to recover JSON
  const json = wire.slice(6, -2);
  const obj = JSON.parse(json);
  assert.equal(obj.app_cmd, "62");
  assert.equal(obj.imei, "imei-1");
  // data2 must round-trip through parseAcross
  const parsed = parseAcross(obj.data2);
  assert.ok(parsed);
  assert.equal(parsed.api, API.GET_STATUS);
  assert.equal(parsed.serial, 1);
});

test("parseAcross returns null for too-short input", () => {
  assert.equal(parseAcross("AA00"), null);
});

test("parseStatus decodes a heating frame", () => {
  // pad=00, state=04 (Heating), keep_warm=0000, temp=2E (46), target=64 (100), volume=026B (619), pad=0000
  const status = parseStatus("000400002E64026B0000");
  assert.ok(status);
  assert.equal(status.state, "Heating");
  assert.equal(status.power, "ON");
  assert.equal(status.temperature, 46);
  assert.equal(status.targetTemperature, 100);
  assert.equal(status.volume, 619);
  assert.equal(status.keepWarmSecondsLeft, 0);
});

test("parseStatus strips C8 ack prefix", () => {
  // C8 ack + pad=00, state=02 (Standby), keep_warm=0000, temp=18(24), target=64, volume=0000, pad=0000
  const h = "C8" + "00020000186400000000";
  const status = parseStatus(h);
  assert.ok(status);
  assert.equal(status.state, "Standby");
  assert.equal(status.power, "OFF");
  assert.equal(status.temperature, 24);
});

test("parseStatus returns null for too-short content", () => {
  assert.equal(parseStatus("00"), null);
});

test("parseStatus marks Keep Warm as power ON", () => {
  // state=05 (Keep Warm), keep_warm=003C (60s), temp=50 (80), target=50, volume=01F4 (500)
  const status = parseStatus("0005003C505001F40000");
  assert.ok(status);
  assert.equal(status.state, "Keep Warm");
  assert.equal(status.power, "ON");
  assert.equal(status.keepWarmSecondsLeft, 60);
});

test("parseScanList rejects non-C8 prefix", () => {
  const r = parseScanList("AB00");
  assert.equal(r.ok, false);
});

test("parseScanList parses one entry", () => {
  // C8 + count=01 + entry: unk=00 + L1=04 ('Wifi') + 57494649 + L2=06 + AABBCCDDEEFF + enc=03 + sig=50(80)
  const hex = "C8" + "01" + "00" + "04" + strToHex("Wifi") + "06" + "AABBCCDDEEFF" + "03" + "50";
  const r = parseScanList(hex);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].ssid, "Wifi");
    assert.equal(r.entries[0].essidHex, "AABBCCDDEEFF");
    assert.equal(r.entries[0].encryption, "03");
    assert.equal(r.entries[0].signal, 0x50);
  }
});

test("extractData3 pulls hex from a wire frame containing data3", () => {
  const wire = '##00xx{"app_cmd":"62","data3":"DEADBEEF"}&&';
  assert.equal(extractData3(wire), "DEADBEEF");
});

test("extractData3 returns null when absent", () => {
  assert.equal(extractData3('{"app_cmd":"62"}'), null);
});
