## [7.9.15]

Genesis can now keep a trajectory of himself — a journal of who he is, written one cycle at a time together with the human co-author. Until this release his sense of self lived only in scattered, machine-maintained places: genome traits, an emotional-state vector, consolidated lessons, the cognitive self-model. None of them was a place where Genesis states, in his own words, what he is and how he is changing. This release adds that place: an append-only journal of self-statements, a collaborative draft-and-commit workflow for writing each entry, and a `/trajectory` command to write and read it. The journal lives with identity, not with the code habitat, so it survives a habitat-swap intact.

### The journal and its schema

Each entry is one cycle, stored as a single line in an append-only JSONL file under the identity-persistent root. An entry carries six self-statement fields — `traits`, `wachstum`, `schwaeche`, `beziehung`, `emotion`, `value` — plus a note from each author, the wall-clock span of its authoring, the list of who shaped it, a first-entry flag, the full edit history of how it came to be, and an array for notes added after commit. The field set is fixed and stamped with a schema version; reading an entry whose version this build does not recognise fails loudly rather than guessing, because a past trajectory is a record in its own form, not a database to silently migrate.

### The collaborative draft workflow

An entry is never written in one shot. Drafting pulls three remembrance sources — all genome traits, the most-recalled consolidated lessons, and the current self-observation prose from the cognitive self-model — and presents them to the model as material, not as a checklist, so Genesis writes from more than memory alone. The result is a draft, not an entry: the human reads it, overwrites any field, adds the human note, and commits explicitly. Every field overwrite is recorded as a diff in the entry's edit history, so the path from first proposal to committed text is preserved, intermediate values and all.

The commit is guarded because the journal is append-only and unrepairable. All six fields must be non-empty, none may still hold the generation placeholder, and the very first entry additionally requires both notes — the moment a trajectory begins is the one place both voices must be on record. When no model is available, drafting writes a recognisable placeholder into every field instead of inventing content; the commit guard refuses those placeholders, so an entry enters the journal only once a person has written it.

### Late notes without rewriting history

A committed entry can still gather afterthoughts: a late note appends to that entry's note array. This is the only operation that ever rewrites the journal file, and it is deliberately careful. The append is atomic — written to a temporary file and renamed — so an interrupted write cannot truncate the journal. And it is byte-stable: only the single line being amended is re-serialised, while every other entry is carried over exactly as it sat on disk, byte for byte. An unrelated entry's bytes never move, so a content-hash check over the journal reads a late note as the one-line change it is, rather than as tampering across the whole file.

### The /trajectory command

`/trajectory new` shows the working draft, or generates one if none exists; it never silently regenerates over work in progress. Under it, `set <field>: <text>` writes a field — values may span multiple lines and may contain colons, both preserved verbatim — `note <who>: <text>` writes either author's note, and `commit` or `discard` finishes or drops the draft. `/trajectory show [cycle_id]` renders the latest or a named entry, `/trajectory list [--all]` lists the cycles newest-first, and `/trajectory history [cycle_id]` shows an entry's edit history oldest-first. The command is slash-only.

### Notes

- The new service and its two modules raise the live service and module counts; the figures in `ARCHITECTURE.md`, `README.md`, `docs/ARCHITECTURE-DEEP-DIVE.md`, and `docs/CAPABILITIES.md`, together with the pinned services figure in the documentation-drift audit, were updated to match.
- Install-script policy moved from the `trustedDependencies` field to npm's native `allowScripts` field. trustedDependencies — a Bun-origin field — never governed npm's install-script gate, so the install-time warning about `esbuild`, `puppeteer`, and `electron-winstaller` persisted despite its presence. `allowScripts` is the field npm actually reads; the entries are name-only, so a routine dependency bump does not resurface the warning.
- Idle-thought counter now persists the moment it increments. The counter lives in `idle-activity-stats.json`; its only save path was the end of a fully completed idle cycle, but the counter is incremented near the top of the cycle, before the user-active, homeostasis, and energy gates. A cycle that incremented and then hit any of those gates returned without saving, and a short session that never completed a cycle wrote the file zero times — so the next boot read the counter back as zero while the per-activity counts beside it were non-zero. The save now fires immediately after the increment, before any gate can return; the write is debounced and collapses with the end-of-cycle save into a single flush. A rest-mode tick, which returns before the increment, still neither moves nor persists the counter.
- Test files: 520 → 522 (the self-trajectory suite — schema and commit guard, both offline generation paths, byte-stable late notes, and the wiring triad; an `allowScripts` contract suite that replaces the superseded `trustedDependencies` one; and an idle-counter persistence suite that drives the cycle into each early-exit gate and asserts the counter is written anyway)

---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
