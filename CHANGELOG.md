## [7.9.20]

This release has two parts. The first is audit hygiene — no new behaviour, only correctness made firmer: a kernel filesystem boundary, three shared vocabularies settled into the layer they belong to, the architectural-fitness check hardened, and the documentation brought back in line. The second is field hardening that DOES change behaviour, driven by a runtime trace of a live instance: completed autonomous goals were leaving no durable benefit (analyses never reached the knowledge graph because the extractor is German-first), the planner kept re-inspecting files because nothing remembered they were done, a conversational message could be misread as a slash-only command, and — the load-bearing fix — a single over-general lesson was hijacking the symbolic DIRECT path and replacing real analyses with a boilerplate string. These are fixed at the root, against the runtime dump, not patched per symptom. Two further root-cause fixes ride along: the mental-simulation risk score is no longer a hard gate that could abort and cascade a read-only goal into empty sub-goals, and the step-level approval that supervised and autonomous modes depend on — which had been left silently auto-approving — reaches the user again.

### A sibling directory can no longer masquerade as the project root

The kernel's write and read guards confined every path to the project root by asking whether the resolved path began with the root string. A prefix test alone is too weak: a sibling directory whose name merely starts with the root — a neighbouring folder one level up — satisfied it and slipped past the boundary. The guards now compare against the root followed by a path separator (or an exact match for the root itself), the same form the protected-path check already used, so only paths genuinely inside the root are admitted and a name-prefix neighbour is rejected. The fix is pinned by a contract test that exercises an in-root path, a colliding-sibling path, and a clearly-outside path against both the read and the write guard.

### Three shared vocabularies move to the layer they belong to

Three small, dependency-free modules — the read-only-intent verb list, the step-type catalog, and the failure-classification patterns — are shared vocabulary: several layers read them, none owns them. They had been sitting in the revolution and agency layers, which meant a lower layer importing them was reaching upward across a phase boundary. They now live in core/, the foundation layer every other layer is allowed to depend on, and the ten import sites across the planners, the verification engine, the failure policy and the idle-time activity follow them there. Nothing about their contents changes; what changes is that the imports now point downward, the direction the architecture permits.

### The cross-phase fitness check now sees what it was missing

Relocating those modules removed the upward edges the fitness check could see, but the check itself had blind spots that would let a future violation pass unnoticed. It recognised only single-level `../` imports, so a deeper reach across layers was invisible; it did not know the agency layer at all, so edges touching it resolved to nothing; it skipped the foundation layer as a source because its phase number is zero and the guard treated zero as absent; and it matched text inside comments, so a commented-out import counted as a real one. All four are fixed — the import pattern matches any depth, the agency layer has its phase number, the source guard tests for a defined phase rather than a truthy one, and comments are stripped before matching. The architectural-fitness score reads 127 of 130 with no upward cross-phase dependencies, and the four corrections are pinned by a contract test.

### The documentation says what the code is

Several figures in the README and the architecture documents had drifted from the code: the architectural-fitness score, the test-file count, the dependency count and its list, and the count of type-checked source files, together with a note claiming a hosted continuous-integration workflow that does not exist. Each is now corrected to the measured value — the fitness score and test-file count to their live numbers, the dependency list to the five production dependencies actually declared, the type-checking note to the files that opt in through a `@ts-check` pragma rather than an outdated total, and the integration note to the local gate suite that genuinely runs. The version-of-record advances to 7.9.20 in `package.json`, `README.md`, `docs/banner.svg`, and `docs/COMMUNICATION.md`.

### The drift audit closes its own gaps

The documentation-drift audit already pinned the architecture and capability documents' copies of the test-file and dependency counts, and the README's badges — but the README's own stats table carried its own copies of the file count and the dependency line, and those were unpinned, free to drift on their own. The audit now pins both README rows against the same live values, so a future edit that updates one copy and forgets another is caught. The new pins are covered by a contract test.

### The symbolic shortcut no longer replaces a real analysis with a slogan

The agent loop can resolve a step symbolically: if a stored lesson is confident enough, it applies that lesson DIRECTly and skips the model. The eligibility gate keyed on the lesson's own confidence, never on whether the lesson actually fit the step. A runtime trace made the failure concrete: a manually-seeded lesson — "step by step decomposition works best", with a bare string as its strategy, used 180 times at 0.99 confidence — passed every gate and fired DIRECT on analysis, search and shell steps alike. Because a string strategy has no command to run, DIRECT took the branch that returns the lesson's text as if it were the analysis, so the loop emitted that one slogan in place of real work and never reached the step that writes an analysis to the knowledge graph. The fix is narrow and at the root: a string strategy is no longer DIRECT-eligible. Only an object strategy carries something DIRECT can apply (a command, or the already-filtered failure classification); a bare slogan may still GUIDE the model but can no longer replace it. Every in-code lesson producer already writes an object strategy, so only a manually-seeded lesson can be a bare string — the gate is surgical, and the model now does the analysis the loop had been skipping.

### Completed work now leaves a durable trace, and the planner remembers what it has seen

A completion used to route its analysis through a German-first fact extractor that silently drops English code analyses, so the knowledge graph held nothing afterwards; completions stored no re-readable result; and the idle planner had no memory of what it had already inspected, so it kept re-proposing the same files. The analysis now writes a structured insight node to the knowledge graph directly — the node type the read-source activity already uses — language-agnostically and keyed by a forward-slash path, gated by a novelty check so a repeat that learns nothing is not stored. The idle planner reads those nodes before proposing and de-prioritises files already covered, across every activity's storage convention (some store the path under `file`, some under `module`), so a file is recognised regardless of which activity touched it. Goal completions now also carry an explicit success flag, so decision-quality scoring is no longer inverted.

### A conversational message is no longer misread as a command

The intent classifier's free-text patterns for the slash-only shell, install and open intents used open wildcards without word boundaries, so German inflection that embeds an English command token — a longer word containing "lauf", or one ending in "test" — was bounced with a "this is slash-only" hint instead of an answer, and the same German-only object words missed genuine English requests in the other direction. The patterns now require word boundaries and bounded proximity, the open-app pattern requires a real app signal rather than any word, and English verbs and object words restore parity. A DE/EN corpus pins both directions.

### Identity paths are platform-stable, and the architecture scan no longer re-reads everything

Identity strings shown to the model or written into the agent's store carried OS-native separators — on Windows the same file then had two different knowledge-graph keys depending on platform. A single canonical-path helper normalises them to forward slashes at the source the planner reads from; it is a no-op on Linux. Separately, the architecture-reflection graph re-read every source file on each rebuild; it now caches per-file results by modification time and re-reads only changed files, removing the periodic multi-second rebuild spikes seen on Windows.

### Simulation risk no longer halts a goal

A read-only inspection could abort itself. The agent loop runs a mental simulation before acting and gives the plan a numerical risk score; a score past a fixed threshold was treated as a hard gate that aborted the goal, and under full autonomy it spawned an investigative sub-goal in the goal's place. A runtime trace made the cost concrete: a goal that only inspected the cognitive monitor scored as high-risk, aborted, and recursively spawned sub-goals to the depth limit — four goals, no work done, nothing learned. The simulation variance is a heuristic about uncertainty, not a safety boundary, and stacking it on top of the trust system turned a reading task into a cascade. The gate is removed: the simulation now only logs a warning and the goal proceeds on every trust level. Whether an action pauses for approval is decided solely by the trust level at the step that performs it — never by the simulation score. The decompose, the obsolete-marking and the abort telemetry that hung off the old gate are gone with it; the threshold constant and the risk helper are retained but no longer drive a gate.

### Step-level approval reaches the user again

The trust system defines three levels — supervised asks before every gated action, autonomous asks only for the categorically critical ones (deploy, external API, send-mail), and full autonomy never asks — but the steps that run a shell command, write a file, or delegate to a peer were calling a helper that had been left permanently approving, so the prompt never appeared and the chosen level made no difference at those steps. The three steps now route through the real approval channel, which consults the trust level and, when an answer is genuinely needed, raises a Dashboard entry the user accepts or rejects. The risk table gains explicit entries for the three step actions, so the unknown-action default can no longer mis-rate a plain file write as the highest risk. The approval prompt also no longer expires on a timer by default: the auto-reject timeout is configurable and now defaults to off across the whole chain (the setting, its clamp, the manifest wiring and the gate all preserve a zero instead of collapsing it to a default), so a pending approval waits for the user's decision instead of silently lapsing after a few minutes — a positive timeout can still be set for anyone who wants one. The request-for-input step keeps its own separate path, because it needs a typed answer rather than an accept/reject.

### Batch 2: completed and failed goals are read from the archive

The idle planner unions the live goal stack with `goals/archive.json` and skips a draft that overlaps a recently completed or recently failed goal, so a finished goal — which has left the live stack for the archive — is not proposed again. The dedup vocabulary moved into `src/agent/core/goal-intent.js` to keep `Plan.js` under the 250-line contract.

### Batch 2: a goal draft is refined before it becomes a goal

A bounded second-look pass (`plan-refine.js`) may adopt a refined title, but only when it is valid, different, and keeps the same leading verb; any error leaves the draft untouched and the `addGoal(title)` landmark is preserved.

### Batch 2: skills appear in the self-model and can fulfil pursuit steps

`SelfModel` merges the agent's grown skills into its capability views (late-bound, no upward dependency). A pursuit step can be handled by an autonomous skill through three gates: manifest `autonomous: true`, capability match >= 0.75, and an AST scan of the skill code (`skill-step.js`).

### Batch 2: episodes carry a surprise weight

`EpisodicMemory.recordEpisode` accepts and stores an emotional/surprise weight and metadata, which the dream and consolidation cycle reads to prioritise surprising experiences.

### Batch 2: analyses become improvement proposals

`improvement-proposals.js` turns agent-loop-analysis insights into deduplicated, budgeted, file-targeted proposals; the `propose-improvements` idle activity writes them, and `CommandHandlersProposals` lists, accepts, and rejects them.

### Batch 2: Genesis learns from its own modifications

`SelfModOutcomeTracker` records a `self-modification` lesson when a file is changed three or more times within fourteen days, and that file is excluded from new proposals. No automatic rollback.

### Batch 2: self-modification is a critical, confirmed action

`SELF_MODIFY` is reclassified from `high` to `critical`, so it is auto-approved only at Full Autonomy; the new `security.selfModifyRequiresConfirmation` setting (default on) requires confirmation even there. Four UI strings are added across en/de/fr/es.

### Batch 2: a Dashboard panel approves or rejects proposals

Three IPC channels (`agent:get-proposals`, `agent:accept-proposal`, `agent:reject-proposal`) back a proposals panel that renders open proposals as cards; accepting runs the gated pipeline, rejecting dismisses with a cooldown.

### Batch 2: embedding selection is hardened at boot

`EmbeddingService` probes candidate models in a deterministic order (exact preferred name before partial match) with failover and a boot-only CPU last-resort; steady-state embedding keeps its normal timeout. A new `EMBEDDING_PROBE` timeout governs the boot probe only.

### Notes

- Test files: 531 → 538 — the audit-hygiene suites (kernel root-boundary; the four cross-phase fitness-check corrections; the drift audit guarding the README's own rows), plus three field-hardening suites: one covering canonical paths, the consolidation primitive (English analysis persisting as an insight node, novelty-gated, POSIX-keyed) and the goal-success flag; a DE/EN slash-discipline corpus pinning both directions; a contract pinning that a string lesson strategy is not DIRECT-eligible while an object strategy still is; and the approval-repair contract pinning the step routing, the three-level matrix, the risk classification and the no-timeout default. The simulation-gate-removal contracts (the hard-gate three-level and emit suites, and the foundation-pass invariant) were rewritten in place to pin the new proceed-always behaviour rather than adding files.
- This release changes runtime behaviour (unlike a pure hygiene release): a string lesson strategy can no longer fire the symbolic DIRECT shortcut, so the model performs analyses it had been skipping; completed goals persist a knowledge-graph insight node and the planner reads it back before proposing; goal completions carry a success flag and an optional outcome; the slash-discipline classifier no longer false-matches conversation; identity paths are POSIX-normalised at the source; and the architecture scan caches by modification time. One new source module is added (the planner's review-feedback helper) plus a canonical-path helper in core/utils; no new event type or payload field beyond the goal-completion success/outcome and the DIRECT-gate guard. The German-first fact extractor is left untouched — the consolidation path bypasses it via a direct insight write rather than being widened — and the LLM shell-command-quality issue (a naked path emitted as a command) is deliberately deferred as its own strand rather than papered over with path rewriting. Two further behavioural changes: the mental-simulation risk score no longer aborts, decomposes or marks a goal obsolete on any trust level — it only warns and proceeds, with the abort, decompose, obsolete-marking and abort telemetry removed (the threshold constant and risk helper remain but are inert); and the shell, write and delegate steps now route through the real approval channel so the trust level is honoured at the step (supervised asks, autonomous asks only for critical, full autonomy never), with the approval prompt no longer expiring by default. No new event type or payload field is introduced by these two; the approval channel and trust matrix already existed and are now reached. The request-for-input step is left on its own approval path deliberately — it needs a typed answer, not an accept/reject — and is tracked as a separate concern rather than folded in here.

---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
