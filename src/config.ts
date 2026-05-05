// Config: env vars first, then auto-discovery.
import { discoverKettle } from "./discovery.js";

export interface KettleConfig {
  ip: string;
  imei: string;
}

export const loadKettleConfig = async (): Promise<KettleConfig> => {
  const ip = process.env.KETTLE_IP;
  const imei = process.env.KETTLE_IMEI;
  if (ip && imei) return { ip, imei };

  const k = await discoverKettle();
  return { ip: k.ip, imei: k.imei };
};
