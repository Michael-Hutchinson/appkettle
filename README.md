# appkettle

The AppKettle is a Wi-Fi kettle. The company that made it shut down their
cloud service, so the official app stopped working — overnight, my smart
kettle was just a kettle.

This project makes it smart again. It talks to the kettle directly over your
home Wi-Fi: no cloud, no account, nothing leaves your house. The kettle's own
language was figured out by unpacking the official Android app and reading its
code, then rebuilt from scratch in TypeScript.

What's here:

- A **command-line tool** for boiling, stopping, checking status, and pairing
  the kettle to a new Wi-Fi network
- An **[MCP](https://modelcontextprotocol.io/) server** so Claude (Code or
  Desktop) can control the kettle when you ask it to
- The **TypeScript library** underneath both, if you want to build something
  else on top

A native phone app and a Raspberry Pi host for remote access (via Tailscale)
are planned.

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

There are two transports. Most people want the **stdio** one — it's what Claude
Code and Claude Desktop expect. The **HTTP** one is for running on an always-on
host (e.g. a Raspberry Pi) so MCP clients elsewhere on your network can reach it.

### Stdio (Claude Code / Desktop)

After `npm run build`:

**Claude Code** — register via the CLI (canonical method):

```bash
claude mcp add-json appkettle '{
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/appkettle/dist/mcp.js"],
  "env": { "KETTLE_IP": "<your-kettle-ip>", "KETTLE_IMEI": "<your-kettle-imei>" }
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
      "env": {
        "KETTLE_IP": "<your-kettle-ip>",
        "KETTLE_IMEI": "<your-kettle-imei>"
      }
    }
  }
}
```

Restart Claude. Tools available:

- `kettle_status` — current temp / state / volume
- `kettle_boil` — start a boil (optional `target_temp`, `keep_warm_minutes`); auto-wakes the kettle from Standby
- `kettle_on` — explicitly wake from Standby (rarely needed since `kettle_boil` auto-wakes)
- `kettle_stop` — cancel boil / keep-warm
- `kettle_standby` — display off
- `kettle_keep_warm_start` — engage keep-warm at the current target temp
- `kettle_keep_warm_stop` — cancel keep-warm
- `kettle_wait_until_ready` — block until heating finishes or `target_temp` is reached
- `kettle_discover` — re-find IP if your DHCP lease changed

### HTTP (Pi host / remote access)

The HTTP transport hosts the same tools over a single `/mcp` endpoint. Run it
on a host that's always on (e.g. a Raspberry Pi on your home LAN with the
kettle), expose that host to your other devices via [Tailscale](https://tailscale.com)
or similar, and you can boil the kettle from anywhere.

```bash
npm run build
MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
MCP_HTTP_HOST=0.0.0.0 \
MCP_HTTP_PORT=8080 \
node dist/mcp-http.js
```

Config (env vars):

- `MCP_HTTP_HOST` — bind address. Default `127.0.0.1` (local-only). Set to your
  Tailscale IP or `0.0.0.0` to listen on all interfaces.
- `MCP_HTTP_PORT` — port. Default `8080`.
- `MCP_AUTH_TOKEN` — if set, every request must include
  `Authorization: Bearer <token>`. If unset, the endpoint is unauthenticated
  (acceptable on a tailnet, **not** acceptable if exposed to the open internet).
- `KETTLE_IP` / `KETTLE_IMEI` / `LOG_LEVEL` — same as stdio.

Smoke test from another machine:

```bash
curl -X POST http://<host>:8080/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

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

## Project structure

```
src/
  protocol/                  pure wire format, no I/O
    hex.ts                   hex helpers, byte stuffing, checksum
    frames.ts                Across frame build/parse, JSON envelope
    commands.ts              API codes + command builders
    parsers.ts               status + scan-list parsers
    index.ts                 public barrel
  client.ts                  TCP client (typed events, exponential reconnect, status caching)
  discovery.ts               UDP/15103 broadcast probe
  config.ts                  env-or-discover loader
  env.ts                     zod-validated startup config
  errors.ts                  KettleError class hierarchy
  logger.ts                  leveled stderr logger
  cli.ts                     entry: status / boil / stop / standby / setup / discover
  mcp.ts                     entry: stdio MCP server
  mcp-http.ts                entry: HTTP MCP server (with /healthz)
  mcp-tools.ts               shared KettleManager + tool registration
  *.test.ts                  unit + integration tests (32 total)
.github/
  workflows/ci.yml           lint → typecheck → test on every push
  dependabot.yml             weekly npm + monthly actions
.husky/pre-commit            lint-staged: ESLint + Prettier on staged files
Dockerfile                   multi-stage Alpine build, runs the HTTP server
```

Three concentric layers: `protocol/` is pure functions, `client.ts` adds TCP +
state, the entry points (`cli`, `mcp`, `mcp-http`) wire everything to a transport.
Adding a new transport (e.g. WebSocket) means a new `mcp-*.ts` file that calls
`buildKettleServer(manager)` from `mcp-tools.ts` — nothing else has to change.

## Protocol notes

- Wire frame: `##00<2-hex-len>{json}&&`
- JSON: `{"app_cmd":"62","imei":"...","SubDev":"","data2":"<across-hex>"}`
- Across inner: `AA + frameLen(4) + prefix(4) + msgUnique(12) + serial(2) + api(2) + retain(4) + content + sign(2)` (with `0xAA` byte-stuffed to `AA55`)
- `data1`-style replies (`wifi_cmd:61`) are unrelated red herrings — the real protocol is binary inside `data2`.
- Discovery: UDP/15103 broadcast `Probe#YYYY-MM-DD-HH-MM-SS-1`; reply has the kettle's IMEI, version, and `deviceStatus` blob.

## Development

```bash
npm run dev         # stdio MCP server (tsx)
npm run dev:http    # HTTP MCP server (tsx)
npm run cli <cmd>   # see Quick CLI test above
npm run lint        # ESLint (typescript-eslint recommended)
npm run typecheck   # tsc --noEmit
npm test            # node --test via tsx — unit tests + TCP integration tests
npm run format      # prettier --write
```

The integration tests in `src/client.integration.test.ts` spin up a real TCP
server on loopback that mimics the kettle, so the full `send → frame parse →
API correlation → ack-check` loop is exercised end-to-end without needing a
physical kettle.

CI runs `lint → typecheck → test` on every push and PR. `prepublishOnly`
runs the same gauntlet plus `build` before allowing `npm publish`.

## Not affiliated with the manufacturer

AppKettle is a product of iFavine, which was dissolved in 2023. This project is
independent: not made by, endorsed by or connected to that company or anyone who
acquired its assets. The name is used only to say which kettle the code talks to.

The protocol was worked out by examining the manufacturer's own Android app in
order to keep hardware working after the service it depended on was switched
off. Nothing here circumvents a protection measure or unlocks paid
functionality; it re-implements a local network protocol so that a kettle you
own keeps doing what it did when you bought it.

## License

[MIT](./LICENSE)
