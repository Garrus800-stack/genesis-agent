# Genesis Agent — Changelog v6.x.x

For the current release notes see [CHANGELOG.md](../CHANGELOG.md).

---

## [6.1.1] — Coverage Target

**Focus: Push coverage toward the v6 target (80/75/75). 26 low-coverage modules tested across 8 test files, +298 tests. Final: 79.75/75.16/77.22 — ratchet set to 79/75/75. Plus 12 bugfixes making Genesis practically usable: IPC spam eliminated, AgentLoop robust, Sandbox opened for skills, prompts cleaned up, self-teaching capability gaps, chat Run button.**

### Bugfixes

- **IPC Serialization Spam** — `agent:loop-status` IPC handler and `push()` in AgentCoreWire now sanitize data via `JSON.parse(JSON.stringify())` before sending over Electron IPC. Eliminates hundreds of "An object could not be cloned" errors per minute during AgentLoop execution.
- **ArchReflect Memory Churn** — Stale threshold increased from 60s to 300s (5min). Reduces architecture graph rebuilds from ~60/hour to ~12/hour, lowering memory pressure during idle operation.
- **AgentLoop Goal `[object Object]`** — `pursue()` passed an object to `GoalStack.addGoal()` which expects a string. Goals now registered with the actual description text, not a serialized object literal.
- **AgentLoop Simulation Hard-Block** — Simulation "replan" recommendation no longer aborts the entire goal. Changed from hard gate to advisory warning. Genesis now proceeds with risk-flagged plans instead of refusing to act, enabling learning from outcomes.
- **Sandbox Blocks Skills** — Added `fs` to allowed modules. Skills now have filesystem access, scoped by path restrictions (read: project root + sandbox + node_modules; write: sandbox only). SkillManager passes project root via `GENESIS_SANDBOX_ALLOW_READ_ROOT`.
- **Repetitive Self-Report Prompt** — Removed "was bist du?", "wer bist du?", "what are you?" from `self-inspect` intent. Identity questions now route to `general` intent, letting the LLM answer naturally instead of dumping a technical module report.
- **Prompt Section Bloat** — Extended model gating to all Ollama-served models (added kimi, mannix). Gated sections expanded from 4 to 8: organism, consciousness, selfAwareness, bodySchema, metacognition, values, anticipator, optimizer. Reduces prompt noise that confuses LLMs into philosophical responses instead of action.
- **EISDIR in SelfModel.readModule** — `readModule()` now checks `isFile()` before reading, preventing EISDIR errors when AgentLoop steps target directories instead of files.
- **Genesis Never Asks** — Added 3 prompt rules: ask clarifying questions when stuck (never "Nothing to retry"), explain failures with next steps, report progress and ask at decision points during autonomous work.
- **Skill Creation Prompt** — Rewritten `create-skill` template: explicit output format (separate JSON + JS blocks), lists allowed/blocked modules, emphasizes JSON-serializable returns and working test() methods. Skills should now be functional instead of empty shells.
- **Chat Code Block ▶ Run Button** — JavaScript code blocks in chat now have a "▶ Run" button that executes directly in the sandbox and shows output inline. Previously only "Open in editor" was available.
- **Self-Teaching Capability Gaps** — When Genesis says "I can't", LearningService now detects this and emits `learning:capability-gap`. The Daemon picks up these real user requests and attempts to auto-create skills for them on the next cycle. Gap detection is no longer limited to a hardcoded list of 4 capabilities — Genesis learns what it needs from actual usage. Prompt also updated: Genesis now tries to solve problems with existing tools or build new skills instead of refusing.
- **"use your skill"** — Skill name extraction now handles German possessives (dein, mein, den, der). Previously "use your skill" extracted the possessive as skill name, fell back to shell, and ran `use` as a command.
- **Chat ▶ Button: HTML → Browser** — HTML code blocks now show "▶ Open" which saves as temp file and opens in system browser. JS code blocks show "▶ Run" for sandbox execution. Password generators, UIs etc. open directly.
- **`agent:open-path` IPC** — New IPC channel for opening files/folders anywhere on the system. Resolves `~` to home dir. Supports absolute paths, relative paths.
- **Open folders: Desktop, Downloads** — `openPath` handler resolves semantic names across supported languages: "Desktop", "Downloads", "Documents", "Pictures", "Music", "Home". "Open the folder XYZ on the Desktop" works.
- **Save files to Desktop** — `save-file` IPC now resolves `~` paths to home directory. Files can be saved to `~/Desktop/`, `~/Downloads/` etc., not just the project root.
- **Tool-Loop closed** — When NativeToolUse is unavailable, ChatOrchestrator now parses `<tool_call>` tags from LLM text output, executes the tools, feeds results back to the LLM, and loops up to 5 rounds. Previously tool calls in text were displayed as raw tags without execution.
- **Test-Fix v510** — Updated "what are you?" test expectation from `self-inspect` to `general` after intent routing change.
- **Paths with spaces** — Windows-path regex now captures full paths including spaces (e.g. "New Folder (3)"). Previously the regex cut off at the first space.
- **"open Firefox"** — Launching applications now works: `start` on Windows, `open -a` on macOS, `xdg-open` on Linux. Previously "open" was sent as a shell command.
- **`open-in-editor` tool** — New tool that opens files in Genesis's Monaco editor. LLM can now call `open-in-editor` when the user says "show in editor".
- **Skill-prefix fallback** — ToolRegistry.execute() now auto-searches under `skill:${name}` when a tool is not found directly. Skills are callable from the LLM without prefix.
- **Tool results → LessonsStore** — Every tool call in chat is stored as a lesson (success + failure). ChatOrchestrator now has a LessonsStore late-binding.
- **Shell commands → LessonsStore** — CommandHandlers emits `shell:outcome` events. LessonsStore listens and remembers which commands work on which platform.
- **Dream-insights → LessonsStore** — `dream:complete` events now flow into LessonsStore. Dreams are no longer decorative — insights are stored as lessons and influence future behavior.
- **Memory pressure thresholds** — Healthy threshold raised from 85% to 93%. V8 in Electron naturally runs at 85-95% heap utilization. The old threshold caused permanent CRITICAL states and unnecessary cache pruning.

### Coverage Sweep

- **CommandHandlers** (23% → ~55%): 37 tests covering all 18 handler methods — executeCode, executeFile, daemonControl, journal, plans, goals, handleSettings, webLookup (npm/URL/ping), runSkill, shellTask, shellRun, projectScan, mcpControl, registerHandlers.
- **Reflector** (21% → ~65%): diagnose (kernel integrity, syntax errors, require-chain), repair (kernel/missing-dep/unknown), suggestOptimizations (complexity + coupling detection).
- **CodeAnalyzer** (51% → ~85%): analyze routing (file/inline/general), _analyzeFile with missing file, compareWith.
- **SelfOptimizer** (33% → ~75%): analyze(), all 4 _analyze* methods, _trackQuality, _trackError, recommendation generation, getLatestReport, buildContext.
- **ModuleRegistry** (39% → ~70%): register, registerSelf, validate (missing deps, phase violations, clean manifest), getManifest with late bindings.
- **HealthServer** (29% → ~80%): _basicHealth, _fullHealth (with/without services, compromised kernel), start/stop lifecycle.
- **SkillManager** (36% → ~70%): loadSkills (empty/valid/invalid), listSkills, executeSkill (unknown skill), removeSkill.
- **HomeostasisEffectors** (54% → ~75%): _handlePruneCaches (LLM cache, vector memory at high/low pressure), _handlePruneKnowledge (with/without KG), _handleReduceContext, getReport, start/stop.
- **ReasoningEngine** (42% → ~65%): _assessComplexity (7 strategy patterns), _detectToolNeed (4 tool patterns), _directAnswer, _buildContextualPrompt, _parseSubTasks, _isToolRelevant, _callTool.
- **LearningService** (48% → ~70%): _extractFacts (DE+EN), _extractPreferences, _recordIntentOutcome, _trackToolUsage, _trackIntentSequence, _learnFromChat full pipeline, start/stop.
- **PromptEvolution** (48% → ~65%): getSection, recordOutcome, getStatus, setEnabled, buildPromptContext, stop.
- **NativeToolUse** (36% → ~60%): _buildToolSchemas (all/filtered), _convertInputSchema, _supportsNativeTools, _appendToolResults (ollama), getStats.
- **SelfSpawner** (46% → ~60%): getActiveWorkers, killAll, kill.
- **IntrospectionEngine** (57% → ~70%): _tick (productive tension, depletion risk, social hunger), stats accumulation, start/stop.
- **TemporalSelf** (64% → ~75%): getReport, getRetention, getCurrentChapter, buildPromptContext, start/stop.
- **AgentLoop** (33% → ~50%): _reportCognitiveLevel (NONE/PARTIAL/FULL), getStatus, approve/reject, stop (cleanup + pending rejection), _buildStepContext (consciousness + value + workspace context), _reflectOnProgress.
- **AgentLoopSteps** (16% → ~45%): _executeStep dispatch (ANALYZE, SHELL, SANDBOX, SEARCH, ASK, unknown type), symbolic DIRECT bypass, symbolic GUIDED enrichment, error handling.
- **McpTransport** (19% → ~50%): _validateMcpUrl (SSRF protection: 9 test cases — valid URLs, localhost, private IPs, numeric obfuscation), _recordLatency, getLatencyPercentiles, enqueue/queue-full, disconnect cleanup, getStatus, _maybeReconnect.
- **AutonomousDaemon** (48% → ~65%): _healthCheck (clean + with issues + trust-gated repair), _consolidateMemory (with/without memory), _learnFromHistory, getStatus, runCheck dispatch, _log level filtering, start/stop.
- **GoalStack** (59% → ~75%): addGoal, pauseGoal, resumeGoal, abandonGoal, getProgress, getGoalTree.
- **EpisodicMemory** (75% → ~85%): recall (keyword + tag + outcome filters), getByTag, getRecent, buildContext, getStats, getTags, _scoreRelevance, _tokenize.
- **AttentionalGate** (65% → ~75%): getCurrentFocus, getPrimaryFocus, getMode, getGateWidth, directFocus, buildPromptContext, getReport, _tick, start/stop.
- **EffectorRegistry** (70% → ~80%): register, execute (success + unknown), listEffectors, getSchemas, getStats.

### Stats

- Source: 243 files, ~85k LOC. Tests: 283 files, 4266 passing, 0 failing.
- Coverage ratchet: 77/73/73 → 79/75/75. Actual: 79.75/75.16/77.22.
- Fitness: 90/90. Events audit: ✅. TSC: 0 errors.

---

---

## [6.1.0] — Observability

**Focus: Every system that makes a decision must count it. Silent failures eliminated, consciousness layer made measurable, coverage pushed forward.**

### Silent Catch Audit

- **`swallow()` utility** (core/utils.js, ~17 LOC): Centralised fire-and-forget pattern. Replaces 10× bare `.catch(() => {})` across 5 modules with `swallow(promise, label)` — semantically identical, but failures are now visible in debug logs. Zero functional change.
- **TaskOutcomeTracker** (CRITICAL): `storage.write()` failures no longer silently lost — Learning Flywheel data integrity depends on this path.
- **NetworkSentinel** (5 sites), **AutoUpdater** (2 sites), **SkillRegistry** (2 sites): All migrated to `swallow()`.
- **chat.js clipboard**: Intentionally kept as `.catch(() => {})` — UI layer, no Logger available.

### Self-Modification Gate Statistics (NEW)

- **`_gateStats`** in SelfModificationPipeline: 7 counters tracking every decision at all 4 gates (circuit breaker, consciousness, energy, pass). Answers the question: "Does ConsciousnessGate actually block anything?"
- **`getGateStats()`**: Returns `blockRate`, `consciousnessBlockRate`, per-gate counts, last coherence value.
- **IPC `agent:get-gate-stats`**: New endpoint. Preload whitelisted.
- **Dashboard**: Consciousness panel now shows Self-Mod Gates block with pass/attempt ratio, consciousness block rate, energy blocks. Only visible when `totalAttempts > 0`.
- 6 tests (initial state, circuit breaker, consciousness, energy, pass-through, mixed rate computation).

### Coverage Push

- **3 new test files** targeting previously untested modules:
  - `v610-ports-coverage.test.js`: PeerHealth (10), CorrelationContext (10), NullWorkspace, SandboxPort, KnowledgePort, MemoryPort
  - `v610-data-layer-coverage.test.js`: EventStore (10), ConversationMemory (10)
  - `v610-wiring-coverage.test.js`: BiologicalAliases (4), CostGuard (6), utils._round, robustJsonParse, safeJsonParse
- Coverage ratchet bumped: 77/72/72 → 77/73/73.

### Event Schema Ratchet (NEW CI Gate)

- `validate-events.js`: New Check 4 — Schema Coverage Ratchet. Enforces `MINIMUM_SCHEMA_RATE = 0.25` (25%). New events without schemas will be flagged before they can erode coverage below the floor.

### Stats

- Source: 243 files, ~85k LOC. Tests: 275 files, 3951 passing, 0 failing.
- Fitness: 90/90. Events audit: ✅. TSC: 0 errors.

---

---

## [6.0.9] — The Learning Flywheel (Hardened)

**Focus: Deep audit of v6.0.8 — every finding resolved, DIRECT resolution live, full test coverage, zero red tests.**

### Bug Fixes

- **DIRECT Resolution live** (SR-BUG-1, HIGH): `LessonsStore.recall()` now returns `useCount` + `lastUsed` in its result shape. Previously missing — DIRECT path in SymbolicResolver was dead code. Mock divergence in tests corrected to match real `recall()` signature.
- **BackupManager overwrite test** (BM-PRE-1): `tmpDir()` used `Date.now()` without uniqueness suffix — two calls in the same millisecond returned the same directory. Fixed with counter suffix. 9/9 green.

### API Improvements

- `LessonsStore.updateLessonOutcome(id, success, opts)`: New public API for confidence feedback. Replaces private `_lessons` array access in SymbolicResolver. Clean encapsulation.
- `SymbolicResolver._pass()`: Now emits `symbolic:fallback` event with `{ reason, stepType }`. Previously registered but never emitted.
- `EventPayloadSchemas`: +1 schema (`symbolic:fallback`). All 4 v6.0.8 events now have schemas.

### New Wiring

- **Productive Tension → Step Boost**: AgentLoop subscribes to `consciousness:insight`. When IntrospectionEngine detects productive tension, `maxStepsPerGoal` is raised by `AGENT_LOOP_STEP_EXTENSION`. Listener cleanup in `stop()` via `_unsubs`.

### Test Coverage

- SymbolicResolver: 20 → 24 tests (+4: fallback events, graceful missing lesson, DIRECT for ANALYZE).
- DirectedCuriosity: 5 new tests (`directed-curiosity.test.js`) — weakness scorer, targeted explore, event emission, fallback to random.
- ConsciousnessGate: 5 new tests (`consciousness-gate.test.js`) — block <0.4, allow ≥0.4, no PhenomenalField, event emission, error graceful.
- BackupManager: 8/1 → 9/0. Zero flaky tests.

### Stats

- Source: 243 files, ~85k LOC. Tests: 273 files, 3879 passing, 0 failing.
- Fitness: 90/90. Events audit: ✅. TSC: 0 errors.

---

---

## [6.0.8] — The Learning Flywheel

**Focus: Genesis thinks before it calls the LLM. Three isolated systems become one feedback loop.**

### Symbolic Resolution (NEW)

- `SymbolicResolver.js` (~280 LOC): Before every AgentLoop step calls model.chat(), checks LessonsStore + SchemaStore for known solutions. Three levels: DIRECT (bypass LLM, execute known fix), GUIDED (inject lesson as directive into prompt), PASS (normal flow).
- Wired into `AgentLoopSteps._executeStep()` — single injection point before the step-type switch.
- DIRECT only for safe actions (ANALYZE, SHELL, SEARCH) with high confidence (>0.85), proven track record (useCount > 3), and recent success (< 7 days). CODE and SELF_MODIFY can never be DIRECT.
- GUIDED mode prepends lessons as DIRECTIVE (not context) — stronger signal than PromptBuilder injection.
- Outcome recording via `LessonsStore.updateLessonOutcome()` — success boosts confidence, failure penalizes. Creates a learning flywheel.
- Phase 2 manifest. Late-bound to LessonsStore + SchemaStore. 24 tests.

### Directed Curiosity

- `IdleMind._pickActivity()`: New scorer queries `CognitiveSelfModel.getCapabilityProfile()` for weak task types. Boosts `explore` score proportionally to weakness count.
- `IdleMind._explore()`: When weakness is known, targets modules related to the weak area (WEAKNESS_MODULE_MAP) instead of random exploration. Generates targeted insights.
- Late-binding: `cognitiveSelfModel` → IdleMind (phase 6 manifest).
- Event: `idle:curiosity-targeted` with weakness, targetModule, insight. 5 tests.

### Consciousness Gate

- `SelfModificationPipeline.modify()`: Checks `PhenomenalField.getCoherence()` before allowing self-modification. Coherence < 0.4 → modification deferred with user-facing message.
- First real consciousness→action coupling in Genesis. The consciousness layer now has a measurable job.
- Late-binding: `phenomenalField` → SelfModPipeline (phase 5 manifest).
- Event: `selfmod:consciousness-blocked` with coherence score. 5 tests.

### Productive Tension

- `AgentLoop`: Subscribes to `consciousness:insight` — when IntrospectionEngine detects productive tension (frustration driving better solutions), temporarily raises `maxStepsPerGoal`. Listener cleanup in `stop()`.

### Infrastructure

- EventTypes: +4 events (symbolic:resolved, symbolic:fallback, selfmod:consciousness-blocked, idle:curiosity-targeted).
- EventPayloadSchemas: +4 schemas (symbolic:resolved, symbolic:fallback, selfmod:consciousness-blocked, idle:curiosity-targeted).
- `LessonsStore.recall()`: Now returns `useCount` + `lastUsed` in result shape.
- `LessonsStore.updateLessonOutcome()`: New public API for confidence feedback (replaces private `_lessons` access).
- Source: 243 files, ~85k LOC. Tests: 273 files, ~3879 passing.

---

---

## [6.0.7] — Earned Autonomy + Model-Aware Prompt Gating

**Focus: Close the trust feedback loop — Genesis earns the right to act without asking.**

### Earned Autonomy (NEW)

- `EarnedAutonomy.js` (~230 LOC): Per-action-type Wilson score confidence tracker. Records outcomes from `agent-loop:step-complete` / `agent-loop:step-failed`. When wilson_lower > 0.85 (30+ samples), auto-promotes action type to TrustLevelSystem. Auto-revokes below 0.70.
- `AgentLoop._requestApproval()`: Now consults `TrustLevelSystem.checkApproval()` **before** asking the user. Auto-approved actions skip the user prompt entirely, emit `agent-loop:auto-approved`.
- Late-binding: `trustLevelSystem` → AgentLoop (phase 8 manifest).
- CLI `/autonomy`: Per-action confidence bars, trust level, earned overrides.
- IPC `agent:get-autonomy-report`. Preload whitelisted. 21 tests.

### Reactive Prescription

- `OnlineLearner._checkStreak()`: Streak detection (3+ consecutive failures) now triggers `AdaptiveStrategy.runCycle()` immediately. Closes feedback gap from hours (IdleMind calibrate schedule) to seconds.
- Late-binding: `adaptiveStrategy` → OnlineLearner (phase 9).

### Trust-Gated Daemon

- `AutonomousDaemon._healthCheck()`: Repair scope now depends on trust level. Level 0-1: syntax only (safe). Level 2+: syntax + style + optimization.
- Late-binding: `trustLevelSystem` → daemon (phase 6 manifest).

### Model-Aware Prompt Gating

- `PromptBuilder._applyModelGating()`: Local models (llama, qwen, gemma, mistral, deepseek, phi, etc.) auto-skip organism/consciousness/selfAwareness/bodySchema prompt sections. Cloud models (Claude, GPT) keep everything. Failover-aware — re-enables on model switch.
- **Benchmark result**: 4x latency reduction on local models with 0% quality loss (A/B validated).

### Cognitive Boot Default

- Default boot profile changed from `full` to `cognitive` (phases 1-12). Phase 13 (consciousness) benchmarked at 0pp success rate impact. Opt-in via `--boot-profile full`.

### Infrastructure

- EventTypes: +5 events (`agent-loop:step-failed`, `agent-loop:auto-approved`, `autonomy:earned`, `autonomy:revoked`, `autonomy:status`).
- EventPayloadSchemas: +7 schemas (step-failed, auto-approved, 3 trust events, 2 autonomy events).
- IPC: +1 channel (`agent:get-autonomy-report`).
- Shutdown: `earnedAutonomy` added to TO_STOP.
- All audits green: fitness 90/90, events ✅, channels 64/64 in sync.

---

---

## [6.0.6] — Replay + KG Offline-Cache + SelfModel Dashboard + Colony Live

**Focus: Deterministic task replay, complete offline operation, visible self-awareness, and real multi-instance colony proof.**

### V6-8: Deterministic Replay (NEW)

- `TaskRecorder.buildReplayManifest(id)`: Merges steps, LLM calls, and tool calls into a single chronological timeline sorted by offset.
- `TaskRecorder.replay(id, {speed, emit})`: Replays recorded events on the bus. `speed: 0` = instant, `speed: 1` = real-time. Emits `replay:started`, `replay:event`, `replay:completed`.
- `TaskRecorder.formatReplay(manifest)`: Human-readable timeline with step/LLM/tool entries and timing.
- CLI `/replay <id>`: Shows full timeline for a recording. Supports partial ID matching.
- 3 new events registered in EventTypes + PayloadSchemas.
- 16 tests (buildReplayManifest, replay, formatReplay, bus events, edge cases).

### V6-10: KG Offline-Cache Complete

- NetworkSentinel now flushes `KnowledgeGraph` + `LessonsStore` to disk on offline transition. Zero data loss.
- Late-bindings added: `_knowledgeGraph` + `_lessonsStore` in phase 6 manifest.
- KG search already has keyword fallback without embeddings — queries work offline out of the box.
- V6-10 is functionally complete: network detection ✅, Ollama failover ✅, KG cache ✅, sync on reconnect ✅.

### V6-11: SelfModel Dashboard — Complete

- **Dashboard Panel**: Fully wired — capability radar (Wilson floor bars), backend recommendations, bias alerts. Renderer: `_renderSelfModel()` in DashboardRenderers.js. IPC: `agent:get-selfmodel-report`. Auto-refreshed every Dashboard tick.
- **CLI `/selfmodel`** (v6.0.6): Visual capability profile with bar charts (★ STRONG / ⚠ WEAK), backend strength map, bias patterns, outcome stats.

### V6-3: Live Deployment — Enhanced Strategies

- All 4 strategies (Direct/Canary/Rolling/Blue-Green) now support HTTP + shell health checks.
- `_httpHealthCheck(url, timeout)`: HTTP probe for external deploy targets.
- Canary: 2 health checks before expanding. Rolling: per-step + final verification. Blue-Green: 3 checks + `deploy:swap` event.
- Pre-flight validates environment (dev/staging/prod). CLI `/deploy` for deployment history.
- `deploy:swap` event registered in EventTypes + PayloadSchemas.
- 17 tests covering all strategies, rollback, pre-flight, health checks.

### V6-1: Colony — Real Peer Verification (ENHANCED)

- `scripts/colony-test.js` enhanced: peer discovery via `/discover`, sync/pull verification, cross-instance identity.
- Colony convergence proven in unit tests: v605-colony-live.test.js (17 tests, 3-peer daisy-chain).

---

---

## [6.0.5] — Offline-First + Pipeline Validation + Colony Convergence Proof

**Focus: Network resilience with automatic Ollama failover, end-to-end validation of the v6.0.4 intelligence pipeline, and real cross-instance colony convergence proof.**

### V6-10: NetworkSentinel — Offline-First (NEW)

- `src/agent/autonomy/NetworkSentinel.js` (~400 LOC): Periodic connectivity monitoring with automatic failover to local Ollama models.
- Probes 2 external endpoints + Ollama local health. Debounced: 3 consecutive failures → offline.
- **Auto-Failover**: On network loss, saves current cloud model, switches to best available Ollama model via `ModelBridge._selectBestModel()`. Zero manual intervention.
- **Auto-Restore**: On reconnect, restores previous cloud model. Emits `network:restored`.
- **Mutation Queue**: Ring buffer (500 entries) for deferred sync events. Replayed on reconnect with `_replayed` flag.
- Events: `network:status`, `network:failover`, `network:restored` (all in EventTypes catalog + PayloadSchemas).
- Phase 6 manifest, late-bound `_modelBridge` + `_settings`. `TO_STOP` registered.
- 24 tests.

### Intelligence Pipeline Integration Validation (NEW)

- `test/modules/v605-intelligence-pipeline.test.js` (16 tests): First end-to-end validation of the v6.0.4 closed loop.
- Validates: `CognitiveBudget.assess()` → `ExecutionProvenance.beginTrace/record*/endTrace` → `AdaptivePromptStrategy.analyze()` → `getSectionAdvice()`.
- Budget filtering: TRIVIAL skips organism/consciousness, COMPLEX keeps everything.
- 10-iteration convergence test: advice is deterministic (no oscillation).
- Per-intent advice: code vs chat produce independent section recommendations.
- Edge cases: empty provenance, disabled budget, ring buffer eviction.

### Colony Live Convergence Proof (NEW)

- `test/modules/v605-colony-live.test.js` (17 tests): Real cross-instance convergence with two `PeerConsensus` instances.
- Unidirectional A→B, bidirectional A↔B, idempotent re-sync.
- LWW conflict resolution on concurrent edits (wall-clock timestamp wins).
- Multi-round catch-up: 10 missed mutations recovered in 1 sync.
- **3-peer daisy-chain**: Alpha↔Beta↔Gamma converges to identical state.
- Multi-domain: settings + knowledge + schemas sync independently with per-domain vector clocks.

### Shutdown Coverage Fix

- 4 services added to `TO_STOP` in AgentCoreHealth: `cognitiveBudget`, `executionProvenance`, `adaptivePromptStrategy`, `networkSentinel`.
- Restores fitness score from 80/90 → 90/90 (100%).

### Consolidation — Event Catalog + CC Reduction

- **Event warnings: 2 → 0**: `lesson:learned` (AdaptiveStrategy) and `prompt:strategy-updated` (AdaptivePromptStrategy) added to EventTypes catalog + PayloadSchemas. CI event validation now fully clean.
- **CC>30 reduction**: `FailureAnalyzer._buildPatternDB` refactored from inline match() lambdas (CC=56) to declarative `PATTERN_RULES` table (CC=8). 29 tests pass unchanged.
- **SA-O1 closed**: Remaining 9 CC>30 functions documented as intentional (core loops, safety-critical, consciousness rules). No further action.
- **BodySchema wiring**: NetworkSentinel late-bound into BodySchema (phase 7). `canAccessWeb` now reflects real connectivity status instead of static effector presence.
- **Coverage sweep**: 32 new tests covering constructors + public APIs of 20 modules across 2 sweep files. Ports (KnowledgePort, MemoryPort, SandboxPort, WorkspacePort), cognitive (IntrospectionEngine, ConsciousnessExtensionAdapter), planning (Anticipator, Reflector, SelfOptimizer, SolutionAccumulator, GoalPersistence), revolution (SessionPersistence, NativeToolUse, ReasoningEngine, VectorMemory, ModuleRegistry), hexagonal (CommandHandlers, LearningService).
- **Coverage ratchet bumped**: 75/70/70 → **77/72/72** (lines/branches/functions). Functions went from 69.6% → 75.2% without vendor (+5.6pp). 4 sweep test files, 90 new tests total.

### CLI Commands (NEW)

- `/network`: NetworkSentinel status — online/offline, failover state, Ollama availability, probe stats, mutation queue size.
- `/trace`: Last ExecutionProvenance trace — budget tier, intent, prompt sections, model, response metrics.
- `/traces`: Last 5 traces as compact overview (tier, duration, outcome).

### IPC Channels (NEW)

- `agent:get-network-status`: Returns NetworkSentinel.getStatus() for Dashboard.
- `agent:force-network-probe`: Triggers immediate connectivity probe.
- `agent:get-provenance-report`: Returns ExecutionProvenance stats + recent traces + last trace.
- Channels: 60 → **63** (55 invoke + 2 send + 6 receive). All in sync.

### Files Changed

- `src/agent/autonomy/NetworkSentinel.js` (NEW, ~400 LOC)
- `src/agent/core/EventTypes.js`: +6 events (NETWORK + LESSONS.LEARNED + PROMPT_STRATEGY.UPDATED)
- `src/agent/core/EventPayloadSchemas.js`: +5 schemas
- `src/agent/manifest/phase6-autonomy.js`: +networkSentinel registration
- `src/agent/manifest/phase7-organism.js`: +networkSentinel late-binding for BodySchema
- `src/agent/organism/BodySchema.js`: +networkSentinel sampler (canAccessWeb live)
- `src/agent/AgentCoreHealth.js`: +4 services in TO_STOP
- `src/agent/revolution/FailureAnalyzer.js`: _buildPatternDB CC 56→8
- `cli.js`: +3 commands (/network, /trace, /traces)
- `main.js`: +3 IPC handlers
- `preload.js` + `preload.mjs`: +3 channels whitelisted
- `package.json`: version 6.0.5, coverage ratchet 77/72/72
- `README.md`: Offline-First feature documented
- `docs/`: 5 docs updated to v6.0.5
- 8 new test files (152 tests)

---

---

## [6.0.4] — Proportional Intelligence + Empirical Validation + Smart Model Selection

**Focus: Proportional cognitive effort, causal traceability, empirically validated architecture, verified consensus, and a first-run experience that actually works.**

### Empirical Result: Consciousness A/B — 0pp Impact

4 A/B runs on Windows 11 (Ryzen 7 7735HS, 64GB) with default Ollama backend. 24 task executions total (12× full, 12× without consciousness). **Result: Δ = 0pp across all runs.** Consciousness layer (Phase 13: AttentionalGate, PhenomenalField, TemporalSelf, etc.) produces no measurable improvement in task success.

**Action taken:** Default boot profile changed from `full` to `cognitive`. Phase 13 no longer loads by default. Use `--full` to opt in.

### Default Boot Profile: `full` → `cognitive`

- Default profile is now `cognitive` (phases 1-12, ~120 services). No consciousness layer.
- `--full` flag added to explicitly enable all 13 phases when needed.
- `--cognitive` flag still works (now a no-op since it's the default).
- Saves boot time and ~15MB heap. Zero impact on task success (empirically validated).

### Benchmark Timeout: 60s → 120s

- Cloud Ollama backends (`qwen3-coder:480b-cloud`, `gpt-oss:120b-cloud`) frequently timed out at 60s.
- 8 of 24 benchmark tasks failed with `ETIMEDOUT` — noise that obscured real results.
- Increased to 120s for more reliable cloud backend benchmarking.

### BUG FIX: --backend CLI Flag

- `--backend ollama:model-name` was parsed but never applied — `switchModel()` was never called after boot.
- Additionally, `ollama:` prefix was not stripped — `switchTo()` expects just the model name.
- Fixed: `cli.js` now calls `agent.switchModel()` after boot with stripped prefix.
- Without this fix, all benchmarks ran on whichever model Ollama returned first (often `minimax-m2.7:cloud`).

### Empirical Result: Organism A/B — +33pp Impact

- Ran with `--backend ollama:kimi-k2.5:cloud` (now actually applied thanks to the fix above).
- Full pipeline: 1/3 (33%). Without organism: 0/3 (0%). **Δ = +33pp.**
- Organism layer empirically validated as beneficial. Stays active in all boot profiles.

### Benchmark Verification Hardening

- `_extractCode(output)`: Extracts code from markdown fences before verification. LLMs wrap code in explanation text — verification now runs on extracted code, not raw output.
- All 8 code tasks updated with broader regex patterns and `"Output ONLY code"` prompts.
- Reduces false negatives from ~50% to ~10% (based on empirical runs).

### CognitiveBudget — Proportional Intelligence (NEW)

- `src/agent/intelligence/CognitiveBudget.js` (~250 LOC): Classifies request complexity into 4 tiers (TRIVIAL / MODERATE / COMPLEX / EXTREME)
- TRIVIAL: greetings, yes/no, simple math → skip PromptBuilder, Organism, Consciousness. Target: <200ms
- MODERATE: explanations, medium questions → lightweight prompt (8 sections), no AgentLoop
- COMPLEX: code generation, multi-step, shell → full pipeline
- EXTREME: project refactoring, deployment, clone → full pipeline + extended verification
- `shouldIncludeSection()` API for PromptBuilder to skip irrelevant sections based on tier
- Stats tracking: tier distribution, avg assessment time
- Phase 2 manifest, 0 dependencies. 30 tests

### ExecutionProvenance — Causal Traceability (NEW)

- `src/agent/intelligence/ExecutionProvenance.js` (~350 LOC): Every response gets a causal trace
- Tracks: input → budget tier → intent classification → prompt sections (active/skipped) → context assembly → model selection → response metrics → side effects
- Ring buffer (100 traces), queryable via `getTrace(id)`, `getLastTrace()`, `getRecentTraces(n)`
- `formatTrace()` produces human-readable causal chain for CLI `/trace`
- Passive EventBus observation — zero performance impact
- Phase 2 manifest, late-bound CognitiveBudget. 20 tests

### Boot Infrastructure

- `--skip-phase N[,N]` flag: Skip specific boot phases for A/B benchmarking. Phases 1-5 protected (core infrastructure). Usage: `--skip-phase 13` (consciousness), `--skip-phase 7,13` (organism + consciousness)
- Wired end-to-end: `main.js` + `cli.js` → `AgentCore` → `AgentCoreBoot` → `ContainerManifest.buildManifest()`. 2 tests

### Layer A/B Benchmark Framework (NEW)

- `scripts/benchmark-agent.js --ab-layer N`: Generic A/B comparison — runs tasks with full pipeline then without specified phase(s)
- `--skip-phase` passthrough: benchmark spawns CLI with `--skip-phase` so phase filtering applies to actual boot
- npm scripts: `benchmark:agent:layer:consciousness` (P13), `benchmark:agent:layer:organism` (P7), `benchmark:agent:layer:full` (P7+13)
- Verdict: >+10pp = helps, ±5pp = noise, <-5pp = hurts. Per-task delta with "X helped/hurt" markers
- Results: `.genesis/benchmark-ab-layer-{N}.json`

### Big Three Branch Coverage

Targeted tests for the three most critical modules — error paths, edge cases, circuit breakers:
- **SelfModificationPipeline**: Circuit breaker trips/reset, metabolism gating, genome-scaled threshold, verifier fail-closed, preservation violations. 17 tests
- **Sandbox**: Language detection (Python/Bash/PHP/Ruby), timeout with SIGKILL, trusted flag enforcement, safety scanner integration, audit log rotation, isolation status. 14 tests
- **ContainerManifest**: skipPhases filtering, phase protection (1-5 cannot be skipped). 2 tests

### Colony Proof — Consensus Verification (NEW)

- `test/modules/v604-colony-proof.test.js` (16 tests): First real proof that Colony consensus works
  - **VectorClock**: tick, compare (before/after/concurrent/equal), merge with tick
  - **Phase 2 Sync**: A→B mutation transfer, bidirectional sync, no-op when converged
  - **Phase 3 Conflict**: LWW resolution on concurrent edits, strictly-newer overwrites, multi-domain sync
  - **Phase 4 Recovery**: catch-up after missed rounds, idempotent re-sync, diagnostic status
  - **Verdict**: Full A→B→A round-trip converges to identical state ✅

### Coverage Ratchet

- **B2**: Global coverage ratchet raised: `70/60/65` → `75/70/70` (lines/branches/functions)
- Safety-critical modules remain at `80/70/75` (unchanged)

### Smart Model Ranking (NEW)

- `ModelBridge._scoreModel()`: 35 tier patterns scoring models 0-100. Claude = 100, DeepSeek Coder = 92, kimi-k2 = 88, Llama 3 8B = 78, minimax = 15. Unknown models scored by parameter count (size-based fallback).
- `_selectBestModel()`: Replaces "first alphabetical" selection. Result: 0% → 100% benchmark.
- `getRankedModels()`: Sorted model list with scores, notes, active markers. Powers `/models` command.

### First-Run Detection + `/models` + `/model` Commands (NEW)

- First boot detects weak models, shows recommendations with quality scores.
- `/models`: Visual quality bars for all available models. `/model <n>`: Switch + auto-save as preferred.

### CognitiveBudget + ExecutionProvenance — Hot Path Integration

- Both services wired into `ChatOrchestrator.handleStream()` as optional late-bindings.
- Every request: `beginTrace()` → `recordBudget()` → `recordIntent()` → `recordModel()` → `endTrace()`.

### BUG FIX: --backend CLI Flag

- `switchModel()` never called after boot — flag was parsed but ignored. Fixed + prefix stripping (`ollama:model` → `model`).

### BUG FIX: console.log in ContainerManifest

- Raw `console.log` replaced with `createLogger`. v4100-audit-fixes: 22/22 pass (was 21/22).

### AdaptivePromptStrategy — Self-Optimizing Prompts (NEW)

- `src/agent/intelligence/AdaptivePromptStrategy.js` (~300 LOC): Genesis optimizes its own prompts based on empirical data.
- Analyzes provenance traces: which sections were active, what was the result → calculates effectiveness per intent-type.
- Recommendations: `boost` (section gets one priority tier up), `skip` (section is omitted), `neutral`.
- Protected sections (identity, formatting, safety, capabilities, session) are NEVER skipped.
- Minimum 10 traces + 3 samples per condition before recommendations are made.
- Auto-analysis every 25 requests. Persisted to `adaptive-prompt-strategy.json`.
- **PromptBuilder wired**: `_buildWithBudget()` checks `getSectionAdvice()` and tracks active/skipped/boosted sections.
- **Feedback loop closed**: ChatOrchestrator → `setIntent()` → PromptBuilder builds prompt → `recordPrompt()` to provenance → AdaptivePromptStrategy analyzes → better prompts.
- 15 tests: advice, analysis, multi-intent, protected sections, persistence.

### Documentation

- `docs/BENCHMARKING.md` (NEW): Comprehensive guide — unit tests, agent benchmarks, layer A/B, colony tests, boot profiles, CI pipeline.

### Files Changed

- `src/agent/intelligence/CognitiveBudget.js` (NEW, ~250 LOC)
- `src/agent/intelligence/ExecutionProvenance.js` (NEW, ~350 LOC)
- `src/agent/intelligence/AdaptivePromptStrategy.js` (NEW, ~300 LOC)
- `src/agent/intelligence/PromptBuilder.js`: Adaptive strategy integration, setIntent(), _lastBuildMeta (+35 LOC)
- `src/agent/foundation/ModelBridge.js`: Smart ranking + 35 tiers + size fallback (+120 LOC)
- `src/agent/hexagonal/ChatOrchestrator.js`: Budget + Provenance + setIntent + recordPrompt (+25 LOC)
- `src/agent/manifest/phase2-intelligence.js`: +3 service registrations, +1 late-binding
- `src/agent/manifest/phase5-hexagonal.js`: +2 late-bindings for ChatOrchestrator
- `src/agent/ContainerManifest.js`: skipPhases + console.log fix (+17 LOC)
- `src/agent/AgentCore.js`: skipPhases + default profile → cognitive (+4 LOC)
- `src/agent/AgentCoreBoot.js`: skipPhases passthrough (+1 LOC)
- `main.js`: --skip-phase + --full flag, default → cognitive (+8 LOC)
- `cli.js`: --skip-phase, --full, --backend fix, /models, /model, first-run detection (+80 LOC)
- `scripts/benchmark-agent.js`: --ab-layer + --skip-phase + 120s timeout + _extractCode (+130 LOC)
- `package.json`: version bump, coverage ratchet 75/70/70, +4 npm scripts
- `docs/BENCHMARKING.md` (NEW)
- `test/modules/v604-cognitive-budget-provenance.test.js` (NEW, 50 tests)
- `test/modules/v604-big-three-coverage.test.js` (NEW, 35 tests)
- `test/modules/v604-colony-proof.test.js` (NEW, 16 tests)
- `test/modules/v605-smart-model-ranking.test.js` (NEW, 27 tests)
- `test/modules/v604-adaptive-prompt-strategy.test.js` (NEW, 15 tests)
- Test suites: 252 → 257 (+5). Tests: ~3380 → ~3524 (+144)

---

---

## [6.0.3] — Security Audit Hardening + Stabilization

**Focus: Systematic resolution of IPC input validation gaps, sandbox FS coverage, external process isolation, SA-P audit completion, and test coverage expansion. Based on full codebase audit (595 files, 82k LOC).**

### IPC Input Validation Hardening (Kernel)

All IPC handlers in `main.js` now validate every parameter. Previously 6 handlers accepted string/object parameters without `_validateStr` or type checks — inconsistent with the defense-in-depth pattern established in v4.10.0.

- **H-1 FIX**: `agent:import-data` — added `_validateStr` + path scope restriction (must be within home directory). Prevents compromised renderer from importing attacker-controlled archive from arbitrary path
- **H-2 FIX**: `agent:get-replay-diff` — added `_validateStr` with 200-char max for both `idA` and `idB` parameters
- **H-3 FIX**: `agent:clone` — added structural validation (`typeof === 'object'`, not array). Config is now validated before passing to `cloneSelf()`
- **M-1 FIX**: `agent:mcp-remove-server` — added string type check for `name`
- **M-1 FIX**: `agent:mcp-reconnect` — added `_validateStr` for `name`
- **M-1 FIX**: `agent:loop-reject` — `reason` now type-checked and truncated to 1000 chars; defaults to `'User rejected'` on non-string
- **L-1 FIX**: `agent:set-setting` — `value` rejected if `typeof` is `function` or `symbol` (non-serializable)

### Sandbox Security Coverage Extension

- **M-5 FIX**: `executeExternal()` (Python, Ruby, etc.) now applies `_linuxWrap()` for Linux namespace isolation (PID/net/mount/IPC). Previously only JS `execute()` used namespace isolation — external language runtimes ran with env-stripping and CWD restriction but without OS-level process isolation. Also added `killSignal: 'SIGKILL'` for reliable timeout termination
- **M-6 FIX**: Sandbox FS intercept expanded:
  - `fs.cp` / `fs.cpSync` (Node 16+) added to blocked list — recursive copy was unguarded while `copyFile`/`copyFileSync` were already blocked
  - `fs.appendFile` / `fs.appendFileSync` / `fs.promises.appendFile` — intercepted with `_checkWritePath()` write-scope enforcement
- **M-7 FIX**: Sandbox VM `safeCopy()` — prototype chain now fully independent. Previously `Object.create(Ctor.prototype)` shared the original prototype via `__proto__`, meaning mutations could propagate if `_deepFreeze` failed on freeze-resistant builtins. Now copies all own properties into a `null`-prototype object — zero linkage to host builtins

### ShellAgent Hardening

- **L-4 FIX**: `_sanitizeCommand()` now applies NFKC Unicode normalization before blocklist matching. Fullwidth confusables (e.g. `ｒｍ` → `rm`, `ｋｉｌｌ` → `kill`) are normalized to ASCII, preventing regex bypass. One-liner but closes a theoretical defense gap

### Kernel Documentation

- **L-7 FIX**: `uncaughtException` handler in `main.js` — added detailed rationale comment: no `process.exit()` is intentional because Electron manages its own lifecycle, and forcing exit would bypass `agent.shutdown()` → data loss risk. CrashLog captures the error for diagnostics
- **L-3**: `global.gc()` in HomeostasisEffectors + ImmuneSystem — reviewed, code is correct (`if (global.gc)` guard + try/catch). No change needed, documented as intentional

### Resilient Git Polling

- **M-3 FIX**: `WorldState._pollGitStatus()` — `Promise.all` → `Promise.allSettled`. Git branch parse failure no longer loses status data. Branch falls back to `'unknown'` on failure instead of throwing

### MCP Server Security Documentation

- **L-6 FIX**: `McpServer.js` now logs a security warning when starting without API key authentication. Warns about localhost-only CORS not protecting against tunnels/port-forwarding
- **L-6 FIX**: `docs/MCP-SERVER-SETUP.md` — new "Security: API Key Authentication" section with config example and built-in protection summary

### Test Suite

- `test/modules/v603-security-hardening.test.js`: 28 tests covering all v6.0.3 fixes
  - IPC validation patterns (18 tests): H-1, H-2, H-3, M-1, L-1
  - Sandbox FS intercepts (5 tests): cp, cpSync, appendFile, appendFileSync blocked + sandbox-internal appendFileSync allowed
  - Sandbox executeExternal (3 tests): env stripping, timeout, CWD restriction
  - WorldState allSettled (2 tests): partial failure handling, branch fallback

### Audit Observations Closed (No Action Needed)

- **M-2**: StorageService.flush() — re-evaluated as safe. Each write already has individual `.catch()` handler before `Promise.all`. No error propagation risk
- **M-4**: MemoryConsolidator race condition — re-evaluated as impossible. `_consolidateKG()` and `_consolidateLessons()` are synchronous. JS single-threaded event loop guarantees no interleaving between `_running = true` and `_running = false`
- **L-2**: Dashboard `Promise.all` — re-evaluated as safe. Each IPC invoke already has individual `.catch(() => null)`. `Promise.all` never rejects

### SA-P Audit Completion

- **SA-P3 ArchitectureReflection** — Audit complete, clean. Pure read-only graph observer, no side effects. BFS uses visited Set. 12 new tests
- **SA-P4 EmbodiedPerception** — Audit found listener leak: `bus.on('ui:heartbeat')` not tracked in `_unsubs`. Fixed: `_unsubs[]` init + tracked subscription + `stop()` cleanup. 15 new tests
- **SA-P8 DynamicToolSynthesis** — Audit complete, clean. Good safety pipeline (LLM → parse → safety scan → syntax check → sandbox test → register). Existing test suite adequate

### Stabilization — Test Coverage Expansion

- `test/modules/v603-stabilization.test.js` (NEW): 49 tests across 7 modules
  - **EmbodiedPerception** (15): heartbeat processing, engagement transitions (idle/away/background), prompt context, events, listener lifecycle
  - **ArchitectureReflection** (12): graph building, service queries, dependency chains, coupling detection, phase/layer maps, NL query
  - **CostGuard** (5): budget enforcement, autonomous blocking, user chat bypass (priority≥10), usage tracking, disabled mode
  - **EmotionalSteering** (5): construction, thresholds, signals, stats, disabled mode
  - **ImmuneSystem** (5): construction, report, quarantine, prompt context, lifecycle
  - **HomeostasisEffectors** (3): construction, stats tracking, lifecycle
  - **DesktopPerception** (3): construction, start/stop lifecycle

### Documentation

- **L-5 FIX**: `ARCHITECTURE.md` test count corrected: "~3150" → "~3370 tests, 252 suites"

### Files Changed

- `main.js`: 7 IPC handlers hardened, uncaughtException rationale (+29 lines)
- `src/agent/foundation/Sandbox.js`: executeExternal namespace wrap, FS intercepts, safeCopy independence (+27 lines)
- `src/agent/foundation/WorldState.js`: allSettled migration (+4 lines)
- `src/agent/capabilities/McpServer.js`: Keyless-mode security warning (+6 lines)
- `src/agent/capabilities/ShellAgent.js`: NFKC Unicode normalization (+4 lines)
- `src/agent/organism/EmbodiedPerception.js`: Listener lifecycle fix (+7 lines)
- `docs/MCP-SERVER-SETUP.md`: API key authentication section added
- `CHANGELOG.md`: v6.0.3 entry
- `AUDIT-BACKLOG.md`: SA-P3/P4/P8 audits closed, all findings resolved
- `ARCHITECTURE.md`: Version bump + test count correction
- `test/modules/v603-security-hardening.test.js`: 34 tests (NEW)
- `test/modules/v603-stabilization.test.js`: 49 tests (NEW)
- Test suites: 250 → 252 (+2). Tests: ~3295 → ~3380 (+83)
- Version: `package.json` bumped to 6.0.3

---

---

## [6.0.2] — Meta-Cognitive Feedback Loop (V6-12)

**Focus: Close the gap between self-diagnosis and self-correction. CognitiveSelfModel detects weaknesses → AdaptiveStrategy proposes compensating adaptations → QuickBenchmark validates → confirmed or rolled back. Genesis now prescribes, not just diagnoses.**

### AdaptiveStrategy — Meta-Cognitive Loop Engine (NEW)
- `src/agent/cognitive/AdaptiveStrategy.js` (~400 LOC): Three adaptation strategies driven by CognitiveSelfModel data
- **Prompt Mutation**: Bias pattern → hypothesis → PromptEvolution experiment. Mapping: `scope-underestimate` → solutions, `token-overuse` → formatting, `error-repetition` → metacognition, `backend-mismatch` → optimizer
- **Backend Routing Injection**: Empirical BackendStrengthMap → ModelRouter scoring bonus (+0.3 max). Data-driven model selection replaces pure heuristics
- **Temperature Signal**: Capability profile weakness → OnlineLearner temp multiplier (0.85× for weak, 1.10× for strong task types)
- Every adaptation follows: `PROPOSED → APPLIED → VALIDATING → CONFIRMED | ROLLED_BACK`
- Safety: Max 1 concurrent adaptation, 30-min cooldown per type, min 10 outcomes before adapting, recently-rolled-back skip
- Persistence: `~/.genesis/adaptive-strategy.json` — history, cooldowns, stats
- Events: `adaptation:proposed`, `:applied`, `:validated`, `:rolled-back`, `:validation-deferred`, `:cycle-complete`
- CLI: `/adapt` (manual cycle), `/adaptations` (history with status icons ✓✗⏳)

### QuickBenchmark — Adaptation Validation Engine (NEW)
- `src/agent/cognitive/QuickBenchmark.js` (~200 LOC): Wraps existing `benchmark-agent.js` in `--quick` mode (3 tasks)
- Baseline caching (4h TTL, disk-persisted). Compare logic: confirm (≥-2pp), rollback (<-5pp), inconclusive (between)
- CostGuard integration: Defers validation when budget < 20%. Marks adaptation as `APPLIED_UNVALIDATED`
- No child process — direct function import from `scripts/benchmark-agent.js`

### Wiring Patches (6 existing modules extended)
- **ModelRouter.js**: `injectEmpiricalStrength(strengthMap)` method + Step 4 scoring bonus in `_scoreModel()`. Empirical data expires after 7 days
- **OnlineLearner.js**: `receiveWeaknessSignal(taskType, isWeak)` method + weakness multiplier applied in `_adjustTemperature()`. Signals expire after 4 hours
- **IdleMindActivities.js**: `_calibrate()` activity — triggers `AdaptiveStrategy.runCycle()` during idle time
- **IdleMind.js**: `calibrate` registered as candidate (weight 1.5), dispatched in switch, genome consolidation trait applied
- **PromptBuilder** (existing integration): CognitiveSelfModel already flows via `buildPromptContext()` (v5.9.8). Now AdaptiveStrategy closes the loop by acting on the data

### LessonsStore Integration
- Every confirmed or rolled-back adaptation stores a lesson via `lesson:learned` event
- Category: `meta-adaptation`. Tags: `[adaptation, type, confirmed|rolled-back]`
- Lessons feed back into future SelfModel evaluations — true closed-loop learning

### Infrastructure
- `EventTypes.js`: +7 events (6× ADAPTATION, 1× ROUTER.EMPIRICAL_STRENGTH_INJECTED). Total: 355
- `EventPayloadSchemas.js`: +7 schemas. Total: 97
- `Constants.js`: +5 PHASE9 constants (ADAPTATION_COOLDOWN_MS, ADAPTATION_MIN_OUTCOMES, ADAPTATION_REGRESSION_THRESHOLD, ADAPTATION_NOISE_MARGIN, QUICK_BENCHMARK_BUDGET_FLOOR)
- `preload.js` + `preload.mjs`: +2 IPC channels whitelisted
- `main.js`: +2 IPC handlers (`agent:get-adaptation-report`, `agent:run-adaptation-cycle`)
- `cli.js`: +2 commands (`/adapt`, `/adaptations`), help text updated
- `phase9-cognitive.js`: +2 service registrations (quickBenchmark, adaptiveStrategy)
- 3 new test suites: AdaptiveStrategy (21 tests), QuickBenchmark (18 tests), MetaCognitiveLoop (12 tests)
- Source files: 235 → 237 (+2 new JS modules)
- Test suites: 247 → 250 (+3)
- Version: `package.json` bumped to 6.0.2

---

---

## [6.0.1] — Safety Infrastructure + Documentation Audit

**Focus: Five non-roadmap gaps closed — LLM cost cap, data backup, crash logging, update checker, skill security docs. Full documentation audit: 7 files fixed, all German LLM prompts translated to English, all stale metrics corrected.**

### CostGuard — LLM Budget Cap (NEW)
- `src/agent/ports/CostGuard.js` (~230 LOC): Session (500k) and daily (2M) token limits for autonomous LLM calls
- Blocks autonomous calls at 100%, warns at 80%. User chat never blocked (priority >= 10 bypasses)
- Daily auto-reset at midnight. Configurable via `settings.json → llm.costGuard`
- Wired into `LLMPort._checkRateLimit()` as step 3. Late-bound via Container
- Events: `llm:cost-cap-reached`, `llm:cost-warning`. CLI: `/budget`

### BackupManager — Export/Import (NEW)
- `src/agent/capabilities/BackupManager.js` (~240 LOC): Export/import all `~/.genesis/` data as `.tar.gz`
- Exports 10 data files + 2 directories (replays, lesson archives) with manifest
- Import merges — preserves existing settings by default
- Events: `backup:exported`, `backup:imported`. CLI: `/export`, `/import <path>`

### CrashLog — Rotating Error Log (NEW)
- `src/agent/core/CrashLog.js` (~230 LOC): Ring buffer of last 1000 warn/error entries → `~/.genesis/crash.log`
- Flush every 5s or immediately on errors. Rotation at 500KB (keeps 1 old file)
- Wired via `Logger.setSink()` in `AgentCoreBoot._bootstrapInstances()` — captures from first boot message
- CLI: `/crashlog`

### AutoUpdater — GitHub Release Checker (NEW)
- `src/agent/capabilities/AutoUpdater.js` (~240 LOC): Checks GitHub Releases API for newer versions
- Boot check (10s delay), periodic check (24h). Notifies only — no auto-install
- Event: `update:available`. CLI: `/update`

### SKILL-SECURITY.md — Security Boundary Docs (NEW)
- `docs/SKILL-SECURITY.md`: Complete documentation of skill sandbox boundaries
- Covers: allowed/blocked modules, AST scanner rules, execution environment, trust model, timeout behavior
- Linked from README doc table and SECURITY.md

### Documentation Audit
- **SECURITY.md**: Version table `4.12.x` → `6.0.x`. Added SKILL-SECURITY.md link
- **README.md**: 11 corrections — badges (services 123→125, events 318→343), infrastructure (events 308→343, layers 12→10), metrics table (DI 116→125, cognitive 14→17, safety 12→10, TSC 218→210), SECURITY.md link (7→10-layer), SKILL-SECURITY.md link added
- **ARCHITECTURE.md**: Version 5.9.9→6.0.1, test counts updated (3106→~3100, 176→178 suites), benchmark 8→12 tasks, A/B text version fix
- **CONTRIBUTING.md**: cognitive/ listing 5→17 modules, test suites 135→178
- **SELF-ANALYSIS-AUDIT.md**: All 9 German Genesis quotes translated to English (originals in italics), 4 German section headers translated
- **ContextManager.js**: 4 German LLM prompt strings → English (`BEWÄHRTES VORGEHEN`, `ARCHITEKTUR-ÜBERSICHT`, `Antworte in natürlicher Sprache`, `GESPRÄCHSVERLAUF`)
- **AutonomousDaemon.js**: 1 German suggestion string → English

### Code Quality (Deep Analysis Fixes)
- **V6-9 Complete**: `scripts/benchmark-readme.js` (~130 LOC) — reads `.genesis/benchmark-latest.json`, generates per-task markdown table with category breakdown, injects into README.md between `<!-- BENCHMARK-START/END -->` markers. npm scripts: `benchmark:readme`, `benchmark:readme:dry`. V6-9 is now 100% done.
- **BackupManager.js**: `execSync` with string interpolation → `execFileSync` with array args. Shell injection vector eliminated
- **Constants.js**: +9 timeout constants (EMBEDDING_LOCAL/REMOTE, GITHUB_API, NATIVE_TOOL_HTTP, DEPLOY_STEP_DELAY, PERSIST_DEBOUNCE, VECTOR_SAVE_DEBOUNCE, UPDATE_BOOT_DELAY, BACKUP_TAR) + 2 interval constants (DAEMON_BOOT_DELAY, LEARNING_SAVE)
- **10 files patched**: EmbeddingService, GitHubEffector, NativeToolUse, AutonomousDaemon, DeploymentManager, SessionPersistence, VectorMemory, LearningService, AutoUpdater, BackupManager — all hardcoded timeouts replaced with Constants references. 0 magic numbers remaining
- **AdaptiveMemory.js**: `@deprecated v6.0.1` — 3 external refs, scheduled for removal. Use UnifiedMemory instead
- **MemoryFacade.js**: `@deprecated v6.0.1` — 4 external refs, scheduled for removal. Use UnifiedMemory directly
- **ConsciousnessExtension.js**: `@note` added — 0 external functional refs, kept by design (see Roadmap Explicitly Deferred)
- **AgentCoreHealth.js**: CrashLog.stop() added as final shutdown step — captures all shutdown errors before exit
- **ToolBootstrap.js**: MemoryFacade dependency removed — knowledge-search/connect tools now use KnowledgeGraph directly (MemoryFacade was a pure pass-through)
- **3 new test suites**: model-router (10 tests), correlation-context (14 tests), dynamic-context-budget (14 tests)
- **9 more test suites**: language (9), local-classifier (9), meta-learning (9), value-store (10), error-aggregator (10), prompt-evolution (10), event-store (11), body-schema (6), immune-system (6). Untested critical modules: 91 → 79

### Infrastructure
- `EventTypes.js`: +5 events (COST_CAP_REACHED, COST_WARNING, BACKUP.EXPORTED, BACKUP.IMPORTED, UPDATE.AVAILABLE). Total: 348
- `EventPayloadSchemas.js`: +5 schemas. Total: 90
- `preload.js`: +5 IPC channels whitelisted
- `main.js`: +6 IPC handlers (cost-budget, export, import, crash-log, check-update)
- `cli.js`: +5 commands (/budget, /export, /import, /crashlog, /update), help text updated
- `phase1-foundation.js`: CostGuard registered (phase 1, safety tag)
- `phase6-autonomy.js`: BackupManager + AutoUpdater registered
- `AgentCoreBoot.js`: CrashLog wired into Logger.setSink()
- `LLMPort.js`: CostGuard late-binding + _checkRateLimit() step 3 + post-call token recording
- Source files: 231 → 235 (+4 new JS modules)
- Version: `package.json` bumped to 6.0.1

---

---

## [6.0.0] — Memory Consolidation + Task Replay + Benchmark Matrix

**Focus: Complete three V6 roadmap items (V6-5, V6-7, V6-8), expand benchmark suite to 12 tasks with multi-backend A/B matrix validation, add CLI skill management commands, wire workspace eviction pipeline.**

### V6-5-FINAL: Workspace Eviction Pipeline (Complete)

- **Root cause**: `onEvict` callback added to CognitiveWorkspace in v5.9.8 but never wired in workspaceFactory. Evicted slots were lost silently.
- **Fix**: workspaceFactory in phase9-cognitive.js now passes `onEvict` callback that emits `workspace:slot-evicted` with key, value (truncated 500 chars), salience, accessCount, goalId.
- **Event**: `workspace:slot-evicted` registered in EventTypes.js + EventPayloadSchemas.js.
- **Downstream**: MemoryConsolidator subscribes to eviction events for archival tracking.
- **Impact**: V6-5 Context Window Manager is now fully complete — no remaining work items.

### V6-7: MemoryConsolidator (New Service)

- **MemoryConsolidator.js** (~340 LOC): Phase 9 cognitive service. Periodic pruning and merging of KnowledgeGraph and LessonsStore to prevent unbounded growth.
- **KG Redundancy Detection**: Groups same-type nodes by word-level Jaccard similarity (≥0.75 threshold). Merges properties, redirects edges, removes self-loops. Configurable max merges per run.
- **KG Stale Pruning**: Delegates to `KnowledgeGraph.pruneStale()` with configurable age threshold (default: 14 days).
- **Lesson Archival**: Lessons older than 30 days with <2 uses → serialized to `~/.genesis-lessons/archive/archived-{ts}.json` and removed from active store. Configurable thresholds.
- **Relevance Decay Scoring**: Identifies lessons approaching archival threshold for Dashboard display.
- **Cooldown**: 5-minute minimum between consolidation runs. Concurrent run protection.
- **Compaction Report API**: `getReport()` returns cumulative stats, current KG/lesson counts, configuration, cooldown state.
- **IdleMind Integration**: `_consolidateMemory()` now emits `idle:consolidate-memory` bus event → MemoryConsolidator handles execution. `consolidate` activity always available (not gated on UnifiedMemory).
- **CLI**: `/consolidate` command triggers manual consolidation with inline report.
- **Manifest**: phase9-cognitive.js, late-bindings for knowledgeGraph + lessonsStore + storage.
- **TO_STOP**: Added. **Events**: `memory:consolidation-complete`, `memory:consolidation-failed` (2 events, 2 schemas).
- **IPC**: `agent:get-consolidation-report`, `agent:trigger-consolidation`. Preload whitelisted.

### V6-8: TaskRecorder (New Service)

- **TaskRecorder.js** (~380 LOC): Phase 9 cognitive service. Records complete execution traces for debugging and regression testing. No competing framework has this capability.
- **Automatic Recording**: Subscribes to `agent-loop:started` / `agent-loop:complete` for recording boundaries. Each goal/task gets a separate recording file.
- **Execution Trace**: Captures steps (`goal:step-complete`), intent classification, LLM calls (`chat:completed` with model/prompt/response/tokens/duration), tool invocations (`shell:complete`, `mcp:tool-call`), reasoning decisions.
- **Data Sanitization**: Strings truncated to 500 chars, arrays capped at 10 elements, objects replaced with `[object]`. Prevents multi-MB recording files.
- **Persistence**: Recordings saved as `rec_{ts}_{id}.json` in `~/.genesis/replays/`. Ring buffer of last 50 recordings in memory. Index loaded from disk on boot.
- **Diff API**: `diff(idA, idB)` compares two recordings step-by-step. Finds divergence point, compares step types, reports outcome deltas (success, duration, LLM calls).
- **Query API**: `list(limit)`, `load(id)`, `getReport()`, `getStats()`.
- **CLI**: `/replays` command lists recent recordings with status icons.
- **Manifest**: phase9-cognitive.js. **TO_STOP**: Added (finalizes active recordings on shutdown).
- **Events**: `replay:recording-complete` (1 event, 1 schema).
- **IPC**: `agent:get-replay-report`, `agent:get-replay-diff`. Preload whitelisted.

### V6-6-CLI: Skill CLI Commands

- `/skills` / `/skill list`: Shows built-in and community skills with version and source.
- `/skill install <source>`: Install from GitHub URL, Gist, npm package (`npm:<n>`), or archive URL. Validates manifest, triggers SkillManager reload. Error handling with user feedback.
- `/skill uninstall <name>`: Remove community skill by name.
- `/skill update <name>`: Re-fetch from original source URL.
- **Impact**: V6-6 Skill Registry remaining work reduced to public registry index hosting only.

### V6-9-EXT: Benchmark Suite Expansion + A/B Matrix

- **4 new benchmark tasks** (8 → 12): `cg-4` async rate limiter, `bf-3` async error handling bug, `rf-2` strategy pattern extraction, `an-2` API design review. Coverage: code-gen (4), bug-fix (3), refactoring (2), analysis (2), chat (1).
- **`--ab-matrix` mode**: Runs A/B organism comparison across ALL configured backends. Auto-discovers backends from `settings.json`. Per-backend success rate delta + aggregate average. Results saved to `.genesis/benchmark-ab-matrix.json`.
- **npm script**: `benchmark:agent:ab:matrix`.
- **Impact**: V6-9 remaining work reduced to README auto-generation only.

### Infrastructure

- **EventTypes.js**: +3 sections (MEMORY_CONSOLIDATION, WORKSPACE_EVICTION, TASK_RECORDER), +4 events.
- **EventPayloadSchemas.js**: +5 schemas.
- **TO_STOP**: +2 services (memoryConsolidator, taskRecorder). Stoppable services: 52 → 54.
- **IPC**: +4 handlers (get-consolidation-report, trigger-consolidation, get-replay-report, get-replay-diff). Preload whitelisted.
- **CLI commands**: +7 new commands (/skills, /skill install|uninstall|update, /consolidate, /replays).

### Version Housekeeping

- package.json, package-lock.json, README badge, docs/banner.svg, McpTransport clientInfo → 6.0.0

