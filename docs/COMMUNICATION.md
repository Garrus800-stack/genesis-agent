# Genesis Agent — Communication Architecture

> v7.5.6 — How Genesis instances communicate with each other and the outside world.
> Updated through v7.5.6: same-backend failover (no Genesis-to-Genesis change, but the LLM transport layer now recovers from sticky errors without relying on cross-backend escape), reasoning-block filter on the model-out path, and the carry-over `streamChat` MetaLearning fix.

---

## Overview

Genesis has four communication layers, from internal (single-instance) to external (multi-agent):

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: MCP (Model Context Protocol)                      │
│  Genesis ←→ External MCP Servers (databases, APIs, tools)   │
│  Genesis AS MCP Server → any MCP client can use its tools   │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: PeerNetwork (Genesis ←→ Genesis)                  │
│  Multicast discovery, encrypted HTTP, task delegation       │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: IPC (UI ←→ Agent)                                 │
│  Electron contextBridge, rate-limited, input-validated      │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: EventBus (Internal Service ←→ Service)            │
│  In-process pub/sub, typed events, payload validation       │
└─────────────────────────────────────────────────────────────┘
```

---

## Layer 1: EventBus (Internal)

All services communicate via a centralized EventBus. No direct `require()` calls between services — the DI Container injects dependencies, and cross-service notifications flow through events.

```
EmotionalState ──emit('emotion:shift')──→ EventBus ──→ PromptBuilder (adjusts tone)
                                                   ──→ IdleMind (adjusts priorities)
                                                   ──→ NeedsSystem (recalculates drives)
```

Key properties:

- **449 event types** catalogued in `EventTypes.js` (v7.5.6 baseline)
- **445 payload schemas** in `EventPayloadSchemas.js` — 100% coverage for non-fire-and-forget events; dev-mode validation throws on mismatch
- **Ring buffer history** — last 500 events for debugging
- **Source tracking** — every event carries `{ source: 'ModuleName' }` for audit
- **Listener leak detection** — warns when >5 listeners on one event
- **Promise.allSettled dispatch** — handler exceptions logged via `console.error`, never produce unhandled rejection events

New v7.5.6 events: `model:marked-unavailable`, `model:unavailable-cleared`, `model:thinking-trace`. The first two come from the availability-TTL marker (Section 4.7 in ARCHITECTURE-DEEP-DIVE); the third carries reasoning content from `<think>...</think>` blocks for the ReasoningTracer.

---

## Layer 2: IPC (UI ←→ Agent)

The Electron renderer (UI) communicates with the Agent (main process) through a strict IPC channel contract:

```
┌──────────────┐    contextBridge     ┌──────────────┐
│   Renderer   │ ◄──────────────────► │    Kernel    │
│   (UI)       │   window.genesis.*   │   (main.js)  │
│              │                      │              │
│  <genesis-   │   invoke(channel)    │  CHANNELS{}  │
│   chat>      │ ─────────────────►   │  handler()   │
│              │   ◄──── result ────  │     │        │
│              │                      │     ▼        │
│              │   on('stream-chunk') │  AgentCore   │
│              │ ◄─────────────────── │  .handleChat │
└──────────────┘                      └──────────────┘
```

### Security gates (every message passes through all of these):

1. **Preload whitelist** — `preload.mjs` blocks any channel not in `ALLOWED_INVOKE/SEND/RECEIVE`
2. **Rate limiter** — Token-bucket per channel (e.g. chat: 10 burst, 2/sec refill)
3. **Input validation** — `_validateStr()` checks type + length (max 100k chars)
4. **CSP headers** — `script-src 'self'`, `connect-src 'self'`, `object-src 'none'`
5. **Permission handler** — denies camera, mic, geo (only notifications allowed)
6. **Navigation guard** — blocks renderer from navigating away from `file://`

### Channel categories:

| Direction | Channels | Examples |
|-----------|----------|---------|
| UI → Agent (invoke) | 62 | `agent:chat`, `agent:save-file`, `agent:switch-model`, `agent:get-network-status`, `agent:get-provenance-report`, `agent:model-reset` (v7.5.6) |
| UI → Agent (fire-and-forget) | 2 | `agent:request-stream`, `ui:heartbeat` |
| Agent → UI (push) | 8 | `agent:stream-chunk`, `agent:status-update`, `agent:loop-progress` |

---

## Layer 3: PeerNetwork (Genesis ←→ Genesis)

When multiple Genesis instances run on the same network, they discover each other and can collaborate:

```
┌──────────────────┐         encrypted HTTP         ┌──────────────────┐
│  Genesis A       │ ◄──────────────────────────►   │  Genesis B       │
│                  │                                 │                  │
│  PeerNetwork     │   1. Multicast discovery        │  PeerNetwork     │
│  ├─PeerTransport │   2. Token exchange (PBKDF2)    │  ├─PeerTransport │
│  ├─PeerCrypto    │   3. AES-256-GCM encrypted      │  ├─PeerCrypto    │
│  └─PeerHealth    │   4. HMAC-authenticated          │  └─PeerHealth    │
│                  │                                 │                  │
│  TaskDelegation  │   POST /task/submit             │  TaskDelegation  │
│  AgentLoop       │   GET  /task/status?id=         │  AgentLoop       │
│  SelfSpawner     │   POST /task/cancel             │  SelfSpawner     │
└──────────────────┘                                 └──────────────────┘
```

### Discovery & Security

1. **Multicast announcement** — each Genesis broadcasts on the local network every 30s
2. **Token-based auth** — shared peer token (generated on first run, stored in `.genesis/peer-token.txt`)
3. **Session key derivation** — PBKDF2 derives per-session AES-256-GCM keys
4. **HMAC verification** — every message authenticated before processing
5. **Per-IP rate limiting** — max 30 requests/min per remote peer
6. **AST code safety scan** — any code received from peers is scanned by CodeSafetyScanner before execution
7. **Protocol versioning** — min compatible version enforced (currently v2+)

### Task Delegation Flow

When Genesis A has a sub-goal that another instance might handle better:

```
Genesis A (AgentLoop)
  │
  ├── 1. AgentLoop encounters DELEGATE step type
  │
  ├── 2. TaskDelegation.delegate(subGoal)
  │     ├── findMatchingPeer(requiredCapabilities)
  │     │   └── Scores peers by: skill match, health score, latency
  │     │
  │     ├── submitTask(peer, task)
  │     │   └── POST /task/submit { taskId, description, requiredSkills, deadline }
  │     │       → peer responds: { accepted: true, estimatedMs: 30000 }
  │     │
  │     └── pollResult(taskId)
  │         └── GET /task/status?id=xxx → { status: 'done', result: {...} }
  │
  └── 3. Result flows back into AgentLoop execution
```

### What peers share:

| Shared | NOT shared |
|--------|-----------|
| Skill manifests (what each instance can do) | API keys or secrets |
| Task results | Conversation history |
| Health/capability metadata | Emotional state |
| Schema patterns (via gossip) | Internal file contents |

---

## Layer 4: MCP (Model Context Protocol)

Genesis implements both MCP client and server:

### As MCP Client (Genesis connects to external tools)

```
Genesis                          External MCP Server
  │                                     │
  │  McpClient                          │
  │  ├── addServer(config)              │
  │  │   └── McpServerConnection        │
  │  │       └── HTTP POST + SSE ───►   │  (database, API, etc.)
  │  │                                  │
  │  ├── Tool discovery                 │
  │  │   └── tools/list ──────────►     │
  │  │   ◄── tool schemas ─────────     │
  │  │                                  │
  │  └── Tool execution                 │
  │      └── tools/call ──────────►     │
  │      ◄── result ───────────────     │
```

Features:
- Auto-discovery of tool schemas
- Pattern detection (detects repeated tool chains → creates "recipes")
- Skill candidate extraction (recurring patterns → suggest new built-in skills)
- Schema validation before tool calls
- Idle exploration (IdleMind probes available tools during downtime)
- CircuitBreaker per connection — `failFastMs: 15000` (v7.4.3 semantics): the breaker opens 15s before the 30s HTTP transport timeout, so flaky servers stop wasting full HTTP windows. The LLM circuit, by contrast, runs with `failFastMs: null` so the OllamaBackend's own `req.setTimeout(LLM_RESPONSE_LOCAL)` is the single ceiling.

### As MCP Server (Genesis exposes its own tools)

```
External Client                  Genesis McpServer
  │                                     │
  │  JSON-RPC 2.0 / HTTP               │
  │  POST /  ──────────────────►  _handleRequest()
  │                                │    │
  │  tools/list ──────────────►    │    ├── ToolRegistry.listTools()
  │  ◄── Genesis tool schemas ──   │    │
  │                                │    │
  │  tools/call ──────────────►    │    ├── ToolRegistry.execute(name, args)
  │  ◄── result ────────────────   │    │
  │                                │    │
  │  GET /sse ────────────────►    │    └── SSE event stream
  │  ◄── server-sent events ────   │
```

This means any MCP-compatible application (Claude Desktop, other agents, custom tooling) can use Genesis as a tool provider.

---

## SelfSpawner (Internal Parallelism)

Not cross-network, but worth documenting — Genesis can fork lightweight worker processes:

```
Genesis (main)
  │
  ├── SelfSpawner.spawn(subGoal, context)
  │     │
  │     ├── fork('_self-worker.js')
  │     │     ├── Minimal context: ModelBridge config + goal
  │     │     ├── Own Sandbox (code execution)
  │     │     ├── Time limit (5 min default)
  │     │     ├── Memory limit
  │     │     └── IPC back to parent: { status, result }
  │     │
  │     ├── fork('_self-worker.js')   ← up to 3 concurrent
  │     │
  │     └── Collect results → merge into AgentLoop
```

---

## Communication Matrix

Which component talks to what, and how:

| From | To | Method | Encrypted | Rate Limited |
|------|-----|--------|-----------|-------------|
| Service → Service | EventBus | In-process pub/sub | N/A | No (in-process) |
| UI → Agent | IPC (invoke) | Electron contextBridge | N/A (same process) | Yes (token-bucket) |
| Agent → UI | IPC (send) | Electron webContents | N/A | No (push only) |
| Genesis → Genesis | PeerNetwork HTTP | AES-256-GCM + HMAC | Yes | Yes (30/min/IP) |
| Genesis → MCP Server | McpClient HTTP | TLS (if server supports) | Depends | No |
| External → Genesis MCP | McpServer HTTP | Localhost only (127.0.0.1) | N/A | No |
| Genesis → LLM (Ollama) | HTTP | Plaintext (localhost) | No | Yes (semaphore, 3 concurrent) |
| Genesis → LLM (Cloud) | HTTPS | TLS | Yes | Yes (semaphore + rate limit) |
| Genesis → Workers | Node IPC (fork) | In-process | N/A | Yes (max 3 workers) |
| NetworkSentinel → External | HTTP HEAD probes | TLS (dns.google, 1.1.1.1) | Yes | Every 30s |
| NetworkSentinel → Ollama | HTTP GET /api/tags | Plaintext (localhost) | No | Every 30s |
| NetworkSentinel → ModelBridge | In-process switchTo() | N/A | N/A | On failover/restore |

---

## Network Resilience (v6.0.5)

NetworkSentinel provides automatic offline detection and LLM failover:

```
             ┌─────────────────┐
             │ NetworkSentinel │  30s probes
             │  (Phase 6)      │────────────► dns.google / 1.1.1.1
             └────────┬────────┘
                      │
          ┌───────────┼───────────┐
          │ ONLINE    │ OFFLINE   │
          ▼           ▼           │
    (no action)  emit network:    │
                 status {false}   │
                      │           │
                 ┌────▼────┐      │
                 │ Failover │     │
                 │ to Ollama│     │
                 └────┬────┘     │
                      │          │
                 Queue mutations │
                      │          │
              ┌───────▼──────┐   │
              │  RECONNECT   │◄──┘
              │  Restore     │
              │  cloud model │
              │  Flush queue │
              └──────────────┘
```

Consumers: BodySchema (canAccessWeb), ImmuneSystem (health:degradation), ErrorAggregator (network:error).
