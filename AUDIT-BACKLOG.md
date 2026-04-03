# Audit Backlog

Tracking sheet for open findings and monitor items.
Resolved items are documented in CHANGELOG.md for traceability.

## Monitor Items

| ID   | Severity | Status   | Note |
|------|----------|----------|------|
| SA-O1| Info     | Reduced  | CC>30: 12 → 7. _analyzeStack refactored to table-driven. Remaining: declarative tables, core loops, consciousness rules. No further action. |
| SA-O2| Info     | Stable   | God classes (>20 methods): 24 files. Top: LLMPort (42, multi-class), EventBus (41, infrastructure). Extraction not beneficial. |
| TS-1 | Info     | ✅ Done  | 0 @ts-nocheck files (was 25). All 25 cleaned via JSDoc + @ts-ignore + type casts. |
| L-4x | Low      | Hardened | ShellAgent: _sanitizeCommand() + blocklist + execFile. Shell-spawn for pipes is intentional. |
| I-2  | Info     | Stable   | Orphan events — expected for IPC/EventStore/Peer audit trail. |
| M-4x | Info     | ✅ Done  | 0 phantom listeners (was 5). All resolved: IPC/Peer events added to exclusion set, shell:complete traced to EventStore routing. |
| CP-1 | Info     | Stable   | Cross-phase coupling: AgentLoop (phase 8) → CognitiveWorkspace (phase 9). Intentional. |

### Observations (no action needed)

| Area | Note |
|------|------|
| ConsciousnessExtension | 10 uncatalogued events — Node.js EventEmitter, not Genesis EventBus. |
| Catch blocks | 44 comment-annotated + 270 with _log calls. Zero truly empty. |
| Event schemas | 0 unschema'd events (was 7). All registered events now have payload schemas. |
| Listener leaks | 0 (was 11). All services use _sub()/_unsubs auto-cleanup pattern. GoalPersistence + SessionPersistence migrated in v5.9.9. |
| Async without await | ~70 methods (45 interface stubs, 25 procedural). Observation only. |
| Hardcoded timeouts | 42 sites. Constants defined (GIT_OP, QUICK_CHECK, COMMAND_EXEC, TEST_INSTALL). |
| 'use strict' | 35/206 files (17%). No `for...in`, no `with`, no `arguments.callee`, TSC active. Strict violations impossible by construction. Intentional. |
| hasOwnProperty | 0 checks needed. Zero `for...in` loops — codebase uses Object.keys/entries/values + for...of exclusively (all prototype-safe). |
| Prototype pollution | `__proto__` filtered in WorldState.js. No `for...in` eliminates the primary attack vector. |
| console.log | 1 in SkillManager.js:85 — runs in Sandbox child process where _log unavailable. Design-correct (v5.9.1 FIX-5). |

## v5.9.9 — Resolved (Stabilization + CI Green)

| ID     | Severity | Description |
|--------|----------|-------------|
| TSC-1  | HIGH   | `ignoreDeprecations: "6.0"` missing from tsconfig.json + tsconfig.ci.json. TypeScript 6.0.2 exit 2. CI blocker. Fixed both files. |
| TSC-2  | HIGH   | 36 TS errors unmasked after TSC-1 fix. Root cause: types/node.d.ts missing `events`, `http` (IncomingMessage/ServerResponse), `crypto` (timingSafeEqual), `electron` (Notification), `cheerio`, `puppeteer`. All resolved via type declarations. New service errors (CognitiveSelfModel, SkillRegistry) fixed with JSDoc. Zero @ts-nocheck. |
| EVT-1  | HIGH   | `skill:installed` + `skill:uninstalled` emitted but not in EventTypes.js / EventPayloadSchemas.js. audit:events:strict exit 1. Added SKILL_REGISTRY section + 2 schemas. Catalog: 338 events, 80 schemas. |
| PHANTOM-1 | LOW | `shell:complete` phantom listener — design-correct (EventStore → EVENT_STORE_BUS_MAP routing). Added to fitness check exclusion. Phantoms: 1 → 0. |
| CATCH-1 | LOW  | SkillRegistry silent catch-swallows on SkillManager.loadSkills() after install/uninstall → added `_log.warn()`. |
| LEAK-1 | MEDIUM | GoalPersistence: 5 raw `bus.on()` without cleanup, no `stop()`, not in TO_STOP. Fixed: `_unsubs[]` + tracked subs + `stop()` with sync persist + TO_STOP. |
| LEAK-2 | MEDIUM | SessionPersistence: 6 raw `bus.on()` in `_wireEvents()` without cleanup, no `stop()`. Fixed: `_unsubs[]` + tracked subs + `stop()` + TO_STOP. Stoppable: 47 → 49. |
| ANNOT-1 | LOW | HealthServer: 5 silent `catch (_e) { /* */ }` → annotated `/* optional service */`. |
| LEAK-3 | MEDIUM | DeploymentManager: `deploy:request` listener untracked, `stop()` was no-op. Fixed: `_unsubs[]` + cleanup + TO_STOP. |
| LEAK-4 | MEDIUM | ColonyOrchestrator: `colony:run-request` listener untracked. Fixed: `_unsubs[]` + cleanup + TO_STOP. |
| FIT-2 | MEDIUM | Fitness scanner blind spot: only detected `static containerConfig` services. Now also traces manifest `R('Module')` factory patterns. Stoppable: 49 → 52. Found LEAK-3/LEAK-4. |

## v5.9.8 — Resolved (V6-5 Fully Wired + V6-11 CognitiveSelfModel)

| ID     | Severity | Description |
|--------|----------|-------------|
| CW-1   | HIGH   | ConversationCompressor late-binding fix: `_compressor → conversationCompressor` added to `context` manifest entry in phase2-intelligence.js. ConversationCompressor (265 LOC, v5.9.7) was built and tested but never wired — `buildAsync()` always fell back to sync `build()`. Now live. |
| WS-1   | MEDIUM | CognitiveWorkspace eviction data pipeline: `onEvict(key, slot)` callback (capacity + decay evictions), rich eviction return `{ key, value, salience }`, decay evictions counted in `totalEvictions`. 7 new tests (22 → 29). |
| SM-1   | HIGH   | CognitiveSelfModel.js (530 LOC): V6-11 core service. Wilson-calibrated capability profiles, 4 bias detectors, backend strength map, confidence reports, prompt context injection. Phase 9 manifest. TO_STOP. IPC `agent:get-selfmodel-report`. Preload whitelisted. 29 tests. |
| UI-4   | MEDIUM | SelfModel Dashboard Panel: `_renderSelfModel(report)` renderer (~70 LOC), capability radar bars with Wilson floor, backend recommendation pills, bias alert cards. IPC fetch, 23 CSS rules. |
| BM-1   | MEDIUM | `scripts/benchmark-agent.js` (~230 LOC): V6-9 agent benchmarking suite. 8 tasks across 5 categories. Baseline save/compare, regression detection, JSON output. 13 tests. |
| SR-1   | HIGH   | SkillRegistry.js (~320 LOC): V6-6 community skills. Install from GitHub/npm/URL, uninstall, update, search. Manifest validation, meta persistence, SkillManager reload. Phase 3 manifest. TO_STOP. 2 events. 13 tests. |
| SB-1   | HIGH   | Sandbox.execute() timeout kill fix: `killSignal: 'SIGKILL'` for reliable process termination through unshare wrappers. Fixes legacy test suite hang (154 tests were unreachable). Full suite now 3105/0. |

## v5.9.7 — Resolved (SelfModel Data Layer + Context Overflow Protection)

| ID     | Severity | Description |
|--------|----------|-------------|
| TOT-1  | HIGH   | TaskOutcomeTracker.js (280 LOC): V6-11 SelfModel data collection layer. Records structured task outcomes (type, backend, success, cost, duration) from 4 event sources. Aggregate stats, persistence, pruning. Phase 9 manifest. 2 events. 21 tests. |
| CC-1   | HIGH   | ConversationCompressor.js (265 LOC): V6-5 LLM-based history compression. Summarizes older conversation segments when budget exceeded. Extractive fallback, caching. ContextManager integration (now async). Phase 10 manifest. 2 events. 21 tests. |
| COV-2  | LOW    | Coverage ratchet: 65/55/60 → 70/60/65. |
| SA-1   | MEDIUM | Self-Awareness Prompt Injection: `_taskPerformanceContext()` in PromptBuilderSections. Empirical task performance injected into LLM system prompt. P3 priority, 250 char budget. Late-binding for TaskOutcomeTracker. |
| UI-2   | MEDIUM | Task Performance Dashboard Panel: `_renderTaskOutcomes()` renderer (60 LOC), success-rate heat bars, backend comparison, IPC handler, preload whitelist, 15 CSS rules. |

## v5.9.6 — Resolved (Organism Context Containment)

- UX-1: Homeostasis.buildPromptContext() no longer exposes raw vitals to LLM — behavioral instructions only
- UX-2: _organismContext() containment guard + _formatting() explicit prohibition of internal metric leakage
- Version bumped across all tracked files

## v5.9.3 — Resolved (CI Fix + Quality Infrastructure)

| ID       | Severity | Description |
|----------|----------|-------------|
| CI-FIX-1 | HIGH   | `audit:events:strict` exit 1 — 36 non-EventBus events flagged. Fixed: EXCLUDED_EVENTS set + EVENT_STORE_BUS_MAP loading in `audit-events.js` and `validate-events.js`. `mcp:tool-call` added to EventTypes EVENTS tree. |
| CI-FIX-2 | HIGH   | TypeScript 6.0 deprecation errors (exit 2) — `moduleResolution: "node"` and `baseUrl`. Fixed: `"ignoreDeprecations": "6.0"` in both tsconfig files. |
| FIT-1    | MEDIUM | Fitness regression 90→87 — 7 phantom listeners (false positives). Fixed: `.request()` scanning + IPC/external event exclusion in `architectural-fitness.js`. Score: 90/90. |
| REC-1    | MEDIUM | ServiceRecovery.js (338 LOC): Auto-healing for degraded services. Reinit/restart/reset strategies, circuit breaker (3 attempts/5min), 3 health events, phase 6 manifest, TO_STOP. 13 tests. |
| SKILL-1  | LOW    | Built-in skill pack: `git-status`, `file-search`, `code-stats`. 3 skills, 3 manifests. 17 tests. |
| INT-1    | MEDIUM | Lifecycle integration test harness (10 tests): Boot→Wire→Interact→Shutdown verification. |
| REL-1    | LOW    | `scripts/release.js`: Version bump across 7 locations, CI gate, dry-run mode. 4 tests. |

## v5.9.2 — Resolved (Security Hardening + V6 Foundations)

| ID     | Severity | Description |
|--------|----------|-------------|
| SEC-1  | HIGH   | MCP Server: API key auth (Bearer + x-api-key), sliding-window rate limiter (120 req/min), CORS localhost-only default, body size cap (1MB), Mcp-Session-Id in CORS headers. |
| CI-1   | MEDIUM | CI: removed 3× `continue-on-error: true` (validate-channels, fitness-trend, audit:events:strict). |
| COV-1  | LOW    | Coverage thresholds ratcheted: 60/50/55 → 65/55/60. |
| UI-1   | LOW    | 2 silent `catch {}` blocks in UI replaced with `console.debug()` logging. |
| V6-4   | MEDIUM | UI Phase 2 complete: Architecture Graph, Reasoning Decision Trees, Insights Timeline, Coupling Hotspot Heatmap. 4 new panels + CSS. |
| V6-1-1 | MEDIUM | Colony Mode foundation: ColonyOrchestrator.js (decompose, distribute, merge, consensus, local fallback). Phase 8 manifest. 5 events. 11 tests. |
| V6-3-1 | MEDIUM | Deployment foundation: DeploymentManager.js (Direct/Canary/Rolling/Blue-Green strategy, rollback, health checks). Phase 6 manifest. 5 events. 15 tests. |
| TEST-1 | MEDIUM | MCP security test suite: 26 tests (auth, rate-limit, CORS, body size, session, lifecycle). |
| DEP-1  | MEDIUM | Electron ^35 → ^39 (Chromium 142, Node 22.20). No breaking changes. |
| COM-1  | LOW    | Community Standards: CODE_OF_CONDUCT.md, Issue Templates (bug + feature), PR Template. |

## v5.9.1 — Resolved (real-world CLI testing, Windows 11, Ryzen 7 7735HS, 64GB, qwen2.5:7b)

| ID    | Severity | Description |
|-------|----------|-------------|
| FIX-1 | HIGH   | `run-skill` intent (8 patterns) + handler + SkillManager late-binding (`skills` not `skillManager`). Shell fallback when skill not found. |
| FIX-2 | HIGH   | `shellRun()` missing `async/await` — `shell.run()` returns Promise, caused trim() crash on `$ ...` commands. |
| FIX-3 | HIGH   | CLI log noise: Logger `warn` after boot (default), `--verbose` for full logs. AttentionalGate 1x/60s, ConsciousnessExt 1x/30s, HomeostasisEffectors 1x/2min. |
| FIX-4 | MEDIUM | Retry intent: "yes"/"ja" after skill failure retries with error context for LLM. Max 3 retries. |
| FIX-5 | MEDIUM | `SkillManager.executeSkill()`: `_log.info()` → `console.log()` in sandbox child process. |
| FIX-6 | MEDIUM | Sandbox whitelist: +`os` module (read-only, safe). |
| FIX-7 | MEDIUM | `system-info` skill: removed `child_process` dependency, pure `os` module. |
| FIX-8 | LOW    | Sandbox error diagnostics: returns stderr instead of generic "Command failed". |
| FIX-9 | LOW    | `run skill` (bare) → lists installed skills. `run <name>` matches without `-skill` suffix. |

## v5.9.0 — Resolved

| ID   | Severity | Description |
|------|----------|-------------|
| MCP-5 | Medium | Auto-start: `mcp.serve.enabled/port` settings, `_autoStartServer()` in McpClient.boot(). |
| MCP-6 | Medium | Streamable HTTP: POST with Accept text/event-stream → SSE response. Session tracking via Mcp-Session-Id. |
| MCP-7 | Medium | Resource providers: 4 resources (KG stats, KG nodes, lessons all, lessons stats). list_changed notifications. |
| MCP-8 | Medium | 18 new tests (56 total MCP). |
| CLI-1 | Medium | Headless CLI: `cli.js` (230 LOC). REPL chat, `--serve` daemon, boot profiles, `/health`/`/goals`/`/status` commands. |
| EVT-1 | Low    | 7 high-traffic event schemas added. validate-events.js import fix (SCHEMAS vs EVENT_SCHEMAS). |
| UI-3  | Low    | MCP Server toggle in Dashboard System panel. `agent:mcp-stop-server` IPC handler. |
| DOC-1 | Low    | `docs/MCP-SERVER-SETUP.md` — IDE integration guide (VSCode, Cursor, Claude Desktop). |
| CLI-2 | Medium | Headless hardening: Settings env var overrides, EffectorRegistry Electron fallback, headless-boot.test.js (18 tests). |

## v5.8.0 — Resolved

| ID   | Severity | Description |
|------|----------|-------------|
| MCP-1 | Medium | McpServer.js rewrite: full MCP 2025-03-26 protocol (JSON-RPC error codes, CORS, health, ping, listChanged, resources stub). 310 LOC. |
| MCP-2 | Medium | McpServerToolBridge.js: 7 Genesis tools exposed as MCP server tools (verify-code, verify-syntax, code-safety-scan, project-profile, project-suggestions, architecture-query, architecture-snapshot). 250 LOC. |
| MCP-3 | Medium | Integration wiring: Phase 3 manifest, McpClient.mcpServer getter, mcp:bridge-started event, bus.fire() migration. |
| MCP-4 | Medium | 38 tests: 21 McpServer protocol compliance + 17 McpServerToolBridge tool execution. |
| TS-2  | Medium | @ts-nocheck elimination: 25 → 0. All files cleaned via JSDoc, @ts-ignore, type casts. |
| UI-1  | Medium | Dashboard Overhaul: 5 new panels (Consciousness, Energy, Architecture, Project Intelligence, Tool Synthesis). 13 sections total. |
| UI-2  | Low    | 3 new IPC channels (get-architecture, get-project-intel, get-tool-synthesis). Preload whitelisted. mcpToolBridge in TO_STOP. |
| CH-1  | Low    | Channel sync: agent:stream-done added to CHANNELS. validate-channels.js regex fix. 45/45 in sync. |
| TSC-B | Medium | TSC baseline errors: 10 → 0. vm.Script timeout via `/** @type {*} */` cast, setInterval/setTimeout type casts, PeerTransport NonNullable guard, worker msg type. |
| CC-1  | Low    | CC>30 reduction: 12 → 7. ProjectIntelligence._analyzeStack refactored to table-driven (CC=35→~12). |

## v5.7.0 — Resolved

| ID   | Severity | Description |
|------|----------|-------------|
| SA-O1-R | Medium | CC>30 reduction: 18 → 12. 6 functions refactored (ConsciousnessExtensionAdapter, BodySchema, PeerNetwork, ReasoningTracer, AutonomousDaemon, PhenomenalFieldComputation). |
| TS-1-R  | Medium | @ts-nocheck batch: 101 → 25. 76 files checked across 6 batches. types/node.d.ts extended. |
| ES-1    | Low    | Event payload schemas: 9 missing → 0. All registered events now have schemas. |
| CB-1    | Info   | Catch blocks: verified clean. Zero truly empty catches. |
| SA-P3   | Medium | Architecture Reflection: ArchitectureReflection.js — live queryable architecture graph. 18 tests. |
| SA-P8   | Medium | Dynamic Tool Synthesis: DynamicToolSynthesis.js — LLM-generated tools with safety+sandbox pipeline. 19 tests. |
| LL-1    | Medium | Listener leaks: 11 → 0. _sub()/_unsubs pattern applied to all 54 bus.on() registrations across 11 services. |
| INT-1   | Medium | Integration wiring: ArchReflection→PromptBuilder, ToolSynthesis→ToolRegistry, IdleMind→ProactiveInsights, ProjectIntelligence→PromptBuilder. |
| PI-1    | Medium | ProjectIntelligence: stack detection, conventions analysis, quality indicators, coupling hotspots. 19 tests. |

## v5.6.0 — Resolved

| ID   | Severity | Description |
|------|----------|-------------|
| H2-1 | Medium   | @ts-nocheck Batch 1: 116 → 92. types/node.d.ts created. |
| H2-2 | Medium   | PromptBuilder God-Class: 31 → 6 methods. |
| H2-3 | Medium   | IdleMind God-Class: 26 → 16 methods. |
| H3-1–H3-4 | Medium | God-Class Batch 2: DreamCycle, KnowledgeGraph, GoalStack, PeerNetwork extracted. |
| H3-5 | Low      | PhenomenalField: 14 proxy methods removed. |
| H3-7 | Medium   | IntrospectionEngine CC=45→~8: declarative INSIGHT_RULES. |
| H3-8 | Low      | ShellAgent _sanitizeCommand(). |
| H3-9 | Medium   | @ts-nocheck Batch 2: 100 → 94. |
| H4-1–H4-5 | Medium | God-Class Batch 3: TemporalSelf, SchemaStore, ChatOrchestrator, Homeostasis, CognitiveMonitor extracted. |
| SA-P4| Medium   | Embodied Perception: EmbodiedPerception.js → BodySchema integration. |
| DA-1 | Medium   | Unbounded Maps: 23 → 0. Size caps + eviction. |
| DA-2 | Medium   | Event Catalog: 20 → 10 uncatalogued. 10 events registered. |
| DA-3 | Low      | _round() deduplication: 7 → 1 in core/utils.js. |

### Instability Metrics

| Layer          | I_eff | Status |
|----------------|-------|--------|
| core           | 0.00  | ✓ Stable anchor |
| manifest       | 0.24  | ✓ Port-layer deps only |
| ports          | 0.00  | ✓ Interfaces only |
| foundation     | 0.00  | ✓ |
| intelligence   | 0.00  | ✓ |
| revolution     | 0.00  | ✓ |
| capabilities   | 0.00  | ✓ |
| hexagonal      | 0.00  | ✓ |
| organism       | 0.00  | ✓ |
| consciousness  | 0.00  | ✓ |
| cognitive      | 0.00  | ✓ |
| planning       | 0.00  | ✓ |
| autonomy       | 0.00  | ✓ |
