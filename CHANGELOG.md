## [7.9.23]

A live audit of a running instance's identity folder, together with the long autonomous field run that preceded it, surfaced two independent groups of issues: a set of boot- and process-level safety gaps around the identity store, and a coupled cluster in the goal/timeout machinery that made long autonomous goals fail in ways single-point fixes had never held. This release adds a single-instance lock so two processes can never share one identity, grounds the daemon's dependency scan in the parsed syntax tree instead of a line scan, heals a corrupt identity file instead of only warning about it, and replaces the flat goal timeout with one that scales to the work and resumes after a restart — alongside coupling the cognitive token budget to the real model window and unblocking a handful of starved signals. Every change is against the runtime trace and at the root; none touches the kernel or the gate set.

### A single-instance lock keeps two processes from sharing one identity

Nothing stopped a second process from booting against the same identity folder, so two instances could write the same knowledge graph and emotional state and corrupt each other. A lock file now lives as a sibling of the identity folder — beside the backups, never inside it, so a backup of the identity folder can never capture the lock — holding the owning process id, a heartbeat timestamp, and the host name. Acquisition runs before any boot work: a live holder makes the boot refuse and abort rather than start a second instance. Liveness is judged stale-first to survive process-id reuse — a heartbeat older than the staleness window means the holder is gone regardless of which process now owns that id — and only on a fresh timestamp is the id probed on the same host (a different host cannot be probed, so a fresh remote lock is taken as alive). The live holder re-stamps the timestamp on an unref'd heartbeat that never holds the process open, and a clean shutdown releases the lock after the final flush, before the crash logger stops.

### The daemon's dependency scan reads the syntax tree, not the text

The self-model extracted a module's `require(...)` targets with a line-and-string scan, which cannot tell a real call from one that merely appears as text inside a multi-line template literal — so the fenced `require('./Foo')` in one module's prompt string was recorded as a real dependency, inflating its coupling count and raising a daemon-health flag on every cycle. Extraction now walks the parsed syntax tree and collects only genuine `require('<literal>')` call nodes: comments are not in the tree, template text is skipped, and a require inside a `${...}` interpolation — which is real, executing code — is kept. The parser is the one already vendored for exactly the case where the package tree is absent; on a parse failure the previous line scan still runs as a fallback, so no module loses its real dependencies.

### A corrupt identity file is healed, not just flagged

When the boot integrity check found a file whose checksum no longer matched, it warned and fired a bus event that never persisted, and left the corrupt file in place to fail again on the next boot. The check now heals: the corrupt bytes are moved to a sibling quarantine folder stamped with the time — nothing is destroyed — the file is restored from the most recent backup that holds it, and its checksum is recomputed from the restored content so an older backup is not flagged corrupt again on the next boot. The degradation is appended directly to the event store, not only fired on the bus, so the event survives the boot. Two building blocks are added for this: a single-file restore on the backup system and a public checksum-recompute on the storage service, neither of which existed before.

### The autonomy loop's timeout scales with the work and resumes after a restart

Two autonomous goals failed at the same flat ten-minute ceiling — a nine-step documentation goal cannot finish in ten minutes on a slow cloud backend no matter how well it is decomposed — and a goal interrupted by a restart began again from its first step. The global timeout now scales with the step count: a base allowance plus a per-step budget that matches the local-inference timeout, since a step's dominant cost is one model call, hard-capped at thirty minutes so the worst case stays bounded, with a floor that preserves the previous allowance for small goals. For an autonomous goal the step count is known up front and the budget is set immediately; for a planner-decomposed goal a planning budget is armed first and re-armed to the real step count once the plan is known. And the loop now resumes from its last checkpoint: the step state already written after each completed step is loaded on boot, and execution continues at the next step with the earlier results seeded, instead of repeating finished work.

### The cognitive budget tracks the model, and three starved signals are unblocked

The cognitive monitor measured every step against a fixed eight-thousand-token budget while the context manager knew the real window was far larger, so the agent rationed itself below its own model and raised false pressure warnings — the budget setter simply had no caller. It is now called at both points where the model is configured, at boot and on a runtime model switch, so the budget tracks the real window. Three further signals that had quietly stopped firing are unblocked: the dream gate, whose unprocessed-episode threshold sat above the counts a calm instance ever reached, is lowered and given an age fallback so a long-idle backlog still consolidates; the goal driver's failure-burst counter, which reset on every restart and so could let a once-per-session failure loop forever, is persisted and rehydrated on boot, self-expiring through its existing reset window; and the per-message profile learner now reads the message-carrying chat event rather than one that carries only a length, so the semantic profile fills from ordinary conversation.

### Smaller corrections

The quick-benchmark wrapper's path to its benchmark script was one directory too shallow and silently never loaded its suite; it is corrected. A constructor parameter used but undeclared in one cognitive module's type annotation is declared, so the type check stays clean. And the release-notes file, a byte-for-byte duplicate of the changelog regenerated on every install, is removed along with its generator, its install hook, its aliases, and the two audit references that read it — the changelog is the single source.

### Notes

- Test files: 573 → 576 — coverage for the single-instance lock (sibling placement, live refusal, release-and-reacquire, stale and remote-host reclaim), the syntax-tree dependency extraction (the four require cases plus the real template-text and interpolation files and the parse-failure fallback), and the integrity heal (restore-from-backup, the checksum recompute that settles a restored older file, and the no-backup path).
- This release changes runtime behaviour across the boot and autonomy layers. A second instance is refused; the dependency scan no longer miscounts template text; a corrupt identity file is quarantined, restored, and re-checksummed with the degradation persisted; the autonomy timeout scales to the step count and a restarted goal resumes from its checkpoint; the cognitive budget follows the model window; and the dream, failure-burst, and profile signals fire again. The heal appends a degradation event so the outcome is durable; the new modules are the lock lifecycle on the boot-recovery component, the restore-and-recompute building blocks, and the three new test files.

---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
