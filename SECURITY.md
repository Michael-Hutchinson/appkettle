# Security policy

## Reporting a vulnerability

If you find a security issue in `appkettle`, please **don't open a public issue**.
Email the maintainer at <support@michaelhutchinson.me> with:

- A description of the issue
- Steps to reproduce
- Affected version (or commit SHA)
- Any suggested mitigation

I'll acknowledge receipt within 7 days and aim to publish a fix or workaround
within 30 days for high-severity issues.

## Threat model

This project talks directly to a smart kettle on your local network. It does not
connect to any cloud service. The relevant attack surface is:

- **The TCP client** (`src/client.ts`) — connects to the kettle on port 6002 and
  exchanges binary frames. Only the kettle's IP and IMEI need to be trusted.
- **The HTTP MCP server** (`src/mcp-http.ts`) — exposes the kettle to MCP clients
  over HTTP. It defaults to binding `127.0.0.1` so it isn't reachable off the
  host without explicit configuration.

## Operating securely

If you run the HTTP MCP server outside `127.0.0.1`:

- **Always set `MCP_AUTH_TOKEN`** to a random value of at least 16 characters
  (e.g. `openssl rand -hex 32`). Without it, anyone who can reach the port can
  control your kettle.
- **Don't expose the port to the open internet** without a TLS-terminating
  reverse proxy and additional auth in front of it. The bearer-token check is
  defense-in-depth, not a substitute for network isolation.
- **Prefer Tailscale or another zero-trust mesh** over port-forwarding. The
  endpoint never needs to be publicly reachable to use it from your phone.

## Supported versions

This project is pre-1.0 and only the latest commit on `main` is supported.
