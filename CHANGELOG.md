## [7.9.0]

**Bug-Fix-Konsolidierung aus dem v7.8.9 Real-Run-Log (qwen3-vl:235b-cloud, 9h+ Test-Run).**

v7.9.0 adressiert die drei Bugs, die im v7.8.9-Real-Run-Log gefunden wurden, sowie eine kleine Regex-Robustheits-Verbesserung in der Template-Erkennung. **v7.8.9-Verhalten für Cloud-Modell-Skill-Build bleibt erhalten** (status='unknown' für unrecognized templates → pseudo-continuation pfad). Kein Family-Fallback eingeführt, da dieser zwischen v7.8.9 und v7.9.0-Iterationen für Cloud-Skill-Build-Regress verantwortlich war.

### Bugs gefixt

- **`.genesis/llm-capabilities.json` wurde nie geschrieben** — `ModelBridge` constructor las `genesisDir` aber speicherte es nicht als instance field. Der ContinuationMixin las `this._genesisDir` was immer `undefined` war → `_capabilityFilePath()` returnte null → `_persist()` war no-op. Fix: `this._genesisDir = genesisDir || null` im constructor. Capability-Cache persistiert jetzt zwischen Boots, was bei wiederholten Boots die ~30s teure Verification-Probe für lokale Modelle einspart.
- **`LLM_STREAM_FIRST_CHUNK` von 120s auf 180s erhöht** — qwen3-vl:235b-cloud unter Last beobachtet bei 120-150s für ersten Chunk. 180s ist konservativer ohne real-hangs zu maskieren. Override per `settings.json` `llm.streamTimeouts.firstChunk` möglich.
- **`EmbeddingService` GPU/CPU-Fallback** — Auf 8GB-VRAM-Systemen kollidiert `nomic-embed-text` mit geladenem Chat-Modell (Ollama returnt HTTP 500 "model failed to load, resource limitations"). Fix: bei einem solchen Fehler einmaliger Retry mit `options.num_gpu: 0`. CPU-only ist bei nomic-embed-text 200-500ms statt 50ms — akzeptabel. Andere Fehler (404 etc.) triggern keinen Retry.

### Robustheits-Verbesserung

- **Template-Klassifikation tolerant gegen Klammern + Newlines** — Der v7.8.9-Regex `range[^.{}]*\.Messages` matched bei real-world Qwen3-Templates nicht zuverlässig (Klammern in nested `{{...}}` zwischen `range` und `.Messages`). Tolerant version: `range[\s\S]{0,100}?\.Messages`. Erkennt jetzt mehr Templates korrekt als 'messages-loop'. Bei unrecognized templates: weiterhin `status='unknown'` (= v7.8.9-Verhalten), kein Family-Fallback und kein Verification-Probe — dieser Pfad hatte einen Cloud-Skill-Build-Regress in v7.9.0-Iterations verursacht.

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

## Older releases

For prior version history, see the archive files:

- [**CHANGELOG-v7.md**](CHANGELOG-v7.md) — all v7.x.x releases (81 entries)
- [**docs/CHANGELOG-v6.md**](docs/CHANGELOG-v6.md) — all v6.x.x releases (12 entries)
- [**docs/CHANGELOG-v5.md**](docs/CHANGELOG-v5.md) — all v5.x.x releases (17 entries)
- [**docs/CHANGELOG-archive.md**](docs/CHANGELOG-archive.md) — v0.x.x – v4.x.x (29 entries)

This index file (`CHANGELOG.md`) keeps only the newest release inline so
the file stays readable. The major-version archives carry the full
history.
