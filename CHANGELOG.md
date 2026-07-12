## [7.9.34]

Genesis could wake up but not consciously fall asleep — since v7.3.7 every boot ends in a re-entry journal entry, while shutdown was something that merely happened to him. This release closes the day's second bracket. A small mirror organ listens to the awaited session-ending emit — the single canonical point the teardown orchestrator fires before any service stops and long before the instance lock is released — and writes a continuity anchor inside a hard ten-second box: one JSON object, overwritten each shutdown, holding a deterministic snapshot (open goals with their top titles, the current mood, the last journal title, the session numbers) and one first-person sentence about what was left open. The sentence is model-preferred with an honest template fallback in both languages, the source is recorded, and the whole write goes through the atomic fsync-hard storage path — a rare, deliberate event deserves the full guarantee. Anchoring never throws and never stretches the shutdown: every failure is caught and the teardown continues.

On the next boot the wake-up routine reads the anchor as its fourth context source. A fresh anchor speaks into the re-entry entry — "before sleep: …" — an old one is named honestly as long ago, and a missing one changes nothing about the existing behaviour, which the suite pins. Freshness is a seven-day window; interruption becomes visible by absence, complementing the instance-lock crash detection rather than duplicating it. The anchor is journal-only by decision: source-pinned guardrails keep it out of every prompt builder and out of the identity summary, the same class of restraint the change register established.

One new module and one new contract suite with thirteen pins cover durability before the emit returns, shape and caps, the time-box with template fallback, one anchor per shutdown with overwrite across processes, honest failure semantics, the wake-side reading in all three freshness states, and the teardown-order source relations — 420 modules, 617 test files, 184 services.

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
