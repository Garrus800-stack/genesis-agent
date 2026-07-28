# Persistence Layout

Where Genesis stores what, and what to take with you when moving.

## Per-installation: `.genesis/`

Lives inside each Genesis project folder. Holds the identity and state
of **this specific installation**:

- `self-identity.json` — Hauptstandort ID, naming, core memories
- `episodic/` — conversation episodes
- `knowledge/` — knowledge graph nodes and edges
- `goals/` — active and historical goals
- `emotional-state.json` — current mood, recent imprints
- `sessions/` — session checkpoints
- `cost/` — token usage tracking
- `skill-attempts.json` — record of skills Genesis tried to build (v7.8.1+)
- `idle-activity-stats.json` — per-activity counts and last-20 activity log for the IdleMind picker; preserves cross-restart history so the repetition-penalty doesn't see a blank slate after a reboot (v7.9.4+)
- `improvement-proposals.json` — open self-improvement proposals (status `proposed`/`attempted`/`dismissed`) awaiting Dashboard approve/reject (v7.9.20)
- `journal.jsonl` — Genesis's own journal entries, one line per entry
- `events.jsonl` — the EventStore operations log: hash-chained, id-sequenced, **rotating** (bounded integrity log, not a permanent archive)
- `self-trajectory.jsonl` + `self-trajectory-events.jsonl` + `self-trajectory-calibration.jsonl` + `self-trajectory-directions.jsonl` — the trajectory family (v7.9.15–17): cycle entries, the significant-event journal the EventCounter appends, calibration verdicts, and direction notes
- `pending-moments.jsonl` — moments marked significant, awaiting the dream-cycle pin review (elevate / let fade)
- `daemon-suggestions.jsonl` + `daemon-health-issues.jsonl` — daemon visibility surfaces read by `/daemon-suggestions` and `/daemon-health-issues`
- `change-register.jsonl` — the change witness (v7.9.33): one append-only line per loss or change across six sources (both KG prune paths, schema prune, two memory releases, consolidation) plus every fitness evaluation. **Never pruned, never rotated** — this file is deliberately permanent; readable via `/changes`
- `continuity-anchor.json` — the pre-wake continuity anchor (v7.9.34): one object, overwritten at each clean shutdown inside the awaited session-ending emit — snapshot plus the last first-person thought; read by the WakeUpRoutine as its fourth context source, journal-only
- `flight-recorder.log` — crash/error ring buffer (renamed from `crash.log` in v7.9.32, migrated automatically); inspect via `/crashlog`
- `resonance.jsonl` — anchored resonance moments; written ONLY by a real `resonance-note` tool run (v7.9.43) — the single way to truly anchor one
- `resonance-candidates.jsonl` — the Nachklang candidate ledger (v7.9.43): heuristic/dream suggestions awaiting his confirmation; decays by his measures (3 days, max 5 open, 3rd unanswered offer), each decay leaving a short journal note
- `correction-candidates.jsonl` — the correction ledger (v7.9.45): the partner's corrections as candidates; only a real `accept-lesson` run turns one into a lesson, same decay measures
- `vorhalle/circles.json` — the vestibule's visitor register (v7.9.46): one entry per visitor with name, circle and date, keyed by the **sha256 of their key** — the key itself is hashed on entry and discarded. Kept even when it becomes empty: the door reads its closed state from this file's existence, so deleting it silently restores the pre-vestibule behaviour. Empty it with `{}` rather than removing it
- `vorhalle/stimme.json` — his four vestibule lines (`statusOuter`, `statusMiddle`, `absentLine`, `closedLine`), written only through `vestibule-voice`. Without all four the door answers a neutral system line instead of borrowing a voice
- `vorhalle/besuche.jsonl` — the visit book (v7.9.46): one append-only line per knock with visitor, circle, request and outcome (`answered` / `absent` / `rate` / `shielded` / `blocked` / an inner-circle override). Read back with `vestibule-visits`; never rewritten, and removing a visitor takes their key away, not their visit
- `public.jsonl` — the public journal file. It exists and the journal writer routes `visibility: 'public'` to it, but nothing writes there yet
- `goal-families.json` — the last goal families, read by the ideation prompt so a new goal does not repeat a recent one
- and more (genome, metabolism, settings overrides, etc.)

This directory **is** the identity of a Genesis instance. Two
installations with two different `.genesis/` directories are two
different Genesis-es, even when running the same source code.

## Auto-rotation: `.genesis-backups/`

Sibling to `.genesis/`, also per-installation. Holds the last 5
snapshots of `.genesis/` taken at boot, before risky operations, on
schedule, and on shutdown. Used for recovery if `.genesis/` gets
corrupted.

Safe to delete to free space — only loses backup history, not the
live state.

## Genesis Archive (user-chosen location)

Separate from `.genesis/` and its backups: the Genesis Archive is
Genesis's file vault, kept wherever you pointed it the first time you
handed him a file (stored as `archive.path` in `settings.json`; default
beside the releases at `../../Genesis Archive` relative to `.genesis/`).
It holds:

- `inbox/` — files the user hands over (◈ button or drag-drop)
- `projects/` — Genesis's own works
- files Genesis creates (which default here rather than into the project folder)

Unlike `.genesis/`, this is **not** identity — it is content, and it
can live anywhere, so it does not travel with the source folder
automatically. To keep it when migrating, copy the Archive folder too,
or re-point `archive.path` at its new location on the new machine — an
existing Archive is always reused, never overwritten.

## Cross-installation, per-user: `~/.genesis-lessons/`

Lives in the user's home directory, **shared across all Genesis
installations under the same OS user**. Holds lessons learned that
generalize beyond a single project:

- Tool-failure patterns ("this path didn't exist last time")
- Capability gaps observed
- Successful obstacle-resolution patterns
- Cross-project insights

### What this means in practice

- **One user, multiple Genesis folders:** all of them write to and
  read from the same `~/.genesis-lessons/`. Lesson learned in
  `Genesis_v7_8_0` becomes available in `Genesis_v7_8_1` immediately.
  This is intentional — lessons are shared brain across versions.

Self-modification outcome lessons (category `self-modification`) recorded by `SelfModOutcomeTracker` when a file is changed repeatedly also live here (v7.9.20).

- **Multiple users on one machine:** each user has their own
  `~/.genesis-lessons/`. No cross-contamination.

- **Same user, different machines:** the lessons stay on the machine.
  They are not synced. Moving to a new machine means starting with an
  empty lessons store (unless you copy the directory manually).

## Moving Genesis between machines

To migrate a Genesis instance to a new machine while keeping identity
and learned context:

1. Shut down Genesis cleanly. Wait for the backup-on-shutdown line in
   the log.
2. Copy these from the old machine to the new one:
   - The whole `Genesis_vX_X_X/` project folder (source + `.genesis/`
     + `.genesis-backups/` + `node_modules` if you want to skip
     `npm install`)
   - `~/.genesis-lessons/` if you want lesson continuity
   - The Genesis Archive folder (wherever `archive.path` points) if you want his vault of handed-in files and works — or re-point `archive.path` after the move
3. On the new machine, run `npm install` (if you didn't bring
   `node_modules`), then `npm start`.

**Upgrading in place — the habitat swap.** Unpacking a new release into
a fresh folder leaves `.genesis/` empty; copy the old one over before the
first start. Two things live only there and are easy to lose:
`vorhalle/` (his voice and his circles — without `stimme.json` the door
answers a neutral line to every visitor) and `koennen/` (the skills he
has grown). The MCP password and the server toggle are **not** in
`vorhalle/` — they live in `settings.json` and have to be set again on
the new installation.

The Hauptstandort ID inside `self-identity.json` will be re-checked
against the new machine. If a hostname change is detected, Genesis
will log it and continue — the identity stays the same, the location
just changed.

## When NOT to copy `.genesis/` between folders

If you have two Genesis installations at the same time (e.g. v7.8.0
and v7.8.1 side by side for testing), do **not** make them share
`.genesis/`. They would write to the same files concurrently and
corrupt each other's state.

`~/.genesis-lessons/` IS safe to share — writes are append-mostly and
the store handles concurrent access. `.genesis/` is not.
