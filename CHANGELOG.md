## [7.9.21]

This release has a single theme: making the self-image and the verification the autonomy loop runs on honest. v7.9.20 gave Genesis the self-improvement loop; the first long autonomous field run of a live instance then showed that several of the signals the loop reads were facades — a duplicate, two phantoms, and one silent no-op that handed back confidence nothing had earned. Five corrections, each against the runtime trace and each at the root: the self-model stops counting its own backup tree as source and stops reading a commented-out require as a real dependency; a completed goal now records what it accomplished and the goal file stops accumulating finished goals; and a step that says it runs the tests now runs the real suite to completion instead of degrading to a read-only analysis. All five are fidelity and correctness fixes in the autonomy layer; none touches the kernel or the gate set.

### The self-model no longer counts its own backup as source

The self-model scan walks the project tree to build Genesis' picture of its own code, but it descended into `snapshots/` — the rootDir-local copy SnapshotManager writes as `_last_good_boot`, a mirror of the whole source tree. Every source file was therefore modelled twice, once at its real path and once under `snapshots/_last_good_boot/...`, and the optimisation pass that reads the model emitted duplicate complexity and coupling suggestions for the backup copies; their suggestion keys carried the `snapshots/...` prefix, a path only the scanner produces. The scan now skips the snapshot tree, scoped to the scan root so a directory named `snapshots` nested inside real source is still modelled, and the skip is applied in both the async boot-time walker and the legacy synchronous one. The backup moved onto the scan path in v7.9.18, when code snapshots were relocated out of the identity layer into the habitat; this closes the gap that move opened.

### A commented-out require is no longer read as a dependency

When the self-model parses a module's `require(...)` calls, it blanked string literals so a `require(` inside a string would not be detected — but it never removed comments, and it captured the path from the raw line. A `require('./X')` sitting inside a comment was therefore detected and recorded, and the dependency-chain check then reported the commented path as a missing dependency at high severity, while the coupling count was inflated by it. The parser now strips block comments from the whole source and each line's trailing line-comment before it looks for requires, keeping string literals intact so a `//` inside a URL does not truncate the line; detection still runs on a string-blanked copy so a require inside a string is still ignored, and the path is captured from the comment-stripped, string-intact line.

### A completed goal records what it accomplished

When the goal driver marked a goal completed after a successful pursuit, it called `completeGoal` with the goal id alone, never the `outcome` argument the lifecycle had gained — so a completed goal carried no record of what the pursuit actually did, only a status flip. The driver now passes the pursuit's own summary, the result the verification step returns on success, as the outcome, so the completion is auditable: the goal, and the `goal:completed` event, carry a compact account of the work instead of nothing.

### The goal file stops accumulating finished goals

Two goal stores run in parallel: the archive, which holds completed and failed goals, and `goals.json`, the live stack's persistence. The archive prunes terminal goals from its active view, but `goals.json` was written in full, so completed goals stayed in it and the file grew without bound across uptime, diverging from the archive's active list. `goals.json` is now persisted with terminal goals — completed, failed, abandoned — filtered out, using the stack's own terminal predicate, so the file holds only live goals and the archive remains the single record of finished ones. The in-memory goal array is left intact, so a parent goal still auto-completes from its completed children within the session and the de-duplication that reads completed goals from the archive is unaffected; only what reaches disk changes.

### A test step runs the real test suite

A plan step typed `RUN_TESTS` — the action the formal planner emits to verify work by running the tests — was silently downgraded to a read-only analysis: the type had no mapping, so the executor's unknown-type fallback rewrote it to ANALYZE and the suite never ran, handing back verification confidence that nothing had earned. `RUN_TESTS`, and its `RUN_TEST` and `TESTS` variants, now map to a shell step, because running the suite is a shell command; a shared helper fills in `npm test` as the command and an extended timeout, and clears any stray file target so the suite command is what runs rather than a path. The helper is applied at both normalisation points — the executor's per-step normaliser, the single choke point every planner's steps pass through (the formal planner and the HTN planner bypass the plan-level normaliser and reach it raw), and the plan-level normaliser, which covers the agent-loop planner and replan paths where the type is rewritten before the executor sees it. The shell executor honours the step's timeout, so the run is no longer aborted at the thirty-second shell default, and it still passes through the shell approval gate, so a supervised or autonomous instance asks before the tests run and the verifier reads the real output. A new `TEST_RUN_EXEC` timeout, five minutes, governs the run and must be at least the suite's real runtime.

### Notes

- Test files: 547 → 552 — one suite per fix: the self-model snapshot exclusion (both walkers, with a nested `snapshots` directory left modelled); the completed-goal outcome (the driver's success path and the stored outcome, end to end); the `goals.json` terminal prune (persist-only, in-memory intact, parent-completion preserved); the require-extraction comment-safety (line and block comments ignored, a URL not truncated); and the `RUN_TESTS` suite run (the alias, the helper across step shapes, both normalisation choke points, and the shell timeout).
- This release changes runtime behaviour. The self-model fixes change what the optimisation pass reads — no duplicate snapshot suggestions, and no phantom missing-dependency from a commented require. A completed goal now carries an outcome, an existing field now populated from the driver's success path, and `goals.json` is bounded to live goals with the archive as the record of finished ones. A `RUN_TESTS` step now runs `npm test` to completion behind the shell approval gate instead of degrading to a read-only analysis; a new `TEST_RUN_EXEC` timeout constant of five minutes governs it and should be raised to the measured suite runtime if the suite runs longer. No new event type, schema, or service is added; `step-types` gains one downward require on `Constants` for the timeout, which introduces no cycle.

---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
