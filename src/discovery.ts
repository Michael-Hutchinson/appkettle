// UDP/15103 broadcast discovery for AppKettle on the local network.
// Sends "Probe#YYYY-MM-DD-HH-MM-SS-1" and parses the reply.
import dgram from "node:dgram";
import os from "node:os";

const PORT = 15103;

export interface DiscoveredKettle {
  ip: string;
  imei: string;
  version: string;
  apSsid?: string;
  devRouter?: string;
  deviceStatus?: string;
}

const broadcastTargets = (extra?: string): string[] => {
  const set = new Set<string>(["255.255.255.255"]);
  if (extra) set.add(extra);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        const parts = iface.address.split(".");
        parts[3] = "255";
        set.add(parts.join("."));
      }
    }
  }
  return [...set];
};

export const discoverKettle = (timeoutMs = 8000, broadcast?: string): Promise<DiscoveredKettle> =>
  new Promise((resolve, reject) => {
    const probe = `Probe#${new Date().toISOString().replace(/[T:]/g, "-").replace(/\..+/, "")}-1`;
    const targets = broadcastTargets(broadcast);
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let resolved = false;

    const finish = (err: Error | null, k?: DiscoveredKettle): void => {
      if (resolved) return;
      resolved = true;
      try {
        sock.close();
      } catch {}
      if (err) reject(err);
      else if (k) resolve(k);
    };

    sock.on("message", (msg, rinfo) => {
      const text = msg.toString("ascii");
      if (text.startsWith("Probe#")) return; // ignore own broadcast loopback
      const parts = text.split("#");
      if (parts.length < 7) return;
      try {
        const j = JSON.parse(parts[6]);
        finish(null, {
          ip: rinfo.address,
          imei: parts[0],
          version: parts[3] ?? "",
          apSsid: j.AP_ssid,
          devRouter: j.devRouter,
          deviceStatus: j.deviceStatus,
        });
      } catch {
        // ignore malformed
      }
    });

    sock.on("error", (e) => finish(e));

    sock.on("listening", () => {
      sock.setBroadcast(true);
      let sends = 0;
      const id = setInterval(() => {
        for (const t of targets) sock.send(probe, PORT, t, () => {});
        if (++sends >= 6 || resolved) clearInterval(id);
      }, 1500);
    });

    sock.bind(PORT);
    setTimeout(() => finish(new Error(`Discovery timeout after ${timeoutMs}ms`)), timeoutMs);
  });

// CLI entry: `npm run discover`
if (import.meta.url === `file://${process.argv[1]}`) {
  discoverKettle()
    .then((k) => {
      console.log("Discovered kettle:");
      console.log(JSON.stringify(k, null, 2));
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(2);
    });
}
