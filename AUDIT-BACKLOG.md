# Genesis Agent — Audit Backlog

> Version: 7.4.6 · Last updated: v7.4.6 (goal-pipeline fixes #28/#29/#30/#31 actually committed, source-presence tests added per Principle 0.9, rootDir sandbox added)

This document tracks all audit findings, monitor items, and their resolution status.
Referenced from [ARCHITECTURE.md](ARCHITECTURE.md). Per-version details in [CHANGELOG.md](CHANGELOG.md).

---

## Resolved in v7.4.6 — Goal-Pipeline Fixes (real this time)

The Windows live-test of v7.4.5.1 reproduced "Zugriff verweigert" failures
on a goal that should have worked. Investigation found that v7.4.5 had
declared #28/#29/#30 in its changelog and added regression locks, but
the source-code patches were partial (the fallback LLM-prompt had no OS
hint, the `find /C /V ""` pattern wasn't auto-fixed, the result didn't
surface adaptedCommand). v7.4.6 finishes the patches and adds Fix #31:
a hard rootDir sandbox in ShellAgent.

### Items resolved
- **#28 step.target||step.command resolution + enriched fallback prompt** —
  fallback now includes OS detection, rootDir, and don't-broaden-scope
  rules. Empty-command after fallback returns hard-refuse error.
- **#29 quote-safe counting** — `_adaptCommand` auto-fixes the broken
  `find /C /V ""` pattern even if the LLM emits it directly. Inverted
  `find /V /C ""` form also handled.
- **#30 execAsync verbatim** — result shape now surfaces `adaptedCommand`
  and `originalCommand` so Verifier-summary can show what the LLM
  proposed vs. what actually ran on this OS.
- **#31 NEW: rootDir sandbox** — ShellAgent rejects commands containing
  absolute paths outside rootDir, plus `dir /s C:\` / `where /r C:\`
  even when on the same drive. Returns `sandboxBlock:true` with a
  clear reason, instead of letting Windows return random "Zugriff
  verweigert" messages from system folders.

### Verification
- 17 new tests in `test/modules/v746-fix.test.js`, all green
- All previous goal-pipeline tests (v745-fix, goaldriver, agentloop-steps,
  AgentLoopRecovery, ShellAgent, renderer, formalplanner) still green
- Schema scan: 0 mismatches
- Fitness: 127/130 (unchanged)

### Principle added
**0.9 — Tests for code-presence, not just code-behavior.**
For any "this fix changes X in file Y" claim, write at least one test
that reads file Y with `fs.readFileSync` and asserts the change is there.
Without this, a future Claude session can write a changelog describing
fixes that don't fully exist in source — exactly what happened in v7.4.5.

### Why this happened (post-mortem)
The v7.4.5 release was produced through long Claude conversations. Code
edits were made, tests were written, but the connection between
"described in changelog" and "verified in source" was implicit. The
v745-fix test file ended up testing three unrelated small patches
(resume-prompt timeout, bilingual goal-patterns, dot-path setter) while
the changelog described 30 fixes. No source-presence test caught the
gap. v7.4.6 makes the connection explicit via Principle 0.9.

---

## Resolved in v7.4.5 — "Durchhalten"

A goal-pipeline release: end-to-end functionality from plan → execute →
observe-output → honest-verdict-in-chat. 30 fixes shipped (#16–#30) plus
4 Bausteine A–D (GoalDriver as P10, CostStream P1, ResourceRegistry P1,
Sub-Goal-Spawn). Live-verified on Windows (qwen3-vl:235b-cloud).

### What was verified
- **Tests:** 5668 pass, 0 failed
- **Schema scan:** 0 mismatches (273 source files, 436 emit/fire calls, 424 schemas)
- **Architectural fitness:** 127/130 (binary File-Size-Guard penalty — see O-8 update below)
- **Live-pipeline:** goal *"liste alle .js Dateien im Genesis-Ordner und zähle sie"* → `dir /b *.js` then `dir /b *.js | find /V /C ":"` → 4 files, count 4
- **Failure case:** goal *"node test-fake.js"* → honest `MODULE_NOT_FOUND`, marked FAILED

### Items resolved
- **Goal-pipeline unbroken end-to-end** — 30 separate bugs (#16–#30) listed in CHANGELOG.
  The single most consequential was #26 (a missing `await` on `loop.shell.run`) which
  silently swallowed all SHELL stderr and let the Verifier count broken commands as
  100% success. Architecture gap closure (#22 — `GoalStack.completeGoal`) prevented
  goals from infinite re-pickup. UI bridge (#23) made results visible in chat.
- **Windows shell parity** — POSIX → Windows command translation expanded (#27),
  `_adaptCommand` applied unconditionally on Windows, `exec` instead of `execFile`
  for shell path (#30) so pipes/quotes/redirects all work the way the LLM wrote them.
- **Quote-safe counting** — `find /V /C ":"` replacing `find /C /V ""` (the doubled
  empty quotes get re-escaped through Node.js → cmd.exe and trigger access-denied).

### O-8 status update — REGRESSION (deferred)
- **v7.4.4 baseline:** 2 files >700 LOC (`PromptBuilderSections.js`, `EpisodicMemory.js`)
- **v7.4.5:** **5 files >700 LOC**
  - `PromptBuilderSections.js` — 769 LOC (deferred via O-12 — bundled with BeliefStore in v7.6+)
  - `EpisodicMemory.js` — 758 LOC (deferred — no driving feature touch yet)
  - `GoalDriver.js` — **829 LOC** (NEW — grew through v7.4.5 #16–#22 rate-limit/race/lock fixes)
  - `AgentLoop.js` — **813 LOC** (NEW — grew through #22–#23 completeGoal wiring + blocked-branch path)
  - `GoalStack.js` — **769 LOC** (NEW — grew through `completeGoal` addition with cascading effects)
- Fitness score **unchanged at 127/130** because File-Size-Guard is binary (any warn → 7/10), but **this is an honest-bookkeeping regression**.
- **Action:** deferred. Three new split candidates for a future "Aufräumen III" release.
  Per Principle 0.5: feature stability first, structural cleanup follows. The natural
  moment is once the v7.4.5 fixes have run live for a while and the new code paths
  in GoalDriver/AgentLoop/GoalStack are stable.

### Items added (open by design)
- **O-13: Multi-model fallback in ModelBridge** — would structurally solve the
  rate-limit problem that #16–#19 patched at the GoalDriver level. When current
  model hits rate-limit, switch to fallback (cloud → local Ollama). Open for a
  future release.
- **O-14: Reflect→Study path** — Genesis can now see its own outputs (post-#26).
  Next step is to learn from failures: when a goal fails honestly, the
  failure-reason should feed a "study" episode that informs future plans.
  Foundation for v7.5+ meta-planner.

---

## Resolved in v7.4.4 — "Buchführung"

A bookkeeping release: four config files updated to reflect findings
from the v7.4.3 post-release verification on Windows, plus a docs
version-header hygiene pass (same approach v7.4.3 used to close O-10).
No code changes, no new tests.

### What was verified
- **Full coverage run** (`npm run test:ci` on Windows, v7.4.3 codebase):
  5583 tests pass, branch coverage **77.17%** (well over the temporary
  75.9% floor and the original 76% target), lines 83.3%, functions 80.41%.
- **Schema scan** (`npm run scan:schemas`): 415/415 events, 0 mismatches.
- **Architectural fitness** (`npm run audit:fitness`): 127/130. The
  3-point gap is the binary File-Size-Guard penalty — two files still
  warn (`EpisodicMemory.js`, `PromptBuilderSections.js`); both are
  already deferred (O-8 / O-12).
- **Diagnose-Skript** (`node scripts/diagnose-v741-d0.js`): Szenario C —
  see O-7.
- **GateStats persistence check**: see O-9 — file does not exist *by
  design*; GateStats has no persistence.

### Bookkeeping changes
- `package.json` — c8 `--branches` floor raised from `75.9` to `76`
  in both `test:ci` and `test:coverage:enforce` (matches the original
  pre-v7.2.0 baseline; 1.17pp safety margin remains).
- `scripts/ratchet.json` — `_locked_at` v7.4.2 → v7.4.4, `_date`
  updated, `testCount.floor` 5555 → 5582 (1-test buffer below the
  measured 5583), `fitnessScore.note` brought current (the old note
  listed five files as the cause of the 3-point gap; four of those
  were already split in v7.4.1–v7.4.3).
- `AUDIT-BACKLOG.md` — O-2 reformulated, O-6 RESOLVED, O-7 DEFERRED
  (with explicit pending-reproduction reasoning), O-9 CLOSED
  (correctness fix), this section added.
- `CHANGELOG.md` — `[7.4.4] — "Buchführung"` section added.
- **Docs version-header hygiene pass** — `README.md` (badge + current-
  state sentence with refreshed test count 5556 → 5583 + new v7.4.4
  history note), `ARCHITECTURE.md` (header version + verification
  footer numbers), `docs/ARCHITECTURE-DEEP-DIVE.md` (header + LOC
  reference + ratchet baseline mention), `docs/CAPABILITIES.md`,
  `docs/COMMUNICATION.md`, `docs/EVENT-FLOW.md`,
  `docs/MCP-SERVER-SETUP.md`, `docs/GATE-INVENTORY.md`,
  `docs/SKILL-SECURITY.md` — all "current-version" headers bumped
  v7.4.3 → v7.4.4. Historical references inside content (e.g.,
  *"split via IntentPatterns extract in v7.4.3"*, *"failFastMs
  semantics (v7.4.3)"*) deliberately preserved — they document what
  v7.4.3 did and stay accurate. Source-file headers in `src/agent/`
  and version-bound test files (`test/modules/v743-*.test.js`) are
  also unchanged for the same reason. Same approach as the v7.4.3
  docs-hygiene pass that closed O-10.

### Items resolved
- **O-6 → RESOLVED.** Branch coverage organically reached 77.17% over
  v7.3.4–v7.4.2 coverage pushes; original 76% target met. Threshold
  raised in `package.json`.
- **O-9 → CLOSED (correctness fix).** GateStats has no persistence —
  the originally-prescribed `cat .genesis/gate-stats.json` action was
  based on a false premise. Verification path is IPC + Dashboard, not
  a JSON file.

### Items reformulated
- **O-2 → reformulated.** "50+ samples" is unreachable across sessions
  with the current in-memory-only design. Decision deferred whether to
  add persistence or accept per-session telemetry as the intended view.
- **O-7 → DEFERRED.** Diagnose-Skript ran, returned Szenario C (no
  drift, no tool-call evidence). Item awaits fresh reproduction; D.1
  cannot be planned without it.

### What was deliberately not done
- No new tests for the original O-6 fallback-branch targets — they
  are covered by existing tests, and adding more would be coverage
  theater. Threshold met → closure.
- No EpisodicMemory or PromptBuilderSections split — both deferred per
  Principle 0.5 (one split per release, no busy-work) and the explicit
  O-12 rationale (PromptBuilderSections reorg bundled with BeliefStore
  in v7.6+).
- No fitness score push from 127 → 130. The score is binary on
  File-Size-Guard; getting to 130 requires both warning files to drop
  below threshold simultaneously. Splitting only one yields zero
  points. The natural moment is v7.6+ together with EpisodicMemory's
  next "natural feature touch" (O-8).

---

## Resolved in v7.3.7 – v7.4.2 (Kassensturz-Catch-Up)

Five releases (v7.3.7, v7.3.8, v7.3.9, v7.4.0, v7.4.1) had shipped without
AUDIT-BACKLOG updates. v7.4.2 closes this drift and also adds what v7.4.2
itself resolved.

### From v7.3.7 — "Zuhause einrichten"

- **IntentRouter overmatch (v7.3.6 9-step-plan bug)** — Stage 1
  `_conversationalSignalsCheck()` in IntentRouter routes conversational
  meta-questions (e.g. "was hat sich geändert") to general-intent before
  regex/fuzzy/LLM cascade can escalate them to tasks with hallucinated
  file paths. Extended in v7.4.1 with 13 additional meta-state patterns
  (emotion/mood, goals/work, settings/model, daemon, energy, autonomy,
  peers — both DE and EN).
- **MemoryDecay/Consolidation Three-Layer architecture** — episodes carry
  `layer` field (1=Detail, 2=Schema, 3=Feeling). DreamCycle Phase 4c
  consolidates aging episodes. CoreMemories ↔ Episode bidirectional links.
  Relational anchors (`johnny-reference`, `garrus-trust`, etc.) as immune
  markers. Addresses Memory backlog "graceful forgetting".
- **WakeUpRoutine** — time-boxed re-entry after boot via `boot:complete`
  event. Context collection, pending-moments review, journal re-entry.
- **JournalWriter with three visibilities** (private/shared/public),
  monthly rotation, crash-robust JSONL.
- **ActiveReferencesPort** — prevents DreamCycle from consolidating
  episodes referenced in active chat turns (fixes race condition).
- **Pin-and-Reflect** — `mark-moment` tool + DreamCycle Phase 1.5 (KEEP /
  ELEVATE / LET_FADE).
- **Goal-Lifecycle Auto-Transitions** — `GoalStack.reviewGoals()`
  auto-completes (all steps done), auto-fails (attempts exhausted),
  auto-stalls (72h inactive). Closes Memory backlog "goals at 6/8 never
  auto-complete".

### From v7.3.8 — "Ehrliches Nichtwissen"

- **LLM-Failure-Honesty** — typed error classifier, system-message
  format `⚠ Modell nicht verfügbar`, not pushed to history.
  `chat:llm-failure` event. Doppel-Call fix in `_generalChat`.
- **Synchroner Source-Read** (CHANGELOG.md + package.json) — `_maybeReadSourceSync`
  in ChatOrchestrator, mtime-cached, PromptBuilder `attachSourceContent`
  with authority framing.
- **Principle 0.4** established: *Honest non-knowing.*

### From v7.3.9 — "Aufräumen"

- **DreamCycle-Split** 854 → 482 LOC (extracted `DreamCyclePhases.js`).
- **ChatOrchestrator-Split** 719 → 582 LOC (extracted `ChatOrchestratorSourceRead.js`).
- **Principle 0.5** established: *Structural hygiene is its own release.*

### From v7.4.0 — "Im Jetzt"

- **RuntimeStatePort** + 8 service `getRuntimeSnapshot()` implementations
  (Settings, EmotionalState, NeedsSystem, Metabolism, AutonomousDaemon,
  IdleMind, GoalStack, PeerNetwork).
- **Identity-Leak-Fix** — removed LLM model name from `_identity()`
  block, added explicit "Du bist NICHT das zugrundeliegende Sprachmodell".
  55-test regression lock against 23 branded model names.
- **CI Sensitive-Scan Gate** — vendor-specific regex patterns (OpenAI,
  Anthropic, AWS, Bearer tokens) against full snapshot.
- **PromptBuilder runtimeState section** — compact text block between
  frontier and capabilities.

### From v7.4.1 — "Echte Antworten"

- **10 events nachkatalogisiert** — 9 v7.3.7-era memory/dream events
  (core-memory:released, memory:layer-transition-asked, etc.) + separate
  `reasoning:trace-recorded` fix. Coverage 415/415, 0 schema mismatches.
  New `JOURNAL` namespace.
- **Anti-Hallucination Quoting-Directive** in PromptBuilderRuntimeState —
  explicit instruction to quote values verbatim, forbidden shapes
  (log-lines, JSON, timestamps), anti-tool-call directive, three-case
  defensive empty-snapshot handling.
- **Anti-Escalation Hint** in `_formatting()` — "Kündige Tiefe nicht an".
- **IntentRouter Meta-State Patterns** — 13 alternations with new stage
  `conversational-meta-state` (confidence 0.9), DE and EN.
- **Snapshot Consistency regression lock** — ContextCollector and
  RuntimeStatePort must return equivalent values for emotional state.
- **Principle 0.7** established: *Genesis spricht aus dem was ist.*

### From v7.4.1 — **not documented in CHANGELOG** (Erratum)

- **SelfModel-Split** (4 files via Prototype-Delegation):
  - `SelfModel.js` (210 LOC) — core
  - `SelfModelParsing.js` (200 LOC) — `_scanDir`, `_scanDirAsync`, `_parseModule`
  - `SelfModelCapabilities.js` (140 LOC) — `_detectCapabilities`, helpers
  - `SelfModelSourceRead.js` (260 LOC) — `readModule`, `readSourceSync`, `describeModule`

  **Note:** CognitiveSelfModel.js (518 LOC) is NOT part of this split —
  it is an independent cognitive service since v5.9.8. The split
  happened but was omitted from the v7.4.1 CHANGELOG. The file-header of
  each split file documents "v7.4.1: Split into 4 files via prototype
  delegation." This entry serves as the after-the-fact erratum.

### From v7.4.2 — "Kassensturz" (this release)

- **AUDIT-BACKLOG drift closed** — five releases of missing entries
  caught up.
- **CHANGELOG erratum** — v7.4.1 SelfModel-Split now documented.
- **Stalled-Status Docs-Drift resolved** — `GoalStack.js:129` status
  comment extended with `stalled`. `_isTerminal()` has explicit header
  comment documenting the design decision (stalled/paused are
  active-with-warning, intentionally not terminal). Regression test locks
  this behavior.
- **CommandHandlers Domain-Split** — `CommandHandlers.js` 846 LOC →
  under 700 LOC via 6 domain mixins (Code, Shell, Goals, Memory, System,
  Network), Prototype-Delegation pattern (same as DreamCyclePhases,
  ChatOrchestratorSourceRead, SelfModel split). 23 methods preserved.
- **Principle 0.8** established: *AUDIT-BACKLOG is part of every release.*

---

## Resolved in v7.1.6 (Post-Release)

### R-1: shell:complete → shell:outcome Event Mismatch
- **Since:** v6.1.1 (CommandHandlers emitted `shell:outcome`, consumers listened on `shell:complete`)
- **Impact:** HIGH — TaskOutcomeTracker and TaskRecorder received zero shell data.
  CognitiveSelfModel Wilson-score calibration had no shell evidence.
- **Fixed:** TaskOutcomeTracker, TaskRecorder, CognitiveEvents, EventTypes, EventPayloadSchemas.

### R-2: prompt-evolution:promoted Never Emitted
- **Since:** v5.3.0 (PromptEvolution emitted `experiment-completed` but not `promoted`)
- **Impact:** HIGH — LessonsStore never captured promoted prompt variants as lessons.
- **Fixed:** PromptEvolution now emits `prompt-evolution:promoted` on successful promotion.

### R-3: EmotionalFrontier Double-Injection in Prompt
- **Since:** v7.1.5 (added in both `_frontierContext` and `_organismContext`)
- **Impact:** MEDIUM — Duplicate token usage per LLM call.
- **Fixed:** Removed from `_organismContext`. Canonical location: `_frontierContext`.

### R-4: KG Mutation Without Persistence in _tryMerge
- **Since:** v7.1.6 (FrontierWriter._tryMerge mutated KG nodes by reference without `_save()`)
- **Impact:** MEDIUM — Merged frontier nodes could be lost on crash before next unrelated save.
- **Fixed:** New `KnowledgeGraph.updateFrontierNode()` API with atomic mutation + save.

### R-5: McpTransport Reconnect Timer Leak
- **Since:** v5.2.0 (reconnect `setTimeout` not tracked, could fire after `disconnect()`)
- **Impact:** MEDIUM — Ghost reconnect attempt after intended disconnect.
- **Fixed:** `_reconnectTimer` tracked, cancelled in `disconnect()`.

### R-6: 21 Cross-Phase Required Late Bindings
- **Since:** various (promptBuilder, commandHandlers, idleMind)
- **Impact:** MEDIUM — Boot failure in P7/P8 could cascade to P2/P5/P6 services.
- **Fixed:** All 21 bindings changed to `optional: true`. All code paths already try-catch guarded.

### R-7: 2 Dangling Late Binding Names
- **Since:** unknown (shellAgent → `verificationEngine`, dynamicToolSynthesis → `toolRegistry`)
- **Impact:** LOW — Properties stayed `undefined`, features silently unavailable.
- **Fixed:** Corrected to `verifier` and `tools` respectively.

---

## Open Items

### O-1: Benchmark Re-Run with InferenceEngine Live
- **Since:** v7.1.1
- **Status:** DONE (v7.2.3)
- **Detail:** Full A/B re-run on Daniel's machine with kimi-k2.5:cloud.
  Result: 83% vs 67% = +16pp with Organism active. Baseline timeouts (ETIMEDOUT)
  on CPU-only inflated delta slightly. Organism helped on an-1 (code smells) and
  rf-2 (strategy pattern extraction). Results in BENCHMARKING.md.

### O-2: GateStats Sample-Count über Sessions
- **Since:** v7.0.0
- **Status:** OPEN — reformulated in v7.4.4 (in-memory finding)
- **Detail:** Original entry tracked "passive collection" toward 50+ samples
  for AwarenessPort statistical significance. The v7.4.4 verification of
  the related O-9 item revealed that `src/agent/cognitive/GateStats.js`
  has **no persistence** — counters live in an in-memory `Map`, no
  `_save()`/`_load()`, no `gate-stats.json` file. Every Genesis restart
  resets the counters. The previously-reported "3/50 samples since v7.0.0"
  was a single-session Dashboard observation, not a cumulative total.
- **Consequence:** The "50+ samples" target is unreachable across sessions
  with the current design. With current architecture, statistical
  significance for AwarenessPort gating requires either:
  (a) a very long uninterrupted Genesis runtime, or
  (b) adding persistence to GateStats (`_save()`/`_load()` analogous to
  `EmotionalState`, `GoalStack`, `KnowledgeGraph`).
- **Action:** Decide which view is intended. Per-session telemetry
  ("does the gate block sensibly *in this session*?") is a valid design
  and may not need cross-session aggregation. If cross-session
  measurement is wanted, the persistence design is a small, contained
  follow-up release — not a passive-collection task.
- **v7.4.4 note:** No code change in this release. This item is preserved
  as an architectural question for a future release.

### O-3: 31 Legacy Test Files Use Inline Runner
- **Since:** v3.5.2
- **Status:** ACCEPTED (migration attempted, deferred)
- **Detail:** 31 test files use the `let passed = 0` inline runner pattern instead of the
  shared harness. All execute correctly and are counted by test/index.js.
- **Migration analysis (v7.1.3):** Automated migration was attempted but reverted — the legacy
  files use `await test(...)` inside `async` IIFE/function wrappers. The harness uses a
  queue+run model incompatible with top-level `await` in CJS. Each file would need individual
  manual restructuring (~6500 total LOC across 31 files).
- **Risk:** None. test/index.js detects and executes both patterns correctly. The test count
  (4200) is accurate. Tests pass on both Ubuntu and Windows CI.
- **Action:** Migrate opportunistically when files are touched for other reasons.

### O-4: Coverage Plateau (4 modules)
- **Since:** v7.1.3
- **Status:** ACCEPTED
- **Detail:** Four modules have <35% function coverage and require integration-level testing
  that can't be achieved with unit tests:
  - `McpTransport.js` (0% fn) — requires SSE connection lifecycle
  - `McpCodeExec.js` (20% fn) — requires worker_threads RPC bridge
  - `PeerNetwork.js` (33% fn) — requires UDP/HTTP server + multicast
  - `AgentCore.js` (35% fn) — requires full 12-phase boot
- **Action:** These are integration test targets, not unit test targets.

### O-5: package-lock.json Not Committed
- **Since:** v7.0.8 (D-1)
- **Status:** ACCEPTED (developer workflow)
- **Detail:** `npm install` generates package-lock.json on Garrus's machine.
  Committed at his discretion with `git add -A`.

### O-6: Branch Coverage Threshold Temporarily Lowered
- **Since:** v7.2.0
- **Status:** RESOLVED in v7.4.4 (organic close)
- **Detail:** v7.2.0 introduced new fallback branches in `_identity()`,
  `_handleSelfReflect()` (now `reflect()`), and `_scoreResearchInsight()`
  that lowered branch coverage from 76.1% to 75.91%. Threshold was
  temporarily reduced to 75.9%.
- **Resolution:** The 76% target was reached organically through
  unrelated coverage pushes across v7.3.4 (`o6-coverage-push`),
  v7.3.6 (`v736-coverage-push`), v7.4.0 (Identity-Leak-Tests, Service
  Snapshots), v7.4.1 (Intent-Meta-Patterns, Snapshot Consistency) and
  v7.4.2 (GoalStack Stalled, Circuit Timeout). Full v7.4.3 measurement
  on Windows: aggregate branch coverage **77.17%** (+1.26pp over the
  v7.2.0 trough, +1.07pp over the pre-v7.2.0 baseline).
- **Action in v7.4.4:** `package.json` `test:ci` and
  `test:coverage:enforce` floors raised from `--branches 75.9` to
  `--branches 76` (1.17pp safety margin remains).
- **Honest note:** The originally-named v7.2.0 fallback branches in
  `_identity()` are covered by `o6-coverage-push.test.js` (v7.3.4); the
  outer `reflect()` happy/error paths by `selfmodpipeline.test.js`. File-
  level branch-coverage gaps in `PromptBuilderSections.js` (62.74% in the
  v7.4.3 measurement) concern *other* methods (`_taskPerformanceContext`,
  `_disclosureContext`, `_introspectionContext`, `_versionContext`) —
  unrelated to O-6 and bundled with O-12 (BeliefStore reorg in v7.6+).

### O-7: Baustein D Fall 2 — "ich kann das nachprüfen"
- **Since:** v7.4.1 (Baustein D diagnostic phase only)
- **Status:** DEFERRED in v7.4.4 — pending fresh reproduction
- **Detail:** The v7.4.1 Windows test session observed Genesis asking for
  a memory ID in response to "ich kann das nachprüfen". Three scenarios:
  A) LocalClassifier drift, B) LLM tool-call hallucination, C) neither.
- **Resolution attempt:** `node scripts/diagnose-v741-d0.js` executed on
  Windows during v7.4.4 preparation. Result: **Szenario C** — no
  LocalClassifier samples file (`.genesis/local-classifier-samples.json`
  does not exist; the classifier has never learned anything from this
  install), and none of the relevant events
  (`intent:classified`, `tool:called`, `llm:fallback`,
  `intent:cascade-decision`) found in the event log.
- **Diagnose-Skript-Empfehlung wörtlich:** *"D.1 erst planen nachdem
  der Bug erneut auftritt und frisch ins Log geschrieben wird."*
  Possible reasons for the empty result: paraphrased quote in the
  original report, or log not filled since the bug occurred.
- **Action:** None. Item registered without active task. Re-activate
  the moment the symptom occurs again with a fresh log entry; route
  to D.1 if it then maps to scenario A.

### O-8: Files over 700-LOC warn threshold
- **Since:** v7.4.2 (CommandHandlers split addressed the largest; four remained)
- **Status:** REDUCED in v7.4.3 (4 → 2 files); REGRESSED in v7.4.5 (2 → 5 files); deferred
- **Detail:** v7.4.3 Bausteine B/C/D resolved three of the four original files:
  - `Container.js` — 771 → 581 LOC (Baustein B: ContainerDiagnostics extract)
  - `IntentRouter.js` — 713 → 450 LOC (Baustein C: IntentPatterns data extract)
  - `SelfModificationPipeline.js` — 704 → 453 LOC (Baustein D: Modify family extract)

  v7.4.5 goal-pipeline work grew three files over the threshold:
  - `GoalDriver.js` — 829 LOC (NEW; rate-limit pause logic, idempotency-guard, lock-cleanup, completeGoal call, blocked-branch handling, budget-reset listener — fixes #16–#22)
  - `AgentLoop.js` — 813 LOC (NEW; `_emitFailure` helper, completeGoal wiring, blocked-branch path — fixes #14, #22, #23)
  - `GoalStack.js` — 769 LOC (NEW; new `completeGoal()` method with cascading effects — unblockDependents, parent-completion check, `goal:completed` event)

  Still over threshold (carry-over):
  - `PromptBuilderSections.js` — 769 LOC — see O-12 (deferred to v7.6+ on purpose)
  - `EpisodicMemory.js` — 758 LOC (no driving feature need; left until natural touch)
- **Action:** All five deferred. Three new candidates for a future "Aufräumen III" release.
  Per Principle 0.5: feature stability first, structural cleanup follows. The natural
  moment is once v7.4.5 has run live for a while and the new code paths are stable.
  Splits will likely follow Prototype-Delegation pattern (same as v7.4.3 Bausteine B/C/D).
- **Honest note:** Fitness score remained 127/130 across the regression because the
  File-Size-Guard is binary (any warn → 7/10). The score didn't move from 2 warnings to
  5 — but that means the metric stops capturing this regression. The honest record
  lives here in O-8.

### O-9: GateStats data collection status unverified
- **Since:** v7.4.2 (carry-over check item)
- **Status:** CLOSED in v7.4.4 (correctness fix)
- **Detail:** Original action — *"`cat .genesis/gate-stats.json` on the
  Windows instance, update O-2 status"* — was based on a wrong assumption.
- **Resolution:** The file does not exist by design. `src/agent/cognitive/
  GateStats.js` has **no persistence layer**: counters are held in an
  in-memory `Map`, the class has no `_save()` / `_load()` methods, and no
  `fs` calls at all. Verification at runtime happens via the IPC endpoint
  `agent:get-gate-stats` (`main.js:787` → `pipeline.getGateStats()`),
  which the Dashboard consumes (`src/ui/dashboard.js:111`).
- **Verification:** On Windows (v7.4.4 prep): `type .genesis\gate-stats.json`
  → "Das System kann die angegebene Datei nicht finden." Confirms the
  file is not present. This is the correct state, not a regression.
- **Consequence:** Forwarded to **O-2** which is reformulated in v7.4.4
  to acknowledge that cross-session aggregation is not supported by the
  current design.

### O-10: docs/ five releases of version drift
- **Since:** v7.3.7 (docs not updated alongside v7.3.7, v7.3.8, v7.3.9, v7.4.0, v7.4.1)
- **Status:** RESOLVED in v7.4.3 (docs-hygiene pass)
- **Detail:** Originally: most files in `docs/` carried a `v7.3.6` version
  header and referenced outdated counts (5036 tests, 156 services, 391 events,
  etc.). Affected: ARCHITECTURE-DEEP-DIVE.md, CAPABILITIES.md, COMMUNICATION.md,
  EVENT-FLOW.md, MCP-SERVER-SETUP.md.
- **Resolution:** Dedicated docs-hygiene pass within v7.4.3. All docs/ files
  now reference v7.4.3 or are correctly version-bound historical (BUG-TAXONOMY,
  ONTOGENESIS, TROUBLESHOOTING, BENCHMARKING, phase9-cognitive-architecture).
  DEGRADATION-MATRIX.md regenerated from script (Services 143→151, Bindings
  532→569). Event counts corrected throughout (415→405, the actual catalog
  count per `audit-events.js`); test counts brought current (5036→5556 in
  ARCHITECTURE.md, 5510→5556 in README.md). README and ARCHITECTURE.md
  internal inconsistencies (414 badge / 415 inline / 404 schemas) collapsed
  to single source of truth (405/405). Historical version references kept
  as-is (Principle: a doc that says "fixed in v7.1.3" is documenting
  history, not drifting).

### O-11: Circuit-Breaker uses one global timeout for all backends
- **Since:** v4.x (latent) / v7.4.2 (explicitly documented)
- **Status:** RESOLVED in v7.4.3 Baustein A
- **Detail:** v7.4.2 Baustein E synchronized `CIRCUIT.TIMEOUT_MS` to 180s
  as a workaround. v7.4.3 fixed the root cause: the LLM circuit was
  running a duplicate `Promise.race` over a function whose own HTTP
  timeout did the same job.
- **Resolution:** Renamed `CircuitBreaker.timeoutMs` → `failFastMs` with
  `null|0` opt-out semantics. LLM circuit configured with `failFastMs: null`
  (HTTP layer is the single ceiling). MCP keeps `failFastMs: 15000` because
  there it is real fail-fast (15s CB window, 30s HTTP timeout).
  `timeoutMs` retained as deprecation alias. New invariant test
  `v743-fail-fast-semantics.test.js` pins the new semantics including a
  source-parse check that the LLM circuit stays opted out. Effectively
  equivalent to the recommended Option B from the original entry, with
  the wrapper preserved for callers (MCP) that need real fail-fast.

### O-12: PromptBuilderSections re-org bundled with BeliefStore
- **Since:** v7.4.3 (deliberate deferral)
- **Status:** OPEN by design
- **Detail:** `PromptBuilderSections.js` is 769 LOC. v7.4.3 considered
  splitting Organism context (~130 LOC) as a fourth Baustein but chose
  to leave it. Reason: BeliefStore in v7.6+ will inject a new
  "Vermutungen / Überzeugungen / Anker" section into the prompt.
  Splitting now would force a second invasive edit on the same file
  in v7.6.
- **Action:** Re-organise PromptBuilderSections in the BeliefStore release
  with a clear taxonomy: Identity / Organism / Context / Beliefs as
  distinct modules. One coherent change instead of two adjacent ones.

---

## Resolved Items

### Monitor Items (from CHANGELOG v7.0.5–v7.0.6)

| ID | Finding | Resolution | Version |
|----|---------|-----------|---------|
| M-5 | 47 TS errors remaining | **0 errors.** All 62 @ts-ignore eliminated (23 prototype-delegated + 39 TS inference). | v7.1.2 |
| M-6 | 14 unused exports (barrel re-exports) | **Moot.** `src/agent/index.js` barrel deleted in v7.0.1. | v7.0.1 |
| M-7 | 2 legacy test files (autonomy.test.js, hardening.test.js) | **Deleted.** Both redundant, all coverage in dedicated files. | v7.0.6 |
| M-8 | Organism A/B evidence from v5.9.9 only (8 tasks, 1 model) | **Confirmed.** v6.0.4: +33pp, v7.2.3: +16pp (both kimi-k2.5:cloud, 12 tasks). | v7.2.3 |
| M-9 | Electron ^39.0.0 not exact-pinned | **Accepted.** Dev dependency, caret is acceptable risk. | — |
| M-10 | 111 magic numbers across source | **Partially addressed.** THRESHOLDS section in Constants.js covers behavioral constants. Remaining are ring buffer caps and percentage thresholds — structural, not behavioral. | v7.0.0 |
| M-12 | 85 @ts-ignore remaining | **0 remaining.** Eliminated in two sessions (v7.1.1 + v7.1.2). | v7.1.2 |

### Security Audit Items (from v6.0.3)

| ID | Finding | Resolution | Version |
|----|---------|-----------|---------|
| SA-P3 | ArchitectureReflection audit | Clean. Pure read-only graph observer. 12 tests. | v6.0.3 |
| SA-P4 | EmbodiedPerception listener leak | Fixed: `_unsubs[]` + tracked subscription + `stop()` cleanup. 15 tests. | v6.0.3 |
| SA-P8 | DynamicToolSynthesis audit | Clean. Good safety pipeline. Existing tests adequate. | v6.0.3 |
| H-1 | IPC `agent:import-data` no validation | Fixed: `_validateStr` + path scope restriction. | v6.0.3 |
| H-2 | IPC `agent:get-replay-diff` no validation | Fixed: `_validateStr` with 200-char max. | v6.0.3 |
| H-3 | IPC `agent:clone` no structural validation | Fixed: `typeof === 'object'`, not array. | v6.0.3 |
| M-1 | IPC `agent:mcp-*` no string validation | Fixed: type checks added. | v6.0.3 |
| M-5 | `executeExternal()` no namespace isolation | Fixed: `_linuxWrap()` applied. | v6.0.3 |
| M-6 | Sandbox FS: `fs.cp` unguarded | Fixed: `cp`, `cpSync`, `appendFile*` blocked. | v6.0.3 |
| M-7 | Sandbox VM `safeCopy()` prototype shared | Fixed: `null`-prototype object. | v6.0.3 |
| L-4 | ShellAgent Unicode bypass | Fixed: NFKC normalization before blocklist. | v6.0.3 |

### V7 Roadmap Items

| ID | Item | Resolution | Version |
|----|------|-----------|---------|
| V7-1 | Colony IPC | ✅ `SelfSpawner.spawnParallel()` with real `fork()` + IPC. | v7.0.0 |
| V7-2 | Consciousness → AwarenessPort | ✅ 14 modules removed, AwarenessPort + NullAwareness. | v7.0.0 |
| V7-3 | Coverage 81/76/80 | ✅ Ratchet reached, then recalibrated to 80/76/78 after test consolidation. | v7.0.1 |
| V7-4A | Daemon Control (Unix Socket/Named Pipe) | ✅ DaemonController with 8 RPC methods. | v7.0.1 |
| V7-4B | AutoUpdater → DeploymentManager bridge | ✅ Real SnapshotManager rollback, not placeholder. | v7.1.3 |
| V7-4C | A+B combined, end-to-end tested | ✅ `ctl update --apply` triggers full chain. | v7.1.1 |
| V7-5 | God class evaluation (no split needed) | ✅ Evaluated, fitness 10/10. | v7.0.0 |
| V7-6 | NullAwareness default | ✅ Lightweight no-op for Phase 1. | v7.0.0 |

### File Size Guard Resolutions (v7.1.3)

| File | Before | After | Method |
|------|--------|-------|--------|
| AgentLoop.js | 857 | 699 | 4 methods → delegates (Recovery, Cognition) |
| SelfModificationPipeline.js | 764 | 699 | JSDoc + section compaction |
| VerificationEngine.js | 704 | 687 | Header compaction |

---

## Audit History

| Version | Scope | Findings | Resolved |
|---------|-------|----------|----------|
| v7.1.3 | Docs audit, File Size Guard, V7-4B, Coverage push | 5 INFO | 5/5 |
| v7.1.2 | @ts-ignore elimination, composition splits, type layer | 0 | — |
| v7.1.1 | InferenceEngine hot-path, benchmark timeout, V7-4B bridge | 0 | — |
| v7.0.8 | lockCritical expansion, security tests, setInterval audit | 7 | 7/7 |
| v7.0.6 | @ts-ignore 336→85, dead events, legacy tests | 3 M-items | 3/3 |
| v7.0.5 | Event schema 100%, test consolidation | 5 M-items | 3/5 |
| v7.0.4 | DisclosurePolicy, identity hardening | 6 F-items | 6/6 |
| v7.0.2 | Fail-honest rollback, event schema fixes | 6 schemas | 6/6 |
| v6.0.3 | IPC validation, sandbox FS, ShellAgent Unicode | 11 items | 11/11 |
| v5.1.0 | Shutdown integrity, DI inversion, security hardening | 19 services | 19/19 |
| v5.0.0 | Organism architecture, shutdown data loss | 14 items | 14/14 |
| v4.12.7 | Full codebase audit (16 findings) | 16 items | 16/16 |
| v4.12.4 | Security audit (Dashboard XSS, SSRF, API masking) | 5 items | 5/5 |
