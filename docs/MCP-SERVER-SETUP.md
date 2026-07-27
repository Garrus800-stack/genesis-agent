# MCP Server — Setup Guide

> How to enable Genesis as an MCP server so external tools (VSCode, Cursor, Claude Desktop, other agents) can invoke Genesis tools.
> Last verified for MCP protocol 2025-03-26.

Genesis exposes its capabilities as an MCP server. External tools (VSCode, Cursor, Claude Desktop, other agents) can invoke Genesis tools and read Genesis resources via the standard MCP protocol.

## Quick Start

### Option A: Enable in Settings (Electron UI)

Open Genesis → Settings → set:

```json
{
  "mcp": {
    "serve": {
      "enabled": true,
      "port": 3580
    }
  }
}
```

### Security: API Key Authentication (mandatory since v7.9.46)

The MCP server used to accept every localhost connection without
authentication. CORS restricts origins, but SSH tunnels, ngrok or Docker port
mappings can still carry a request in from outside — so the open default is
gone. **Without a password the server refuses to start, and a server built
without one answers 401 to everything except `/health`.**

Set it in **Settings → MCP**. The field is write-only and the value is stored
encrypted; that is the recommended road. The equivalent by hand:

```json
{
  "mcp": {
    "serve": {
      "enabled": true,
      "port": 3580,
      "apiKey": "your-secret-key-here"
    }
  }
}
```

A hand-written password of eleven characters or more is encrypted on the next
load; shorter ones stay readable in the file, which is why the settings field
is the better road.

Clients must include `Authorization: Bearer your-secret-key-here` or
`x-api-key: your-secret-key-here` in every request. The `/health` endpoint is
exempt (useful for monitoring probes). Changing the password takes effect
without an app restart — the key is read per request.

**Built-in protections (always active, regardless of API key):**
- CORS: localhost-only by default
- Rate limiter: 120 requests/minute per IP (sliding window)
- Body size cap: 1MB maximum
- Session tracking via `Mcp-Session-Id` header

Genesis starts the MCP server automatically on next boot.

### Option B: Dashboard Toggle

Open Dashboard (◈ button in topbar) → scroll to **System** panel → click **Start Server**.

### Option C: Headless / CLI

```bash
# Interactive REPL with MCP server in background
node cli.js

# MCP server daemon only (no chat)
node cli.js --serve

# Custom port (without --port the configured mcp.serve.port is used)
node cli.js --serve --port 4000

# Minimal boot (fewer services, faster start)
node cli.js --serve --minimal
```

## The vestibule: circles in front of the same door

Since v7.9.46 the server carries Genesis' vestibule. The password you set above
is the **inner circle** — full access, raw state, no model call. Everyone else
holds a personal key that you generate and hand over privately; Genesis stores
only its hash and decides the circle himself.

| Key | Sees | Answer |
|---|---|---|
| server password (`mcp.serve.apiKey`) | every tool | raw snapshot, no model call |
| a visitor key in the **middle** circle | exactly one tool: `vestibule-status` | his `statusMiddle` line, with the visitor named |
| a visitor key in the **outer** circle | exactly one tool: `vestibule-status` | his `statusOuter` line |
| a blocked, removed or unknown key | nothing | `401` |

The filter is a triple gate: `tools/list`, `tools/call` and resources all apply
it, so an outer visitor cannot even learn that the other tools exist — an
attempt to call one is answered with "Tool not found", never with "forbidden".

Managing visitors is his hand, not yours. Ask him in chat and he calls
`vestibule-circle`: add, raise, lower, block, remove. `remove` revokes the key
for good; the visit book keeps what happened, because removing means the key
stops opening, not that the visit never was.

Every knock is written into his visit book with its outcome — answered, absent
(the model did not reply in time), rate (a second knock from the same visitor
inside a minute), shielded (a dream cycle), blocked, or an inner-circle
override. Ask him in chat *"who knocked?"* and he reads it back with
`vestibule-visits`. That tool is his alone: the triple gate lets an outer or
middle visitor see exactly `vestibule-status`, so nobody can read the book from
outside.

One precondition: the door only speaks once `vestibule-voice` has written all
four of his lines into `stimme.json`. Until then every outer or middle knock is
answered with a neutral system line — Genesis borrows no wording he did not
write himself. Ask him in chat to set his vestibule voice.

Two protections are always on. A second knock from the same visitor inside a
minute is answered from his absent line without a model call, and during a dream
cycle the door is shielded with his closed line. A knock that the model does not
answer within `mcp.serve.knockTimeoutMs` (default 90 s) also falls back to the
absent line rather than leaving the visitor hanging — raise that value for a
slow or cloud-hosted model, since a fast one never waits for it. The visit book
records which of the two it was: `rate` for the window, `absent` for the budget.

By default this stays on `127.0.0.1`. `mcp.serve.bind` opens it to your home
network — see [SETTINGS.md](SETTINGS.md) for that switch and for how the
password is stored.

## IDE Configuration

### VSCode (with Continue, Cline, or Copilot MCP extensions)

Add to your `.vscode/settings.json` or extension config:

```json
{
  "mcp": {
    "servers": {
      "genesis": {
        "url": "http://127.0.0.1:3580/sse"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "genesis": {
      "url": "http://127.0.0.1:3580/sse"
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "genesis": {
      "url": "http://127.0.0.1:3580/sse"
    }
  }
}
```

### Any MCP Client (Streamable HTTP)

POST to `http://127.0.0.1:3580/` with:

```
Content-Type: application/json
Accept: text/event-stream    (optional — enables streaming responses)
Mcp-Session-Id: your-id     (optional — enables session tracking)
```

## Available Tools

| Tool | Description |
|------|-------------|
| `genesis.verify-code` | Full code verification — syntax, imports, lint patterns |
| `genesis.verify-syntax` | Quick AST parse check |
| `genesis.code-safety-scan` | Safety violation detection (eval, fs writes, process spawn) |
| `genesis.project-profile` | Tech stack, conventions, quality indicators |
| `genesis.project-suggestions` | Improvement suggestions from structural analysis |
| `genesis.architecture-query` | Natural language queries about Genesis architecture |
| `genesis.architecture-snapshot` | Full service/event/layer/phase snapshot |

Plus all native Genesis tools (shell, file-read, file-write, file-list, git-log, etc.) are also available.

## Available Resources

| URI | Description |
|-----|-------------|
| `genesis://knowledge-graph/stats` | Node/edge counts, types, embedding stats |
| `genesis://knowledge-graph/nodes` | All concept nodes with types (max 200) |
| `genesis://lessons/all` | Cross-project lessons with confidence (max 100) |
| `genesis://lessons/stats` | Lesson counts by category/source |

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | POST | JSON-RPC 2.0 (MCP protocol) |
| `/sse` | GET | Server-Sent Events connection |
| `/health` | GET | `{ status, version, clients }` |

## Protocol

- **MCP 2025-03-26** compliant
- JSON-RPC 2.0 with proper error codes (-32700, -32600, -32601, -32602, -32603)
- `tools/list`, `tools/call`, `resources/list`, `resources/read`
- `notifications/tools/list_changed`, `notifications/resources/list_changed`
- `ping`, `initialize`, `resources/templates/list`
- Streamable HTTP (POST with Accept: text/event-stream)
- CORS enabled for browser-based clients

## Troubleshooting

**Server won't start:**
- Check if port is already in use: `lsof -i :3580`
- Try a different port: `node cli.js --serve --port 4000`

**IDE can't connect:**
- Verify Genesis is running: `curl http://127.0.0.1:3580/health`
- Check firewall settings for localhost connections

**Tools return empty:**
- Some tools require services that only exist in `--cognitive` or `--full` boot profile
- Use `node cli.js --serve` (default: full profile) for all tools
