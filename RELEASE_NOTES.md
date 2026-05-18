# Genesis Agent v7.9.1 — **Live-fix pass from the v7.9.0 real-run log.**

**Live-fix pass from the v7.9.0 real-run log.**

Six focused fixes informed by a real run on AUTONOMOUS trust level. The user observed an approval prompt that auto-rejected after 60s, the same rejected goal being re-picked roughly 25 times in 30 minutes, synthetic loop_early failure ids polluting the burst counter, and an Insights Timeline that only showed the latest five activities with no per-type breakdown. Documentation drift across README, ARCHITECTURE-DEEP-DIVE, and CAPABILITIES is reconciled in the same pass, and the v7.9.0 CHANGELOG entry is fully Englished.

### Live-run fixes

- **TrustLevelSystem — `'continue'` classified as medium** — the AgentLoop step-limit prompt (`ApprovalGate.request('continue', …)` after a goal reaches `maxStepsPerGoal`) previously fell back to `'high'` via `_getActionRisk` and triggered manual approval even at AUTONOMOUS. Now classified as `'medium'` so AUTONOMOUS auto-approves the benign "keep going" decision. `'plan-has-issues'` stays in the `'blocking'` tier deliberately — a structurally broken plan must always pause for conscious user decision regardless of trust level (v7.7.8 safety contract).
- **ApprovalGate timeout 60s → 5 min** — `DEFAULT_TIMEOUT_MS` raised from 60_000 to 300_000. The live run showed the user looking away briefly and the gate auto-rejecting before they could click. Five minutes gives a real human window. Override via `settings.json` key `approval.timeoutMs` or constructor option.
- **GoalDriverFailurePolicy — `loop_early_<ts>` filter** — `AgentLoopPursuit` emits synthetic goal-ids of the form `loop_early_<ts>` when a plan fails before `currentGoalId` is set (dry-run validation failure, plan-generation rejection). These have no GoalStack entry, so the previous code logged a misleading "stalled" warning and burned a burst-counter slot. `_applyFailurePause` now short-circuits at the top for any id starting with `loop_early_`.
- **GoalDriver — 24h rejected-cooldown** — after `setStatus('stalled')` on a user-rejected goal, the same goal was re-picked roughly 25 times over 30 minutes by the next scan-tick, likely a race between async status update and `_scanAndMaybePursue` plus IdleMind re-arming. Belt-and-suspenders: a new `_goalRejectedCooldown` Map holds the goalId for 24h. `_listPursueable()` filters cooldown-active goals with lazy cleanup of expired entries, matching the existing `_goalPausedUntil` pattern.
- **IdleMind — per-activity-type counts** — `IdleMind` now maintains a `_activityCounts` Map alongside the chronological `activityLog`. The recording helper `_recordActivity` lives in the new `IdleMindActivityStats.js` mixin (Object.assign on prototype, keeps IdleMind.js at 700 LOC under the soft-guard). `getStatus()` exposes the counts as `activityCounts`. The dashboard's Insights Timeline renders a top-5 sorted breakdown line ("ideate 24, explore 13, plan 7, …") above the chronological entries — see `IntelRenderers._renderInsightsTimeline` and the new `.dash-insights-breakdown` / `.dash-insight-count` CSS classes.

### Doc-drift reconciliation

- **README.md** — module count, source-table total, LOC, DI services, test suites, test count, event-type catalogue size all updated to current values (372 src modules, 116k LOC, 164 manifest + 13 bootstrap = 177 runtime services, 479 test files, 7794 tests, 476 events). The "Total 237 / ~80,000 LOC" agent-source summary becomes "339 / ~116k".
- **ARCHITECTURE-DEEP-DIVE.md** — Key Numbers Source Modules 371 → 372, Test Files / Tests 478/7601 → 479/7794, services line 155/168 → 164/177, event-type catalogue 452 → 476, src/ total summary 371/108k → 372/116k.
- **CAPABILITIES.md** — test-files row 478/7601 → 479/7794, header test counts 7601/7600 → 7794/7793.
- **CHANGELOG.md + CHANGELOG-v7.md** — v7.9.0 entry fully translated to English (Bug-Fix-Konsolidierung → Bug-fix consolidation, Bugs gefixt → Bugs fixed, Robustheits-Verbesserung → Robustness improvement, plus all body text). The Skill Forge and Können-Konzept sections were already English.
- **QUICK-START.md** — `/skills-pending` description rewritten to describe what the command does rather than what it does not yet do.
- **scripts/audit-doc-drift.js** — `TESTS_WIN_BASELINE` and `TESTS_WIN` baselines bumped from 7601 to 7794 to match the new test count.

### Numbers

7794 tests pass (Win baseline), 7793 (Linux). 130/130 fitness. 12 new contract tests under `v791 contract:` prefix (`test/modules/v791-livefixes.contract.test.js`) covering all five code fixes. New file `src/agent/autonomy/IdleMindActivityStats.js` (51 LOC). Test files 478 → 479.

---



### Bugs fixed

- **`.genesis/llm-capabilities.json` was never written** — the `ModelBridge` constructor read `genesisDir` but did not store it as an instance field. The `ContinuationMixin` then read `this._genesisDir` which was always `undefined` → `_capabilityFilePath()` returned null → `_persist()` was a no-op. Fix: `this._genesisDir = genesisDir || null` in the constructor. The capability cache now persists across boots, saving the ~30s verification probe for local models on every subsequent boot.
- **`LLM_STREAM_FIRST_CHUNK` raised from 120s to 180s** — qwen3-vl:235b-cloud under load was observed at 120-150s for the first chunk. 180s is more forgiving without masking real hangs. Override via `settings.json` key `llm.streamTimeouts.firstChunk`.
- **`EmbeddingService` GPU/CPU fallback** — on 8GB-VRAM systems `nomic-embed-text` collides with the loaded chat model (Ollama returns HTTP 500 "model failed to load, resource limitations"). Fix: on that specific error, retry once with `options.num_gpu: 0`. CPU-only runs nomic-embed-text at 200-500ms instead of 50ms — acceptable. Other errors (404 etc.) do not trigger the retry.

### Robustness improvement

- **Template classification tolerant of brackets and newlines** — the v7.8.9 regex `range[^.{}]*\.Messages` did not match reliably on real-world Qwen3 templates (brackets in nested `{{...}}` between `range` and `.Messages`). Tolerant version: `range[\s\S]{0,100}?\.Messages`. More templates now classify correctly as `messages-loop`. For still-unrecognized templates the path stays at `status='unknown'` (v7.8.9 behaviour) — no family-fallback and no verification probe, because that path caused a cloud-skill-build regression in v7.9.0 iterations.

### Skill Forge — Iteration loop + format tolerance + skill awareness

Final pass to make skill creation work with any configured model — no auto-routing, no silent model substitution. Robustness comes from a feedback loop, not from picking a better model behind the user's back.

- **`SkillManager.createSkill` iteration loop** — Voyager-pattern up to 3 attempts. On parser failure, code-safety block, or sandbox-test failure the concrete error plus the failing code are fed back into the next prompt. The configured model stays configured throughout. After max attempts an honest failure message is returned. Emits `skill:forge-attempt`/`-succeeded`/`-failed` lifecycle events.
- **`SkillCrystallizer._crystallizeOne` iteration loop** — same feedback pattern wired into DreamCycle Phase 3c so Phase 2 Können crystallization gains the same robustness. Settings key `cognitive.koennen.crystallization.maxAttempts` (default 3).
- **`PromptEngine` create-skill template — attempt-aware** — on attempt ≥2 the prompt surfaces the previous error and previous code with "Fix the specific error above; keep the working parts of the previous code intact" — the LLM sees its own broken output and the concrete reason it failed.
- **`SkillManager.executeSkill` format tolerance** — accepts class with `execute()`, `module.exports = async function`, `module.exports = (input) => ({...})`, and `module.exports = { execute }`. No more "is not a constructor" crashes when the LLM returns a plain function.
- **`/run-skill <name> {json}`** — slash form accepts optional JSON-object argument so skills that need input become callable from the command line.
- **`PromptBuilderSectionsExtra._skillsContext`** — new section surfaces installed skills (name + description, capped at 30) into the system prompt so Genesis is aware of his own toolset.
- **3 new events** — `skill:forge-attempt`, `skill:forge-succeeded`, `skill:forge-failed` (catalogue 473 → 476).
- **21 new contract tests** under `koennen-forge-v790 contract:` prefix (minCount 12 in stale-refs.json).

### Können-Konzept — Phase 2 (Skill Crystallization)

Phase 2 of the three-phase Können-Konzept (Phase 1 was v7.8.9 affect-encoding; Phase 3 is v7.9.1 habitat-promotion). Genesis can now extract reusable JavaScript skills from recurring gate-passed task patterns observed at AgentLoop boundaries. Extracted skills are persisted to `.genesis/koennen/skills-pending/` for inspection but are NOT yet active in the SkillManager repertoire — promotion is Phase 3.

**New components:**
- `SkillCrystallizer` (492 LOC) — runs as DreamCycle Phase 3c at intensity ≥ 0.5. Reads gate-passed records from `KoennenCandidateLog.getCandidatesSince(now − windowMs)`, clusters by embedding similarity (threshold 0.75, fallback token-overlap ≥ 2), requires ≥ 3 candidates per pattern, asks the LLM to extract a manifest + JavaScript module, validates the output through CodeSafetyScanner and a sandbox-init probe, then writes passing skills to `.genesis/koennen/skills-pending/<name>/` with embedded provenance (`crystallizedAt`, `sourceCandidateIds`, `patternSignature`). Per-pattern cooldown (6h default) lives in `.genesis/koennen/crystallization-cooldown.json`.
- `SkillEffectivenessTracker` (231 LOC) — tracks per-skill Wilson lower bound using `wilsonLower(successes, total)` imported from CognitiveSelfModel (single source of truth). Public API: `recordInvocation`, `getWilsonLB`, `getStats`, `getAll`, `applyDecay`, `forget`. Persists to `.genesis/koennen/skill-effectiveness.json`. No bus listeners yet — Phase 3 HabitatOutpost will call `recordInvocation()` directly during rehearsals.

**Wiring:**
- `DreamCycle.dream()` calls `skillCrystallizer.run()` as Phase 3c, after value-crystallization, with full try/catch isolation.
- `SelfNarrative` adds `+3` to its change-accumulator on `skill-crystallized` (stronger than v7.8.9's `+2` on `koennen:candidates-noticed`).
- New slash command `/skills-pending` lists extracted skills with description, crystallization date, and Wilson-LB if the tracker is wired.

**Settings (`cognitive.koennen.*`):** master toggle `enabled`; `crystallization.{enabled, minCandidatesPerPattern=3, windowMs=7d, cooldownMs=6h, llm.{enabled, maxTokens=2000, timeoutMs=120s}, sandbox.initTestTimeoutMs=10s}`; `effectiveness.{initialEvidence=1, decayPerWeek=0.05}`. Two toggle-event keys registered (`cognitive.koennen.enabled`, `cognitive.koennen.crystallization.enabled`) so runtime toggling fires the right events.

**Events (3 new, catalogued + payload-schema'd):** `skill-crystallized`, `dream:skills-crystallized`, `skill:quarantined`.

**Tests:** 28 new contract tests under `koennen-crystallizer-v790 contract:` (Tracker 10 + Crystallizer 12 + Narrative+Slash 6). The v7.8.9 KoennenCandidateLog regression suite stays green at 13/13.

### Setup

No new setup steps over v7.8.9. The capability cache at `.genesis/llm-capabilities.json` is now actually populated.

### Numbers

7700+ tests pass (Win baseline), 7699+ (Linux). 130/130 fitness. 4 Code-Änderungen, keine neuen Tests notwendig (existierende v789-llm-* contract tests decken die geänderten Pfade ab).

---

---

**Full Changelog**: See [CHANGELOG.md](https://github.com/Garrus800-stack/genesis-agent/blob/main/CHANGELOG.md)

**Installation**:
```bash
git clone https://github.com/Garrus800-stack/genesis-agent.git
cd genesis-agent
npm install
npm start        # Electron desktop
node cli.js      # Headless CLI
```
