# appkettle

Local-network bridge for the AppKettle smart kettle. The vendor (iFavine) and
their cloud (jingxuncloud) are defunct; this talks to the kettle directly over
its proprietary "Across" protocol on TCP/6002, reverse-engineered from the
official Android APK (`com.ifavine.appkettle` 1.3.9) and the
[`tinaught/appkettleapi`](https://github.com/tinaught/appkettleapi) project.

Provides:

- A pure-TypeScript **protocol library** (`src/protocol/`) — hex helpers, frame builders, command builders, and reply parsers in focused modules
- A **TCP client** (`src/client.ts`) with exponential-backoff reconnect and status caching from heartbeats
- A **CLI** (`src/cli.ts`) for sanity-testing and one-shot Wi-Fi pairing
- An **MCP server** (`src/mcp.ts`, stdio transport) for Claude Code / Desktop
- Typed error classes (`src/errors.ts`) and a leveled stderr logger (`src/logger.ts`)

A native phone app and a Raspberry Pi host for remote access (via Tailscale) are planned.

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
npm run cli setup        # interactive Wi-Fi pairing (see "Pairing the kettle")
```

If `KETTLE_IP` / `KETTLE_IMEI` env vars are set, those are used; otherwise the
client auto-discovers via UDP broadcast on port 15103. Set `LOG_LEVEL` to
`debug | info | warn | error` (default `info`) to control log verbosity — logs
go to stderr to keep MCP stdio clean.

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
- `kettle_keep_warm_start` — engage keep-warm at the current target temp
- `kettle_keep_warm_stop` — cancel keep-warm
- `kettle_wait_until_ready` — block until heating finishes or `target_temp` is reached
- `kettle_discover` — re-find IP if your DHCP lease changed

## Pairing the kettle

Use this when the kettle has no Wi-Fi credentials yet (new kettle, house move,
or a router change). Pairing requires your laptop to be on the kettle's own AP
during setup — Wi-Fi credentials can't be pushed over the home network.

1. Long-press the kettle's button until it enters pairing mode.
2. Connect your laptop to the kettle's AP (typically `AK_Kettle`).
3. Run the interactive flow:

   ```bash
   npm run cli setup
   ```

   It scans nearby networks, lets you pick one, prompts for the password, and
   sends `SET_UPPER_WIFI` (API `3E`).
4. Reconnect your laptop to your home Wi-Fi.
5. Confirm the kettle joined: `npm run cli discover`.

## Protocol notes

- Wire frame: `##00<2-hex-len>{json}&&`
- JSON: `{"app_cmd":"62","imei":"...","SubDev":"","data2":"<across-hex>"}`
- Across inner: `AA + frameLen(4) + prefix(4) + msgUnique(12) + serial(2) + api(2) + retain(4) + content + sign(2)` (with `0xAA` byte-stuffed to `AA55`)
- `data1`-style replies (`wifi_cmd:61`) are unrelated red herrings — the real protocol is binary inside `data2`.
- Discovery: UDP/15103 broadcast `Probe#YYYY-MM-DD-HH-MM-SS-1`; reply has the kettle's IMEI, version, and `deviceStatus` blob.

## Development

```bash
npm run lint        # ESLint (typescript-eslint recommended)
npm run typecheck   # tsc --noEmit
npm test            # node --test via tsx
npm run format      # prettier --write
```

CI runs `lint → typecheck → test` on every push and PR. `prepublishOnly`
runs the same gauntlet plus `build` before allowing `npm publish`.

## License

[MIT](./LICENSE)
