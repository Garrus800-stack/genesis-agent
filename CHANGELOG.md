## [7.9.11]

Four small, scoped corrections that give Windows-Genesis back the ability to read its own source code without recovery detours, restore meaningful failure messages so the lessons pipeline can classify them, sharpen knowledge-graph search for everyone, and close the dashboard inconsistency where `thoughtCount` reset to zero on every restart. No new themes, no broad refactors — each fix targets a concrete bug observed in the 2026-05-25 Windows field-trace or one missed line in v7.9.10's `IdleMindActivityStats` payload.

### IdleMind thoughtCount persistence

The dashboard inconsistency the Win field-trace surfaced was `0 thoughts · idle 24min` rendered right next to `explore 5 · ideate 5 · reflect 4 · plan 4 · research 4` — 22 stored activities and a counter reading zero. Cause was straightforward: `_saveActivityStats` wrote `activityCounts` but never `thoughtCount`, so the constructor's `this.thoughtCount = 0` survived every restart. The fix adds `thoughtCount` to the write payload and restores it on load. Legacy stats files from v7.9.10 and earlier fall back to `sum(activityCounts.values())` — a lower bound (skip-cycles weren't counted at all pre-fix) but vastly better than the visible reset to zero.

The counter remains "grossly accurate" by design, not bookkeeping-precise. `thoughtCount++` runs in `_think()` before the skip-checks (user-active < 60 s, homeostasis-block, low-energy), but `_saveActivityStats` only fires through `_recordActivity` after a successful activity run. Skip-cycles increment in memory without persisting — roughly 9 % drift over a typical session. Genesis is not a ledger; the counter is a dashboard indicator and the comment in `_saveActivityStats` documents the trade-off so future readers don't expect exactness.

### KG-search TF-IDF + file-token boost

The Win field-trace also showed the SEARCH step in the "Reflect on Reflect.js" goal returning two irrelevant results out of five — a `daily-digest` idea node and a `CognitiveWorkspace.js` insight, neither of which referenced `Reflect.js`. The downstream ANALYZE step then produced a "Path Handling Vulnerability" hypothesis extrapolated from the wrong context. Pre-fix `search()` treated every query word equally (+2 for text match, +3 for label match), so a generic idea-node that happened to contain "reflect" outranked a specific insight tagged with `properties.file = 'src/agent/autonomy/activities/Reflect.js'`.

The new scoring runs in a single pass: pass one builds a per-node text cache while counting document frequency per query word, pass two scores with inverse document frequency so rare tokens (file names, specific identifiers) outweigh common words like "all", "from", "the". A file-token boost kicks in when the query contains a recognised extension pattern (`X.js`, `X.ts`, `X.md`, `X.json`, etc.): nodes whose `properties.file` matches gain +10, nodes with no file property at all that matched only via generic terms are demoted to 40 % of their score. The IDF formula `log(N / (1 + freq)) * 1.5` is clamped at a floor of 0.5 so it stays positive in the edge case where a small KG has the query word in every node — without the floor, `learnFromText` recall broke because the score went negative and the matching node fell out of `if (score > 0)`.

Existing `searchAsync` calls `search()` internally as its `keywordResults` source, so the improvement flows into the hybrid keyword + vector ranking too (60/40 weighted). Empty queryWords (short-only queries like `"a is the"`) preserve pre-fix behaviour exactly — the word loop runs zero times and scoring falls through to the recency + connectivity + access components, returning all nodes ranked by freshness.

Performance at realistic KG sizes (33–50 nodes from the field-trace) is sub-millisecond. At 10 000 nodes the single-pass implementation measures around 34 ms, irrelevant for the current scale.

### Forward-slash path adaptation in ShellOSAdapter

The visible Win field-trace symptom was the SHELL step in the same Reflect.js goal failing with `Die Syntax f�r den Dateinamen, Verzeichnisnamen oder die Datentr�gerbezeichnung ist falsch`. Two bugs combined into one user-visible failure. The first: `ShellOSAdapter.adaptCommand` translated `cat src/agent/X.js` to `type src/agent/X.js` (correctly swapping the binary) but left the forward-slash path intact, so cmd.exe interpreted `/agent` as the switches `/a /g /e /n /t` and reported a syntax error. Genesis's plan then needed two extra recovery steps (a SEARCH workaround, then an ANALYZE second-attempt) to read what should have been a single SHELL invocation.

The fix adds an `adaptPaths(cmd)` helper called inside `adaptCommand` after the program-name swaps (so `cat → type` runs first) and before the find/grep canonicalisers (which produce their own cmd switches like `/V /C`). `adaptPaths` walks the command quote-aware, splits on whitespace, and runs a `_looksLikePath` classifier per token. Single-letter or short-word tokens after `/` are recognised as cmd switches and preserved (`/V`, `/c`, `/verbose`, `/q`, `/e`). Tokens starting with `./` or `../` are explicit relative paths and get converted. Tokens with a multi-segment `letter+/letter+` pattern are paths and get converted. POSIX absolute system paths (`/var`, `/etc`, `/usr`, `/tmp`, `/home`, `/root`, `/opt`, `/mnt`, `/sys`, `/proc`, `/dev`) are preserved deliberately — they should fail loudly on Windows rather than be silently rewritten to a non-existent location. Protocol URLs (`https://`, `file://`, `ftp://`) are preserved. Quoted strings pass through unchanged.

Fifteen tests in `v7911-shell-path-adapter.contract.test.js` pin the behaviour, including six checks specifically for cmd-switch preservation (`find /V /C ":"`, `find /v /c ""`, `xcopy /e /i src/foo dst/bar`, `rmdir /s /q somedir`, `dir /b`, `type /q somefile`) so a future regex change can't silently break the find/xcopy/rmdir/dir family. All twenty-four existing `shell-os-adapter.test.js` tests remain green; the v7.5.4 find canonicaliser still rewrites `find /v /c ""` to `find /V /C ":"` as before — the path adapter runs before it and doesn't touch the switches.

### Windows console codepage decoding

The second bug in the same field-trace symptom: even when cmd.exe ran successfully, its German error messages came back as `Die Syntax f�r den Dateinamen` because cmd.exe writes its output in the active console codepage (cp850 on German Windows, cp437 on English Windows, sometimes cp1252) and Node's `encoding: 'utf-8'` mistook those bytes for UTF-8, producing `U+FFFD` replacement characters. The lesson pipeline saw classification-resistant strings full of replacement noise and couldn't tag them as `'structural'` — the v7.9.10 widened `stableClass` gate caught them as `'unclassified'` rather than dropping them, but the resulting lessons carried no useful semantic content for the `SymbolicResolver` to match against later.

New module `src/agent/core/shell/WinConsoleEncoding.js` provides three exports: `detectConsoleCodepage()` runs `chcp` once at boot to read the active codepage and caches the result; `decodeWinConsole(buf, codepage?)` decodes a `Buffer` from cmd.exe output to a UTF-8 JavaScript string; `getCachedCodepage()` is a synchronous accessor with a locale-default fallback (cp850 for DE/FR/ES/IT/PT, cp437 otherwise) used when detection hasn't completed yet. The module is no-op on non-Windows — `detectConsoleCodepage()` returns `'utf-8'` instantly, `decodeWinConsole` simply passes strings through and returns empty for `null`/`undefined`.

Decoding uses `iconv-lite` (the only new dependency: 40 KB, zero transitive deps, the standard pattern in the Node ecosystem for OEM codepages). Node's built-in `TextDecoder` supports `cp1252` but not `cp850` or `cp437` — the WHATWG Encoding Standard excludes the DOS codepages that cmd.exe defaults to, so `iconv-lite` is the only sensible choice. If the `require` fails in a minimal install, decoding falls back to `latin1` (1:1 byte mapping, never throws, no `U+FFFD` noise — accented characters may be slightly off but surrounding ASCII reads correctly).

The pattern is applied at eight call sites that previously used `execFileAsync(..., { encoding: 'utf-8' })`: the `shell` / `git-log` / `git-diff` tools in `ToolRegistry`; `ShellAgent.run` (both the shell-mode and execFile-mode success paths plus the error path); the git `status` and `branch` calls and the PowerShell file-count in `ShellAgent`'s project-scan; and the SHELL-step fallback in `AgentLoopSteps`. Each site reads raw `Buffer` on Windows (`encoding: isWin ? 'buffer' : 'utf-8'`) and runs `decodeWinConsole` before any `.slice(...)` — decoding before slicing matters because slicing a `Buffer` could cut mid-multibyte sequence and produce garbage characters at boundaries.

Boot-integration is a fire-and-forget `detectConsoleCodepage()` call at the end of `AgentCoreBoot` Phase 0. The promise resolves in roughly 50–200 ms; shell tools invoked before resolution use the locale-default fallback, which is correct for the German/English Windows cohort that prompted the fix. Linux and macOS are unchanged — the `if (isWin)` guard skips the new path entirely.

### Numbers

- Tests Win baseline: 8166 (8135 + 31 new) — 3 thoughtCount, 5 KG-search TF-IDF, 15 shell path adapter, 8 WinConsoleEncoding
- Tests Linux: 8121 + the existing dompurify-related upstream failures unchanged
- audit-doc-drift: 57/57 doc claims match live values
- audit-service-numbers: 12/12 service/module counts match
- New dependency: `iconv-lite ^0.6.3` (40 KB, zero transitive)
- Documentation updates: `README.md` (modules badge 379→380), `ARCHITECTURE.md` (modules count), `docs/ARCHITECTURE-DEEP-DIVE.md` (Source Modules, Test Files, npm Dependencies, src/ total), `docs/CAPABILITIES.md` (test files row, source modules count)

---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
