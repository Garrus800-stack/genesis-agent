# Contributing to Genesis Agent

Thank you for your interest in contributing to Genesis! This guide covers everything you need to know.

## Table of Contents

- [Getting Started](#getting-started)
- [Architecture Overview](#architecture-overview)
- [Development Workflow](#development-workflow)
- [Code Conventions](#code-conventions)
- [Testing](#testing)
- [Security Rules](#security-rules)
- [Pull Request Process](#pull-request-process)

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 18.0.0 (tested on 18, 20, 22)
- **Ollama** running locally (for LLM features)
- **Git** for version control

### Setup

```bash
git clone https://github.com/Garrus800-stack/genesis-agent.git
cd genesis-agent
npm install
npm start          # Launch the Electron app
npm test           # Run all tests (237 suites)
```

### Useful Commands

| Command | Description |
|---------|-------------|
| `npm start` | Launch Electron app |
| `npm test` | Run full test suite (legacy + per-module, 237 suites) |
| `npm run test:new` | Run only per-module tests |
| `npm run test:legacy` | Run only legacy suite |
| `npm run test:coverage` | Run tests with c8 coverage report |
| `npm run test:ci` | Run tests with coverage enforcement (81/76/80) |
| `npm run ci` | Full CI: tests + event audit + channel audit + fitness gate |
| `node scripts/audit-events.js` | Audit EventBus event flow |
| `node scripts/audit-events.js --strict` | Audit with exit code on warnings |
| `node scripts/validate-channels.js` | Validate IPC channel consistency |
| `npm run audit:degradation` | Generate degradation matrix |
| `npm run benchmark:consciousness` | Run consciousness A/B benchmark |
| `npm run benchmark:consciousness:dry` | Validate benchmark scoring functions |
| `npm run build:bundle` | Build UI bundle (esbuild) |
| `npx typedoc` | Generate API documentation in docs/api/ |
| `npm run genesis` | Run kernel bootstrap (headless) |

---

## Architecture Overview

Genesis is a **12-phase boot system** with a DI container. Understanding the phases is critical:

| Phase | Layer | Services | Purpose |
|-------|-------|----------|---------|
| 0 | Bootstrap | rootDir, guard, bus, storage, lang, logger | Injected manually by AgentCore |
| 1 | Foundation | Settings, ModelBridge, Sandbox, KnowledgeGraph, WorldState, ModuleSigner, Ports | Core infrastructure |
| 2 | Intelligence | IntentRouter, VerificationEngine, CircuitBreaker, PromptBuilder, CodeSafetyScanner | Decision-making |
| 3 | Capabilities | ShellAgent, McpClient, HotReloader, SkillManager, FileProcessor, SnapshotManager | External interaction |
| 4 | Planning | GoalStack, Reflector, MetaLearning, Anticipator, SchemaStore | Goal decomposition |
| 5 | Hexagonal | ChatOrchestrator, SelfModPipeline, UnifiedMemory, EpisodicMemory, PeerNetwork | Orchestration |
| 6 | Autonomy | AutonomousDaemon, IdleMind, HealthMonitor, CognitiveMonitor, ErrorAggregator | Background processes |
| 7 | Organism | EmotionalState, Homeostasis, NeedsSystem | Agent "feelings" |
| 8 | Revolution | AgentLoop, FormalPlanner, NativeToolUse, SessionPersistence, ModelRouter | Autonomous execution |
| 9 | Cognitive | ExpectationEngine, MentalSimulator, SurpriseAccumulator, DreamCycle, SelfNarrative | Anticipation + identity |
| 10 | Agency | GoalPersistence, FailureTaxonomy, DynamicContextBudget, EmotionalSteering, LocalClassifier | Persistent autonomy |
| 11 | Extended | TrustLevelSystem, EffectorRegistry, WebPerception, GitHubEffector, SelfSpawner | External perception + action |
| 12 | Hybrid | GraphReasoner, AdaptiveMemory | Symbolic + neural reasoning |
| 13 | Consciousness | PhenomenalField, TemporalSelf, IntrospectionEngine, AttentionalGate, ConsciousnessExtension (6 subsystems) | Unified experience + meta-awareness |

### Key Principles

1. **Services in Phase N must not hard-depend on Phase N+1.** Use `lateBindings` for cross-phase references.
2. **All service registrations live in `src/agent/manifest/`.** One file per phase. Auto-discovery resolves module paths.
3. **The EventBus connects everything.** Events are validated against `EventTypes.js` in dev mode. Payload schemas are checked by `EventPayloadSchemas.js`.
4. **The Kernel is immutable.** `main.js`, `preload.js`, and `src/kernel/` cannot be modified by the agent.
5. **Programmatic truth over LLM opinion.** VerificationEngine checks results deterministically before asking the LLM.
6. **Self-modified modules are signed.** `ModuleSigner` creates HMAC-SHA256 signatures for integrity tracking.
7. **Phases 9-13 are optional.** All cognitive and consciousness hooks check for null. Genesis runs fully without these modules — they degrade gracefully.
8. **English for all runtime strings.** Comments may be bilingual, but error messages, progress events, and user-facing strings must be English. Use the i18n system (`lang.t()`) for translated UI text.

### Directory Structure

```
genesis-agent/
├── main.js                    # KERNEL — Electron entry (immutable)
├── preload.js                 # KERNEL — IPC whitelist CJS (immutable)
├── preload.mjs                # KERNEL — IPC whitelist ESM (immutable)
├── SECURITY.md                # Security policy & threat model
├── src/
│   ├── kernel/                # KERNEL — SafeGuard, bootstrap (immutable)
│   ├── agent/
│   │   ├── AgentCore.js       # Boot orchestration
│   │   ├── ContainerManifest.js # Auto-discovery manifest composer
│   │   ├── manifest/          # Per-phase service registrations
│   │   │   ├── phase1-foundation.js ... phase13-consciousness.js
│   │   ├── core/              # EventBus, Container, Constants, WriteLock, CancellationToken
│   │   ├── foundation/        # ModelBridge, Backends, Sandbox, KG, WorldState, BootTelemetry
│   │   ├── intelligence/      # IntentRouter, VerificationEngine, CodeSafetyScanner
│   │   ├── capabilities/      # ShellAgent, McpClient, HotReloader, SnapshotManager
│   │   ├── planning/          # GoalStack, MetaLearning, SchemaStore, Reflector
│   │   ├── hexagonal/         # ChatOrchestrator, SelfModPipeline, PeerNetwork, EpisodicMemory
│   │   ├── autonomy/          # IdleMind, HealthMonitor, ErrorAggregator, HealthServer
│   │   ├── organism/          # EmotionalState, Homeostasis, NeedsSystem, Metabolism, ImmuneSystem, BodySchema
│   │   ├── revolution/        # AgentLoop, FormalPlanner, NativeToolUse, ModelRouter, FailureAnalyzer
│   │   ├── cognitive/         # CognitiveSelfModel, TaskOutcomeTracker, MemoryConsolidator, TaskRecorder, AdaptiveStrategy, ReasoningTracer, DreamCycle, LessonsStore + 12 more
│   │   ├── consciousness/     # PhenomenalField, TemporalSelf, IntrospectionEngine,
│   │   │                      # AttentionalGate, ConsciousnessExtension (7 subsystems)
│   │   └── ports/             # Hexagonal architecture port adapters
│   ├── skills/                # Loadable skill plugins
│   └── ui/                    # Electron renderer (Web Components + vanilla JS)
├── test/
│   ├── harness.js             # Shared async-safe test framework
│   ├── index.js               # Test runner v2 (parallel, async)
│   └── modules/               # Per-module test files (237 suites)
├── schemas/                   # JSON Schemas (skill-manifest)
├── types/                     # TypeScript type definitions (.d.ts)
├── scripts/                   # Tooling (audit-events, benchmark, build-bundle)
├── docs/                      # Architecture & migration documentation
└── .github/workflows/ci.yml   # GitHub Actions CI pipeline
```

---

## Development Workflow

### Adding a New Service

1. **Create the module** in the appropriate directory (e.g., `src/agent/intelligence/MyService.js`)
2. **Add the entry** to the correct phase file in `src/agent/manifest/`
3. **Add events** to `src/agent/core/EventTypes.js` if your service emits new events
4. **Add payload schemas** to `src/agent/core/EventPayloadSchemas.js` for dev-mode validation
5. **Write tests** in `test/modules/myservice.test.js`
6. **Run the event audit:** `node scripts/audit-events.js`

> **Note:** Since v3.8.0, the module resolver uses auto-discovery. You do NOT need to manually add entries to a `_dirMap` — just place the file in the correct directory.

### Service Template

```javascript
// ============================================================
// GENESIS — MyService.js
// Brief description of what this service does.
// ============================================================

const { NullBus } = require('../core/EventBus');

class MyService {
  // Auto-discovery config for ModuleRegistry
  static containerConfig = {
    name: 'myService',
    phase: 2,                    // Pick the correct phase
    deps: ['storage'],           // Hard dependencies (same or lower phase)
    tags: ['intelligence'],
    lateBindings: [              // Cross-phase dependencies
      { prop: 'emotionalState', service: 'emotionalState', optional: true },
    ],
  };

  constructor({ bus, storage }) {
    this.bus = bus || NullBus;    // Always default to NullBus
    this.storage = storage;
  }

  // Lifecycle: asyncLoad() → boot() → start() → stop()
  async asyncLoad() { /* Load persisted data */ }
  async boot() { /* Post-load initialization */ }
  start() { /* Start timers/watchers */ }
  stop() { /* Clean shutdown */ }
}

module.exports = { MyService };
```

### Manifest Entry Template

```javascript
// In manifest/phase2-intelligence.js:
['myService', {
  phase: 2,
  deps: ['storage'],
  tags: ['intelligence'],
  lateBindings: [
    { prop: 'emotionalState', service: 'emotionalState', optional: true },
  ],
  factory: (c) => new (R('MyService').MyService)({
    bus, storage: c.resolve('storage'),
  }),
}],
```

---

## Code Conventions

### Style

- **No external linter/formatter** — keep the existing code style consistent
- **Constructor injection** — all dependencies come through the constructor
- **NullBus default** — every module that uses `bus` must default to `NullBus`
- **Constants centralization** — no magic numbers; add to `Constants.js`
- **German comments are fine** — the project has bilingual roots. However, all **runtime strings** (errors, events, progress messages) must be English. Use `lang.t()` for i18n.

### Naming

- **Services:** PascalCase class, camelCase container name (`KnowledgeGraph` → `'knowledgeGraph'`)
- **Events:** namespace:action format (`'knowledge:node-added'`, `'agent:status'`)
- **Files:** PascalCase matching the class name (`VerificationEngine.js`)

### Error Handling

- Never silently swallow errors — log at minimum `console.debug`
- Use `try/catch` with specific error messages including the module name
- The CircuitBreaker wraps all LLM calls — don't add your own retry logic around LLM

### Lifecycle

Services follow the lifecycle: `constructor → asyncLoad → boot → start → stop`. Not all hooks are required. `asyncLoad()` is for loading persisted data asynchronously; `boot()` for post-load initialization; `start()` for timers and watchers; `stop()` for cleanup.

---

## Testing

### Test Framework

Genesis uses a custom async-safe test harness (`test/harness.js`). No external test framework needed.

### Writing Tests

Create `test/modules/myservice.test.js`:

```javascript
const { describe, test, assert, assertEqual, assertThrows, run } = require('../harness');

const { MyService } = require('../../src/agent/intelligence/MyService');

describe('MyService — Construction', () => {
  test('constructs with NullBus default', () => {
    const svc = new MyService({ bus: null, storage: null });
    assert(svc.bus != null, 'bus should default to NullBus');
  });

  test('has correct containerConfig', () => {
    assertEqual(MyService.containerConfig.phase, 2);
    assert(MyService.containerConfig.deps.includes('storage'));
  });
});

describe('MyService — Core Logic', () => {
  test('does the thing', async () => {
    const svc = new MyService({ bus: mockBus(), storage: mockStorage() });
    const result = await svc.doThing();
    assert(result.ok === true);
  });
});

run();  // ← MUST be called at end of file
```

### Running Tests

```bash
npm test                              # All tests (237 suites)
node test/modules/myservice.test.js   # Single module
npm run test:new                      # Only per-module tests
npm run test:coverage                 # With c8 coverage report
```

### Test Expectations

- Every new service must have a test file
- Minimum: constructor tests, containerConfig validation, core logic tests
- Use mocks for external dependencies (see existing tests for patterns)
- Tests must pass on Node 18, 20, and 22
- Tests must not require Ollama, internet, or any external service

---

## Security Rules

Genesis can modify its own source code. This is powerful but dangerous. These rules are **non-negotiable**:

1. **Never modify kernel files** (`main.js`, `preload.js`, `src/kernel/`). SafeGuard enforces this at runtime.
2. **Never modify hash-locked files** (CodeSafetyScanner, VerificationEngine, Constants, EventBus, Container). SafeGuard.lockCritical() enforces this.
3. **All LLM-generated code must pass CodeSafetyScanner** before being written to disk.
4. **Self-modified modules must be signed** via `ModuleSigner.sign()` for integrity tracking.
5. **IPC channels must be whitelisted** in `preload.js`. Never add a channel without review.
6. **Sandbox execution** has a 15s timeout, 128MB memory limit, and blocked module list. The VM mode uses frozen contexts with no access to `process`, `require`, or `eval`.
7. **Path traversal is blocked** by StorageService. Don't use `fs` directly — go through `storage`.
8. **PeerNetwork imports** are validated with schema check + AST safety scan before disk write.

### Blocked Patterns in Generated Code

The CodeSafetyScanner (AST + regex) blocks:

- `eval()`, `new Function()`, indirect eval
- `process.exit()`, kernel imports
- `vm.run*()`, `nodeIntegration: true`
- `contextIsolation: false`, `webSecurity: false`
- Direct writes to system directories

---

## Pull Request Process

1. **Fork & branch** from `main` (use `feature/my-feature` or `fix/my-fix`)
2. **Write tests** for new functionality
3. **Run the full test suite:** `npm test`
4. **Run the event audit:** `node scripts/audit-events.js --strict`
5. **Update documentation** if you add new services, events, or IPC channels
6. **Open a PR** with a clear description of what changed and why

### PR Checklist

- [ ] Tests pass (`npm test`)
- [ ] Event audit passes (`node scripts/audit-events.js --strict`)
- [ ] Channel audit passes (`node scripts/validate-channels.js`)
- [ ] New services registered in the correct manifest phase file
- [ ] New events added to `EventTypes.js`
- [ ] New event payloads have schemas in `EventPayloadSchemas.js`
- [ ] New IPC channels added to `preload.js` whitelist (if applicable)
- [ ] No kernel or hash-locked files modified
- [ ] Constants extracted to `Constants.js` (no magic numbers)
- [ ] All runtime strings are English (use `lang.t()` for i18n)
- [ ] Long-running async operations accept a `CancellationToken` (if applicable)
- [ ] New skills include a `skill-manifest.json` validated against the JSON Schema

### What Gets Reviewed

- **Phase correctness** — is the service in the right boot phase?
- **Dependency direction** — no upward phase dependencies without `lateBindings`
- **NullBus usage** — does the service degrade gracefully without EventBus?
- **Security** — does the change touch kernel, IPC, or code execution?
- **Test coverage** — is the new functionality tested?
- **Graceful degradation** — does the service handle missing optional dependencies?

---

## Questions?

Open an issue on [GitHub](https://github.com/Garrus800-stack/genesis-agent/issues) or check:

- `docs/ARCHITECTURE-DEEP-DIVE.md` — Comprehensive technical analysis (all layers, metrics, data flows)
- `docs/EVENT-FLOW.md` — Full event architecture
- `docs/TROUBLESHOOTING.md` — Common problems and solutions
- `docs/phase9-cognitive-architecture.md` — Phase 9 design document
- `SECURITY.md` — Security policy and threat model
- `schemas/skill-manifest.schema.json` — Plugin manifest JSON Schema
