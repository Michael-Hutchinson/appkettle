// Integration test: KettleClient driven against a real TCP server that mimics the kettle.
// Verifies the full send → frame parse → API correlation → ack-check loop end-to-end.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { KettleClient } from "./client.js";
import { KettleConnectError, KettleNackError } from "./errors.js";
import { buildAcrossFrame, parseAcross, wireFrame } from "./protocol/index.js";

/** Build a wire frame of the shape the kettle sends back: outer JSON has data3 (not data2). */
const buildReplyWire = (api: string, content: string, serial = 1): string => {
  const inner = buildAcrossFrame({ api, content, serial });
  const json = JSON.stringify({ wifi_cmd: "62", data3: inner });
  return wireFrame(json);
};

interface FakeServer {
  server: net.Server;
  port: number;
  /** Close all open client sockets and the listening socket. */
  teardown: () => Promise<void>;
}

/** A fake kettle: parses incoming Across frames, echoes a reply with the same API + a chosen ack. */
const startFakeKettle = async (
  ackBuilder: (api: string) => string = () => "C8",
  // Optional override of the per-connection handler. Default echoes valid replies.
  handler?: (sock: net.Socket) => void,
): Promise<FakeServer> => {
  const sockets = new Set<net.Socket>();
  const defaultHandler = (sock: net.Socket): void => {
    sock.write(buildReplyWire("A4", "C8"));
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const i = buf.indexOf("&&");
        if (i < 0) break;
        const wire = buf.subarray(0, i + 2).toString("ascii");
        buf = buf.subarray(i + 2);
        if (wire.includes("KeepConnect")) continue;
        const data2 = wire.match(/"data2":"([0-9A-Fa-f]+)"/)?.[1];
        if (!data2) continue;
        const reply = parseAcross(data2);
        if (!reply) continue;
        sock.write(buildReplyWire(reply.api, ackBuilder(reply.api)));
      }
    });
  };

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    (handler ?? defaultHandler)(sock);
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;

  return {
    server,
    port,
    teardown: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
};

const runWith = async (
  fake: FakeServer,
  fn: (client: KettleClient) => Promise<void>,
): Promise<void> => {
  const client = new KettleClient({ ip: "127.0.0.1", port: fake.port, imei: "test-imei" });
  client.on("error", () => {});
  try {
    await fn(client);
  } finally {
    client.close();
    await fake.teardown();
  }
};

test("KettleClient round-trips a boil through a real TCP socket", async () => {
  const fake = await startFakeKettle();
  await runWith(fake, async (client) => {
    await client.connectAndWait(2000);
    // boil() auto-wakes (api 41) then sends boil (api 39); both must round-trip.
    await client.boil({ targetTemp: 95 });
  });
});

test("KettleClient surfaces a non-C8 ack as KettleNackError", async () => {
  const fake = await startFakeKettle((api) => (api === "39" ? "00" : "C8"));
  await runWith(fake, async (client) => {
    await client.connectAndWait(2000);
    await assert.rejects(client.boil(), (e: unknown) => {
      assert.ok(e instanceof KettleNackError, "expected KettleNackError");
      assert.equal((e as KettleNackError).api, "39");
      assert.equal((e as KettleNackError).ack, "00");
      return true;
    });
  });
});

test("connectAndWait rejects with KettleConnectError when the server never sends a frame", async () => {
  // Handler that holds the socket open without writing anything.
  const fake = await startFakeKettle(undefined, () => {});
  await runWith(fake, async (client) => {
    await assert.rejects(
      client.connectAndWait(150),
      (e: unknown) => e instanceof KettleConnectError,
    );
  });
});
