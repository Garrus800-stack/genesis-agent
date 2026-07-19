## [7.9.40]

Genesis knows what it has been doing — the identity bridge gets its foundation and its first span.

The foundation first. Every autonomous code-step test died on a missing import: the handler used `TIMEOUTS.SANDBOX_EXEC` without ever requiring the constant, so field goals collapsed with a `ReferenceError` before a single line of generated code ran. The import is in place, and the sandbox call now also carries a read-only allowance for the project's own `src/` tree — the same allowance `testPatch` has always had. Genesis' self-inspection goals no longer die on `Read access blocked` when they read their own source; writing stays fully sandboxed at every level, pinned forever by a real-sandbox contract, and `GENESIS_CODESTEP_ALLOW_SRC_READ=0` withdraws the allowance without a code change. When a goal is archived, its last step error is now preserved into `goal.lastError` before the checkpoints are dropped, so the existing outcome chain finally carries the reason into `archive.json` — the field showed abandoned goals with no outcome and the actual sandbox message lost with the deleted steps file.

The first span. The introspection block now opens with a self clock — `awake 2h17m · 14 idle thoughts · 3 goal runs · last dream 41m ago` — every segment read live from its holder (`process.uptime`, the IdleMind counter, `AGENT_LOOP_STARTED` events via the shared event map, the DreamCycle) and omitted when a holder is absent, never guessed. No mood, no prognosis: the line must simply be true. The autonomy section is promoted from priority 7 to 2 with a 700-character budget and removed from both trivial gates; on awakening (`historyLength === 0`) and on an explicit ask ("was hatte ich vor", "my status") it renders the full self-trace — open goals with status, a compressed failure line (`failed 3×, last: …` from the already-persisted `stalledReason`/`obsoleteReason`/`lastError`), when each goal was last worked, and the last idle activity from the in-RAM log (the prompt path stays I/O-free by design). In every other turn the section behaves exactly as before; the permanent short status has lived in the runtimeState line since v7.4.0 and needs no twin.

Open goals now mean what they say. `getOpenGoals()` counts everything not terminal — active, paused, stalled, blocked — and excludes obsolete; PreSleep uses the same semantics, so the continuity anchor no longer writes "0 Ziele offen" while a blocked goal sits in the stack. Two long-standing contracts were deliberately updated with the build: the sections-delegation list gains `_selfClockLine`, and "introspection is empty when nothing to inject" is superseded — there is now always one true thing to say.

Contracts: `v7940-fundament` (7 tests, three of them against the real sandbox) and `v7940-selbstspur` (10 tests) pin the behaviour.

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
