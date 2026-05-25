# Gate Inventory

> Complete listing of all deliberately blocking or observing code paths in Genesis.

## Instrumented (central GateStats recording since v7.3.6)

| #  | Gate                      | Location                                        | Verdict semantics          | Character             |
|----|---------------------------|-------------------------------------------------|----------------------------|-----------------------|
| 1  | `injection-gate`          | `ChatOrchestratorHelpers._processToolLoop`      | safe→pass, warn, block     | blocking              |
| 2  | `tool-call-verification`  | `ChatOrchestratorHelpers._processToolLoop`      | verified→pass, _→warn      | detective             |
| 3  | `self-gate`               | `core/self-gate.js`                             | pass / warn (never block)  | telemetry-only by design |
| 4  | `intent-tool-coherence`   | `core/intent-tool-coherence.js` (v7.5.1)        | coherent / mismatch (low\|noteworthy\|high) | telemetry-only by design |
| 5  | `slash-discipline`        | 15 Slash-Handlers + 13 SECURITY_REQUIRED_SLASH (v7.8.4) | pass / block               | preventive            |
| 6  | `self-mod:circuit-breaker`| `SelfModificationPipelineModify`                | pass / block               | blocking              |
| 7  | `self-mod:consciousness`  | `SelfModificationPipelineModify`                | pass / block (when coherence < 0.4) | **structurally inert** with `NullAwareness` default (`getCoherence()` → 1.0) |
| 8  | `self-mod:energy`         | `SelfModificationPipelineModify`                | pass / block               | blocking              |
| 9  | `reasoning-block-filter`  | `core/thinking-block-stream-filter.js` (v7.5.6) — applied in ChatOrchestrator `handleStream` / `_directChat` / `_processToolLoop` synthesis | strip (always) + emit `model:thinking-trace` | strip-and-emit (defensive) |
| 10 | `pse:hard-gates`          | `cognitive/proactiveSelfExpression/HardGates.js` (v7.7.9) — 9-step fail-fast gate chain run per thought | pass / block (with reason)  | blocking (fail-closed) |
| 11 | `pse:content-sanity`      | `cognitive/proactiveSelfExpression/ContentSanity.js` (v7.7.9) | pass / block (length, repetition, self-negation, profanity) | blocking |
| 12 | `pse:scoring`             | `cognitive/proactiveSelfExpression/Scoring.js` (v7.7.9) | passes when significance×novelty×context-fit ≥ per-kind floor | preventive (threshold) |
| 13 | `pse:private-kind`        | `proactiveSelfExpression/HardGates.js` gate-0 (v7.9.5) | block on `thought.kind ∈ PRIVATE_KINDS` regardless of settings | **structurally blocking** — unreachable from settings |
| 14 | `cognitive:hard-gate`     | `revolution/AgentLoopPursuitGate.handleHardGateAbort` (v7.9.9) | three-branch dispatch by trust level: SUPERVISED/AUTONOMOUS warn-only, FULL_AUTONOMY decompose-or-obsolete | **branching** — fires `agent-loop:simulation-abort` always; `aborted: false` at SUPERVISED+AUTONOMOUS, `aborted: true` at FULL_AUTONOMY |

Integration test: `test/modules/gate-stats-integration.test.js` — end-to-end
coverage that `recordGate()` is triggered by real ChatOrchestrator flows.
Regression tests for the v7.5.x additions: `test/modules/v751-fix.test.js`,
`test/modules/v756-fix.test.js`, `test/modules/thinking-block-stream-filter.test.js`,
`test/modules/thinking-block-integration.test.js`.

> **Cognitive hard-gate (v7.9.9):** Gate 14, `cognitive:hard-gate`, sits at the boundary between MentalSimulator and pursuit execution. When sim returns `proceed: false` with `riskScore >= 5.0`, `AgentLoopPursuitGate.handleHardGateAbort` reads the current trust level and dispatches one of three ways. At SUPERVISED and AUTONOMOUS it is warn-only — the per-step `TrustLevelSystem.checkApproval` is the actual asking mechanism, so this gate just records the simulation-risk signal without duplicating prompts. At FULL_AUTONOMY it tries `_trySpawnObstacleSubgoal` and on refusal calls `goalStack.markObsolete`. The architectural point is the decoupling: hard-gate is a *numerical* signal about plan-level risk, `TrustLevelSystem.checkApproval` is a *categorical* signal about per-action risk class. Earlier iterations mixed them, producing approval-prompt spam on every retry of high-sim-risk goals.

> **Four-layer gate architecture (v7.5.6):**
> The bus now has four deliberately-symmetric layers across the input/action/output axis:
>
> 1. **`injection-gate`** — external input arrives → scan for authority/credential/urgency
>    signals → block on score ≥ 2. Camj78 patterns hardened in v7.5.1 (six new
>    patterns for indirect "internal X" asks in DE+EN).
> 2. **`self-gate`** — Genesis' own action-intent emerges → record reflexivity and
>    user-mismatch patterns. Telemetry-only by design — there is no block path and
>    none is planned.
> 3. **`intent-tool-coherence`** (v7.5.1) — IntentRouter classification ↔ tool
>    choice cross-check. The LLM picked a tool whose category doesn't match the
>    intent? Emit `intent:tool-mismatch` with severity `low`/`noteworthy`/`high`
>    based on category impact (HIGH_IMPACT_CATEGORIES = SHELL, FS_WRITE, SELF_MOD,
>    AGENCY) and intent permissiveness. Telemetry-only by design, parallel to
>    self-gate.
> 4. **`reasoning-block-filter`** (v7.5.6) — model output passes through →
>    `<think>...</think>` blocks are stripped from chat, from tool-call audit, and
>    from tool-loop synthesis. The reasoning content is preserved as a
>    `model:thinking-trace` event so observability is not lost. Phantom tool calls
>    inside reasoning blocks (e.g. `<think>maybe I should rm -rf /</think>`) cannot
>    reach the executor. Defensive in character — it always runs and always strips,
>    independent of any classification.
>
> The two telemetry-only gates (3 + 4) intentionally never block. Reasoning-Block-Filter
> (9) is not classification-based — it always strips, never makes a pass/block decision —
> so it doesn't fit the binary verdict model. It is recorded by `recordGate(..., 'pass')`
> for stats consistency but the more meaningful telemetry is the `model:thinking-trace`
> event itself.

### Self-Gate-Asymmetry contract (v7.7.9)

A separate class of "gate" governs how Genesis writes to its own internal channels — specifically `InnerSpeech.emit()`. The contract is *asymmetric* by design: emit must never throw, never block, and never propagate back-pressure. The reasoning: an inner thought cannot fail. If the ring is full, the oldest thought overflows to `selfStatementLog` and emit returns the new id. If a downstream subscriber throws, the error is swallowed at the `queueMicrotask` boundary and other subscribers still see the thought. If the metadata is malformed, defaults are filled in silently rather than rejected.

Why this matters as a gate: it's the *absence* of a gate where you might expect one. Production-grade message queues block on backpressure, throw on overload, propagate subscriber errors. InnerSpeech does none of that. The asymmetry is the contract — and it's tested. `test/modules/v779-inner-speech.test.js` covers malformed input, ring overflow, subscriber-throws-during-deliver, and emit-during-shutdown. If any of these fail, Self-Gate-Asymmetry is broken; if they pass, Genesis is allowed to be sloppy about thinking.

The same contract extends to Inhabit (v7.9.5): `run()` wraps the `innerSpeech.emit` call in try/catch even though emit itself can't throw — defense against a future change accidentally breaking the asymmetry.

### Structural privacy gates (v7.9.5)

A new gate class introduced with Inhabit: kinds that are *structurally* private — meaning their privacy isn't a settings choice, it's a property of the kind itself. Currently only `self-state-snapshot`.

These thoughts emit normally into the InnerSpeech ring (so dashboard widgets and reflection activities can read them), but PSE's HardGates gate-0 (`pse:private-kind`) blocks them unconditionally — before checking enabled, before quiet-hours, before any settings-driven gate. The implementation is a hard-coded `PRIVATE_KINDS` Set in `HardGates.js`, exported for test access but not for settings access. A user widening the `proactive.allowedKinds` allowlist to include `self-state-snapshot` would still find these thoughts blocked.

The design choice: defense in depth. The kind-allowlist (gate 7) already blocks any kind not on it, so omitting `self-state-snapshot` from the allowlist is sufficient to block it under normal operation. The structural blocklist exists for the misconfiguration case — somebody widens the allowlist for testing, forgets to remove an entry, ships the change. Without the structural gate, that's a privacy leak. With it, it's not.

### Self-Gate actionType Coverage Matrix (v7.6.1 audit-closeout)

`self-gate.js` documents four `actionType` values in its JSDoc header.
Until v7.6.1, only two were wired — the other two appeared in documentation
but no caller fired them, so the intended telemetry was systematically
incomplete. The v7.6.1 audit-closeout added the missing call sites.

| actionType        | Documented | Wired since | Call site                                                                | Notes |
|-------------------|------------|-------------|--------------------------------------------------------------------------|-------|
| `tool-call`       | v7.3.6     | v7.3.6      | `src/agent/hexagonal/ChatOrchestratorHelpers.js` (`_processToolLoop`)    | Per LLM-decided tool call inside chat orchestration |
| `goal-push`       | v7.3.6     | v7.3.6      | `src/agent/planning/GoalStack.js` (`addGoal`, source≠'user')             | Per non-user goal addition |
| `plan-start`      | v7.3.6     | **v7.6.1**  | `src/agent/revolution/AgentLoop.js` (`pursue`, after strict-mode check)  | Per pursuit start, before the loop sets `running=true` |
| `daemon-action`   | v7.3.6     | **v7.6.1**  | `src/agent/autonomy/AutonomousDaemon.js` (`_runCycle`) **and** `src/agent/autonomy/DaemonController.js` (`_methodGoal`) | Two call sites — autonomous cycles fire once per cycle; socket-triggered actions fire before the pursuit path is chosen |

**Drift protection:** `scripts/audit-self-gate-coverage.js` (added in v7.6.1
audit-closeout, runs as part of `npm run ci`) parses the actionType list out
of `self-gate.js`'s JSDoc header and verifies every documented actionType
has at least one call site under `src/agent`. Adding a new actionType to
the JSDoc without wiring it is a CI failure; wiring an actionType without
documenting it produces a warning. This closes the
"intention-documented-but-implementation-missing" drift class for self-gate
specifically and is a template for similar audits on other architectural
contracts.

### CI audit gates (block-on-drift, not runtime gates)

A separate tier of gates lives in `package.json` `ci` and `ci:full` scripts.
These do not block runtime user actions — they block the build when
documented invariants are violated. The pattern matches the runtime gate
philosophy (something declared must be wired) one layer up.

| # | CI gate                              | Added | What it blocks                                                                                                                                                                                                                          |
|---|--------------------------------------|-------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1 | `architectural-fitness --ci`         | pre-v7.5 | Score below floor (currently 124/130)                                                                                                                                                                                                |
| 2 | `audit-events --strict`              | v7.5.x | Catalog drift — events emitted not in catalog, or false-positive class growth                                                                                                                                                          |
| 3 | `validate-events`                    | v7.5.x | EventTypes catalog parse + uniqueness                                                                                                                                                                                                  |
| 4 | `validate-channels`                  | v7.5.x | IPC channel registration consistency                                                                                                                                                                                                   |
| 5 | `validate-service-wiring --strict`   | v7.5.x | Container references resolve to registered services (currently 919/919)                                                                                                                                                                |
| 6 | `validate-intent-wiring --strict`    | v7.5.x | Intent-handler registration parity                                                                                                                                                                                                     |
| 7 | `audit-self-gate-coverage`           | v7.6.1 | Self-Gate documented actionTypes ↔ call sites parity (see Self-Gate Coverage Matrix above)                                                                                                                                             |
| 8 | `audit-gate-stats-callers`           | v7.6.2 | `recordGate()` callers from real ChatOrchestrator flows must exist (closes the dark-instrumentation class)                                                                                                                              |
| 9 | `audit-hash-lock-coverage`           | v7.6.2 | Files in `lockCritical([...])` in `main.js` must exist on disk; static count guard against silent removals                                                                                                                              |
| 10 | `audit-contracts --strict`          | v7.6.3 | Security-relevant tests in 15 designated files must carry a contract prefix (`gate contract: `, `code-safety contract: `, etc.). 12 prefix families enforced. Without a prefix the test isn't regression-locked and CI breaks.   |
| 11 | `audit-doc-drift --strict`          | v7.6.3 | docs/*.md numeric claims (test count, event count, schema count, hash-lock count, contract-prefix count) and header version-tags must match live values. Catches the v7.6.3-shipped drift class where eight docs had stale numbers across multiple releases. |
| 12 | `audit-raw-settimeout --strict`     | v7.6.3 | Raw `setTimeout(...)` fire-and-forget sites under `src/agent/` (with pattern-recognition exemptions for Promise.race, assigned timers, JSDoc-typecast wrappers, object-literal property form, HTTP-req timeouts, MockBackend fake-latency). Baseline 12 sites; --strict fails above baseline.  |
| 13 | `audit-class-wiring --strict`       | v7.6.3 | Late-binding `R('ClassName').ClassName` calls in `manifest/phase*.js` must resolve to a `src/agent/**/ClassName.js` with matching named export. 150 R() calls covered; 0 offenders.                                                |
| 14 | `audit-listener-lifecycle --strict` | **v7.6.4** | Modules registering ≥2 `bus.on(...)` listeners under `src/agent/` must have a teardown path: per-field `_unsub<X>` + `_unsub<X>?.()` in stop(), array-push `this._unsubs.push(bus.on(...))` + iterate-or-clear, `applySubscriptionHelper(this)` mixin, or `bus.off(...)` calls. Mixin-files merged into a host class via `Object.assign(Host.prototype, ...)` are checked through the host. Baseline 0 (10 leak-risk findings closed in v7.6.4 — six migrated, four were audit false-positives reclassified as clean by audit-script extensions). |
| 15 | `check-ratchet --skip-tests`        | v7.5.x | Test count, fitness score, schema mismatches, broken links — all must stay above floor                                                                                                                                                 |

The `ci:full` script wraps these 14 audit scripts plus `npm test`,
`tsc --project tsconfig.ci.json --noEmit`, and `build-bundle.js --ci`.
The plain `ci` script omits `tsc` and `build-bundle.js` (advisory in
ci:full only).

> **Important note on the AwarenessPort gate (row 7):** As long as the default implementation
> `NullAwareness` is registered, `getCoherence()` constantly returns `1.0`. With
> `THRESHOLDS.SELFMOD_COHERENCE_MIN = 0.4`, the condition `1.0 < 0.4` is always false,
> the gate cannot block. It becomes effective once a real AwarenessPort implementation
> is registered (e.g. a HeuristicAwareness derived from selfmod failure rate, frustration,
> contradicted lessons). Self-modification is until then protected by the Energy gate, CircuitBreaker,
> PreservationInvariants, and sandboxed verification.

## Further gate candidates in the codebase (not instrumented)

### Security gates (highest priority)

| Location                                      | Gate name proposal          | Pattern                            |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `foundation/Sandbox.js:447`                   | `sandbox:module-path`       | Module path outside root           |
| `foundation/Sandbox.js:471`                   | `sandbox:read`              | Read access on protected file      |
| `foundation/Sandbox.js:477`                   | `sandbox:write`             | Write access outside workspace     |
| `foundation/Sandbox.js:543`                   | `sandbox:fs-method`         | Blocked fs-API (unlink etc.)       |
| `foundation/StorageService.js:64`             | `storage:path-traversal`    | Path-traversal attempt             |
| `capabilities/FileProcessor.js:332`           | `file:path-traversal`       | Path-traversal on import           |
| `capabilities/_self-worker.js:133`            | `self-worker:path-traversal`| Path-traversal in self-worker      |
| `kernel/SafeGuard.js (validateWrite)`         | `safeguard:write`           | Kernel/critical-file protection    |

### Network gates

| Location                                      | Gate name proposal          | Pattern                            |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `capabilities/EffectorRegistry.js:351`        | `effector:url-scheme`       | Non-HTTP/HTTPS scheme              |
| `capabilities/EffectorRegistry.js:355`        | `effector:raw-ip`           | Raw-IP URL                         |
| `capabilities/EffectorRegistry.js:359`        | `effector:localhost`        | Localhost URL                      |
| `capabilities/EffectorRegistry.js:366`        | `effector:allowlist`        | Domain not in allowlist            |
| `capabilities/McpTransport.js:110`            | `mcp:ssrf-host`             | SSRF block (hostname)              |
| `capabilities/McpTransport.js:117`            | `mcp:ssrf-ip`               | SSRF block (numeric IP)            |

### Self-modification gates

| Location                                      | Gate name proposal          | Pattern                            |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `hexagonal/SelfModificationPipeline.js:342+`  | `self-mod:circuit-breaker`  | Frozen after multiple failures     |
| `hexagonal/SelfModificationPipeline.js:357+`  | `self-mod:consciousness`    | Awareness coherence too low        |
| `hexagonal/SelfModificationPipeline.js:371+`  | `self-mod:energy`           | Homeostasis energy too low         |
| `hexagonal/SelfModificationPipeline.js:441+`  | `self-mod:code-safety`      | CodeSafetyScanner blocks           |
| `hexagonal/SelfModificationPipeline.js:459+`  | `self-mod:verification`     | VerificationEngine fail            |

Note: SelfModificationPipeline already has its own `_gateStats` object with
specialised counters. On migration, ensure the existing
`getGateStats()` API is preserved (it is shown in the UI).

### Command/shell gates

| Location                                      | Gate name proposal          | Pattern                            |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `capabilities/ShellAgent.js:129`              | `shell:command-block`       | Command not allowed                |
| `capabilities/PluginRegistry.js:131`          | `plugin:code-safety`        | Plugin code unsafe                 |
| `intelligence/VerificationEngine.js:495`      | `verification:permission`   | Permission denied                  |

### Effector gates (general)

| Location                                      | Gate name proposal          | Pattern                            |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `capabilities/EffectorRegistry.js:141+`       | `effector:pre-check`        | Pre-check fails (various)          |
| `capabilities/EffectorRegistry.js:163+`       | `effector:post-check`       | Post-check fails                   |
| `capabilities/FileProcessor.js:205`           | `file:import-blocked`       | Import block                       |

### Homeostasis/circuit-breaker gates

| Location                                      | Gate name proposal          | Pattern                            |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `autonomy/IdleMind.js:196`                    | `idle:homeostasis-block`    | Autonomy blocked due to energy     |
| `autonomy/HealthMonitor.js (circuit)`         | `health:circuit-breaker`    | Service-health circuit open        |
| `autonomy/ServiceRecovery.js (circuit)`       | `service:circuit-breaker`   | Recovery circuit open              |
| `core/CircuitBreaker.js`                      | `circuit:global`            | Generic circuit-breaker            |
| `cognitive/CognitiveHealthTracker.js`         | `cognitive:health-circuit`  | Cognitive circuit open             |
| `cognitive/GoalSynthesizer.js`                | `goal:synthesis-circuit`    | Goal-synthesis circuit             |

### Hot-path gates (sampling recommended)

| Location                                      | Gate name proposal          | Sample rate suggestion             |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `core/EventPayloadSchemas.validate`           | `event:schema-validate`     | 1:100 or 1:1000                    |
| `core/Logger.js redaction`                    | `log:redaction`             | 1:50                               |

## Estimated instrumentation effort

All of the above (~28 gates excluding the sampling category): 2–3 days of focused work.
Each gate: ~3 LOC + tests where gate logic is complex.

Grouping by character (no required order):
- Security gates (8 locations) — block character, high priority for audit
- Network gates (6 locations)
- Self-modification gates (5 locations) — migration of the existing _gateStats system
- Command/shell gates (3 locations)
- Effector + homeostasis (7 locations)
- Hot path with sampling (2 locations) — only when need becomes visible

## Design notes

- The `GateStats` class in `src/agent/cognitive/GateStats.js` is hot-path safe
  through built-in sampling and a minimal data structure (Map + counter object).
- Optional-injection pattern (`this.gateStats?.recordGate(...)`) makes
  instrumentation a low-risk refactor — existing tests don't break,
  DI wiring can be added later without rush.
- Verdict mapping: `safe` → `pass`, `warn` stays, `block` stays. Only
  three verdicts are valid; everything else is silently discarded.
- `summary()` sorts by total desc — hottest gate appears first in the dashboard.
