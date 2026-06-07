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
3. On the new machine, run `npm install` (if you didn't bring
   `node_modules`), then `npm start`.

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
