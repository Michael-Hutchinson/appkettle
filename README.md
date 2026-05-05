# appkettle

Local-network bridge for the AppKettle smart kettle. The vendor (iFavine) and
their cloud (jingxuncloud) are defunct; this talks to the kettle directly over
its proprietary "Across" protocol on TCP/6002, reverse-engineered from the
official Android APK (`com.ifavine.appkettle` 1.3.9) and the
[`tinaught/appkettleapi`](https://github.com/tinaught/appkettleapi) project.

Provides:

- A pure-TypeScript **protocol library** (`src/protocol.ts`)
- A **TCP client** (`src/client.ts`) with auto-reconnect and status polling
- A **CLI** (`src/cli.ts`) for sanity-testing
- An **MCP server** (`src/mcp.ts`, stdio transport) for Claude Code / Desktop

A Next.js PWA front-end is planned.

## Setup

```bash
npm install
npm run build
```

## Quick CLI test

```bash
npm run discover         # find kettle on local network
npm run cli status       # current temperature / state / volume
npm run cli boil 95      # boil to 95°C
npm run cli boil 100 5   # boil and keep warm 5min
npm run cli stop
npm run cli standby
```

If `KETTLE_IP` / `KETTLE_IMEI` env vars are set, those are used; otherwise the
client auto-discovers via UDP broadcast on port 15103.

## MCP server

The MCP server runs over stdio, so Claude Code/Desktop spawns it as a subprocess.

After `npm run build`:

**Claude Code** — register via the CLI (canonical method):

```bash
claude mcp add-json appkettle '{
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/appkettle/dist/mcp.js"],
  "env": { "KETTLE_IP": "192.168.1.202", "KETTLE_IMEI": "GD0-12900-7a00" }
}' -s user
```

Verify with `claude mcp list` — should show `appkettle: ✓ Connected`.

**Claude Desktop** — same shape in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "appkettle": {
      "command": "node",
      "args": ["/absolute/path/to/appkettle/dist/mcp.js"],
      "env": { "KETTLE_IP": "192.168.1.202", "KETTLE_IMEI": "GD0-12900-7a00" }
    }
  }
}
```

Restart Claude. Tools available:

- `kettle_status` — current temp / state / volume
- `kettle_boil` — start a boil (optional `target_temp`, `keep_warm_minutes`)
- `kettle_stop` — cancel boil / keep-warm
- `kettle_standby` — display off
- `kettle_discover` — re-find IP if your DHCP lease changed

## Pairing the kettle

This repo does not handle pairing — that's a one-time bootstrap that requires
your Mac to switch to the kettle's `AK_Kettle` AP. Use the `pair-kettle.mjs`
script in the original session, or port it later. The API for pairing is
`SET_UPPER_WIFI` (3E) — see `src/protocol.ts` for the frame format.

## Protocol notes

- Wire frame: `##00<2-hex-len>{json}&&`
- JSON: `{"app_cmd":"62","imei":"...","SubDev":"","data2":"<across-hex>"}`
- Across inner: `AA + frameLen(4) + prefix(4) + msgUnique(12) + serial(2) + api(2) + retain(4) + content + sign(2)` (with `0xAA` byte-stuffed to `AA55`)
- `data1`-style replies (`wifi_cmd:61`) are unrelated red herrings — the real protocol is binary inside `data2`.
- Discovery: UDP/15103 broadcast `Probe#YYYY-MM-DD-HH-MM-SS-1`; reply has the kettle's IMEI, version, and `deviceStatus` blob.
