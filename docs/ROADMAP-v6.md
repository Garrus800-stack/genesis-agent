# Genesis — v6 Roadmap

> **v6.0.8 — All 12 roadmap items complete. Learning Flywheel added.** Remaining items deferred to v7.

---

## Current State

| Metric | Value |
|--------|-------|
| Source Files / LOC | 241 / ~84k |
| Test Suites / Tests | 264 / ~3,830 |
| Boot Phases | 13 |
| Registered Services | 139 (131 manifest + 8 kernel) |
| Circular Dependencies | 0 |
| Cross-Layer Violations | 0 |
| Shutdown Integrity | ✅ All 60 services, sync writes |
| Fitness Score | 90/90 (100%) |
| TypeScript CI | ✅ Strict mode, 0 errors |
| @ts-nocheck files | 0 |
| Event Warnings | 0 |
| Coverage Ratchet | 77/72/72 (lines/branches/functions) |
| CLI Commands | 20 |
| IPC Channels | 63 (55 invoke + 2 send + 6 receive) |

---

## v6 Roadmap — Complete

| # | Item | Version | Summary |
|---|------|---------|---------|
| V6-1 | Colony Mode | v5.9.2–v6.0.6 | ColonyOrchestrator, PeerConsensus (VectorClock + LWW), 3-peer daisy-chain convergence (17 tests), colony-test.js peer discovery + sync verification |
| V6-2 | MCP Bidirectional | v5.8.0–v5.9.0 | Genesis as MCP client + server, 7 tools exposed, Streamable HTTP, resource subscriptions, session tracking |
| V6-3 | Live Deployment | v5.9.2–v6.0.6 | DeploymentManager (4 strategies: Direct/Canary/Rolling/Blue-Green), HTTP + shell health checks, environment awareness, auto-rollback, `deploy:swap`, CLI `/deploy` |
| V6-4 | UI Overhaul | v5.9.2 | 13 live Dashboard panels, interactive architecture graph, reasoning trace trees, proactive insights timeline, coupling heatmap |
| V6-5 | Context Window | v5.9.7–v6.0.0 | DynamicContextBudget, ConversationCompressor, CognitiveWorkspace onEvict → MemoryConsolidator |
| V6-6 | Skill Registry | v5.9.8 | SkillRegistry (install/uninstall/update from GitHub/npm/Gist/URL), manifest validation, sandbox isolation, CLI `/skills` |
| V6-7 | Memory Consolidation | v6.0.0 | MemoryConsolidator (Jaccard merge, stale pruning, lesson archival, decay scoring), IdleMind integration, CLI `/consolidate` |
| V6-8 | Task Replay | v6.0.0–v6.0.6 | TaskRecorder (auto-record goal traces), `buildReplayManifest` (chronological timeline), `replay()` (bus events), `formatReplay()`, diff view, CLI `/replay <id>` |
| V6-9 | Benchmarking | v5.9.8–v6.0.4 | 12 benchmark tasks, A/B matrix, layer A/B (--skip-phase), baseline comparison, `--ab-matrix` multi-backend, README auto-gen |
| V6-10 | Offline-First | v6.0.5–v6.0.6 | NetworkSentinel (30s probes, 3-failure threshold, auto-failover to Ollama, auto-restore, mutation queue), KG + LessonsStore flush on offline, keyword search fallback |
| V6-11 | Cognitive SelfModel | v5.9.7–v6.0.6 | TaskOutcomeTracker, CognitiveSelfModel (Wilson-calibrated profiles, bias detection, backend strength map), Dashboard panel (radar + backends + biases), CLI `/selfmodel` |
| V6-12 | Meta-Cognitive Loop | v6.0.2 | AdaptiveStrategy (bias→adaptation→validation→confirm/rollback), QuickBenchmark, ModelRouter empirical injection, OnlineLearner weakness signals, IdleMind `calibrate` |

---

## Version History

| Version | Focus |
|---------|-------|
| v5.1.0–v5.9.9 | Foundation: MCP, Dashboard, TypeScript CI, Cognitive Architecture, Organism Layer, Consciousness, Boot Profiles |
| v6.0.0 | V6-5 eviction, V6-7 MemoryConsolidator, V6-8 TaskRecorder, V6-6 CLI, V6-9 benchmarks (12 tasks) |
| v6.0.1 | Safety: CostGuard, BackupManager, CrashLog, AutoUpdater, SKILL-SECURITY.md |
| v6.0.2 | V6-12 Meta-Cognitive Loop: AdaptiveStrategy, QuickBenchmark, ModelRouter/OnlineLearner patches |
| v6.0.3 | Security Audit: 3 High IPC fixes, sandbox hardening, SA-P3/P4/P8 complete |
| v6.0.4 | Proportional Intelligence: CognitiveBudget, ExecutionProvenance, AdaptivePromptStrategy, Smart Model Ranking, Consciousness A/B (0pp → cognitive default), Organism A/B (+33pp) |
| v6.0.5 | Offline-First: NetworkSentinel, intelligence pipeline integration tests (16), colony convergence proof (17), CC>30 SA-O1 closed, event warnings 2→0, coverage sweep (functions 69.6→75.2%), ratchet 77/72/72 |
| v6.0.6 | V6-8 Replay complete, V6-10 KG Offline-Cache, V6-11 Dashboard + CLI, V6-3 Deploy strategies enhanced, V6-1 Colony peer verification |
| v6.0.7 | Earned Autonomy (Wilson-score per-action trust), AgentLoop trust-gated approval, OnlineLearner→AdaptiveStrategy reactive bridge, model-aware prompt gating, cognitive boot default |
| v6.0.8 | Learning Flywheel: SymbolicResolver (DIRECT/GUIDED/PASS pre-LLM lookup), DirectedCuriosity (weakness-targeted IdleMind exploration), ConsciousnessGate (coherence-gated self-modification) |

---

## Deferred to v7

| Proposal | Reason |
|----------|--------|
| V6-1: Full 2-process IPC sync | Protocol proven (17 tests). Real-world test needs 2 running instances with Ollama — manual test, not code gap. |
| V6-3: External Hot-Swap via IPC | Self-deploy (HotReloader) and shell-based deploy work. IPC hot-swap in external processes is a new feature, not v6 scope. |
| V6-11: Calibrated Estimation | Self-calibrating — needs accumulated runtime data. No code needed, just usage time. |
| V6-11: Colony Task Routing | SelfModel per worker → lead routes tasks to best-suited agent. Depends on V6-1 real multi-process. |
| Remove Consciousness Layer | Empirically validated as 0pp impact (v6.0.4). Default boot is `cognitive`. Available via `--full` for research. |
| Predictive Load Balancer | Over-engineering for single-user desktop. Revisit for colony mode. |
| Shadow Execution for SelfMod | Existing sandbox + snapshot rollback covers 90%. |
| Full OpenTelemetry | Too heavy. Correlation IDs provide 80% of tracing value at 5% complexity. |

---

## How to Use This Roadmap

1. Run `node scripts/architectural-fitness.js` before starting any sprint.
2. Run `node scripts/fitness-trend.js` to check for drift.
3. Don't add features that lower the fitness score.

**The rule: reliability before capability. Fix what's broken before building what's missing.**
