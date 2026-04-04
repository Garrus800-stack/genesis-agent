# Genesis — Development Roadmap

**v6.0.0. Prioritized by impact, not novelty.**

---

## Current State

| Metric | Value |
|--------|-------|
| Source Files / LOC | 235 / ~80.8k |
| Test Suites / Tests | 247 / ~3500 |
| Boot Phases | 13 |
| Registered Services | 128 |
| Circular Dependencies | 0 |
| Cross-Layer Violations | 0 |
| Shutdown Integrity | ✅ All 56 services, sync writes |
| Fitness Score | 90/90 (100%) |
| TypeScript CI | ✅ Strict mode, 0 errors |
| @ts-nocheck files | 0 (was 25) |
| Coverage Ratchet | 70/60/65 (lines/branches/functions) |

---

## Completed (detail in CHANGELOG.md)

| Version | Focus |
|---------|-------|
| v5.1.0  | Reliability: MCP CircuitBreaker, 100% test coverage, Windows compat, UI fixes, chat/model fixes |
| v5.2.0  | Observability: Correlation IDs, fitness trending, PromptEvolution, CC reduction, god-class extraction |
| v5.3.0  | Cognitive: SA-P5 OnlineLearner, SA-P6 CognitiveWorkspace, SA-P7 LessonsStore, boot profiles |
| v5.4.0  | Hardening: TypeScript strict CI, Dashboard extraction, WorldState CQRS-lite |
| v5.5.0  | Safety: PreservationInvariants (11 rules), ReasoningTracer, shutdown data-loss fixes |
| v5.6.0  | Tech debt: 12 god-class extractions, CC reduction, @ts-nocheck batches, SA-P4 Embodied Perception, DA-1/DA-2/DA-3 |
| v5.7.0  | Monitor cleanup + SA-P3 + SA-P8: CC>30 18→12, @ts-nocheck 101→25, ArchitectureReflection, DynamicToolSynthesis, ProjectIntelligence |
| v5.8.0  | MCP Bidirectional, Dashboard Overhaul (5 panels), @ts-nocheck 25→0, Channel sync fix |
| v5.9.0  | MCP Server Phase 2: Auto-start, Streamable HTTP, Resources (KnowledgeGraph + LessonsStore) |
| v5.9.1  | CLI UX: 12 bugs fixed from real-world testing — run-skill intent, retry, shell fix, log throttle, sandbox fixes |
| v5.9.2  | Hardening + V6 Foundations: MCP server security, CI strictness, coverage ratchet, Colony/Deploy foundations, UI Phase 2 complete (4 panels), Electron 39, CI badge |
| v5.9.3  | CI Fix + Quality Infrastructure: Green pipeline restored (audit:events:strict, TS6), ServiceRecovery (auto-healing), 3 built-in skills, lifecycle integration tests, release automation |
| v5.9.6  | Organism Context Containment: Homeostasis prompt containment (behavioral-only), organism context guard, formatting metric prohibition |
| v5.9.7  | SelfModel Data Layer + Context Overflow: TaskOutcomeTracker (V6-11 data collection), ConversationCompressor (V6-5 LLM-based history compression), coverage ratchet 70/60/65 |
| v5.9.8  | V6-5 + V6-11 + V6-9 + V6-6: ConversationCompressor wiring fix, CognitiveWorkspace onEvict, CognitiveSelfModel (Wilson-calibrated), SelfModel Dashboard, Benchmarking Suite (8 tasks), SkillRegistry (install/uninstall/update), Sandbox SIGKILL fix (0 failures) |
| v5.9.9  | Stabilization + CI Green: TSC-1/TSC-2 (TypeScript 6 fix), 4 listener leaks fixed (LEAK-1–4), fitness scanner upgrade (FIT-2), A/B Organism Validation (+37pp), headless --once mode |
| v6.0.0  | V6-5 complete (eviction pipeline), V6-7 MemoryConsolidator, V6-8 TaskRecorder, V6-6 CLI commands, V6-9 benchmark expansion (12 tasks + --ab-matrix) |

### Completed SA Items

| ID   | Name | Version |
|------|------|---------|
| SA-P4 | Embodied Perception | v5.6.0 |
| SA-P3 | Architecture Reflection | v5.7.0 |
| SA-P8 | Dynamic Tool Synthesis | v5.7.0 |
| SA-P5 | Online Learning | v5.3.0 |
| SA-P6 | Working Memory (CognitiveWorkspace) | v5.3.0 |
| SA-P7 | Cross-Project Learning (LessonsStore) | v5.3.0 |
| Self-Preservation Invariants | PreservationInvariants.js | v5.5.0 |
| Reasoning Trace UI | ReasoningTracer.js | v5.5.0 |

---

## Open — v6.0 Roadmap

### V6-1: Colony-Mode (Multi-Agent Coordination)

Multiple Genesis instances working together on a shared goal.

- **✅ ColonyOrchestrator**: Foundation module — goal decomposition, peer distribution, result merge, conflict detection, consensus-gated merge (v5.9.2)
- **Task Decomposition**: A "lead" agent breaks a large goal into sub-tasks and distributes them to worker agents
- **Result Merge**: Worker results are merged, conflicts resolved (e.g. two agents modifying the same file)
- **Consensus Protocol**: Before code changes are applied, agents vote via peer consensus (PeerConsensus.js already exists)
- **Shared Memory**: Colony-wide KnowledgeGraph and LessonsStore — what one agent learns, all agents know
- **Remaining**: Real peer integration testing, shared KG sync, multi-file conflict resolution UI
- **Prerequisite**: PeerNetwork ✅, TaskDelegation ✅, PeerConsensus ✅, ColonyOrchestrator ✅
- **Effort**: Medium (remaining)

### V6-2: Extended MCP Integration (Bidirectional) — ✅ Complete

Genesis is both an MCP client and a full MCP server.

- **✅ Genesis as MCP Server**: Full MCP 2025-03-26 protocol (JSON-RPC error codes, CORS, health, ping, listChanged, resources)
- **✅ McpServerToolBridge**: 7 tools exposed (verify-code, verify-syntax, code-safety-scan, project-profile, project-suggestions, architecture-query, architecture-snapshot)
- **✅ Auto-Start**: `mcp.serve.enabled` + `mcp.serve.port` in Settings → McpServer starts automatically on boot
- **✅ Streamable HTTP**: POST with `Accept: text/event-stream` returns SSE response (MCP 2025-03-26 transport)
- **✅ Resource Subscriptions**: 4 resources exposed (knowledge-graph/stats, knowledge-graph/nodes, lessons/all, lessons/stats) with `resources/list_changed` notifications
- **✅ Session Tracking**: `Mcp-Session-Id` header tracked per connection
- **Prerequisite**: McpServer.js ✅, McpTransport ✅, ToolRegistry ✅, McpServerToolBridge ✅
- **Effort**: Complete

### V6-3: Live Deployment

Genesis deploys code changes into running systems — not just into itself.

- **✅ DeploymentManager**: Foundation module — strategy pattern (Direct/Canary/Rolling/Blue-Green), health checks, auto-rollback, step tracking (v5.9.2)
- **External Hot-Swap**: Replace modules in external Node.js processes (via IPC/Socket)
- **Rolling Update**: For multi-service projects: update service-by-service with health checks between each step
- **Deployment Verification**: After each deploy: health check, smoke tests, automatic rollback on failure
- **Environment Awareness**: Genesis knows dev/staging/prod and adapts deployment strategy
- **Remaining**: External process IPC, real rolling update with load balancer, canary traffic splitting
- **Prerequisite**: HotReloader ✅, ShellAgent ✅, EffectorRegistry ✅, TrustLevels ✅, DeploymentManager ✅
- **Effort**: Medium (remaining)

### V6-4: UI Overhaul — ✅ Complete

Modern dashboard that visualizes the new cognitive capabilities.

- **✅ Consciousness Panel**: PhenomenalField awareness meter, valence/arousal, attention gate, temporal self, values alignment
- **✅ Energy Panel**: Metabolism gauge with level coloring, LLM call cost tracking
- **✅ Architecture Panel**: Service/event/layer/coupling counts, phase map pills
- **✅ Project Intelligence Panel**: Tech stack grid, conventions summary
- **✅ Tool Synthesis Panel**: Generated/active/failed/evicted counts, active tool pills
- **✅ Interactive Architecture Graph**: SVG force-directed layout, drag, click-to-highlight, phase-colored, hover tooltips (v5.9.2)
- **✅ Reasoning Trace Decision Trees**: Grouped by correlationId, collapsible chains, step connector visualization (v5.9.2)
- **✅ Proactive Insights Timeline**: IdleMind activities chronologically, thought counter, idle/active status, activity icons (v5.9.2)
- **✅ Coupling Hotspot Heatmap**: Top-20 services by connection count, heat-colored bars, in/out counts (v5.9.2)
- **Prerequisite**: Dashboard.js ✅, IPC channels ✅, all backend data available ✅, ArchitectureGraph.js ✅

### V6-5: Context Window Manager

Automatic context budget tracking and compression to prevent token overflow.

- **✅ ContextBudget Service**: DynamicContextBudget tracks token usage per LLM call, intent-based allocation profiles (v4.10.0)
- **✅ Auto-Summarization**: ConversationCompressor — LLM-based history compression with extractive fallback, caching, ContextManager integration (v5.9.7)
- **✅ Compressor Wiring**: `_compressor` late-binding added to `context` manifest entry — ConversationCompressor now live in `buildAsync()` (v5.9.8)
- **✅ Backend-Aware Limits**: `configureForModel()` sets `maxContextTokens` per model via MODEL_CONTEXT_MAP, passed to DynamicContextBudget.allocate() (v3.5.3+)
- **✅ Slot Eviction Hook**: CognitiveWorkspace `onEvict(key, slot)` callback + rich eviction data return (v5.9.8)
- **Remaining**: ~~Wire `onEvict` in workspaceFactory to persist/summarize evicted slots~~ → **✅ Complete (v6.0.0)**: `onEvict` callback wired in workspaceFactory, emits `workspace:slot-evicted` bus event. MemoryConsolidator subscribes for archival tracking.
- **Prerequisite**: CognitiveWorkspace ✅, LLMPort ✅, AttentionalGate ✅, DynamicContextBudget ✅, ConversationCompressor ✅
- **Effort**: Very low (remaining — one callback wiring in workspaceFactory)
- **Priority**: High — directly improves output quality on long tasks

### V6-6: Skill Registry (Community Skills)

Discover, install, and manage third-party skills from external sources.

- **✅ SkillRegistry.js**: Core service (320 LOC). Phase 3 manifest. Install, uninstall, update, search, list. Meta persistence. SkillManager reload integration. 2 events. 13 tests. (v5.9.8)
- **✅ `install(source)`**: Fetches from GitHub Gist, GitHub repo, npm (`npm:<n>`), direct archive URL (.zip/.tar.gz), or git clone. Validates manifest BEFORE loading code. (v5.9.8)
- **✅ Manifest Validation**: Required fields, name pattern, semver version, entry file existence. (v5.9.8)
- **✅ Sandbox Isolation**: Community skills run in existing sandbox with restricted permissions (inherited from SkillManager)
- **✅ Uninstall + Update**: `uninstall(name)` removes dir + meta. `update(name)` re-fetches from original source. (v5.9.8)
- **✅ Search**: `search(query)` queries optional registry index URL. (v5.9.8)
- **✅ CLI Commands (v6.0.0)**: `/skills`, `/skill install|uninstall|update` in CLI REPL.
- **Remaining**: Public registry index hosting
- **Prerequisite**: SkillManager ✅, Sandbox ✅, skill-manifest.schema.json ✅
- **Effort**: Low (remaining — CLI wiring + registry hosting)
- **Priority**: High — lowers barrier for external contributors

### V6-7: Memory Consolidation — ✅ Complete (v6.0.0)

Periodic pruning and merging of KnowledgeGraph and LessonsStore to prevent unbounded growth.

- **✅ MemoryConsolidator Service**: Phase 9 cognitive service (~340 LOC). KG redundancy detection (Jaccard similarity merge), stale node pruning, lesson archival with decay scoring, compaction reports. (v6.0.0)
- **✅ Redundancy Detection**: Same-type KG nodes merged by word-level Jaccard similarity (≥0.75). Properties merged, edges redirected, self-loops removed. Configurable max merges per run.
- **✅ Lesson Archival**: Lessons older than N days with low access count → archived to `~/.genesis-lessons/archive/`. Configurable thresholds.
- **✅ Relevance Scoring**: Decay-weighted relevance (recency × access frequency) drives eviction priority.
- **✅ Compaction Report**: Dashboard-ready report via IPC. Cumulative stats across all runs.
- **✅ IdleMind Integration**: `consolidate` activity triggers MemoryConsolidator via bus event. Always available.
- **✅ CLI**: `/consolidate` command for manual trigger.
- **Prerequisite**: KnowledgeGraph ✅, LessonsStore ✅, IdleMind ✅

### V6-8: Task Replay / Debug Mode

Record and deterministically replay complete task executions for debugging and regression testing.

- **✅ TaskRecorder Service (v6.0.0)**: Phase 9 cognitive service (~380 LOC). Automatic recording of goal execution traces (steps, LLM calls, tool invocations, decisions). Serialized to `.genesis-replay` files. Ring buffer of last 50 recordings. Index loaded from disk on boot.
- **✅ Diff View (v6.0.0)**: `diff(idA, idB)` compares two recordings step-by-step. Finds divergence point, compares step types, reports outcome deltas.
- **✅ CLI (v6.0.0)**: `/replays` lists recent recordings with status icons.
- **✅ IPC (v6.0.0)**: `agent:get-replay-report`, `agent:get-replay-diff`. Preload whitelisted.
- **Deterministic Replay**: Replay with mocked LLM responses reproduces exact execution path (remaining)
- **Dashboard Integration**: Replay visualized in existing Reasoning Trace Decision Trees panel (remaining)

### V6-9: Agent Benchmarking Suite

Standardized benchmarks to measure agent capability across versions and backends.

- **✅ `scripts/benchmark-agent.js`** (~230 LOC): 8 benchmark tasks across 5 categories (code-gen, bug-fix, refactoring, analysis, chat). Each task has programmatic `verify(output)` function. (v5.9.8)
- **✅ Metrics**: Success rate, token estimate, latency per task, aggregate scores. (v5.9.8)
- **✅ Regression Detection**: `--baseline save/compare` mode. Per-task regression flagging + overall success rate delta. (v5.9.8)
- **✅ Modes**: `--quick` (3 tasks), `--backend <n>`, `--json` output. (v5.9.8)
- **✅ Extended Task Suite (v6.0.0)**: 4 new tasks (8 → 12): async rate limiter, async error handling, strategy pattern, API design review. Coverage across 5 categories.
- **✅ `--ab-matrix` mode (v6.0.0)**: Runs A/B comparison across ALL configured backends. Auto-discovers backends from settings.json. Per-backend delta + aggregate average. Results saved to `.genesis/benchmark-ab-matrix.json`.
- **✅ README Auto-Gen (v6.0.1)**: `scripts/benchmark-readme.js` reads `.genesis/benchmark-latest.json`, generates markdown table, injects into README.md between `<!-- BENCHMARK-START/END -->` markers. npm script: `benchmark:readme`.
- **Prerequisite**: SkillManager ✅, LLMPort ✅, Sandbox ✅
- **Effort**: Low (remaining)
- **Priority**: Medium — provides hard numbers for competitive positioning

### V6-10: Offline-First / Ollama Priority Mode

Graceful degradation to local-only operation when no internet is available.

- **Network Detection**: Periodic connectivity check, automatic backend failover
- **Ollama Auto-Switch**: When cloud backends unreachable, route all LLM calls to Ollama
- **KG Cache**: Local snapshot of KnowledgeGraph for offline queries
- **Degradation Matrix Extension**: Add network-aware rules to existing DegradationMatrix
- **Sync on Reconnect**: Queue mutations during offline, sync to cloud backends on reconnect
- **Prerequisite**: DegradationMatrix ✅, OllamaBackend ✅, KnowledgeGraph ✅
- **Effort**: Low–Medium
- **Priority**: Medium — natural extension of existing degradation infrastructure

### V6-11: Cognitive SelfModel

A continuously updated internal model of the agent's own capabilities, weaknesses, and failure patterns. No existing AI agent framework has this.

- **✅ TaskOutcomeTracker**: Data collection layer — records structured task outcomes (type, backend, success, cost, duration) from 4 event sources. Aggregate stats API. Persistence. Phase 9 manifest. (v5.9.7)
- **✅ CognitiveSelfModel Service**: Phase 9 cognitive service (v5.9.8). Wilson-calibrated capability profiles, bias detection (4 detectors), backend strength map, confidence reports, prompt context injection. Late-binds to TaskOutcomeTracker + LessonsStore + ReasoningTracer. 29 tests.
- **✅ Capability Profile**: Per-task success rates with Wilson lower-bound confidence intervals. `isWeak`/`isStrong` flags. Top error categories per type. (v5.9.8)
- **✅ Backend Strength Map**: Per-backend empirical performance matrix, sorted by Wilson confidence. Recommended backend per task type. (v5.9.8)
- **✅ Bias Detection**: 4 pattern detectors — scope-underestimate, token-overuse, error-repetition, backend-mismatch. Severity + evidence strings. Cached, invalidated on new outcomes. (v5.9.8)
- **✅ Proactive Disclosure**: `getConfidence(taskType, backend?)` returns risk report before task execution. `buildPromptContext(intent)` injects into LLM system prompt via PromptBuilder. (v5.9.8)
- **✅ PromptBuilder Integration**: `_taskPerformanceContext()` now prefers CognitiveSelfModel over raw TaskOutcomeTracker. Falls back to legacy path if SelfModel absent. (v5.9.8)
- **Calibrated Estimation**: Predicted vs. actual duration/token cost — needs more outcome data to calibrate accurately
- **Colony Integration**: In V6-1 colony mode, each worker shares its SelfModel → lead agent routes tasks to the best-suited worker
- **Dashboard Panel**: Capability radar chart, calibration drift graph, bias log, per-backend comparison (IPC handler `agent:get-selfmodel-report` ready)
- **Data Sources**: TaskOutcomeTracker (raw outcomes) ✅, ReasoningTracer (raw decisions) ✅, LessonsStore (historical patterns) ✅, CognitiveWorkspace (cognitive context) ✅, PreservationInvariants (overconfidence guard) ✅, OnlineLearner (update trigger) ✅
- **Preservation Rule**: SelfModel MUST NOT overestimate capabilities — Wilson lower-bound enforces pessimistic calibration
- **Prerequisite**: TaskOutcomeTracker ✅, ReasoningTracer ✅, LessonsStore ✅, CognitiveWorkspace ✅, PreservationInvariants ✅, OnlineLearner ✅
- **Effort**: Low (remaining — calibrated estimation + dashboard rendering + colony integration)
- **Priority**: Critical — unique differentiator with no equivalent in any competing framework (LangChain, CrewAI, AutoGen, Devin). Genesis is the only project with the cognitive substrate to implement this.

---

## Explicitly Deferred

| Proposal | Reason |
|----------|--------|
| Predictive Load Balancer | Over-engineering for single-user desktop. Revisit for colony mode. |
| Shadow Execution for SelfMod | Existing sandbox + snapshot rollback covers 90%. Input replay is v7.0+. |
| Remove Consciousness Layer | Integration exists and is tested. Indirect influence via prompt context is the intended design. |
| Full OpenTelemetry | Too heavy. Correlation IDs provide 80% of the tracing value at 5% of the complexity. |

---

## How to Use This Roadmap

1. Run `node scripts/architectural-fitness.js` before starting any sprint.
2. Run `node scripts/fitness-trend.js` to check for drift.
3. Pick the highest-priority open item.
4. Implement, test, verify fitness score.
5. Don't add features that lower the fitness score.

**The rule: reliability before capability. Fix what's broken before building what's missing.**
