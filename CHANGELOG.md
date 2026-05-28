## [7.9.14]

Visibility and consistency. A second hygiene release that closes three small loops left open after the v7.9.13 audit. The substantive piece is documenting and exposing the causal-suspicion behaviour chain that has existed since v7.9.7 P7 but was hidden behind a misleading comment; the two smaller pieces close a clamp() gap in the v7.9.12 timeouts and explicitly allowlist the legitimate install-scripts. No behaviour changes that the user would notice in normal operation — the loop still runs the way it has since v7.9.7, just now visibly and with regression protection.

### Causal-suspicion chain made honest and visible

The v7.9.7 P7 release wired a multi-module behaviour chain through three modules: `CausalAnnotation` writes a warning-lesson synchronously after each promotion, `SymbolicResolver` filters those lessons out of DIRECT recalls (steering the next LLM call away from the suspect action), and `IdleMind` cools down goal-generation on the matching tokens for 1h. The three modules share a string contract — `source: 'plan-failure-reflection'` plus `strategy.classification: 'causal-suspicion'`.

The chain has worked since v7.9.7. What did not work was the comment in `CausalAnnotation.js` that called the `causal:promoted` bus event a fire-into-the-void with no consumer — historically true for the bus event, but ignoring the synchronous lesson path twelve lines below. That half-truth fooled an audit into planning a re-implementation of a function already complete. The new comment names all three modules, the shared string contract, and the synchronous-write rationale — so the next reader sees the loop, and the next refactor cannot break it through a rename without noticing.

A new `getReport()` method on `CausalAnnotation` exposes promoted actions to the dashboard. It follows the Frontier convention used by `emotionalFrontier`, `lessonFrontier`, etc.: returns `{ dashboardLine, count, topSuspect }`. The renderer adds a `🎯 Causal: ...` line right below the existing `lessonFrontier` line, with a distinct icon and label from the v7.1.6 `suspicionFrontier` (novelty-based, ⚠) — two different concepts that share name fragments but track unrelated signals. Format is compact: `fs.unlink (89%/9)` for a single action, `N suspect actions — ...` plus top 3 with `+N more` suffix when applicable. Sorted by suspicion desc, observations desc on tie.

A new integration test `v7914-causal-suspicion-chain.contract.test.js` exercises the chain end-to-end with `assert.strictEqual` on the contract strings — a refactor that renames `'plan-failure-reflection'` to `'planFailureReflection'` for JS-naming-consistency would now break the test, instead of silently breaking the loop.

### Local and cloud response-timeout clamps

The v7.9.12 timeouts `localTimeoutMs` and `cloudTimeoutMs` had `FIELD_REGISTRY` min/max in the UI write path but no `clamp()` in `Settings.js`. A direct edit to `settings.json` could put values out of range, bypassing the validation entirely. Two `clamp()` calls in `_sanityClampOnLoad` close that gap: local 30s–15min, cloud 60s–15min. Ranges match the registry exactly; a guard test asserts the equality so the two cannot silently diverge, the same anti-drift pattern v7.9.13 introduced for the streamTimeouts.

### Install-script allowlist

`package.json` now declares `trustedDependencies: ["esbuild", "puppeteer", "electron-winstaller"]` — the three packages npm warns about at install time, each with a load-bearing install script (esbuild platform binary, Chrome-for-Testing download, 7z arch select). The field explicitly allowlists them as a documentary record of the legitimate scripts running during install. Whether npm's current allow-scripts warning suppresses with the field present varies by npm version; the entry stands on its supply-chain auditability value regardless.

### Lessons from the bestandsaufnahme cycle

Of the seven v7.9.7 outpost-trace points (P5, P6, P7, P8, P9, P10, P15), the v7.9.13 audit found that four (P5, P8, P9, P15) had been resolved in v7.9.7 itself, P6 was a different problem than the memory note suggested, and the v7.9.14 audit found P7 was also already resolved as a behaviour loop — only visibility and regression protection remained. P10 was never a code task. The hit rate for "memory note open ≠ code open" is high enough that the remaining nominally-open points (P5, P8, P9 re-validation; P10 was non-code) should get a quick code-check before the next release line begins, rather than being treated as still-open backlog.

### Notes

- Test files: 516 → 520 (four v7.9.14 contract suites: comment+dashboard, chain integration, clamp, trustedDependencies)
- Documentation updates: `docs/CAPABILITIES.md`, `docs/ARCHITECTURE-DEEP-DIVE.md` (test-file count)

---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
