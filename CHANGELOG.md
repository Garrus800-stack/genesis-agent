## [7.9.25]

A verification pass over the v7.9.24 identity and model layers, read against a long autonomous field run, surfaced a set of defects that shared one trait: each failed quietly. A genome write that hit a transient lock on shutdown was swallowed as a warning; a session summary that ran past its budget left its recovery checkpoint stranded; deleted goal checkpoints left their integrity records behind as permanent phantom warnings; a cloud model that had been retired was retried first on every single call; an emotional alert re-fired on every check; and the idle mind kept proposing the same idea under slightly different words. This release closes each at the root so the agent runs clean, with no workaround left standing behind a fix. Every change is against the runtime trace and at the root; none touches the kernel or the gate set.

### A transient lock on a shutdown write is retried, not lost

The atomic write path stages a temporary file, fsyncs it, and renames it into place — and on Windows that final rename can briefly fail with `EPERM` or `EBUSY` when a scanner or indexer is holding the target for a moment. The synchronous write used at shutdown took that failure as final, and the genome's own sync persist logged it only as a warning, so the last write of an identity could vanish silently. The rename now retries a transient lock with a short backoff, but the blocking retry is gated to a shutdown window that the health component opens around the teardown burst and closes in a finally — so a normal-operation sync write, of which many components issue, never blocks the event loop on a retry. The asynchronous path retries the same transient locks without blocking, the file descriptor used for the fsync is now closed even when the fsync itself throws (it previously leaked on that path), and a genome write that still fails after the retries is logged as an error, because at that point the loss is real and must be visible.

### A slow session summary writes its fallback instead of stranding the checkpoint

The shutdown summary asks the model for a two-line recap, and the eight-second budget for that call used to live in the caller, racing the whole summary method against a timeout. When the timeout won, the method's own catch — which writes a deterministic fallback summary and deletes the crash-recovery checkpoint — never ran, so on a slow model neither the real summary nor the fallback was written, and the checkpoint survived to resurface as a stale recovery on the next boot. The budget now lives inside the summary method, racing only the model call, so a timeout rejects into that existing catch: the fallback is written and the checkpoint deleted on the slow path exactly as on the fast one. The caller passes the configured timeout through and no longer races a parallel one.

### The shutdown-summary skip guard reads the field that exists

The guard that skips the summary for a session too short to be worth recording read `sess.startTime` — a field the session object does not have. With the value always undefined the elapsed time computed as zero, so the age half of the test was inert and the skip degenerated to "skip when empty." The guard now reads `startedAt`, the real field, which is an ISO-8601 string, and parses it to a timestamp before comparing — reading the field without parsing it would have broken the comparison a second way. An unparseable value is treated as elapsed zero, and because a session with real content fails the empty half of the test, it is never wrongly skipped.

### Deleted checkpoints no longer leave phantom integrity records

The store keeps a checksum per file and verifies them at boot; deleting a file did not remove its checksum, so every goal-step checkpoint deleted on goal completion left an integrity record pointing at a file that was gone, and the boot verifier reported it as missing forever. Delete now clears the checksum once the file is gone — and only then, so a delete that fails to unlink keeps the record for the file that is still there. The checksum manifest gains a `{schema, checksums}` envelope, which lets a one-time migration on first load drop exactly the ephemeral goal-step orphans whose files are already gone while keeping a genuinely missing critical file flagged, so the integrity guard means something again.

### A retired cloud model is marked gone, not retried first every call

Failover classifies why a model call failed to decide how long to skip that model, and a retired cloud model returns HTTP 410 — a status the classifier had no branch for, so it fell through to a generic reason with no skip duration and the dead model was retried first on the next call, and the one after that. The classifier now recognizes a retired or decommissioned model, matching the 410 status only in a status-code context so an unrelated token count cannot trip it, and it makes that call before the authentication check so a 410 that also mentions a key still earns the retired reason rather than the short auth one. A retired model carries an effectively-permanent skip that self-heals after thirty days, so failover moves to the next model immediately instead of beating on the gone one.

### An unresolved backend falls back to local instead of warning on every call

During the boot window the active backend can still be null until the real model resolves, and a call in that window threw "No model backend configured," which the caller turned into a failover warning every time until the switch landed. The dispatch path now treats an unresolved backend as a fall-back to the always-present local backend at debug level, and reserves the throw for genuine misconfiguration — the local backend itself being absent. A configured backend is used exactly as before; only the unresolved case changes.

### The idle mind stops repeating itself under different words

The knowledge graph deduplicates ideas by exact normalized label, so "Personalized Learning Path Generator" and "Personalized Learning Pathway Generator" landed as two separate nodes and the same idea recurred across idle cycles. Ideation now feeds the recent ideas back into the brainstorming prompt so the model can diverge, and measures a fresh idea against them with a TF-IDF cosine similarity — the 0.40 threshold is measured on the real idea distribution, where genuine near-duplicates cluster well above it and distinct ideas well below. A near-duplicate triggers a single retry with a stronger hint; if the retry is still close the first idea is kept, because ideation must not stall in a loop.

### The emotional watchdog alert fires once per episode, not every tick

The watchdog resets a dimension stuck at an extreme for too long, and that per-dimension reset is self-limiting; the alert it raises when two or more dimensions are stuck at once was not, so it re-fired on every check interval for as long as the dimensions stayed stuck. The alert is now edge-guarded: it fires on the transition into the two-or-more-stuck state and re-arms only after the count drops back below two, so a single stuck episode raises a single alert. The reset path is unchanged.

### Notes

- Test files: 578 → 586 — one focused suite per fix: the write-path retry gating, the descriptor close on a throwing fsync, and the transient/non-transient split; the summary timeout writing its fallback and deleting the checkpoint; the skip guard reading and parsing `startedAt`; the checksum lifecycle, envelope, and one-time orphan migration; the retired-model classification with its false-positive guard and TTL wiring; the null-backend fall-back and the preserved genuine-misconfiguration throw; the ideation similarity backstop with measured thresholds; and the watchdog alert edge guard with the reset path intact.
- This release changes runtime behaviour mostly at the edges. On Windows a transient lock during a shutdown write is now retried rather than lost; a slow shutdown summary writes its deterministic fallback; a retired cloud model is skipped for thirty days instead of retried each call; and the emotional watchdog alert is edge-triggered. On a healthy run with a resolved backend and no stuck dimensions, none of these paths fire.
- No new source files. The new surface is a set of helper functions inside the files they serve — the storage rename-retry and shutdown-window methods, the session-summary skip decision, and the ideation recent-idea and similarity helpers — plus the checksum envelope and the retired-model reason with its skip duration. Two values, the skip decision and the skip-duration map, are exported for their tests.

---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
