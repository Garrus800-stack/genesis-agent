## [7.9.27]

This release follows a long autonomous field run and a pass over its trace. The run exposed a cluster of defects that left the agent working against itself: it carried four built-in skills it never used, re-synthesising a broken copy of one and recording the result as an unusable object; its concurrent self-checks raced on shared temporary files and reported syntax errors on clean code; the continuation telemetry it emitted each round was recorded nowhere; and its own introspection tripped the prompt-injection guard. Alongside those, this version corrects how a completed goal reports its result, narrows three over-eager learning signals, learns the user's name instead of filing it under their role, charges energy on every model call rather than only on user replies, surfaces boot failures that were only logged, and lifts a hardcoded threshold into configuration. Every change is against the runtime trace and at the root; none touches the kernel or the gate set.

### Genesis sees and uses its own skills

The four shipped skills — file-search, code-stats, system-info, git-status — loaded at boot but were never registered as callable tools, because registration ran only on a separate promotion path that stays dormant in a normal run. A request that matched a skill therefore found nothing and fell through to tool synthesis, which generated a parallel copy; the synthesised copy read the script's standard output where the real skill returns a structured value, so its result surfaced as an unusable object. Skills are now registered as tools at boot and the moment the daemon creates one, and a tool lookup that finds a skill of the same name registers it on demand before any synthesis runs. With the real skill in place the existing result path serialises its output correctly, and synthesis is reserved for names that have no skill behind them.

### Concurrent sandbox checks no longer collide

The sandbox wrote every syntax check to one fixed temporary file, and every patch test to a file named only after the original — and for skills and plugins that name is always the same. Several subsystems run these checks in parallel on the shared sandbox, so one caller's cleanup deleted another's file mid-run: a clean file was reported as a module-not-found syntax error, and a reused name returned a stale cached module. Each syntax check and each patch test now writes a uniquely named temporary file, and the boot-time cleanup recognises the new names. The patch test loads by absolute path, so the unique name changes nothing about resolution.

### Continuation telemetry is recorded

A continuation sequence — the loop that asks a model to resume a truncated output — emitted a per-round event and a failure event, but nothing consumed them, so a sequence that ran its whole round budget without completing left no persisted trace. That is the case a cloud model falls into on a long code-with-manifest output. A sink now records each round's done-reason, per-round character growth, and completeness verdict, and each failure's reason and attempt count, to a continuation-telemetry file under the identity folder. Each round also carries the structural completeness reason — which check held the round incomplete even when the model reported a clean stop — and the sink keeps that reason in its own field, separate from the model's done-reason, so a stop that never completed stays diagnosable.

### Self-inspection is not treated as external input

Genesis's introspection tools — the ones that read its self-model and runtime state — were not classified as internal, so their output ran through the prompt-injection scan, and the word "routine" in a self-report matched the urgency heuristic, making the agent flag its own introspection as an injection attempt. Those tools are now classified as internal reads, like a read of its own source.

### A goal summary reports verification, not the no-error rate

The completion summary reported the share of steps that ran without throwing as a success rate, so a goal where two of ten steps were verified read as "100%". The summary now reports verification coverage directly — how many steps were verified, how many ran without error but unverified, and how many errored — while the completion decision and its thresholds are unchanged.

### Three learning signals are narrowed

The capability-gap detector fired on any phrase of inability, including a subjective one: declining to say which option felt better was logged as a missing capability and pushed to the daemon as a skill to build. It now fires only on real limits — access, tooling, execution, or the bounds of the current environment — and never when the user's message was itself subjective. Separately, the symbolic resolver's lesson-affinity match counted generic verbs such as "inspect", "review", and "wiring" as shared subject, so an avoid-lesson lent its weight to almost any review or configuration step; those generic tokens no longer count toward the match. Third, the solution accumulator recorded a reusable solution whenever a completed message held a single keyword — an error word anywhere in the text, or one ordinal connective such as "then" — and stored the whole reply as that solution, which the prompt builder fed back into later prompts; an ordinary remark that contained the word "bug" was captured both as an error fix and as a workflow. It now records an error fix only when the message reports a fault — a broken-state phrase, a fix request, or a pasted code or log block beside the error word — and a workflow only when the message lists at least two ordinal steps that each introduce an action, so conversation no longer lands in the solution store.

### Genesis learns the user's name

The two self-introduction patterns — "ich bin X" and "i am X" — both routed their match to the user's role, so a message giving a name was filed as a role whose value was that name, and the name lookup, which reads only the name field, returned nothing: the agent never learned who it was talking to. A self-introduction is now classified before it is filed. When no name is known yet, "ich bin X" is read as a name and stored as the name; a profession or a passing state is recognised as such and stored as the role. A name only ever populates the name field and a role only ever the role field; the two never cross. Once a name is on file, a later differing "ich bin X" is left for a confirming reply rather than overwriting the established name.

### Energy is spent on every model call, not only on replies

Metabolic energy was charged only when a user-facing turn completed, so an agent running its own reasoning loops between turns — reflecting, planning, dreaming — spent nothing while its idle telemetry rose. The real cost now rides on the per-call event the model port already emits for every call, computed from that call's tokens and latency. The completed-turn handler stays the per-turn marker and cancels the fixed dip the emotional state applies on a turn, so a turn is charged once rather than twice, and the per-turn heap snapshot that fed the old estimate — which has no per-call equivalent — is removed.

### Smaller corrections

A boot failure in a service's asynchronous phase was logged but never merged into the degraded set, so it never reached the components that listen for a degraded boot; it is now included. The reasoning-solve handler is wrapped to match the web-search handler beside it, returning a null result on rejection rather than an unhandled rejection. The file watcher now ignores the rotating backup and snapshot folders, which raised a file-busy error during a backup write and fed self-authored churn back as external changes. The token-budget warning threshold is read from configuration, matching the limits beside it, instead of a fixed value. The keyed-subscription index drops its entry when a listener is removed by source or by handler, instead of leaving it behind. The architectural-fitness event-hygiene scan recognises the emit-helper form `_emit(bus, 'event', …)`, the same wrapper the event audit already reads, so the continuation events it forwards are no longer counted as listeners without an emitter.

### Notes

- Test files: 590 → 603 — one focused suite per point: self-inspection classified as internal; the keyed-subscription index cleaned on removal; the configurable token-warning threshold; the affinity match ignoring generic verbs; the capability-gap detector ignoring subjective messages; the reasoning-solve guard returning null on rejection; concurrent syntax checks and patch tests writing unique files with a real syntax error still caught; skills registered as tools at boot, on creation, and on demand with synthesis reserved for unbacked names; the continuation sink persisting a round and a failure with its done-reason and structural reason kept apart; the goal summary reporting verification coverage; a self-introduction routed to the name field rather than the role; the solution accumulator no longer capturing conversation as a solution; and metabolic energy charged on every model call.
- This release changes three behaviours visible in a run: a request that matches a built-in skill now runs the skill instead of a synthesised copy, a goal summary reports how many steps were verified rather than how many ran without error, and a self-introduction is learned as the user's name rather than filed as a role. The rest correct internal signalling, classification, observability, and the metabolic cost of autonomous work; on a run that already resolved its skills and verified its steps, those paths read as before.

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
