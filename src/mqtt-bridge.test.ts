import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { Aedes } from "aedes";
import mqtt from "mqtt";
import { MqttBridge, type KettleSource } from "./mqtt-bridge.js";
import { createLogger } from "./logger.js";
import type { KettleStatus } from "./protocol/parsers.js";

const log = createLogger("error");

const status = (over: Partial<KettleStatus> = {}): KettleStatus => ({
  state: "Standby",
  power: "OFF",
  temperature: 21,
  targetTemperature: 100,
  volume: 700,
  keepWarmSecondsLeft: 0,
  ...over,
});

// Fake kettle: records calls, serves scripted statuses, can simulate busy.
const fakeSource = () => {
  const calls: string[] = [];
  let next: KettleStatus = status();
  let busy = false;
  const client = {
    pollStatus: async () => {
      if (busy) throw new Error("timeout");
      calls.push("poll");
      return next;
    },
    boil: async (args: { targetTemp?: number }) => {
      calls.push(`boil:${args.targetTemp}`);
      // Real kettle starts heating on boil; without this the bridge's next
      // active poll would see Standby and fall back to idle cadence.
      next = status({ state: "Heating", power: "ON" });
    },
    stop: async () => calls.push("stop"),
    standby: async () => calls.push("standby"),
    startKeepWarm: async () => calls.push("kw:on"),
    stopKeepWarm: async () => calls.push("kw:off"),
  };
  const source: KettleSource = {
    ensure: async () => {
      if (busy) throw new Error("connect timeout");
      calls.push("ensure");
      return client as never;
    },
    release: () => calls.push("release"),
  };
  return {
    source,
    calls,
    setStatus: (s: KettleStatus) => (next = s),
    setBusy: (b: boolean) => (busy = b),
  };
};

let broker: Aedes;
let server: Server;
let url: string;

before(async () => {
  broker = await Aedes.createBroker();
  server = createServer(broker.handle);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  url = `mqtt://127.0.0.1:${addr.port}`;
});

after(async () => {
  broker.close();
  server.close();
});

const collect = (topics: string[]) => {
  const seen = new Map<string, string[]>();
  const c = mqtt.connect(url);
  c.on("message", (t, p) => {
    const arr = seen.get(t) ?? [];
    arr.push(p.toString());
    seen.set(t, arr);
  });
  const ready = new Promise<void>((res) =>
    c.on("connect", () => c.subscribe(topics, () => res())),
  );
  return { seen, ready, end: () => c.endAsync() };
};

const until = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("publishes discovery, availability and status, then releases", async () => {
  const fake = fakeSource();
  const sub = collect(["homeassistant/#", "appkettle/#"]);
  await sub.ready;
  const bridge = new MqttBridge(fake.source, log, { url, idlePollMs: 200 });
  await bridge.start();
  await until(() => (sub.seen.get("appkettle/state") ?? []).length >= 1);
  assert.equal(sub.seen.get("appkettle/availability")?.at(-1), "online");
  const disc = [...sub.seen.keys()].filter((t) =>
    t.startsWith("homeassistant/"),
  );
  assert.ok(disc.some((t) => t.includes("appkettle_temp")));
  assert.ok(disc.some((t) => t.includes("appkettle_boil")));
  const state = JSON.parse(sub.seen.get("appkettle/state")!.at(-1)!);
  assert.equal(state.temperature, 21);
  assert.ok(fake.calls.includes("release"));
  await bridge.stop();
  await sub.end();
});

test("boil command uses the set target and enters active polling", async () => {
  const fake = fakeSource();
  const bridge = new MqttBridge(fake.source, log, {
    url,
    idlePollMs: 60000,
    activePollMs: 100,
  });
  await bridge.start();
  const c = mqtt.connect(url);
  await new Promise<void>((res) => c.on("connect", () => res()));
  await c.publishAsync("appkettle/cmd/target_temp", "95");
  await c.publishAsync("appkettle/cmd/boil", "PRESS");
  await until(() => fake.calls.some((x) => x === "boil:95"));
  fake.setStatus(status({ state: "Heating", power: "ON", temperature: 60 }));
  await until(() => fake.calls.filter((x) => x === "poll").length >= 3);
  fake.setStatus(status({ state: "Ready", temperature: 95 }));
  await until(() => fake.calls.at(-1) === "release");
  await bridge.stop();
  await c.endAsync();
});

test("busy kettle keeps availability online and retries later", async () => {
  const fake = fakeSource();
  fake.setBusy(true);
  const sub = collect(["appkettle/#"]);
  await sub.ready;
  const bridge = new MqttBridge(fake.source, log, { url, idlePollMs: 150 });
  await bridge.start();
  // The broker is shared across tests, so a subscribe here can immediately
  // replay a retained appkettle/state from an earlier test. Wait for the
  // latest message to actually be stale, not just for any message to exist.
  const states = () => sub.seen.get("appkettle/state") ?? [];
  await until(() => {
    const last = states().at(-1);
    return last != null && JSON.parse(last).stale === true;
  });
  const state = JSON.parse(states().at(-1)!);
  assert.equal(state.stale, true);
  assert.equal(sub.seen.get("appkettle/availability")?.at(-1), "online");
  const countAtBusy = states().length;
  fake.setBusy(false);
  await until(() => {
    if (states().length <= countAtBusy) return false;
    const last = states().at(-1);
    return last != null && JSON.parse(last).stale === false;
  });
  await bridge.stop();
  await sub.end();
});
