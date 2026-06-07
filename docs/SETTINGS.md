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
discovery token are encrypted at rest with AES-256-GCM, anchored to a
per-installation UUID stored in `.genesis/.install-id` (v7.6.9+) and
salted via `.genesis/enc-salt`. The install-id is generated once per
`.genesis/`-folder and survives hostname changes, username changes,
and folder copies between machines — encrypted values stay readable
as long as `.install-id` travels with the folder. If `.install-id` is
missing or rotated, encrypted values become unreadable; Genesis will
boot, log a warning (`settings:keys-unreadable` event), and surface a
chat-system-message asking you to re-enter the affected keys via
**Settings → Models**. See [SECURITY.md](../SECURITY.md) for the
threat model around `.genesis/`-folder portability.

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
| IdleMind goal-step balance | `3` | After N consecutive goal-step cycles, IdleMind breaks out to pick a non-goal activity (reflect, journal, dream, calibrate, inhabit). `0` = legacy always-goal-step. *(v7.9.4)* |
| IdleMind score normalization | `'none'` | Activity-picker score smoothing. `'log'` (reserved) dampens score outliers via `log1p`. *(v7.9.4, opt-in)* |
| IdleMind recurrence bonus | `false` | If on, activities that haven't run for a long time get a small score boost proportional to the gap. *(v7.9.4, opt-in)* |
| Trust level | `0` (SUPERVISED) | `0`=Supervised (always ask), `1`=Autonomous (ask only on categorically critical actions: DEPLOY/EXTERNAL_API/EMAIL_SEND/SELF_MODIFY), `2`=Full Autonomy (never ask). v7.9.9 froze this three-level structure — `TrustLevelSystem`, the migration table, and the default are settled and remain unchanged. |
| IdleMind — idle threshold (minutes) | `10` | How long without user activity before IdleMind starts autonomous thinking. *(default raised from 2 in v7.9.10 after Win-trace evidence)* |
| IdleMind — think interval (minutes) | `15` | How often IdleMind picks a new activity once idle. *(default raised from 3 in v7.9.10)* |
| Goal-add mode | `ask` | `always` resume on boot, `never` skip, `ask` prompt. |
| Negotiate before add | `false` | If on, `/goal add` proposes goals as pending; Genesis clarifies first. |
| Auto-route by task | `false` | If on, ModelBridge picks model per task-type. Off because it caused multi-model thrashing on CPU-only setups. Re-enable with caution. |
| Commit-snapshot on shutdown | `false` | Was always-on, polluted git history on collaborator machines. Off now — opt in if you want shutdown-state in git. |
| Software-Installation: Install-Ziel | `machine` | Where `/install` puts new software. `machine` = system-wide (Program Files on Win, sudo apt on Linux); `user` = per-user (no admin); `auto` = winget default. Setting key: `install.scope`. *(v7.5.9)* |
| Software-Installation: Auto-Install | `false` | If on (and trust ≥ AUTONOMOUS = level 1), `/install <pkg>` runs the package-manager command directly instead of just previewing. Setting key: `install.allowAutoInstall`. *(v7.5.9)* |

#### Organism behavior (PSE + Metabolism + Inhabit)

These settings live under the `organism.*` and `proactive.*` keys. They tune
how Genesis acts on its own emotional / homeostatic state and what it allows
itself to surface to you proactively.

| Setting | Default | Notes |
|---|---|---|
| `proactive.enabled` | `true` | Master toggle for the Proactive Self-Expression (PSE) pipeline (v7.7.9). When off, Genesis still emits inner-speech thoughts but never surfaces them to chat. |
| `proactive.minIntervalMs` | `1800000` (30 min) | Minimum quiet gap between two proactive self-messages. |
| `proactive.userActivityCooldownMs` | `600000` (10 min) | After you send a message, PSE stays silent for this window. |
| `proactive.quietHours.start` / `.end` | `'22:00'` / `'07:00'` | Local-time quiet hours. Wrap-around supported. |
| `proactive.allowedKinds` | `['plan-failure-reflection']` | Allowlist of thought-kinds that may surface. `self-state-snapshot` is **structurally private** and blocked at the gate regardless of this list (v7.9.5). |
| `proactive.perKindFloors.*` | varies | Per-kind significance/novelty thresholds. Each kind has its own floor. |
| `proactive.dailyVolumeSoftCap` | `8` | Soft cap on daily self-messages. Hard stop at 2× this value. |
| `proactive.goals.stalledTimeoutMs` | `900000` (15 min) | StalledGoalWatchdog converts blocked goals to failure-reflections after this. |
| `proactive.goals.stalledWatchdogTickMs` | `60000` (1 min) | How often the watchdog scans. |
| `organism.metabolism.differentiatedCosts` | `true` | Per-activity energy costs (idleMind:plan = 12, idleMind:journal = 2, idleMind:inhabit = 2, etc.). Pre-v7.9.4 every activity charged the flat `idleMindCycle = 2`. Set to `false` to revert. *(v7.9.4)* |
| `organism.inhabit.enabled` | `true` | Master toggle for the Inhabit activity (17th IdleMind activity). Composes a deterministic self-state snapshot (energy, dominant emotion, urgent need, body restrictions, goal count) and emits it via InnerSpeech with kind `'self-state-snapshot'`. PSE HardGate blocks proactive surfacing — text stays private to Genesis. *(v7.9.5)* |
| `organism.inhabit.cooldownMinutes` | `15` | Min minutes between two inhabit emissions. Clamped 1–1440. *(v7.9.5)* |
| `organism.inhabit.idleBoost` | `true` | Raise inhabit selection score during idle stretches > 30 min. Toggle off to keep cooldown-only behaviour. *(v7.9.5)* |

#### Können (Skills) behavior

The Können pipeline (Crystallizer → Forge → PromotionEvaluator → Active) is
controlled by settings under `cognitive.koennen.*`.

| Setting | Default | Notes |
|---|---|---|
| `cognitive.koennen.enabled` | `true` | Master toggle for the entire Können system. *(v7.8.9)* |
| `cognitive.koennen.crystallization.enabled` | `true` | If off, SkillCrystallizer stops collecting candidate patterns. *(v7.8.9, restart)* |
| `cognitive.koennen.crystallization.minCandidatesPerPattern` | `3` | How many occurrences of the same pattern before crystallization fires. *(v7.8.9, restart)* |
| `cognitive.koennen.crystallization.cooldownMs` | `300000` (5 min) | Min gap between two crystallization runs. *(v7.8.9, restart)* |
| `cognitive.koennen.promotion.minWilsonLB` | `0.55` | Promotion threshold on the Wilson lower bound of skill-effectiveness. Below this, skills stay pending. *(v7.9.0)* |
| `cognitive.koennen.promotion.minInvocations` | `5` | Min invocation count before a skill is eligible for promotion. *(v7.9.0)* |
| `cognitive.koennen.rehearsal.enabled` | `true` | Toggle for SkillRehearsal IdleMind activity. When on, Genesis exercises promoted skills during idle to keep them warm. *(v7.9.4)* |

#### v7.9.5 live-fix settings

These six settings came out of the v7.9.5 live-fix audit. They're not in the Behavior UI tab today — set them via JSON Editor or via slash. All are quietly defensive: the defaults preserve old behavior unless something would otherwise hurt (UX-blocker shutdown LLM wait, raw git error surface, dead optimization-suggestions firehose).

| Field | Default | Notes |
|---|---|---|
| `shutdown.sessionSummaryMinMs` | `60000` (60 s) | Sessions shorter than this with no chat content skip the shutdown summary entirely. Pre-fix Genesis waited 80 + s for a cloud-LLM summary even on instant test-runs. *(v7.9.5)* |
| `shutdown.sessionSummaryTimeoutMs` | `8000` (8 s) | Hard timeout on the shutdown summary LLM call. Range 500–120000. Above this, the call is abandoned and shutdown proceeds. *(v7.9.5)* |
| `llm.continuation.maxAttempts` | `4` | Hard cap on ContinuationLoop attempts for Ollama code-generation. Previously hardcoded — `qwen3-coder:480b-cloud` hit the ceiling at 9131 chars partial output. Range 1–20. *(v7.9.5)* |
| `cognitive.architectureReflection.staleThresholdMs` | `900000` (15 min) | Architecture graph rebuild cadence (was 5 min hardcoded, so the daemon rebuilt every ~6 min unprompted). Range 60000–86400000. *(v7.9.5)* |
| `peer.discoveryToken` | `''` (empty) | Multicast discovery is opt-in by setting a shared token across instances. Pre-fix the multicast log line fired regardless of token, which was misleading. *(v7.9.5)* |
| `agency.gitAutoCommit` | `false` | Existed since v7.7.1 but the Undo button surfaced raw `fatal: not a git repository` when off + no `.git`. The UI button now hides when this is off, and slash `/undo` returns a friendly i18n message. *(v7.9.5 visibility fix)* |

Plus two new slash commands surface daemon work that previously disappeared into the log:

| Slash | Notes |
|---|---|
| `/daemon-suggestions [N]` (alias `/suggestions`) | Show the last N optimization-analysis snapshots from `AutonomousDaemon`. Persisted to `.genesis/daemon-suggestions.jsonl` (rolling 100). *(v7.9.5)* |
| `/daemon-health-issues [N]` (alias `/health-issues`) | Show the last N health-check snapshots. Persisted to `.genesis/daemon-health-issues.jsonl` (dedup by fingerprint, rolling 100). *(v7.9.5)* |

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
| Require self-mod confirmation | `true` | When on (default), a self-modification is never applied without explicit confirmation, even at Full Autonomy. When off, self-modification follows the trust level (auto-applied only at Full Autonomy). Setting key: `security.selfModifyRequiresConfirmation`. *(v7.9.20)* |
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
| `.genesis/.install-id` | Per-installation UUID (v7.6.9+) — encryption key anchor; survives hostname/username changes and folder copies |
| `.genesis/.hauptstandort.json` | Hauptstandort identity stamp (v7.6.9+) — install-uuid, creation timestamp, hostname-history; foundation for v7.7+ Außenposten |
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

---

## Runtime vs Restart (v7.9.3)

Not every setting takes effect the moment you save it. Some are read once
when the relevant service is constructed at boot. The settings UI marks
these with `(takes effect after restart)` in the hint line.

### Runtime settings (apply immediately on save)

These are wired to Settings event listeners or read fresh on every use:

- `trust.level` — Trust level dropdown
- `daemon.enabled`, `daemon.autoRepair`, `daemon.autoOptimize` — Daemon toggles
- `idleMind.enabled` — IdleMind toggle
- `security.allowSelfModify`, `security.allowNetworkPeers`, `security.allowFileExecution`
- `security.selfModifyRequiresConfirmation` — Require explicit confirmation before any self-modification (v7.9.20)
- `agency.autoResumeGoals`, `agency.autoRouteByTask`, `agency.negotiateBeforeAdd`
- `agency.commitSnapshotOnShutdown`, `agency.gitAutoInit`, `agency.gitAutoCommit`
- `agency.installAuto`, `agency.installFull`, `agency.installScope` (v7.9.3)
- `cognitive.strictMode`, `cognitive.koennen.enabled`
- `models.anthropicApiKey`, `models.openaiApiKey` — API keys reload live
- `mcp.serve.enabled` — MCP server toggle
- `timeouts.approvalSec`, `llm.costGuard.*` (after Bug F+S fix)
- `health.httpEnabled` — health server toggle
- `ui.editorFontSize`, `ui.chatFontSize` — apply live to Monaco editor + chat container

### Restart-required settings (boot-time readers)

These are constructor-time or `asyncLoad()` readers. Changing them while
Genesis is running has no effect until the next start. The UI shows
`(takes effect after restart)` next to these.

Models tab:
- `models.preferred`, `models.roles.chat/code/analysis/creative`
- `models.openaiBaseUrl`, `models.openaiModels`

Behavior tab:
- `cognitive.koennen.crystallization.enabled`
- `cognitive.koennen.crystallization.minCandidatesPerPattern`
- `cognitive.koennen.crystallization.cooldownMs`
- `idleMind.maxActiveGoals`

Limits tab (constructor-time parameters):
- `models.maxConcurrent`, `models.ollamaKeepAlive`
- `selfSpawner.maxWorkers`, `selfSpawner.timeoutMs`, `selfSpawner.memoryLimitMB`
- `workerPool.maxWorkers`
- `knowledgeGraph.maxNodes`, `selfStatementLog.maxStatements`
- `eventStore.maxFileSizeMB`, `eventStore.maxRotations`
- `episodicMemory.maxEpisodes`
- `idleMind.journalMaxFileSizeMB`

MCP tab:
- `mcp.serve.port`

Advanced tab:
- `cognitive.simulation.maxBranches`, `cognitive.simulation.maxDepth`
- `organism.emotions.decayIntervalMs`, `organism.emotions.lonelinessIntervalMs`
- `daemon.cycleMinutes`
- `health.httpPort`

A full programmatic listing lives in
`src/ui/modules/settings-defaults.js` — entries flagged
`requiresRestart: true` produce the badge automatically.
