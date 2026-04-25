# Genesis Agent — Benchmarking & Testing Guide

> How to measure, validate, and prove that Genesis works correctly.

---

## Quick Reference

| Command | What it does | Duration |
|---------|-------------|----------|
| `npm test` | Run all 4200 tests | ~30s |
| `npm run test:ci` | Tests + coverage enforcement (78/75/71) | ~45s |
| `npm run benchmark:agent --quick` | 3-task capability benchmark | ~2 min |
| `npm run benchmark:agent:layer:organism` | A/B: full vs without organism | ~5 min |
| `npm run benchmark:agent:ab` | A/B: full vs baseline (no organism) | ~10 min |
| `npm run test:colony` | Colony infrastructure test (2 instances) | ~1 min |

---

## 1. Unit Tests

### Run all tests

```bash
npm test                    # Full suite (4200 tests)
npm run test:new            # Only per-module test files
npm run test:legacy         # Only monolithic legacy suite
```

### Run a single test file

```bash
node test/modules/sandbox.test.js
node test/modules/v604-colony-proof.test.js
```

### Test coverage

```bash
npm run test:coverage              # HTML + text report
npm run test:coverage:enforce      # Enforce ratchet (81/76/80)
npm run test:coverage:safety       # Safety-critical modules only (80/70/75)
```

The coverage ratchet is enforced in CI. Current thresholds:

| Scope | Lines | Branches | Functions |
|-------|-------|----------|-----------|
| Global | 78% | 75% | 71% |
| Safety-critical | 80% | 70% | 75% |

Safety-critical modules: `src/kernel/**`, `CodeSafetyScanner`, `VerificationEngine`, `Sandbox`, `WebFetcher`, `SelfModificationPipeline`, `MemoryFacade`.

---

## 2. Agent Benchmarks

### Basic benchmark

Runs 12 tasks (or 3 in `--quick` mode) across 5 categories: code generation, bug fixing, analysis, explanation, and multi-step tasks.

```bash
# Full suite (12 tasks)
node scripts/benchmark-agent.js

# Quick mode (3 tasks, ~2 min)
node scripts/benchmark-agent.js --quick

# Specific backend
node scripts/benchmark-agent.js --quick --backend ollama:qwen2.5:7b
node scripts/benchmark-agent.js --quick --backend anthropic:claude-3.5-sonnet

# Save as baseline for future comparison
node scripts/benchmark-agent.js --baseline save

# Compare against saved baseline
node scripts/benchmark-agent.js --baseline compare
```

**Output:** Per-task pass/fail, aggregate success rate, total tokens, average latency.

**Results saved to:** `.genesis/benchmark-latest.json`

---

## 3. Layer A/B Benchmarks

The most important benchmarks: empirically validate whether a cognitive layer actually improves agent performance. Each test runs the same tasks twice — once with all phases, once with specific phases skipped — and compares results.

### Awareness A/B (Phase 13 — removed in v7.0.0)

**Result:** Phase 13 (Consciousness Layer) was empirically validated at **0pp** impact and removed in v7.0.0. Replaced by lightweight AwarenessPort (2 modules, 112 LOC). The benchmark commands below remain available to validate the AwarenessPort interface.

```bash
# Quick mode (recommended first run)
npm run benchmark:agent:layer:consciousness

# Equivalent manual command
node scripts/benchmark-agent.js --ab-layer 13 --quick

# Full suite (12 tasks × 2 runs)
node scripts/benchmark-agent.js --ab-layer 13

# With specific backend
node scripts/benchmark-agent.js --ab-layer 13 --quick --backend ollama:qwen2.5:7b
```

**Results saved to:** `.genesis/benchmark-ab-layer-13.json`

### Organism A/B (Phase 7)

**Question:** Does the organism layer (EmotionalState, Homeostasis, NeedsSystem, Metabolism, Genome) improve task success?

| Version | Model | Mode | Result | Detail |
|---|---|---|---|---|
| v6.0.4 | kimi-k2.5:cloud | Full (12 tasks) | **+33pp** | First validation, CPU-only baseline (timeouts inflated upper delta) |
| v7.2.3 | kimi-k2.5:cloud | Full (12 tasks) | **+16pp** | 83% vs 67%, 2 timeouts in baseline |
| v7.2.3 | kimi-k2.5:cloud | Quick (3 tasks) | 0pp | 100% vs 100%, neutral |

**Caveats — read these before citing the numbers:**
- Single model only (kimi-k2.5:cloud). Not yet replicated on Anthropic, OpenAI, or other Ollama models.
- 12-task suite, single machine.
- The v6.0.4 baseline ran on CPU-only with ETIMEDOUT failures that inflated the upper delta. Treat the v7.2.3 lower bound (+16pp) as the conservative reading.
- Organism helps on complex tasks (code smell detection, strategy pattern extraction) and is neutral on trivial tasks — the delta is task-mix-dependent.

```bash
npm run benchmark:agent:layer:organism

# Or manually
node scripts/benchmark-agent.js --ab-layer 7 --quick
```

**Results saved to:** `.genesis/benchmark-ab-layer-7.json`

### Combined A/B (Organism + Awareness)

```bash
npm run benchmark:agent:layer:full

# Or manually
node scripts/benchmark-agent.js --ab-layer 7,13 --quick
```

### Custom Layer A/B

Skip any phase(s) from 6-13:

```bash
# Without autonomy (phase 6: daemon, health monitor, service recovery)
node scripts/benchmark-agent.js --ab-layer 6 --quick

# Without cognitive (phase 9: self-model, reasoning tracer, dream cycle)
node scripts/benchmark-agent.js --ab-layer 9 --quick

# Without extended + hybrid + consciousness (phases 11-13)
node scripts/benchmark-agent.js --ab-layer 11,12,13 --quick
```

### Interpreting A/B results

| Δ Success Rate | Interpretation | Action |
|---|---|---|
| > +10pp | Layer significantly helps | Keep active, optimize |
| +5pp to +10pp | Layer moderately helps | Keep active |
| -5pp to +5pp | No significant impact (noise) | Consider moving to `--cognitive` profile |
| < -5pp | Layer hurts performance | Disable or investigate |

### Legacy Organism A/B

The A/B mode uses `GENESIS_AB_MODE` environment variable to disable prompt sections:

```bash
# Original mode: disables organism/consciousness sections in PromptBuilder
npm run benchmark:agent:ab
npm run benchmark:agent:ab:quick

# Multi-backend matrix
npm run benchmark:agent:ab:matrix
```

**Results saved to:** `.genesis/benchmark-ab.json`

---

## 4. Colony Tests

### Unit-level consensus proof

Tests PeerConsensus logic: VectorClock causality, sync, LWW conflict resolution, and convergence. Does not require two running instances.

```bash
node test/modules/v604-colony-proof.test.js
```

**What it proves:**
- VectorClock compare/merge: correct causality ordering ✅
- Basic sync: A→B mutation transfer ✅
- Bidirectional sync: both peers share data ✅
- Conflict resolution: LWW (last-write-wins) on concurrent edits ✅
- Recovery: catch-up after missed sync rounds ✅
- Convergence: full A→B→A round-trip produces identical state ✅

### Infrastructure integration test

Spawns two headless Genesis instances and tests MCP protocol communication:

```bash
npm run test:colony              # Full test (requires running LLM)
npm run test:colony:dry          # Dry run — infrastructure only, no LLM
```

---

## 5. Awareness Benchmark (Phase 13 removed — historical reference)

Standalone benchmark for consciousness subsystem performance:

```bash
npm run benchmark:consciousness           # Full benchmark
npm run benchmark:consciousness:dry       # Dry run (no LLM, measures computation only)
```

---

## 6. Architectural Fitness

Automated checks for coupling, listener leaks, event catalog completeness, and structural rules:

```bash
npm run audit:fitness            # Score out of 120 (12 checks)
npm run audit:fitness:ci         # Exit 1 if score below threshold
npm run audit:fitness:json       # Machine-readable output

npm run audit:events             # Event catalog audit
npm run audit:events:strict      # Exit 1 on uncatalogued events
npm run audit:channels           # IPC channel validation
npm run audit:degradation        # Service degradation matrix
```

---

## 7. Model Configuration for Benchmarks

Genesis uses Smart Ranking to auto-select the best model, but benchmarks need a specific model for reproducible results:

```bash
# Recommended: set preferred model before benchmarking
node cli.js                          # Start Genesis
/model qwen2.5:7b                   # Switch + save permanently
/quit                                # Exit

# Or use --backend flag per benchmark run
node scripts/benchmark-agent.js --quick --backend ollama:kimi-k2.5:cloud

# Or set in settings file (~/.genesis/settings.json)
{ "models": { "preferred": "qwen2.5:7b" } }
```

**Important:** Without a `preferred` model, Ollama may return different models between runs, making A/B comparisons unreliable.

---

## 8. Boot Profiles for Testing

Genesis defaults to `cognitive` profile (phases 1–12). Phase 13 (Consciousness) was empirically validated as 0pp impact and removed in v7.0.0.

```bash
# Cognitive (default): phases 1-12, ~136 services
node cli.js

# Full: all 12 phases, ~136 services
node cli.js --full

# Minimal: phases 1-8, core agent only (~80 services)
node cli.js --minimal

# Custom: skip specific phases
node cli.js --skip-phase 13         # Skip consciousness
node cli.js --skip-phase 7,13       # Skip organism + consciousness
node cli.js --skip-phase 9,10,11    # Skip cognitive + agency + extended
```

**Phase reference:**

| Phase | Layer | Key Services |
|-------|-------|-------------|
| 1 | foundation | settings, model, llm, sandbox, knowledgeGraph |
| 2 | intelligence | intentRouter, promptBuilder, context, codeSafety |
| 3 | capabilities | skills, shellAgent, mcpClient |
| 4 | planning | goalStack, metaLearning |
| 5 | hexagonal | chatOrchestrator, unifiedMemory, selfModPipeline |
| 6 | autonomy | daemon, healthMonitor, serviceRecovery |
| 7 | organism | emotionalState, homeostasis, needsSystem, genome |
| 8 | revolution | agentLoop, sessionPersistence, vectorMemory |
| 9 | cognitive | cognitiveSelfModel, reasoningTracer, dreamCycle |
| 10 | agency | goalPersistence, conversationCompressor, userModel |
| 11 | extended | trustLevelSystem, webPerception |
| 12 | hybrid | graphReasoner, adaptiveMemory |
| 13 | (removed in v7.0.0 — replaced by AwarenessPort in Phase 1) | — |

Phases 1-5 cannot be skipped (core infrastructure).

---

## 8. CI Pipeline

The CI workflow (`.github/workflows/ci.yml`) runs:

```bash
npm run test:ci                    # Tests + coverage enforcement
node scripts/build-bundle.js --ci  # Bundle build
node scripts/validate-events.js    # Event catalog validation
node scripts/validate-channels.js  # IPC channel validation
```

To run the full CI pipeline locally:

```bash
npm run ci          # Standard CI
npm run ci:full     # CI + TypeScript type check
```
