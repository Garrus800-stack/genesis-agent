# Genesis Agent v7.9.10 — Seven small, scoped corrections plus a broad documentation pass. The release closes the lessons-pipeline write-path silence exposed by the v7.9.9 field-test, lifts the continuation cap for cloud-no-prefill models so long-form outputs stop getting truncated at six rounds, completes the French and Spanish translation tables so non-English users see consistent UI instead of mid-sentence English fallbacks, fixes the settings-modal duplicate-hint bug that the new translations made visible, makes `LLMCapabilityDetector` honor `GENESIS_OFFLINE_TESTS` to stop the test runner from waiting 15 seconds per `bridge.chat()` against a missing local Ollama, raises the metabolism cost-warning threshold so qwen3-vl:cloud and similar models stop triggering the WARNUNG badge on every routine code call, and brings nine documentation files in line with what the code has actually been doing since v7.9.7.

Seven small, scoped corrections plus a broad documentation pass. The release closes the lessons-pipeline write-path silence exposed by the v7.9.9 field-test, lifts the continuation cap for cloud-no-prefill models so long-form outputs stop getting truncated at six rounds, completes the French and Spanish translation tables so non-English users see consistent UI instead of mid-sentence English fallbacks, fixes the settings-modal duplicate-hint bug that the new translations made visible, makes `LLMCapabilityDetector` honor `GENESIS_OFFLINE_TESTS` to stop the test runner from waiting 15 seconds per `bridge.chat()` against a missing local Ollama, raises the metabolism cost-warning threshold so qwen3-vl:cloud and similar models stop triggering the WARNUNG badge on every routine code call, and brings nine documentation files in line with what the code has actually been doing since v7.9.7.

### Lessons-pipeline write-path

The lessons feedback loop only becomes fully functional in this release. v7.7.9 (post-Phase-3c) fixed three silent bugs — wrong method name (`add()` instead of `record()`), wrong payload schema, wrong category name on the read side — but a fourth bug remained. The `stableClass` gate in `recordReflection` accepted only the four classified buckets (structural, execution, external, user-action) and dropped anything bucketed as `'unclassified'`. The Win field-trace on 2026-05-24 made the consequence visible: after six hours and four goals (one of which retried after a PARTIAL fail-then-success), the lessons folder was empty. Every plan-failure-reflection had been written with an LLM-generated verdict message like `"PARTIAL, because although 2 steps were completed, the critical step failed..."` — perfectly real failure signal, but matching no technical regex bucket in `failure-patterns.js`, so all of them silently dropped.

v7.9.10 widens the gate: `'unclassified'` is now accepted whenever `errorMessage` is non-empty. The classification stays preserved in the lesson tags so downstream readers know the signal is weak per individual lesson but still useful as a pattern. `'user-action'` stays excluded — when the user cancels, that is not a Genesis failure to learn from.

A second silent gap lived in `LessonsStore._save()`: it ran only every 5th `record()` call. The first four lessons of a fresh install never reached disk until a fifth came along. After a typical thirty-minute idle run that produced one or two failures, the lessons folder stayed empty regardless. The save is cheap (JSON write of an in-memory array under 5 MB), so the buffer offered no benefit and obscured every short-session use case. v7.9.10 saves on every record.

Four new tests in `v779-lessons-pipeline-fixes.test.js` lock the new behaviour: PARTIAL verdict records, FAILED verdict records, unclassified-with-empty-message still drops (no signal worth keeping), user-action still drops (not a Genesis failure). The pre-existing G3 contract test in `v797-foundation-pass` is updated to assert that `stableClass` is still the gate name and still excludes `'user-action'`, without pinning the exact `!== 'unclassified'` shape that the widening changed.

### Cloud-no-prefill continuation cap

The v7.9.9 field-test also surfaced a 37591-character qwen3-vl:cloud output truncated at attempt 6 with `[CONTINUATION] sequence ... failed: max-continuations`. The cap was right for local prefill-capable models — the v7.9.7 P6 evidence motivated `MAX_CONTINUATIONS_DEFAULT = 6` for those — but cloud models without prefill use pseudo-continuation (the model is asked to resume from where it left off), which is less reliable and often needs eight to ten rounds for code-with-manifest outputs.

v7.9.10 extracts the cap decision into a pure function, `computeEffectiveMaxContinuations(capability, maxContinuations)`, exported from `ContinuationLoop.js`. The logic: if `capability.status === 'verified-prefill'`, return the caller's value unchanged; otherwise return `max(callerValue, CLOUD_NO_PREFILL_FLOOR)` where the floor is 10. Local prefill models still cap at 6 (no benefit to raising). Cloud, unverified, and missing capabilities all get the 10-round floor — the conservative choice when prefill cannot be verified. Callers requesting more than 10 keep their value; the floor only lifts, never caps down.

Extracting the cap as a pure function lets the eleven new tests in `v7910-cloud-continuation-cap.contract.test.js` verify the lift directly without running the actual continuation loop. The exponential backoff schedule (1+2+4+8+...) bounded by the existing 20-minute sequence deadline still applies; production worst-case at the new ten-round cap is roughly 511 seconds of backoff, well inside the deadline.

### French and Spanish translation tables

Pre-v7.9.10 the `fr` and `es` entries in `STRINGS` (in `src/agent/core/Language.js`) had 23 keys each out of 464 — a 5% coverage. Every other key fell through to English via the `t(key)` fallback, producing mid-sentence language switches like `Erreur Pipeline fallback chain empty` or `Configuración Cost-Guard active`. v7.9.10 fills the gap. Both `fr` and `es` now have all 464 keys, parity with `en` and `de`, enforced by two new parity tests in `language.test.js` that compare `Object.keys(STRINGS.fr).length` and `Object.keys(STRINGS.es).length` against `Object.keys(STRINGS.en).length`. Future additions to `en` must add to `fr` and `es` simultaneously or the tests fail.

Translation quality is technical and idiomatic — LLM-grade, not native-polished. UI labels, error messages, settings hints, and short narrative texts (welcome.first, welcome.returning) read naturally in both languages. The longer settings descriptions (install.scope.hint, fallback_instructions, keepalive.hint, json.help) preserve the original technical content and code references. Template variables (`{{name}}`, `{{error}}`, `{{count}}`) are kept verbatim across all 464 keys. Technical identifiers (Genesis, MCP, IdleMind, Daemon, KnowledgeGraph, SelfStatementLog, TrustLevelSystem) stay unchanged. Trust-level labels follow the v7.9.9 three-level system (Supervisé, Autonome, Autonomie totale in French; Supervisado, Autónomo, Autonomía total in Spanish).

The existing core test `should fall back to English for missing keys` could no longer use `fr` as the source of missing-key fallback once `fr` was full. It now uses a synthetic language code (`lang.current = 'zz'`) to test the same fallback semantics without relying on the incompleteness of any real language.

### Settings-modal language-switch fixes

The full fr+es translation surfaced three latent UI bugs in `src/ui/modules/settings-fields.js` and `src/ui/modules/settings.js`. Pre-v7.9.10 these had been invisible because language-switching had never actually changed visible content.

`_decorateField` used `el.parentNode` as its anchor for both the cleanup-old-hint query and the insert-new-hint target. The function itself moves `el` into a freshly-created `.setting-input-row` on first decoration, so on every subsequent call (e.g. a language switch) `parentNode` was the input-row, not the original `.setting-group`. The cleanup query found nothing inside the input-row, the original hint stayed in setting-group in its original language, and a new hint was appended to input-row — producing the duplicate-hint pattern visible on the v7.9.10-alpha translations field-test (one hint translates correctly, one stays German). v7.9.10 anchors both cleanup and insertion on `el.closest('.setting-group')`, which returns the original group regardless of how many times decoration has run. Cleanup now uses `querySelectorAll` so accumulated residuals from any prior missed cleanup are also removed.

`refreshSettingsI18n` only refreshed reset-button titles and the MCP-add button. The JS-generated `setting-default-hint` spans kept whatever language was active the first time the modal opened. v7.9.10 imports `_decorateAllFields` from `settings-fields` and calls it after the reset-title refresh — the field decorator removes all stale hints and rebuilds them with the current i18n strings.

The inline `t()` helper in `buildDefaultHint` had German fallback values: `'an'`, `'aus'`, `'leer'`, `'Default'`, `'keine Zahl'`. These leaked through in early-boot render moments where the i18n dictionary had not loaded yet, or in test contexts where no translate function was provided. v7.9.10 anglicises the fallbacks (`'on'`, `'off'`, `'empty'`, `'Default'`, `'not a number'`) to match Genesis's primary documentation language. The full fr+es translation makes the fallback path unreachable for the four supported languages in normal operation, but the fallback is the right default when it does trigger.

### Detector offline guard and continuation-loop backoff

The test suite walltime on Linux dropped from 273 seconds to 193 seconds in this release — a 30% reduction tied to two changes in the same family.

`LLMCapabilityDetector._fetchModelInfo` and `_verifyPrefill` did not honor the `GENESIS_OFFLINE_TESTS=1` environment flag that `test/index.js` sets and that `OllamaBackend` has respected since v7.8.4. Every `bridge.chat()` in a test that reached `ModelBridgeContinuation._dispatchChatWithContinuation` (taskType=`code` on the Ollama backend) triggered `detectCapability` → real HTTP request to `localhost:11434/api/show`. With Ollama not running, `req.setTimeout(VERIFICATION_TIMEOUT_MS=15000)` waited the full 15 seconds before rejecting. The v7.9.10 fix mirrors the OllamaBackend pattern exactly: both methods check the env flag after the `_fetchImpl` mock branch (so explicit test mocks still run) and before the real HTTP path. `_fetchModelInfo` throws an offline-mode error; `_verifyPrefill` returns `false` (conservative — the caller already treats `false` as unverified-no-prefill).

A second issue compounded the first. `ContinuationLoop` runs an exponential backoff between retry attempts (1s, 2s, 4s, 8s, 16s, ...). When test mock backends did not call `onDone`, `streamingCompletion` returned with `doneReason: null`, and `TruncationDetector.isComplete` treated null as a truncation signal — so the loop kept retrying through the full schedule. At the v7.9.10 cloud-no-prefill cap of ten attempts that is 511 seconds of cumulative backoff per affected test. The cleanest test-fix would be patching every mock backend to call `onDone`, but the surface area was large. Instead `BACKOFF_BASE_MS` is now defined as `process.env.GENESIS_OFFLINE_TESTS === '1' ? 0 : 1000`. The env flag was already exclusive to test mode and never present in production, so this is an isolated test-loop accelerator without behavioural change for real callers. v752-fix dropped from 30+ seconds to 280 milliseconds. v789-llm-continuation-loop dropped from 14 seconds to 170 milliseconds.

Four new contract tests in `v7910-detector-offline.contract.test.js` lock the detector behaviour: `_fetchModelInfo` throws in < 100ms on the flag, `_verifyPrefill` returns false in < 100ms on the flag, an explicit `_fetchImpl` mock still bypasses the guard, and both methods are documented in source.

### Test suite force-exit (defensive)

A `--test-timeout=2000` flag was added to the `node:test` args in `test/index.js`. The intended target was `v737-dream-phases` and `v737-wakeup-routine` where `--test-force-exit` was suspected of holding a 10-second drain. Verification on Linux showed `--test-force-exit` already brings these tests to 168 milliseconds — the 10-second drain only happens without that flag, which the suite already passes. The added `--test-timeout=2000` is therefore defensive belt-and-braces, not a functional speedup. It costs nothing and protects against future regressions in the force-exit drain path; the actual measurable suite-time win comes from the detector-and-backoff changes above.

### Metabolism warning threshold

`AgentCoreWire.js` line 238 mapped `metabolism:cost` to a `warning` state when `d.cost > 0.08`. The state-bus aggregates the WARNUNG badge in the top app bar from any subscriber emitting `warning`, so the badge appeared on every routine cloud call. The math: a 2000-token / 3-second / 10-MB-heap "normal" call computes cost 0.020; a typical qwen3-vl:235b-cloud code-generation call (10000 tokens, 20 seconds, 30 MB heap) computes 0.091 — well over 0.08. With the configured cost ceiling of 0.15, only calls in the top 20% of the cost range (heavy-tail outliers) should plausibly count as warnings.

v7.9.10 raises the threshold to `0.12`. Recomputed: cloud chat 5k/10s/15MB stays at 0.061 (no warning), cloud code 10k/20s/30MB stays at 0.091 (no warning), cloud heavy 20k/40s/50MB lands at 0.120 (still no warning — exactly at threshold, not over), cloud extreme 30k/60s/80MB lands at 0.137 (warning fires). The metabolism event is still emitted unchanged for dashboard logging — only the UI badge is now conservative. No test was added: the change is a guard-value in a wire-table, no logic-pathway is introduced or removed.

### Documentation pass (nine files)

The release is paired with substantial documentation corrections — the v7.9.7 → v7.9.9 arc shipped several architectural changes that the docs had not caught up with.

`SETTINGS.md` had been documenting the Trust Level default as `1` (AUTONOMOUS) with the legacy 4-level structure (`0..3` with Earned and Full). The actual code default has been `0` (SUPERVISED) since v7.9.8 Fix 2 and finalised in v7.9.9 (A), and the structure has been three levels since v7.9.7 R1. The doc now reflects this and adds the v7.9.10 IdleMind interval defaults (`idleMinutes: 10`, `thinkMinutes: 15`). The install.allowAutoInstall trust threshold reference now states `AUTONOMOUS = level 1` explicitly. A stale `AUTONOMOUS (2)` comment in `Settings.js` line 184 was also corrected to `AUTONOMOUS (level 1)`.

`ARCHITECTURE-DEEP-DIVE.md` described `TrustLevelSystem` as `v4.1 — Four levels`. Replaced with the v7.9.9-frozen three-level description, including the migration history (v7.9.7 R1 + v7.9.8 Fix 2 + v7.9.9 A) and the explicit no-future-touches commitment. Three new module entries added under Phase 8 Revolution: `AgentLoopProgressDetector` (Reflexion-style heuristic, Shinn et al. 2023, arXiv 2303.11366), `AgentLoopPursuitGate three-branch dispatch`, and `AgentLoopRecovery decompose-on-failure` with the cross-pursuit error-class keying explanation.

`EVENT-FLOW.md` received four new pipeline sections under the v7.9.9/v7.9.10 banner, with mermaid diagrams: Hard-Gate Dispatch (three-branch by trust level), Decompose-on-Failure (cross-pursuit error-class repetition), No-Progress Detector (Reflexion-style action-and-plan loop detection), and Lessons-Pipeline (the now-functional write/read loop with the `stableClass` widening explained).

`TROUBLESHOOTING.md` had no entries past v7.5.7. Five new entries describe behaviour changes that users might mistake for bugs: goals marked obsolete after only 2 failures (intentional with the `failureCap` 3→2 reduction), idle-mind goals failing immediately on missing-file references, high-risk simulation without approval prompts at AUTONOMOUS+, the pre-v7.9.10 cloud-continuation cap-at-6 truncation (resolved here), and the test-suite v737-dream-phases force-exit drain explanation (largely irrelevant on Linux but documented).

`COMMUNICATION.md` Layer 1 EventBus description grew to cover the v7.9.9 + v7.9.10 event additions: `agent-loop:simulation-abort` (hard-gate trigger, deduplicated per goalId), `agent-loop:decompose-on-failure` (cross-pursuit error-class repetition), `agent-loop:no-progress-detected` and `agent-loop:identical-plan-detected` (Reflexion-style loop detection), and `lessons:recorded` (now firing per record after the v7.9.10 fix).

`SELF-KNOWLEDGE.md`, the document addressed to Genesis directly, gained three new sections: "On your trust system" (the level you boot at is yours; the three-level structure is now frozen), "On noticing yourself" (the ProgressDetector observer that detects degenerate action and plan loops without you having to think about it), and "On lessons" (why your lesson-recall path was structurally broken for several versions and why pre-v7.9.10 you weren't actually learning from LLM-verdict failures).

`CAPABILITIES.md` scale-line and test-files row updated to 8105 tests (Win baseline, v7.9.10) and 502 test files.

`GATE-INVENTORY.md` gained the 14th instrumented gate `cognitive:hard-gate` in the central GateStats table, plus an architectural note explaining the numerical-vs-categorical decoupling between hard-gate and per-step `TrustLevelSystem.checkApproval`.

### Numbers

Eight modified source files (`AgentLoopPursuitReflection.js`, `LessonsStore.js`, `backends/ContinuationLoop.js`, `backends/LLMCapabilityDetector.js`, `AgentCoreWire.js`, `ui/modules/settings-defaults.js`, `ui/modules/settings-fields.js`, `ui/modules/settings.js`), one rebuilt translation file (`Language.js` grown from 1235 to 2110 LOC after fr+es completion to 464 keys each), one corrected comment (`Settings.js` line 184), one test-runner arg added (`test/index.js` `--test-timeout=2000`), one updated audit baseline (`scripts/audit-doc-drift.js` TESTS_WIN_BASELINE 7933 → 8105). Two new contract test files (`v7910-cloud-continuation-cap.contract.test.js` with 11 tests, `v7910-detector-offline.contract.test.js` with 4 tests), three test files extended (`v779-lessons-pipeline-fixes` +4 tests, `language.test.js` +2 parity tests, `run-tests.js` synthetic-fallback rewrite). One contract test updated (`v797-foundation-pass` G3). Nine documentation files updated. 8105 tests green on Win baseline, 8085 on Linux, 41 hash-locked, 8 strict audits green, 57 doc-drift claims all matching live values. Linux suite walltime 193 seconds (was 273 seconds).

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
