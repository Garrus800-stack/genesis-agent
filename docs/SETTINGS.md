# Settings

The Settings panel is the main control surface for Genesis. Six tabs
group ~150 individual fields by purpose. Defaults are tuned so a fresh
install runs sensibly out of the box — most users only ever touch
Models (to add an API key) and maybe Limits (Cost-Guard).

This document lists every tab and the fields most users will look for.
Less common fields are documented inline in the UI via per-field hints
(grey text under each input) showing the default value and valid
range.

Settings persist in `.genesis/settings.json`. API keys and the peer
discovery token are encrypted at rest with a per-install random salt
in `.genesis/enc-salt`.

---

## Tabs

```
[Models] [Behavior] [Limits] [MCP] [Advanced] [JSON Editor]
```

| Tab | What it controls |
|---|---|
| **Models** | Which LLM Genesis uses, per-task overrides, fallback chain, API keys, Ollama keep-alive |
| **Behavior** | Daemon, IdleMind, Trust level, Goal-add mode, auto-routing, auto-commit-on-shutdown |
| **Limits** | Cost-Guard token caps, memory caps (KG / SelfStatementLog / EpisodicMemory), timeouts |
| **MCP** | External MCP servers (add/remove), MCP-serve toggle, MCP-server port |
| **Advanced** | Health server, peer discovery, font sizes, EventStore rotation, security toggles |
| **JSON Editor** | Power-user view: full `settings.json` for fields that don't have a dedicated input |

The JSON Editor sees every persisted setting except API keys and the
peer discovery token, which are masked as `***MASKED***` to prevent
accidental copy-paste exposure. Keys can still be changed via the
Models tab.

---

## Per-tab field reference

### Models

| Field | Default | Notes |
|---|---|---|
| Active Model | auto-detect best available | What Genesis uses for direct user chat. |
| Per-task model: chat / code / analysis / creative | `null` (= auto) | Overrides Active Model for specific task types. |
| Fallback chain | `[]` | Ordered list. If primary fails, Genesis walks the chain. **Empty chain + cloud-only primary = no failover.** Boot warns about this. |
| Anthropic API key | `''` | Masked in UI after entry. Encrypted in `settings.json`. |
| OpenAI API key | `''` | Same. Also `openaiBaseUrl` for OpenAI-compatible endpoints. |
| Ollama keep-alive | `null` (= 5min) | `30s` to free RAM faster, `0` to unload immediately, `-1` or `1h` to keep loaded longer. |
| Max concurrent LLM requests | `3` | Lower to `1` on CPU-only setups to avoid Ollama thrashing. |
| LLM local timeout (ms) | `180_000` | HTTP timeout for local Ollama. **Raise to `300_000` or higher on slow CPUs running 7B+ models** — first inference can take 240–300s. Setting key: `llm.localTimeoutMs`. *(v7.5.9)* |

### Behavior

| Field | Default | Notes |
|---|---|---|
| Daemon enabled | `true` | The autonomous background loop. |
| Daemon cycle (minutes) | `5` | How often the daemon picks up work. |
| Daemon auto-repair | `true` | ImmuneSystem corrections without asking. |
| Daemon auto-optimize | `false` | Speculative refactors. Off by default. |
| IdleMind enabled | `true` | Autonomous thinking when user is idle. |
| IdleMind idle / think minutes | `2` / `3` | How long until idle, how long thinking sessions last. |
| IdleMind max active goals | `3` | Cap on parallel autonomous goals. |
| Trust level | `1` (AUTONOMOUS) | `0`=Supervised, `1`=Autonomous, `2`=Earned, `3`=Full. See `EarnedAutonomy`. |
| Goal-add mode | `ask` | `always` resume on boot, `never` skip, `ask` prompt. |
| Negotiate before add | `false` | If on, `/goal add` proposes goals as pending; Genesis clarifies first. |
| Auto-route by task | `false` | If on, ModelBridge picks model per task-type. Off because it caused multi-model thrashing on CPU-only setups. Re-enable with caution. |
| Commit-snapshot on shutdown | `false` | Was always-on, polluted git history on collaborator machines. Off now — opt in if you want shutdown-state in git. |
| Software-Installation: Install-Ziel | `machine` | Where `/install` puts new software. `machine` = system-wide (Program Files on Win, sudo apt on Linux); `user` = per-user (no admin); `auto` = winget default. Setting key: `install.scope`. *(v7.5.9)* |
| Software-Installation: Auto-Install | `false` | If on (and trust ≥ AUTONOMOUS), `/install <pkg>` runs the package-manager command directly instead of just previewing. Setting key: `install.allowAutoInstall`. *(v7.5.9)* |

### Limits

| Field | Default | Notes |
|---|---|---|
| Cost-Guard enabled | `true` | Token-budget enforcement on autonomous LLM use. Direct user chat is never blocked. |
| Session token limit | `500_000` | Per-session cap. |
| Daily token limit | `2_000_000` | Rolling 24h cap. |
| Cost-Guard warn threshold | `0.8` | Warn at 80% of either limit. |
| KnowledgeGraph max nodes | `5000` | LRU pruning kicks in beyond. `0` = unlimited. |
| SelfStatementLog max statements | `5000` | Same. |
| EpisodicMemory max episodes | `500` | Same. |
| Approval timeout (sec) | `60` | How long ApprovalGate waits for user input. |
| Shell timeout (ms) | `15_000` | Per-shell-command. |
| HTTP timeout (ms) | `60_000` | WebFetcher and similar. |
| Git timeout (ms) | `5_000` | git operations. |

### MCP

| Field | Default | Notes |
|---|---|---|
| MCP enabled | `true` | Master toggle for the MCP client. |
| MCP servers list | `[]` | Add/edit/remove rows; each is `{name, url, ...}`. |
| MCP-serve enabled | `false` | Turn Genesis itself into an MCP server. |
| MCP-serve port | `3580` | Where to listen. |

### Advanced

| Field | Default | Notes |
|---|---|---|
| Health HTTP server | `false` | Exposes `/health`, `/metrics` endpoints. |
| Health HTTP port | `9090` | |
| Peer discovery token | `''` | Set this to enable multicast peer discovery. Empty = disabled (default). |
| Allow self-modify | `true` | If off, blocks SelfModificationPipeline outright. |
| Allow network peers | `true` | If off, blocks PeerNetwork. |
| Allow file execution | `true` | If off, blocks shell tool. |
| EventStore max file size (MB) | `50` | Rotation threshold for `events.jsonl`. |
| EventStore max rotations | `3` | How many rotated files to keep. |
| IdleMind journal max file size (MB) | `10` | Same idea, for the IdleMind journal. |
| IdleMind journal max rotations | `3` | |
| SelfSpawner max workers | `3` | Concurrent self-spawned worker processes. |
| SelfSpawner timeout (ms) | `300_000` | 5 minutes per spawn. |
| SelfSpawner memory limit (MB) | `256` | Per spawned worker. |
| WorkerPool max workers | `0` (= auto) | `worker_threads` pool for code-analysis. |
| Editor font size | `13` | Monaco. |
| Chat font size | `13` | The chat panel. |
| Language | `de` | `de` / `en` / `fr` / `es`. Live-switchable via the language dropdown. |

### JSON Editor

A textarea showing the full `settings.json` (except masked secrets).
Useful for fields not surfaced in the dedicated tabs — for example
`cognitive.strictMode`, individual `models.openaiModels` entries, or
custom keys added by plugins.

Workflow:

1. Edit JSON.
2. Click **Validate** — live syntax check (debounced 400ms; status
   indicator turns green on parse OK).
3. Click **Reload** to discard changes.
4. Click **Save** in the modal footer to persist.

Conflicts: if the same field is present both in a dedicated tab and
in the JSON editor, the dedicated tab wins (field-level precedence).
This is intentional — it stops a stale JSON edit from clobbering a
fresh form change.

---

## Per-field controls

Every numeric/boolean/string field (excluding API keys) has:

- A **↺ Reset** button that returns the field to its default
- A **default hint** showing `Default: <value>` plus min/max if
  applicable, translated into the active language
- **Range validation** with a red border + inline error message;
  Save is blocked until all fields validate

API key fields don't get a Reset button (no point — the default is
empty, and you don't want to accidentally wipe a working key).

---

## Boot summary

After a successful boot, the log shows non-default toggles so you
can see at a glance what's active for this run:

```
[+] Skills: 4, Tools: 29
[+] MCP: 0/0 servers, 0 tools
[+] Model: qwen3-vl:235b-cloud
[+] Auto-routing: disabled
[+] Active: Cost-Guard 500k/session 2.0M/day
```

If a field is at its default, it's not listed. If you've enabled
something opt-in (auto-routing, MCP-serve, peer discovery, etc.) it
shows up here. Quiet log = vanilla install.

---

## Where settings live

| File | Contents |
|---|---|
| `.genesis/settings.json` | All your settings (encrypted secrets) |
| `.genesis/enc-salt` | Random salt for the secret encryption (per-install) |
| `.genesis/trust-level.json` | Trust level state (separate from `settings.json` for safety) |
| `.genesis/settings.bak` | Last-known-good settings, written when `Save` succeeds |

If `settings.json` ever fails to parse on boot, Genesis falls back to
`settings.bak` and continues. If both are bad, you get defaults and a
boot warning.

---

## Troubleshooting

If something is wrong with settings (UI doesn't show a value you
just saved, validation looks broken, the JSON editor refuses to
save), see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — the Settings
section there covers common UI/validation issues with reproduction
steps.
