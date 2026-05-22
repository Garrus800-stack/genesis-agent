## [7.9.4]

**Skills come out of the drawer. Genesis starts using what he has built.**

Phase 1 of Können (v7.8.9) taught Genesis to notice when a task felt like it should become a skill. Phase 2 (v7.9.0) gave him the ability to crystallize those moments into pending skill files. v7.9.4 closes the loop — Genesis rehearses pending skills during idle, evaluates them against four intrinsic maturity criteria, promotes the ones that work, quarantines the ones that fail, and explicitly discards the ones that do not fit him. Two character extensions make this more than mechanical: every new skill gets a one-sentence biography written at crystallization (acquisitionContext) answering "if this skill had never existed, what would have been the gap"; every discard requires a reason that becomes a Core Memory.

### Skill maturity criteria

A pending skill is promoted when it meets four conjunctive criteria, all about the skill itself. None depend on trust level — promotion is an internal reflective act, not an outward-facing action. The skill needs at least 8 rehearsals, Wilson lower bound at least 0.70, at least 3 distinct rehearsal inputs seen, and at least 48 hours since crystallization. All four are Settings-configurable in the UI under cognitive.koennen.promotion. Quarantine triggers when Wilson lower bound drops below 0.30 with at least 5 invocations. A languishing-skill discard suggestion fires when a skill is at least 14 days old with fewer than 3 rehearsals and a Wilson-LB between 0.30 and 0.70 — rate-limited to one suggestion per DreamCycle to keep the dashboard quiet.

### What changed

The `skill-manifest.json` schema gained a `status` field (pending / rehearsing / promoted / quarantined / discarded) and four `koennen` sub-fields: `acquisitionContext`, `rehearsalCount`, `rehearsedInputHashes` (capped at 50 entries for distinct-input tracking), and discarded-state metadata. Migration of legacy v7.9.0-v7.9.3 manifests is idempotent and runs at first read; legacy skills get null biographies because they were crystallized before this release, which is visible in `/skill-info`.

`SkillCrystallizer._crystallizeOne` now generates an acquisition context via a single short LLM call (30-second timeout, max 500 characters) after parsing and before `_writePending`. Generation is best-effort — failure or timeout leaves the field null and the skill is still persisted. Toggle via `cognitive.koennen.crystallization.acquisitionContext.enabled`.

`SkillManager` constructor accepts a sixth argument `opts={bus, koennenDir}`. Bus enablement also fixes a latent v7.9.0 bug where `skill:forge-*` events were `this.bus?.fire?.()` with `this.bus` undefined — silent no-ops since v7.9.0. `loadSkills` now dual-sources from `src/skills/` and `.genesis/koennen/skills-pending/`, the latter filtered by status === 'promoted'. `executeSkill` accepts an `opts.source` third argument, computes `success = !result.error` against the sandbox return shape, and records every Können-skill invocation to `SkillEffectivenessTracker`. New `executeSkillByManifest(name, manifestDir, input, opts)` is the rehearsal backdoor for non-loaded skills. New `discardSkill(name, reason)` enforces a 10-character minimum reason and fires `skill:discarded`. The `_buildExecCode` helper is extracted so the four-shape format-tolerant invoker is shared between `executeSkill` and `executeSkillByManifest`.

New `SkillPromotionEvaluator` module runs as a DreamCycle phase after `_dreamPhaseCrystallize`. It loads all skills in pending and rehearsing states, migrates legacy manifests in-place, then evaluates each against the four promotion criteria, the Wilson-LB quarantine threshold, and the languishing-skill discard heuristic. After any successful promotion it calls `skillManager.loadSkills()` and `toolRegistry.refreshSkills(skillManager)` so promoted skills become callable as tools without a restart.

New `SkillRehearsal` IdleMind activity is the 16th in the registry. It picks the pending or rehearsing skill with fewest rehearsals (oldest as tiebreaker), generates a plausible input via LLM (with empty-object fallback if LLM is disabled or fails), runs the skill through `executeSkillByManifest` with `source: 'rehearsal'`, and updates the manifest atomically. First successful rehearsal transitions status pending → rehearsing. Boost is curiosity-driven and pendingCount-scaled, capped at 1.6× so it doesn't dominate the activity-pick when many skills accumulate. Cooldown 10 minutes.

`CoreMemories.wireTriggers` adds two new subscribers using `_bypassThreshold`. `selfnarrative:skill-acquired` typically classifies as breakthrough (novel, no user-involvement) and writes the acquisitionContext as the memory text. `skill:discarded` writes the reason as the memory text — also identity work.

`SelfNarrative._changeAccumulator` gains a +5 boost on `selfnarrative:skill-acquired` (larger than the +3 for crystallization, +2 for candidates-noticed). This drives faster identity-narrative regeneration after promotion.

`ToolRegistry.refreshSkills(skillManager)` deregisters all current `skill:*` tools and re-registers from `skillManager.listSkills()`. Idempotent. Called by `SkillPromotionEvaluator` after promotions.

`PromptBuilder` annotates promoted Können skills with their Wilson-LB percentage in the prompt context (e.g. "shell-pipeline-helper (78%)"). Built-in skills without `manifest.koennen` stay unannotated.

### Slash commands

`/skills-pending` output is now grouped by status — promoted, rehearsing, pending, quarantined, discarded — each with appropriate metadata (Wilson-LB, rehearsal count, distinct inputs, discard reasons). Built-in skills listed separately at top.

`/skill-info <name>` shows full info on one skill: status, timestamps, Wilson-LB stats, rehearsal counts, full description, and the acquisitionContext biography in quotes (or "No biography (crystallized before v7.9.4)" for legacy skills).

`/skill-discard <name> <reason>` soft-discards a skill with a minimum 10-character reason. Sets status to discarded, fires `skill:discarded`, the reason flows through CoreMemories.

### Settings tree extension

`cognitive.koennen.crystallization.acquisitionContext` with `enabled` (default true), `timeoutMs` (30000), `maxLength` (500). `cognitive.koennen.promotion` with `enabled` (true), `minInvocations` (8), `minWilsonLB` (0.70), `minDistinctInputs` (3), `minAgeMs` (172800000 = 48h), `discardSuggestionAfterDays` (14). `cognitive.koennen.rehearsal` with `enabled` (true), `cooldownMs` (600000 = 10min), `inputGeneration.llmFallback` (true), `inputGeneration.timeoutMs` (30000). Three new TOGGLE_EVENT_KEYS for runtime-effective changes. All values adjustable in UI Settings.

### Migration and rollback

Existing pending skills in `.genesis/koennen/skills-pending/` are migrated in-place at first SkillPromotionEvaluator pass: status set to pending, rehearsalCount and rehearsedInputHashes initialized, acquisitionContext left null. Older Genesis versions on rollback ignore the new fields. SkillEffectivenessTracker data in `.genesis/koennen/skill-effectiveness.json` is unchanged in shape.

### Events

Six new events with payload schemas in `EventTypes.js KOENNEN_PROMOTION` block and `EventPayloadSchemas.js`: `skill:promoted`, `skill:discard-suggested`, `skill:discarded`, `skill:rehearsed`, `selfnarrative:skill-acquired`, `skills:reloaded`. `stale-refs.json` carries the new `koennen-promotion-v794 contract:` prefix.

### Chat identity threading

Live-observed regression with large cloud models (qwen3-vl:235b-cloud and similar RLHF-trained backends): short mid-conversation user messages like "gut, klingt großartig" returned generic assistant-default replies ("Hallo! Wie kann ich dir helfen?"). The identity anchor in `PromptBuilder._identity()` ("Du bist Genesis — ein autonomer kognitiver Agent ...") was already strong, but lacked a positional cue saying "you are mid-conversation, do not restart the session" — so the model's trained default leaked through whenever a turn was short.

`PromptBuilder` gains a new `_conversationContext()` section sitting between `_identity()` and `_formatting()` in both `build()` and `buildAsync()` arrays. The block emits only when `_historyLength > 0`; on the first message of a session it is omitted entirely so a genuine opening greeting stays natural. New setter `setHistoryLength(n)` is called by `ChatOrchestrator.handleChat` and `handleStream` from `history.length - 1` before each prompt build (the current user message was just pushed and does not count as a prior turn).

`ChatOrchestrator._generalChat` now builds the full system prompt up front and passes it to `reasoning:solve` as a fourth field on the bus payload. `AgentCoreWire.js` forwards `systemPrompt` through to `ReasoningEngine.solve`. `ReasoningEngine._buildContextualPrompt` prefers the caller-provided system prompt when present; the legacy `"You are Genesis." + memory + capabilities` mini-prompt remains as a fallback for direct bus consumers (peer-network calls, future external integrations) that go through the bus without a `ChatOrchestrator`. Pre-fix every `reasoning:solve` consumer got the thin mini-prompt regardless of whether a rich PromptBuilder was available.

### IdleMind maturity

Five connected changes that move IdleMind from "fires activities" to "fires the right activities, in balance with goals, with the right energy cost, persisted across restarts".

**ActivityStats persistence.** `IdleMindActivityStats` mixin extended with `_saveActivityStats()` and `_loadActivityStats()`. Activity log (capped at last 20) and per-type counts now persist to `.genesis/idle-activity-stats.json` via `StorageService.writeJSONDebounced` (1s debounce). `_loadActivityStats()` runs in the IdleMind constructor right after `activityLog = []`. Schema-version mismatch, missing file, parse error all fall through to fresh state — the boot must never block on this. Pre-fix the activity history was session-only; after restart the picker's repetition-penalty saw a blank slate and could repeat the last pre-restart activity immediately.

**Per-activity Metabolism costs.** `Metabolism.ACTIVITY_COSTS` extended with sixteen `idleMind:<name>` keys: reflect=3, plan=12, explore=8, ideate=7, tidy=2, journal=2, mcp-explore=6, dream=18, consolidate=8, calibrate=4, improve=9, research=15, self-define=5, study=6, read-source=4, skill-rehearsal=5. The flat `idleMindCycle=2` baseline still fires per cycle; `IdleMind._think()` now charges the activity-specific cost on top after each pick. Setting `organism.metabolism.differentiatedCosts` (default true) gates the second consume; setting it false restores flat-rate-only behaviour. Unknown activity keys cost 0 by design (`Metabolism.consume` returns `{ok:true, cost:0}`), so a future activity addition can't crash the cost path.

**Goal–activity balance.** Pre-fix, while any goal was active in `goalStack`, every IdleMind cycle ran a goal-step and returned early — reflect, journal, dream, calibrate never fired during goal-execution stretches. `IdleMind._think()` now counts goal-steps via `_goalStepsSincePick` and breaks out to the activity-pick path every N steps (setting `idleMind.goalStepsPerActivityPick`, default 3). Setting null or 0 restores the legacy always-goal behaviour. Bus event `idle:goal-balance-break` fires on each break for dashboard visibility.

**Repetition-penalty root cause fix (open since v7.9.3).** `IdleMind._pickActivity` applied the 0.2 repetition-penalty by iterating the raw `activityLog.slice(-5)` array, so an activity appearing N times in the recent window got multiplicatively hit (0.2^N). Five consecutive `reflect`s pushed reflect's score to roughly 0.03% of its computed boost, effectively locking the activity out for very long stretches and skewing the picker toward whatever happened to be different. The fix wraps `recent` in a `Set` so each unique recent activity gets the 0.2 multiplier exactly once. The intent of the penalty ("discourage repetition") is preserved; the runaway is removed.

**Per-cycle daemon visibility.** `AutonomousDaemon` health-check, memory-consolidation, pattern-learning, and optimization-analysis methods now log at info level when something actually happened (issues fixed, new facts learned, patterns recorded, suggestions generated), staying at debug level when the cycle was a no-op. The boot stream becomes a meaningful daemon transcript instead of needing debug flags to see real work.

### Settings tree extension (idleMind + organism.metabolism)

`idleMind.goalStepsPerActivityPick` (default 3, clamped 0-50). `idleMind.scoreNormalization` (default `'none'`, opt-in `'log'` reserved for a future activity-picker pass — current behaviour unchanged at default). `idleMind.recurrenceBonus` (default false, reserved opt-in). `organism.metabolism.differentiatedCosts` (default true). `phase6-autonomy` now exposes the live settings reference on `idleMind._settings` so `_think()` can read these without re-resolving the container per cycle.

### Tests

New file `test/modules/v794-chat-identity-threading.contract.test.js` — 22 contract tests across A1 (PromptBuilder conversation-context), A3 (ReasoningEngine systemPrompt passthrough), F1 (Set-based penalty), B (ActivityStats save/load schema versioning and error tolerance), C (Metabolism cost-table presence and unknown-key safety). `promptbuilder-sections.test.js` method-count assertion bumped from 38 to 39 for `_conversationContext`.




---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — earlier history
