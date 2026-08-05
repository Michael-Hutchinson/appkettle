// Home Assistant MQTT bridge. The kettle serves one client at a time, so idle
// polls release the connection between reads, active states (Heating / Keep
// Warm) hold it, and a busy kettle is served stale and retried next tick.
import mqtt from "mqtt";
import { isConnectionLossError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { KettleStatus } from "./protocol/parsers.js";

const BASE = "appkettle";
const TOPIC_STATE = `${BASE}/state`;
const TOPIC_AVAIL = `${BASE}/availability`;
const TOPIC_CMD = `${BASE}/cmd`;
const DISCOVERY_PREFIX = "homeassistant";

const ACTIVE_STATES: ReadonlySet<string> = new Set(["Heating", "Keep Warm"]);

export const redactUrl = (raw: string): string => {
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable url>";
  }
};

export interface BridgeKettle {
  pollStatus(): Promise<KettleStatus>;
  boil(args: { targetTemp?: number; keepWarmMinutes?: number }): Promise<void>;
  stop(): Promise<void>;
  standby(): Promise<void>;
  startKeepWarm(): Promise<void>;
  stopKeepWarm(): Promise<void>;
}

export interface KettleSource {
  ensure(): Promise<BridgeKettle>;
  release(): void;
}

export interface BridgeOpts {
  url: string;
  idlePollMs?: number;
  activePollMs?: number;
}

interface StatePayload extends KettleStatus {
  target_set: number;
  stale: boolean;
  last_update: string | null;
  last_error: string | null;
}

const DEVICE = {
  identifiers: ["appkettle"],
  name: "AppKettle",
  manufacturer: "iFavine",
  model: "AppKettle",
};

const entity = (base: Record<string, unknown>) => ({
  availability_topic: TOPIC_AVAIL,
  device: DEVICE,
  ...base,
});

// Retained so HA rediscovers the kettle after a restart.
const DISCOVERY: Array<{ topic: string; payload: Record<string, unknown> }> = [
  {
    topic: `${DISCOVERY_PREFIX}/sensor/appkettle_temp/config`,
    payload: entity({
      name: "Temperature",
      unique_id: "appkettle_temp",
      state_topic: TOPIC_STATE,
      value_template: "{{ value_json.temperature }}",
      unit_of_measurement: "°C",
      device_class: "temperature",
      state_class: "measurement",
    }),
  },
  {
    topic: `${DISCOVERY_PREFIX}/sensor/appkettle_volume/config`,
    payload: entity({
      name: "Water volume",
      unique_id: "appkettle_volume",
      state_topic: TOPIC_STATE,
      value_template: "{{ value_json.volume }}",
      unit_of_measurement: "mL",
      icon: "mdi:cup-water",
    }),
  },
  {
    topic: `${DISCOVERY_PREFIX}/sensor/appkettle_state/config`,
    payload: entity({
      name: "State",
      unique_id: "appkettle_state",
      state_topic: TOPIC_STATE,
      value_template: "{{ value_json.state }}",
      icon: "mdi:kettle",
    }),
  },
  {
    topic: `${DISCOVERY_PREFIX}/sensor/appkettle_last_update/config`,
    payload: entity({
      name: "Last update",
      unique_id: "appkettle_last_update",
      state_topic: TOPIC_STATE,
      value_template: "{{ value_json.last_update }}",
      device_class: "timestamp",
      entity_category: "diagnostic",
    }),
  },
  {
    topic: `${DISCOVERY_PREFIX}/number/appkettle_target/config`,
    payload: entity({
      name: "Target temperature",
      unique_id: "appkettle_target",
      state_topic: TOPIC_STATE,
      value_template: "{{ value_json.target_set }}",
      command_topic: `${TOPIC_CMD}/target_temp`,
      min: 40,
      max: 100,
      step: 5,
      unit_of_measurement: "°C",
      icon: "mdi:thermometer",
    }),
  },
  {
    topic: `${DISCOVERY_PREFIX}/button/appkettle_boil/config`,
    payload: entity({
      name: "Boil",
      unique_id: "appkettle_boil",
      command_topic: `${TOPIC_CMD}/boil`,
      icon: "mdi:kettle-steam",
    }),
  },
  {
    topic: `${DISCOVERY_PREFIX}/button/appkettle_stop/config`,
    payload: entity({
      name: "Stop",
      unique_id: "appkettle_stop",
      command_topic: `${TOPIC_CMD}/stop`,
      icon: "mdi:stop",
    }),
  },
  {
    topic: `${DISCOVERY_PREFIX}/button/appkettle_standby/config`,
    payload: entity({
      name: "Standby",
      unique_id: "appkettle_standby",
      command_topic: `${TOPIC_CMD}/standby`,
      icon: "mdi:power-sleep",
    }),
  },
  {
    topic: `${DISCOVERY_PREFIX}/switch/appkettle_keep_warm/config`,
    payload: entity({
      name: "Keep warm",
      unique_id: "appkettle_keep_warm",
      state_topic: TOPIC_STATE,
      value_template:
        "{{ 'ON' if value_json.state == 'Keep Warm' else 'OFF' }}",
      command_topic: `${TOPIC_CMD}/keep_warm`,
      icon: "mdi:heat-wave",
    }),
  },
];

export class MqttBridge {
  private client: mqtt.MqttClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private targetTemp = 100;
  private last: KettleStatus | null = null;
  private lastUpdate: string | null = null;
  private lastError: string | null = null;
  private active = false;
  private stopping = false;
  private readonly idlePollMs: number;
  private readonly activePollMs: number;

  constructor(
    private readonly source: KettleSource,
    private readonly log: Logger,
    private readonly opts: BridgeOpts,
  ) {
    this.idlePollMs = opts.idlePollMs ?? 90_000;
    this.activePollMs = opts.activePollMs ?? 5_000;
  }

  async start(): Promise<void> {
    const client = mqtt.connect(this.opts.url, {
      will: { topic: TOPIC_AVAIL, payload: "offline", retain: true, qos: 0 },
    });
    this.client = client;
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("error", (e) => reject(e));
    });
    for (const d of DISCOVERY) {
      await client.publishAsync(d.topic, JSON.stringify(d.payload), {
        retain: true,
      });
    }
    await client.publishAsync(TOPIC_AVAIL, "online", { retain: true });
    await client.subscribeAsync(`${TOPIC_CMD}/#`);
    client.on("message", (topic, payload) => {
      void this.onCommand(topic, payload.toString())
        .then(() => {
          this.lastError = null;
        })
        .catch(async (e) => {
          // A refused boil (low water) lands here; surfaced to HA as last_error.
          this.lastError = String(e);
          this.log.warn(`command ${topic} failed: ${String(e)}`);
          if (isConnectionLossError(e)) this.source.release();
          await this.safePublishState(false);
        });
    });
    this.log.info(`MQTT bridge up (${redactUrl(this.opts.url)}), polling`);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.source.release();
    if (this.client) {
      await this.client.publishAsync(TOPIC_AVAIL, "offline", { retain: true });
      await this.client.endAsync();
    }
  }

  private schedule(ms: number): void {
    if (this.stopping) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const kettle = await this.source.ensure();
      const s = await kettle.pollStatus();
      this.last = s;
      this.lastUpdate = new Date().toISOString();
      this.active = ACTIVE_STATES.has(s.state);
      await this.publishState(false);
      if (!this.active) this.source.release();
    } catch (e) {
      // Most likely the phone app holds the kettle.
      this.log.warn(`kettle unavailable this tick: ${String(e)}`);
      this.active = false;
      this.source.release();
      await this.safePublishState(true);
    }
    this.schedule(this.active ? this.activePollMs : this.idlePollMs);
  }

  // For void-invoked paths, where a rejected publish would otherwise escape.
  private async safePublishState(stale: boolean): Promise<void> {
    try {
      await this.publishState(stale);
    } catch (e) {
      this.log.warn(`state publish failed: ${String(e)}`);
    }
  }

  private async publishState(stale: boolean): Promise<void> {
    if (!this.client) return;
    const payload: StatePayload = {
      ...(this.last ?? {
        state: "Not on base",
        power: "OFF",
        temperature: 0,
        targetTemperature: 0,
        volume: 0,
        keepWarmSecondsLeft: 0,
      }),
      target_set: this.targetTemp,
      stale,
      last_update: this.lastUpdate,
      last_error: this.lastError,
    };
    await this.client.publishAsync(TOPIC_STATE, JSON.stringify(payload), {
      retain: true,
    });
  }

  private async onCommand(topic: string, payload: string): Promise<void> {
    const cmd = topic.slice(TOPIC_CMD.length + 1);
    if (cmd === "target_temp") {
      const t = Number(payload);
      if (Number.isFinite(t) && t >= 40 && t <= 100) {
        this.targetTemp = Math.round(t);
        await this.publishState(false);
      }
      return;
    }
    if (cmd === "boil_to") {
      const t = Number(payload);
      if (Number.isFinite(t) && t >= 40 && t <= 100) {
        this.targetTemp = Math.round(t);
      }
    }
    const kettle = await this.source.ensure();
    switch (cmd) {
      case "boil":
      case "boil_to":
        await kettle.boil({ targetTemp: this.targetTemp });
        this.active = true;
        break;
      case "stop":
        await kettle.stop();
        break;
      case "standby":
        await kettle.standby();
        break;
      case "keep_warm":
        if (payload === "ON") {
          await kettle.startKeepWarm();
          this.active = true;
        } else {
          await kettle.stopKeepWarm();
        }
        break;
      default:
        this.log.warn(`unknown command topic: ${topic}`);
        return;
    }
    this.schedule(this.activePollMs);
  }
}
