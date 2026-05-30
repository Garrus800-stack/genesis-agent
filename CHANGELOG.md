## [7.9.16]

The self-trajectory journal added in v7.9.15 carried an `event_count` field that was always written as null — a placeholder for a number nothing yet produced. This release fills it. A passive observer watches the events that make a cycle eventful — goals completed, failed, or abandoned; lessons learned; the emotional watchdog firing; sessions ending — and records each one to an append-only journal, so every committed trajectory entry now carries the count of significant events in its cycle. Nothing acts on the number yet: this is the observation phase, gathering the real per-day distribution so the threshold that would decide which cycles are eventful can be read from evidence rather than guessed.

### The passive event counter

A new cognitive service observes seven event types and appends one line — a timestamp and the event type — to an append-only journal beside the trajectory journal, under the identity-persistent root. Session-ending lines also carry the session's duration, so the question of which sessions count as significant becomes a matter of reading the recorded durations, not a threshold baked into the counting. The write is synchronous and flushed to disk before it returns, so an abrupt shutdown never loses a counted event. There is no in-memory tally: the count is read back from the journal on demand, which keeps it consistent with disk and removes any need to rebuild state at boot. The three goal outcomes — completed, failed, abandoned — stay as three separate tags rather than collapsing into one, so the balance between them is visible in a cycle rather than averaged away.

### Filling event_count from a derived cycle window

When a trajectory entry is committed, its `event_count` is the number of events recorded since the previous entry's end-of-cycle timestamp — a half-open window that ends at the new commit. The boundary is derived from the journal that already exists, not stored as a separate marker, so there is no cycle-reset step and nothing extra to keep in sync. The first entry, having no predecessor, counts every event recorded so far; its implicit start is simply the first event the counter ever saw. The event journal is never pruned, so events that fall outside one cycle's window remain available for the per-day view. The dependency runs one way only: the trajectory reads the counter, and the counter never reaches back into the trajectory.

### The session-ending signal, finally emitted

A session-ending event was already being listened for — the frontier writers that collect surprise and applied-lesson nodes during a session were waiting to flush their buffers when it fired — but nothing in the codebase ever emitted it, so those buffers were quietly discarded on every shutdown. This release emits it, as a dedicated step in the shutdown sequence, before the teardown that detaches those listeners, and waits for it to finish so both the frontier flush and the event counter complete before the process exits. The emission is awaited rather than fire-and-forget precisely because the shutdown continues immediately afterward; a fire-and-forget emit would race the teardown. The payload carries the session id the frontier flush reads, alongside the session's duration and message count.

### A self-expression service that was never switched on

KindTriggers — the service that turns system events into first-person thoughts on the inner-speech channel — was registered and listed for shutdown, but had been left out of the start sequence, so its subscriptions never attached and it sat inert. It now starts alongside the other cognitive observers, so the thoughts it was meant to produce can flow.

### Reading the distribution

`/trajectory events` renders the recorded events three ways: a total, a per-type breakdown ordered busiest-first, and a per-day count. It reads from the moment the counter is live, not only once the first entry is committed, so the real per-day shape is visible across the days a first entry is being authored. Committed entries now show their `event_count` in `/trajectory show`.

### Notes

- Test files: 522 → 523 (the event-counter suite: record-and-count across all seven observed types, the three goal outcomes as separate tags, session-duration capture, the half-open cycle window including exclusion of an event exactly on the boundary, restart from the journal, the commit-hook across two cycles with the derived window, and the dashboard view).
- One new source module (the event counter) and one new event type (the session-ending signal, with its payload schema) raise the module, event, and schema figures in `README.md`, `docs/CAPABILITIES.md`, `docs/COMMUNICATION.md`, and `docs/ARCHITECTURE-DEEP-DIVE.md`, which were updated to match.
- Two long-standing audit findings were cleared: two documentation lines that described a frozen subsystem with a phrase the future-reference audit reads as a forward promise were reworded as plain status, and four contract-test names whose wording incidentally matched the security-assertion heuristic were clarified without changing what they assert.

---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
