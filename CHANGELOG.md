## [7.8.9]

**Affect-encoding at AgentLoop boundaries — Genesis starts noticing which tasks feel like they should become skills. Plus a resilience layer that keeps long code-generation calls alive across timeouts.**

v7.8.9 introduces the foundation layer for procedural-memory crystallization in v7.9.0. At every AgentLoop task start and end, Genesis snapshots his 5-dimensional emotional state, tracks frustration and curiosity peaks via emotion:shift events during the trajectory, sums surprise signals from SurpriseAccumulator between start and end timestamps, and evaluates the result against a baseline-relative triage gate. Both passing and failing boundaries are persisted as calibration data for v7.9.0.

The same release adds an LLM-resilience layer so long code-generation calls (skill builds, multi-file refactors, code reflections) survive Ollama timeouts and token-cap truncations instead of being thrown away when a single HTTP request hits its limit.

### What changed — Affect-encoding

- New `KoennenCandidateLog` subscribes to `agent-loop:started`, `emotion:shift`, and `agent-loop:complete`. Tracks per-task affect snapshots (start, end, peaks), accumulates surprise across the trajectory via the new `SurpriseAccumulator.getSignalsSince(timestamp)` method, and persists every boundary to `.genesis/koennen/candidates.jsonl`. A 30-min TTL cleanup tick prunes `_activeTaskStarts` entries older than 2h (crash-recovery for tasks where `:started` fired but `:complete` never came).
- Triage gate is baseline-relative: `satisfaction_end > satisfaction_baseline + 0.15` AND `frustration_peak < frustration_baseline + 0.4` AND `surprise_sum/step_count > θ` AND `success === true` AND `step_count > 0`. `θ = 0.6 - (genome.consolidation * 0.3)`, range [0.315, 0.585]. The `consolidation` genome trait gets its third active reader (alongside Metabolism's regen rate and PickContext's idle-activity context).
- New `SkillCandidateNarrative` reacts immediately to each passing candidate. When ≥3 candidates passed gate in the last 7 days (with 6h cooldown between reflections), it fires `koennen:candidates-noticed` which boosts SelfNarrative's `_changeAccumulator` by 2 — Genesis updates his narrative more often when he's actively learning.
- New `/affect-trail [n]` slash command shows the last n AgentLoop boundaries with affect snapshot, gate-pass status, current θ, and overall pass-rate statistics.
- New `KOENNEN` namespace in EventTypes catalog with two events: `CANDIDATE_RECORDED` and `CANDIDATES_NOTICED`. Both have matching payload schemas in EventPayloadSchemas.

### What changed — LLM resilience layer

- New `StreamingCompletion` wraps any backend's `stream()` with three layered timeouts (`LLM_STREAM_FIRST_CHUNK` 120s, `LLM_STREAM_CHUNK` 30s, `LLM_STREAM_TOTAL` 600s — all user-overridable), accumulates chunks into an in-memory buffer, captures the terminal NDJSON chunk's `done_reason`, and never throws. Partial content always survives, no matter how the stream ended.
- New `TruncationDetector` decides whether accumulated content is structurally complete. Auto-detects expected shape (`code-with-manifest` for the SkillManager pattern, `code-single-block`, `json-bare`, `code-bare`, or `free`) and validates per-shape: code fences must pair, JS brackets must balance via a stack-based matcher that ignores strings/line-comments/block-comments, JSON must parse. Truncation signals (`length`, `chunk-timeout`, `total-timeout`, `abort`, `null` TCP-drop) override structural balance — a model can emit a clean EOS mid-thought even with `done_reason='stop'`.
- New `LLMCapabilityDetector` probes a model's `/api/show` template once per (model, digest) pair, classifies it as `messages-loop` (modern, prefill-capable) or `prompt-response` (legacy, no prefill), checks for `m.Config.Renderer` (multimodal/OCR — pseudo-continuation only). For modern templates, runs a small verification call with an unambiguous prefill marker to confirm the model actually continues from the trailing assistant message instead of re-emitting it. Four status values (`verified-prefill`, `unverified-no-prefill`, `verification-failed`, `special-renderer`) persist to `.genesis/llm-capabilities.json` with model digest for cache invalidation. Lazy: only invoked when continuation is actually needed.
- New `ContinuationLoop` orchestrates the full pipeline. On truncation, re-calls the model with either a trailing-assistant prefill message (`verified-prefill` models) or a pseudo-continuation user prompt (all other status values). Exponential backoff between attempts (1s, 2s, 4s, 8s), `MAX_CONTINUATIONS=4`, cumulative token budget `0.8 * num_ctx`, hard sequence deadline `LLM_CONTINUATION_TOTAL` 1200s. Pushes a temporary `keep_alive: "15m"` override on the backend so the model stays loaded between re-calls (released on sequence exit). Emits `llm:continuation-started/-complete/-failed` bus events. Records a single success/failure to the CircuitBreaker per sequence (not per re-call).
- `OllamaBackend.stream()` gains an optional `onDone(reason)` callback parameter. Backward-compatible: callers that don't pass it see identical v7.8.8 behavior. New `pushKeepAliveOverride(value)` returns a release function; supports nested overrides via a stack so parallel continuation sequences don't fight over the model's keep_alive setting.
- `ModelBridge` routes `taskType === 'code'` calls against the Ollama backend through ContinuationLoop. All nine code-generation call sites (SkillManager, Reflector, MultiFileRefactor, AgentLoopSteps, GoalStackExecution, CloneFactory, SelfModificationPipelineModify) benefit transparently — no caller code changes needed. Other taskTypes and Anthropic/OpenAI backends keep their original non-streaming path unchanged.
- New `ModelBridgeContinuation` mixin holds the dispatch helper (same mixin pattern as ModelBridgeFailover/Availability — keeps ModelBridge.js under the 700-LOC architectural-fitness soft-guard).
- New `MockBackend` `chunked` mode with per-script chunks, inter-chunk delays, `doneReason`, and `terminateAt` (simulates TCP-drop). Used by the resilience contract tests; useful for any test that needs deterministic stream timing.
- New `LLM_STREAM_FIRST_CHUNK`, `LLM_STREAM_CHUNK`, `LLM_STREAM_TOTAL`, `LLM_CONTINUATION_TOTAL` constants in Constants.js.
- New `LLM.CONTINUATION_STARTED`, `LLM.CONTINUATION_COMPLETE`, `LLM.CONTINUATION_FAILED` events with matching payload schemas.

### Setup

No new setup steps over v7.8.8. The LLM-resilience layer activates automatically the first time a code-generation call is made through an Ollama backend; the capability cache lives in `.genesis/llm-capabilities.json` and is populated lazily.

### Numbers

7601+ tests pass (Win baseline), 7600+ (Linux). 130/130 fitness. 87 new tests in 6 contract/test files (`v789-llm-streaming-completion.contract.test.js`, `v789-llm-truncation-detector.contract.test.js`, `v789-llm-capability-detection.contract.test.js`, `v789-llm-continuation-loop.contract.test.js`, `v789-llm-resilience-integration.contract.test.js`, `modelbridge-continuation.test.js`) on top of the 28 affect-encoding tests.

---

## Older releases

For prior version history, see the archive files:

- [**CHANGELOG-v7.md**](CHANGELOG-v7.md) — all v7.x.x releases (81 entries)
- [**CHANGELOG-v6.md**](CHANGELOG-v6.md) — all v6.x.x releases (12 entries)
- [**CHANGELOG-v5.md**](CHANGELOG-v5.md) — all v5.x.x releases (17 entries)
- [**CHANGELOG-archive.md**](CHANGELOG-archive.md) — v0.x.x – v4.x.x (29 entries)

This index file (`CHANGELOG.md`) keeps only the newest release inline so
the file stays readable. The major-version archives carry the full
history.
