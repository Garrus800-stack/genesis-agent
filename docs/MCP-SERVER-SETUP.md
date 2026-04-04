# Genesis MCP Server — Setup Guide

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

### Security: API Key Authentication (Recommended)

By default, the MCP server accepts all localhost connections without authentication. While CORS restricts access to localhost origins, tools like SSH tunnels, ngrok, or Docker port mappings can expose the server to remote clients. **Set an API key to require Bearer token authentication:**

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

Clients must then include `Authorization: Bearer your-secret-key-here` or `x-api-key: your-secret-key-here` in every request. The `/health` endpoint is exempt (useful for monitoring probes).

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

# Custom port
node cli.js --serve --port 4000

# Minimal boot (fewer services, faster start)
node cli.js --serve --minimal
```

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
