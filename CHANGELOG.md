## [7.8.7]

**Honest test-runner + four hidden bugs surfaced and fixed.**

The pre-v7.8.7 test-runner parser had two bugs that displayed test
files as green while their failures were silently absorbed. v7.8.7
fixes the parser, then deals with every hidden failure it surfaces.
Backlog tidy alongside.

### Item 1 — Test-runner parser honesty

`test/index.js` had two parser bugs that combined to swallow
failures and miscount passes:

- **Label-prefix summaries were rejected.** Test files using formats
  like `v756-fix: 30 passed, 4 failed`, `v3.5.0 COGNITIVE TESTS: 82
  passed, 0 failed` or ANSI-coloured `Integration: \x1b[32m200
  passed\x1b[0m, \x1b[32m0 failed\x1b[0m` did not match the regex
  `^\s*(?:Results:\s*)?\d+ passed\s*[,·]\s*(\d+)\s*failed`. The
  parser fell back to `failed = 0` and displayed the file as `✅ N
  passed` regardless of how many tests actually failed inside.
- **passMatch was greedy, not multiline-anchored.** The regex
  `(\d+) passed` matched the FIRST `N passed` anywhere in stdout.
  In `suite-parser.test.js`, a mock-output line `✅ legacy comma
  format: "13 passed, 1 failed"` is printed BEFORE the real summary
  `8 passed · 0 failed`. The parser took 13 from the mock line and
  showed `suite-parser... ✅ 13 passed` instead of 8.

Fix: strip ANSI escapes, split stdout into lines, walk from the END
backwards, return the last line that matches a summary shape. The
optional prefix group now accepts both `Results:` and any
`[\w\-\. ]+:` label. The walk-from-end naturally skips mock-output
lines because the real summary is always at the end.

New contract test `v787-runner-parser.contract.test.js` covers
14 cases: standard middle-dot format, comma format with bracketed
duration, legacy `Results:` prefix, label prefixes, ANSI-coloured,
mock-demo-line followed by real summary, progress lines vs final
summary, false-positive prevention (`Health check 1/1 failed` must
not match), empty input, zero-zero summary.

### Item 2 — 5 obsolete source-regex tests removed

Once the parser was honest, five tests turned red:

- `v756-fix.test.js`: **A1, A2, A3, E3** scanned
  `src/agent/foundation/ModelBridge.js` for `_findFallbackBackend`
  signature, the `modelName === failedModelName` continue-guard,
  the cross-backend ollama check, and the `fallbackModelName`
  capture. All four patterns have lived in
  `src/agent/foundation/ModelBridgeFailover.js` (mixin) since v7.6.5.
- `v748-fix.test.js`: **B2** scanned `ModelBridge.js` for the
  `bus.fire('model:failover', ...)` emit line — moved to
  `_handleFailoverError` in the failover mixin (v7.6.5).

`v765-modelbridge-split.contract.test.js` already covers the
mixin-mount guarantee via prototype-mount and reference-identity
checks — robust against future structural moves. The five source-
regex scans were redundant and would have broken on any further
ModelBridge refactor regardless of behavioural correctness. A4
stays because it tests the ABSENCE of an old pattern (different
contract). B3 stays because it tests the actual routing.

### Item 3 — Two real hidden bugs surfaced and fixed

The parser fix also exposed two real test failures that were
hidden in every recent release:

- **`model-availability` 403 → auth.** Test fed
  `new Error('HTTP 403: requires a subscription')` and expected
  `reason: 'auth'`, but v7.5.7-fix added a `subscription-required`
  branch that matches anything containing `subscription` or
  `requires.*upgrade` BEFORE the generic auth check (Ollama Cloud
  Pro-gates carry both 403 and subscription markers; classifying
  them as `auth` would retry hourly instead of using the 24h
  subscription-TTL). Subscription-required coverage was already in
  `v757-fix-cloud-fallback.test.js`. The model-availability test
  message is now `HTTP 403: forbidden` — pure auth case without
  subscription keyword — and the assertion still expects `auth`.
- **`openpath-path-extraction` tilde expansion.** Test sent
  `öffne ~/.config` and expected `~/.config` preserved in the
  shell.run argument. But v7.5.9 Linux-fix expands `~/` to
  `os.homedir()` BEFORE `fs.existsSync` and before passing to
  `shell.run` because `child_process` spawn without `shell:true`
  passes args literally — a preserved tilde would be a literal
  `~/.config` that doesn't exist on any filesystem. Test now
  expects `path.join(os.homedir(), '.config')` and the name is
  updated to "is expanded to homedir".

### Item 4 — AUDIT-BACKLOG.md cleanup

"Deferred from v7.7.6 audit (carried forward)" section was 6 items
listed as open. Five had already been resolved in earlier releases:

- F5 / C1 — Mermaid SVG `innerHTML` without DOMPurify → v7.8.4
- F6 / B2 — Hardcoded Node v22.22.2 → v7.8.4
- B4 — Pre-deletion-audit pattern formalisation → v7.8.4
- mermaid `^10.9.1` → v11 evaluation → v7.8.4
- Sidebar splitter not draggable → v7.8.6

Only `monaco-editor`'s bundled DOMPurify remains as documentation
(upstream, not self-fixable). Section now contains only that one
entry, clearly labelled "Documentation entry only — does not count
as an open backlog item".

### Numbers

- Tests: 7552 Windows / 7551 Linux (was 7539 / 7538), +14 from
  `runner-parser-v787` contract, −5 obsolete source-regex tests.
- Modules: 360 (unchanged).
- Test files: 459 (was 458).
- Fitness 130/130, doc-drift 56/56, stale-refs ✓.

### What v7.8.7 explicitly does NOT do

Goal-DAG, Self-Gate per-Node, IntentRouter "kannst du X" /
Chrome-open double-turn, ImpactForecast Activity, DELEGATE peer
pre-check → blocker promotion. Each is its own focused release.


---

## Older releases

For prior version history, see the archive files:

- [**CHANGELOG-v7.md**](CHANGELOG-v7.md) — all v7.x.x releases (80 entries)
- [**CHANGELOG-v6.md**](CHANGELOG-v6.md) — all v6.x.x releases (12 entries)
- [**CHANGELOG-v5.md**](CHANGELOG-v5.md) — all v5.x.x releases (17 entries)
- [**CHANGELOG-archive.md**](CHANGELOG-archive.md) — v0.x.x – v4.x.x (29 entries)

This index file (`CHANGELOG.md`) keeps only the newest release inline so
the file stays readable. The major-version archives carry the full
history.
