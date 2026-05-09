# Genesis Agent — Audit Backlog

> Version: 7.7.5 · Audit findings, monitor items, and resolution status.

This document tracks all audit findings, monitor items, and their resolution status.
Referenced from [ARCHITECTURE.md](ARCHITECTURE.md). Per-version details in [CHANGELOG.md](CHANGELOG.md).

---


## Resolved in v7.7.1

### Drift-cleanup wave (closes the v7.6.x → v7.7.0 staleness backlog)

The v7.7.0 audit-doc-drift extension (40 → 50 claims) caught the
*structural* drift sources but left blind spots in **header stamps**,
**inline stats**, **version tables**, **key-numbers tables**, and
**self-referential script headers**. v7.7.1 closes those.

**13 doc drift sources patched** (and now under audit going forward):

1. `ARCHITECTURE.md` Z.6 — header version stamp `7.6.1 → 7.7.1`
2. `ARCHITECTURE.md` Z.6 — header `458/458 → 453/453` events/schemas
3. `ARCHITECTURE.md` Z.9 — header `6606 tests, 127/130 → 6905, 130/130`
4. `ARCHITECTURE.md` Z.510 — inline `Current stats: 424 → 453`
5. `ARCHITECTURE.md` Z.395, Z.665, Z.760 — three `5668 tests` references
   bumped to `6905`
6. `docs/ARCHITECTURE-DEEP-DIVE.md` Key Numbers table — Source Modules
   `322 → 330`, Test Files `384/6650 → 406/6905`, npm Dependencies
   `3 prod + 3 opt + 6 dev → 3 prod + 1 opt + 9 dev`, src/ total
   `306 modules → 330 modules`
7. `docs/CAPABILITIES.md` Z.259 — test files row `384/6709 → 406/6905`
8. `docs/COMMUNICATION.md` Z.43 — baseline marker `(v7.6.3 baseline)
   → (v7.7.1 baseline)`
9. `docs/MCP-SERVER-SETUP.md` Z.3 — header version `v7.7.0 → v7.7.1`
10. `AUDIT-BACKLOG.md` Z.3 — header version stamp
11. `SECURITY.md` supported-versions table — rotated by-one
    (`7.7.x ✅`, `7.6.x ⚠`, `7.5.x ❌`)
12. `README.md` Z.198 + Z.532 — Node version `20+ → 22+`
13. `README.md` Z.557 + Z.562 — module count `273 → 330`, test-suite
    line `335 files, 5668 tests → 406 files, 6905 tests`

**30 stale script-header version stamps removed.** All `scripts/*.js`
files (except `diagnose-v741-d0.js` whose version is part of identity)
now use the standard form `// GENESIS — scripts/foo.js` without
parenthesized version. Per-stamp upkeep was prohibitive — they sat
between v3.12.0 (most stale) and v7.6.4 (least stale). Anti-drift
check added in `audit-doc-drift.js` to prevent re-introduction.

**File-Size-Guard scope extended.** `architectural-fitness.js`
File Size Guard now walks both `src/agent/` and `src/ui/` (323 files
instead of 306). New `FILE_SIZE_CAPS` constant (cap-and-shrink pattern,
analogous to the existing `EXEMPT_CAPS` for method counts in the
God Class check) caps `settings.js` at 1068 LOC as a known
Mixin-Split candidate.

**Engine baseline corrected.** `package.json:engines.node` `>=18.0.0`
→ `>=22.0.0`. Node 18 reached EoL April 2025; Node 20 reached EoL
April 2026. Listing EoL versions as supported was a security-relevant
false claim. README and `test/index.js` declarations brought into
alignment.

**README dependencies block streamlined.** The hardcoded JSON snippet
(`Optional (3) ... Dev (6):`) had drifted in *both directions* against
`package.json` — electron/electron-builder were newer in README,
puppeteer/monaco-editor newer in `package.json`. Replaced by a single
paragraph + link to `package.json` to collapse the two pflege-stände.

**File-Size-Guard comment drift fixed.** The block-header in
`architectural-fitness.js` Z.687–688 had stated `Warn >600 LOC, fail
>800 LOC` while the code used 700/900. Self-referential drift in
the drift-checking auditor itself. Corrected.

### Stats / fitness / audits at v7.7.1

- 6871 tests (Linux baseline), 6905 (Win baseline) — +15 across
  both for new v771-* contracts
- Architectural fitness: **130/130** (unchanged but now reflects
  Agent + UI source basis)
- File Size Guard scope: 306 → 323 files
- audit-doc-drift checks: 40 → **53**
- CI gates: 15 (unchanged)
- Min Node version (declared): 18.0.0 (EoL) → **22.0.0** (Active LTS)
- Stale script-header stamps: 30 → **0** (anti-drift-check active)

### Items still deferred (no Score-pressure)

- **`src/ui/modules/settings.js` Mixin-Split (1068 LOC).** ✅ Resolved
  in v7.7.2 — see above. Split was concern-based (not mixin-based) into
  7 settings-* sub-modules + 2 separate non-settings modules. Facade
  is 64 LOC.
- **CLEANUP-PROTOCOL.md formalisierung des Vor-Lösch-Audits.** Eigene
  Doku-Release.
- **11 docs not yet covered by audit-doc-drift**: BENCHMARKING.md,
  BUG-TAXONOMY.md, DEGRADATION-MATRIX.md, GATE-INVENTORY.md (header
  abgedeckt seit v7.7.1), MCP-SERVER-SETUP.md (header abgedeckt seit
  v7.7.1), ONTOGENESIS.md, QUICK-START.md, SETTINGS.md,
  SKILL-SECURITY.md, TROUBLESHOOTING.md,
  phase9-cognitive-architecture.md. Mechanical extension; defer to
  audit-extension-scope release.
- **Major-Bumps für `electron`, `electron-builder`, `puppeteer`,
  `monaco-editor`, `mermaid`.** Major-Bumps können Breaking Changes
  haben (Electron besonders); gehört in eigene Toolchain-Maintenance-
  Release, nicht in Cleanup.
- **`src/agent/hexagonal/CommandHandlersInstallDB.js` Z.108–109**
  hardcoded Node v20.18.1 als Auto-Install-Target. ✅ Resolved in
  v7.7.2 — see above. Bumped to v22.22.2, aligned with engines.node.
- **8 events emitted without subscriber** (carry-forward from v7.6.7
  baseline=8): goal:stalled, error:trend, lesson:learned,
  narrative:updated, memory:consolidation-failed,
  model:unavailable-cleared, reasoning:started, symbolic:resolved.
  Pinned via ratchet; not regressions.
- **ImpactForecast.fragilityDelta** — nie implementiert. Brand-new
  feature, kein Cleanup.

---

### Resolved post-release (Hotfix in v7.7.1)

**Auto git-init + auto-commit gated behind opt-in settings (default off).**
Found during cross-platform verification of v7.7.1: Genesis was creating
a `.git` directory + initial commit (with hardcoded `user.name=Genesis,
email=genesis@local`) on every `npm install`/`npm test`/`npm start` in a
fresh checkout — without any setting to control it. The
`commitSnapshotOnShutdown` setting (default off since v7.5.7) only
covered the shutdown-commit path; the `SelfModel.scan()` initial-init
path was hardcoded.

Three Genesis-internal git-mutation paths gated:

1. **`SelfModel.scan()` Z.108-126** — `git init` + initial commit →
   `agency.gitAutoInit` (default false)
2. **`SelfModel.commitSnapshot()`** (called by `Reflector.js`,
   `SelfModificationPipelineModify.js` pre/post code-change boundaries)
   → `agency.gitAutoCommit` (default false), no-op when off
3. **`SelfModel.rollback()`** (called by `DeploymentManager` for
   auto-rollback) → `agency.gitAutoCommit`, throws with pointer to
   `.genesis-backups/` as fallback when off

Plus **`MultiFileRefactor.refactor()`**: `autoCommit` parameter default
flipped from hardcoded `true` to settings-derived
(`agency.gitAutoCommit`). Explicit `autoCommit: true` callers keep
working (backward-compat).

**State-preservation when both settings are off:** SnapshotManager
(`.genesis/snapshots/_last_good_boot/`) and GenesisBackup
(`.genesis-backups/<timestamp>/`) cover the same semantic use case via
file-copy. They were always running as primary layers; the git path was
a third redundant layer that ran without consent.

**UI:** two new toggles in Settings → Agency block (directly under
`commitSnapshotOnShutdown`). 8 new i18n strings (4 EN + 4 DE).

**Test coverage:** `v771-git-auto-gating.contract.test.js`, 12 tests
pinning Settings defaults, SelfModel gating points, AgentCoreBoot
injection, MultiFileRefactor default-flip, UI bindings, i18n keys.

**Side-fix:** `architectural-fitness.js` Z.759-760 had two stale
`EXEMPT_CAPS` references that should have been renamed to
`FILE_SIZE_CAPS` in the v7.7.1 main release (rename was done inside the
check body but missed the output formatting). Caught during File-Size-
Guard verification when `settings.js` grew by 6 LOC for the new UI
bindings, triggering exactly the cap-violation code path that referenced
the undefined name. Fixed; cap bumped 1068 → 1074.

---

### Resolved post-release (Hotfix 2 in v7.7.1) — EventStore data-loss race

**EventStore._flushBatch() was silently dropping batches on transient
write errors.** Found during v7.7.1 cross-platform verification — the
log line `[ERROR] [EventStore] Batch flush failed: EBUSY` was visible
on Windows but the consequence (event-batch silently lost) was not
obvious from the log message alone.

**Pre-existing bug** — present since at least v3.8.0 when batch-flush
was introduced. Only manifested on Windows where exclusive file locks
during `GenesisBackup._copyDir` overlap with EventStore's parallel
`appendTextAsync('events.jsonl', ...)`.

**Code path:** `EventStore.js` Z.151-176 — `splice(0)` removed buffered
lines BEFORE the async append was attempted. The `.catch(err =>
_log.error(...))` only logged the failure; lines were never restored
to the buffer. Permanent silent data loss whenever the append failed.

**Two-layer fix:**

1. **EventStore retry on transient errors** (`EBUSY`/`EAGAIN`/`EPERM`):
   - Lines restored to buffer front via `concat` (call-stack-safe)
   - Up to 3 retries (`_maxFlushRetries = 3`)
   - On exhaustion or permanent error: explicit `events lost` log
   - Success path resets retry counter
2. **GenesisBackup awaits EventStore quiescence:**
   - Before `_copyDir`, `await this._eventStore.flushPending()`
   - Best-effort, in try/catch (failure non-fatal)
   - `phase1-foundation.js`: `genesisBackup` deps now include
     `eventStore`; factory passes `eventStore: c.resolve('eventStore')`

**Test coverage:** `v771-eventstore-race-fix.contract.test.js`, 11
tests pinning retry classification, buffer restoration mechanism, retry
limit, success-reset, hard-failure log, GenesisBackup flushPending
order, manifest deps, factory wiring.

**Why it stayed hidden so long:** Linux POSIX file semantics allow
parallel reads + appends to succeed even during `cp -r`; the EBUSY
only surfaces on Windows where file locks are exclusive. The Genesis
test suite runs on Linux primarily; CI never saw the failure mode.

**Why fixed now and not deferred:** Garrus' policy — no release with a
known data-loss bug, regardless of how rare or obscure. Self-modifying
agents that lose entries from their own event log are exactly the
class of system where silent corruption compounds invisibly.

---

## Resolved in v7.7.0

### UI dual-path elimination + modular feature parity

The cleanup begun in v7.6.0 — when `dist/renderer.bundle.js` (built from
`renderer-main.js` + 6 modules) became the loaded UI codepath — was
never finished. The legacy monolithic `src/ui/renderer.js` and its
930-LOC test sat as blueprint references for nine releases.

A behavior audit between the legacy code and the modular path before
deletion surfaced **ten divergences**, including three production bugs
the modular path had quietly carried since v7.6.0:

1. **i18n interpolation broken** — modular used `{var}`/single-replace,
   but every live lang-string in `Language.js` uses `{{var}}` with
   multiple-occurrence semantics. Every interpolated translation
   rendered the literal placeholder.
2. **`sendMessage` silent loss before agent ready** — user messages
   typed during boot were echoed into chat then silently dropped (no
   guard, IPC fired into a not-yet-listening backend). Six other
   handlers (settings.openSettings, settings.showGoalTree,
   settings.undoLastChange, settings.dragdrop, statusbar.showHealth,
   statusbar.showSelfModel) had the same gap.
3. **`undoLastChange` placeholder literal** — variable name mismatch
   (`commit` vs `detail`) plus broken `t()` regex meant the user saw
   `{{detail}}` literal in every undo toast. Plus: the chat-message
   call referenced lang-key `ui.undo_detail` which doesn't exist in
   Language.js, so chat showed literal "↩ ui.undo_detail".

Plus seven feature regressions resolved (status-badge state→CSS
mapping for legacy parity, insight + resting state visibility,
warning-toast surface, toast stack limit, markdown headings,
file-tree icon hierarchy, undo-toast type for nothing-to-undo).

All ten fixed before the legacy was deleted.

**Files removed**: `src/ui/renderer.js` (566 LOC) +
`test/modules/renderer.test.js` (930 LOC) + HTML fallback comments in
both `index.html` files. 8 stale `// v7.6.0: was deleted` comments in
test/source files updated to reflect that the deletion actually
happened in v7.7.0. main.js and ARCHITECTURE.md historical comments
corrected.

**Files added**: `src/ui/modules/agent-state.js` (~25 LOC, shared
ready signal), `test/helpers/dom-shim.js` + `test/helpers/genesis-mock.js`
(extracted from the deleted test), 6 new per-module test files
(`ui-statusbar-module`, `ui-i18n-module`, `ui-chat-module`,
`ui-filetree-module`, `ui-settings-module`, `ui-renderer-main`),
plus `v770-test-helpers.contract.test.js` for helper export-shape
pinning. Total 81 new tests (replacing the 51 deleted, net +30).

### Doc-drift hardening (closes v7.6.5 → v7.6.9 staleness pattern)

Across five releases (v7.6.5 through v7.6.9) several documented
numbers sat stale because nothing audited them: fitness badge 127/130,
README table CI gates 7 (actual 15), README paragraph event types 458
(actual 453), README paragraph hash-locked files 16 (actual 21),
CAPABILITIES.md tests 6709 / modules 327 / fitness 127/130 / CI gates 12.

`scripts/audit-doc-drift.js` extended with `getLiveFitness()` helper
(subprocess to `architectural-fitness.js`, parses `Score: NNN/130`)
plus 10 new check rules covering all of the above stale claims plus
the corresponding ARCHITECTURE-DEEP-DIVE Fitness Score table cell.

`audit-doc-drift --strict` now verifies 40 claims (was 30).

### Lying-test removed (agentloop-legacy 'abort flag prevents execution')

The test called `loop.pursueGoal()` — a method that does not exist on
AgentLoop (real method: `pursue()` from AgentLoopPursuit.js mixin).
The TypeError was swallowed by a try/catch, leaving only the assertion
`loop.running === false` which is the default initial state regardless
of any abort behavior. Removed. Real abort coverage lives in
`agentloop-coverage.test.js:64`.

---

## Resolved in v7.7.5

### Monaco AMD → ESM migration

Monaco was loaded via CDN `<script>` tag using its AMD loader since
the Genesis-UI's earliest releases. AMD is a deprecated module system
from the pre-bundler era; Monaco's own roadmap has marked it as
deprecated. v7.7.5 migrates to a local ESM bundle built by esbuild
during `npm install` (postinstall). The CDN dependency is removed
entirely.

The migration touches 7 files: `scripts/build-bundle.js` (new
section 4 builds Monaco main bundle + 5 worker bundles),
`src/ui/modules/editor.js` (full rewrite of `initMonaco`,
MonacoEnvironment.getWorker setup), `src/ui/index.html` (CDN refs out,
local bundle in), `main.js` (CSP tightened in 4 directives),
`test/modules/v775-monaco-esm.contract.test.js` (new, 12 subtests),
plus retirement of two obsolete pins in `v774-deps-upgrade.contract`
and the standard version-stamp updates (banner, README, COMMUNICATION).

Side-effects of the migration:

- `amd-bypass-pre.js`/`amd-bypass-post.js` no longer generated. They
  existed solely because Monaco's AMD loader set `define.amd = true`,
  which made mermaid's UMD wrapper register via `define()` instead of
  `window.mermaid`. Without Monaco's AMD loader, `define` is never
  set globally, mermaid's UMD path works directly.
- `cdnjs.cloudflare.com` removed from CSP in 4 directives
  (script-src, style-src, font-src, connect-src).
- `blob:` removed from CSP in 2 directives (script-src, worker-src)
  — Monaco's blob:-based worker bootstrap was an AMD-loader artifact;
  ESM workers load directly from `'self'`.

### Index.html version-drift fixed

A long-standing drift in `src/ui/index.html` had two CDN references
hardcoded to `monaco-editor/0.44.0` while `package.json` had moved to
0.52 (v7.7.3) and then 0.55 (v7.7.4). The drift was real but only
affected the CDN fallback path, and `audit-doc-drift` had no pin for
it. The migration to a local bundle dissolves the question — there is
no CDN path anymore.

---

## Resolved in v7.7.4

### Electron 33 → 42 security upgrade

Genesis was nine majors behind current stable Electron and roughly
two years past Electron's "latest 3 stable majors" support window.
The 18 high-severity advisories surfaced by `npm audit` are gone.
`package.json` bumped to `electron: ^42.0.0`. `package-lock.json`
removed so a fresh `npm install` resolves clean against current
registry.

Honest framing: the npm-audit count went from 14 to 14 — the runtime
RCE-class is gone, but a new moderate-severity surface came in via
monaco-editor 0.55's bundled dompurify (8 XSS advisories, monaco-
upstream issue, see deferred items below). The win is in the
**shape** of the remaining surface, not in the count.

Migration foci documented in CHANGELOG (BrowserWindow defaults,
postinstall→first-run binary download in v42, macOS UNNotification
code-signing). Genesis main.js was already aligned with v42-era
defaults, so the structural changes turned out to be no-ops. The one
runtime issue that surfaced was the CSP font-src drift below.

### monaco-editor 0.52.2 → 0.55.1

Coupled with the Electron bump because the UI editor lives next to
the renderer. Small minor delta, low risk on the Genesis-code side.

### monaco CDN fallback drift fixed

`src/ui/modules/editor.js` had a hardcoded CDN fallback path
`monaco-editor/0.44.0/min/vs` while the npm package was at 0.52.
Two distinct Monaco versions could load at runtime depending on
whether the local copy resolved. CDN path aligned with installed
version (0.55.1).

### CSP font-src drift fixed (Monaco 0.55+ codicons)

The HTTP-header CSP in `main.js` had `font-src 'self' cdnjs` only —
strict enough to block Monaco 0.55+ codicon glyphs, which now ship
as embedded `data:font/ttf;base64,...` URIs. The HTML-meta CSP
already permitted `data:`, the HTTP-header CSP didn't. Boot test
caught it via browser CSP-violation report. `font-src` aligned to
permit `data:`. Same drift pattern as v7.5.7's fix for Monaco's
blob: worker URLs (worker-src). Pinned by v774 contract subtest B2.

---

## Resolved in v7.7.3

### audit-doc-drift: header-version exact-match → pattern-only

The pre-v7.7.3 `audit-doc-drift` script forced every doc whose first
10 lines contained a `vX.Y.Z` tag to match the current package.json
version exactly. This created bulk-bump commits at every release: 9-15
docs gained a 1-line diff that contained no actual content change,
burying real edits in `git log -- docs/X.md`. v7.7.3 changes the check
to "is the tag a well-formed semver pattern" — the presence of the
tag is the guarantee, the human bumps it when the doc has been
re-verified. Three specific header-version checks (ARCHITECTURE.md,
MCP-SERVER-SETUP.md, AUDIT-BACKLOG.md) refactored consistently.

### audit-doc-drift: 8 new semantic pins for previously-unscoped docs

The pre-v7.7.3 audit covered 9-12 docs. v7.7.3 adds semantic pins for
8 more, each verifying a doc-claim against live code (not version-tag
matching):

- `BENCHMARKING.md` — referenced `npm run X` scripts exist in package.json
- `MCP-SERVER-SETUP.md` — referenced `mcp.*` setting keys exist in registry
- `QUICK-START.md` — Node.js version requirement matches `engines.node`
- `SETTINGS.md` — mentioned setting keys exist in registry or
  `settings.get()` calls anywhere in src/
- `SKILL-SECURITY.md` — Allowed module list matches `Sandbox.allowedModules`
  (this pin caught the long-standing v6.1.1 fs-allowance drift — see below)
- `TROUBLESHOOTING.md` — referenced in-repo file paths exist
- `phase9-cognitive-architecture.md` — Module 1-6 files exist
- `GATE-INVENTORY.md` — instrumented-gate table is non-empty +
  referenced `*.js` files in Location column resolve

Three docs intentionally have no pin: BUG-TAXONOMY (historical, frozen
at v7.1.9), DEGRADATION-MATRIX (auto-generated by
`scripts/degradation-matrix.js`), ONTOGENESIS (philosophical prose with
fuzzy stats after v7.7.2 Phase 0).

`audit-doc-drift` strict-claim count: 55 → 53 (some old version-stamp
checks consolidated by the pattern refactor) + 8 new semantic pins +
some checks generate multiple claims (e.g. phase9 yields 6 module-file
checks) = 53 total.

### SKILL-SECURITY.md: long-standing `fs` drift fixed

Before v7.7.3, `docs/SKILL-SECURITY.md` claimed `fs` was in the
"Not available" section: "Skills cannot read or write files
directly." The reality (since v6.1.1) was that `fs` lives in
`Sandbox.allowedModules` as a path-restricted module — skills
**can** use `fs.readFileSync('./manifest.json')` and similar, with
`fs.cp`/`fs.cpSync`/`fs.appendFile`/`fs.appendFileSync` explicitly
intercepted to prevent mass-copy/append abuse.

Doc updated: `fs` moved to the "Allowed (path-restricted)" row with
explicit description of the path-restriction. "What Your Skill
CANNOT Do" entry rewritten from "No fs access" to "Read/write files
**outside the sandbox** — `fs` is path-restricted." Caught by the
new `SKILL-SECURITY.md` pin (#21).

### CSS gap closed: dedicated badge colors for thinking/insight/resting

`STATE_TO_CSS` mapped `thinking` → `working` (purple, same as
self-modifying), `insight` → `ready` (green, same as ready), and
`resting` → `ready` (green, same as ready). Three semantically
distinct states rendered as two visual states.

`src/ui/styles.css` got three new classes:

- `.badge-thinking` — blue, slow pulse (active thought)
- `.badge-insight` — gold, slow pulse (Aha-moment)
- `.badge-resting` — muted grey (energy-saving, OK)

`STATE_TO_CSS` mapping in `statusbar.js` updated: each state now
maps to its dedicated class.

### Stale items in AUDIT-BACKLOG cleaned up

The "Items still deferred" list carried three entries that were
already resolved before v7.7.3:

- "8 events emitted without subscriber" — resolved in v7.6.8 (4
  wired, 4 telemetry-only). Was carry-over noise.
- "CSS gap for non-mapped badge states" — partially resolved by
  v7.7.2 (`resting` re-mapping), now fully closed by this release.
- "11 docs not yet covered by audit-doc-drift" — closed by this
  release (8 pinned, 3 by-design no-pin).

Plus body-stat drifts caught during cleanup: README.md badge
6907→6917 tests, ARCHITECTURE-DEEP-DIVE.md and CAPABILITIES.md
test-file count 406→413 and tests 6907→6917, BENCHMARKING.md
6905→~6900 (fuzzy), CONTRIBUTING.md and TROUBLESHOOTING.md Node
version ≥18→≥22, ONTOGENESIS.md "approximately 250 source files"
→ fuzzy "hundreds of source files".

`audit-doc-drift.js` `TESTS_WIN_BASELINE` and `TEST_FILES` baselines
updated to live values (6917, 413).

---

## Resolved in v7.7.2

### Settings.js Mixin-Split (1073 LOC → split into 8 modules)

The v7.7.1 hold-the-line cap on `src/ui/modules/settings.js`
(`FILE_SIZE_CAPS.settings.js = 1074`) is now structurally resolved:
the file was split into seven concern-specific modules plus a thin
facade. The split was concern-based (not mixin-based as initially
considered) because `settings.js` is a function-module, not a class.

**New modules under `src/ui/modules/`:**

- `settings-state.js` — shared state with explicit getter/setter API
  (replaces implicit module-level `let _fallbackState`)
- `settings-fields.js` — generic field DOM helpers + decoration
- `settings-loadsave.js` — `openSettings` + `saveSettings`
- `settings-json-editor.js` — JSON power-mode editor
- `settings-fallback-ui.js` — fallback chain UI; pure helpers now
  directly importable, replacing the v7.5.7 regex-source-parsing
  test pattern with a normal `require()`
- `settings-mcp-ui.js` — MCP servers UI
- `settings.js` — facade (64 LOC, only the public surface)

**Two non-settings concerns extracted out of `settings.js`** —
they only lived there historically:

- `goal-management.js` — `showGoalTree`, `buildGoalNode`,
  `undoLastChange` (wired to `#btn-goals` and `#btn-undo` +
  `Ctrl+Z`, never were settings)
- `drag-drop.js` — `setupDragDrop` (chat-panel file import)

`chat.js` extended with `autoResize` (was a 1-liner inside
`settings.js`, belongs to chat-input behaviour). `renderer-main.js`
caller surface: 4 separate requires instead of 1, mirroring the new
module boundaries.

`FILE_SIZE_CAPS` is now `{}` — no large-module exemptions remain.

### gitAutoInit/gitAutoCommit audit-pinning (v7.7.1 hotfix-1 follow-up)

The v7.7.1 hotfix gated `git init` + initial commit + snapshot commit
behind `agency.gitAutoInit` and `agency.gitAutoCommit` settings
(both default `false`). v7.7.2 adds two `audit-doc-drift` checks
that pin these defaults at `false` going forward. If anyone flips
the default to `true`, the audit fails — explicit signal that
user-repo git operations are now opt-out instead of opt-in, which
is a behavioural regression.

`audit-doc-drift` strict-claim count: 53 → 55.

### CommandHandlersInstallDB nodejs target — Node v22 LTS

`src/agent/hexagonal/CommandHandlersInstallDB.js` `nodejs` entry was
hardcoded to v20.18.1. Aligned with `engines.node` (now `>=22.0.0`):
URLs bumped to v22.22.2, label changed to "Node.js v22 LTS".

v22.x is in Maintenance LTS until April 2027; v22.22.2 is the latest
22.x with security fixes for CVE-2025-55131 and CVE-2026-21637.

### index.bundled.html removed

`src/ui/index.bundled.html` was md5-identical to `src/ui/index.html`
and never loaded at runtime (`main.js` Z.228 loads `index.html`
only). Deleted in v7.7.2.

### statusbar STATE_TO_CSS.resting semantic fix

`STATE_TO_CSS.resting` was mapped to `'booting'` (yellow/warning
colour) — a resting daemon is OK, not warning. Now mapped to
`'ready'` (green). Legacy parity not preserved here because the
old behaviour was a bug, not an intentional design choice.

### v7.7.1 baseline subtests retired

Two subtests in `test/modules/v771-file-size-guard-ui.contract.test.js`
were specifically pinning the v7.7.1 state (settings.js cap +
"settings.js is the only currently-capped file"). Their motivation
is structurally resolved by the v7.7.2 split, so they were removed
rather than rewritten — the v7.7.2 state is pinned in
`v772-cleanup.contract.test.js` instead, keeping the v7.7.1-* and
v7.7.2-* eras separate in the test history.

---

## Items still deferred (no Score-pressure)

- **`index.bundled.html` cleanup.** ✅ Resolved in v7.7.2 — see above.
  File deleted, md5-identical to index.html and never loaded.

- **CSS gap for non-mapped badge states.** ✅ Resolved in v7.7.3 — see
  below. `thinking`, `insight`, and `resting` now have dedicated badge
  classes (`.badge-thinking`, `.badge-insight`, `.badge-resting`) with
  semantically appropriate colors.

- **Slash-Discipline 9 SECURITY_REQUIRED_SLASH extension.** The
  current Slash-Discipline contract covers 4 of the 9 SECURITY_REQUIRED_SLASH
  intents. Extending coverage to all 9 is real security-design work
  (deciding intent-by-intent whether the LLM/classifier post-guard is
  sufficient, or whether the slash-only constraint should be hard).
  Deserves its own focused release.

- **Slash-Discipline coverage inventory in GATE-INVENTORY.md.** The
  v7.6.2 carry-forward asked for documentation of which intents are
  pure-slash-only vs. still keyword-regex. Not Score-relevant; defer.

- **8 events emitted without subscriber.** ✅ Resolved in v7.6.8 (this
  entry was stale carry-over). All 8 are now either wired (4: goal:stalled
  + model:unavailable-cleared via STATUS_BRIDGE; error:trend +
  memory:consolidation-failed via ImmuneSystem subscriptions) or
  explicitly tagged as telemetry-only via `RESERVED_TELEMETRY_ONLY` in
  `scripts/audit-events.js` (4: lesson:learned, narrative:updated,
  reasoning:started, symbolic:resolved). Test baseline = 0 in
  v767-audit-events-scanner.contract.

- **ImpactForecast.fragilityDelta** — never implemented. The class
  itself does not exist in `src/`; this would be brand-new feature
  work, not a cleanup.

- **monaco-editor's bundled dompurify (8 XSS advisories, moderate).**
  Came in with the v7.7.4 monaco bump. Cannot be fixed by Genesis;
  monaco-upstream needs to update its bundled dompurify. `npm audit
  fix --force` would downgrade monaco to 0.53 to "fix" it, which
  isn't a real fix. Track upstream and re-pin when monaco ships a
  patched dompurify.

- **Electron-builder toolchain bumps.** `electron-builder`,
  `dmg-builder`, `electron-builder-squirrel-windows`, `tar`,
  `esbuild`, `@tootallnate/once` all have pending major bumps with
  their own breaking changes. All are dev-only (build pipeline), not
  in the runtime path. Can be done in a follow-up "build chain
  refresh" release without urgency.

- **11 docs not yet covered by audit-doc-drift.** ✅ Resolved in v7.7.3
  — see below. 8 docs got semantic pins (BENCHMARKING, MCP-SERVER-SETUP,
  QUICK-START, SETTINGS, SKILL-SECURITY, TROUBLESHOOTING,
  phase9-cognitive-architecture, GATE-INVENTORY). The remaining 3 don't
  need pins by design: BUG-TAXONOMY (historical, frozen at v7.1.9),
  DEGRADATION-MATRIX (auto-generated by `scripts/degradation-matrix.js`),
  ONTOGENESIS (philosophical/prose, no pin-able structure after v7.7.2
  Phase 0 cleanup made stats fuzzy).

---

## Resolved in v7.6.9

- ✅ File-Size-Guard WARN — AgentLoop.js (Track A)

See [CHANGELOG.md § 7.6.9](CHANGELOG.md) for details.

## Items still deferred after v7.6.9

### File-Size-Guard

**None.** All source files under 700 LOC. Future cleanup will be
preventive — kept in mind during feature work.

### Other low-priority items (no Score-pressure)

- **ModelBridge `_prepareCallContext` extraction** — opportunity for
  further structural cleanup, but ModelBridge is below WARN threshold
  and not blocking any audit. Free to defer or skip.
- **UI dual-path consolidation** — IPC vs direct-call dual paths in
  the renderer accumulated across v7.0.x–v7.5.x (~567 LOC of
  duplication). Worth a dedicated release; not blocking anything.
- **Slash-Discipline extension** to all 9 `SECURITY_REQUIRED_SLASH`
  intents (currently a subset). Improves the unified
  "would I call this tool from this intent" check; not Score-relevant.

---

## Resolved in v7.6.8

- ✅ File-Size-Guard WARN — GoalStack.js (Track A)
- ✅ 8 frequently-emitted events fully resolved (Track B)

See [CHANGELOG.md § 7.6.8](CHANGELOG.md) for details.

## Resolved in v7.6.7

- ✅ File-Size-Guard WARN — Settings.js (Track A)
- ✅ audit-events scanner pattern coverage (Track B)
- ✅ colony:run-request reserved-slot (Track B follow-on)

See [CHANGELOG.md § 7.6.7](CHANGELOG.md) for details.

## Items still deferred after v7.6.7

### File-Size-Guard

- `src/agent/planning/GoalStack.js` — 851 LOC (>700). Carry-over from
  v7.6.4 — natural split candidates: persistence vs. stack-logic vs.
  lifecycle. No active pressure point; deferred until next cleanup.
- `src/agent/revolution/AgentLoop.js` — 868 LOC (>700). Carry-over
  from v7.6.4 — likely splits along planning/cognition/recovery
  boundaries. Largest of the three remaining WARN files; deferred.

### Frequently-emitted-without-subscriber backlog (v7.6.7-baseline=8)

After Track B revealed the true scanner picture, eight events remain
emitted with no subscriber — neither backend nor UI/Dashboard:
`goal:stalled`, `error:trend`, `lesson:learned`, `narrative:updated`,
`memory:consolidation-failed`, `model:unavailable-cleared`,
`reasoning:started`, `symbolic:resolved`. Not regressions — they were
already present pre-v7.6.7 but partially hidden by the scanner blind
spots. Pinned via ratchet `BASELINE = 8` in
`v767-audit-events-scanner.contract.test.js`. Future regressions that
add a 9th will fail the test until either a subscriber is wired (e.g.
Dashboard listener) or the baseline is bumped intentionally.

---

## Resolved in v7.6.6

- ✅ Identity-Resilience: installation-anchored encryption (Track A)
- ✅ Hauptstandort marker (Track B — foundation for v7.7+)
- ✅ CostStream-Dissonance-Listener (Track C)
- ✅ Stale TS-error backlog entry retired (Track D)

See [CHANGELOG.md § 7.6.6](CHANGELOG.md) for details.

## Resolved in v7.6.5

- ✅ Track 1 — Raw-setTimeout phase 2 (audit baseline 12 → 0)
- ✅ Track 2 — A2 ModelBridge file-size split (701 → 646 LOC)
- ✅ Structural fix — README badge drift

See [CHANGELOG.md § 7.6.5](CHANGELOG.md) for details.

## Resolved in v7.6.4

- ✅ L1 — Listener lifecycle (10 findings closed)
- ✅ In-version closeout — external audit follow-up (no version bump)

See [CHANGELOG.md § 7.6.4](CHANGELOG.md) for details.

## Resolved in v7.6.3

- ✅ Erweiterte Analyse-Bericht follow-up (Track 6)
- ✅ Drift cleanup
- ✅ CostStream failover wiring
- ✅ Pre-existing test fix carried in
- ✅ Tests / fitness / audits at v7.6.3

See [CHANGELOG.md § 7.6.3](CHANGELOG.md) for details.

## Resolved in v7.6.2

- ✅ Audit closeout (v7.6.2 in-version, no version bump)
- ✅ Tests / fitness / audits at v7.6.2 (post-closeout)
- ✅ Items still deferred after v7.6.2

See [CHANGELOG.md § 7.6.2](CHANGELOG.md) for details.

## Resolved in v7.6.1 (audit-closeout)

- ✅ Tests / fitness / audits at v7.6.1 audit-closeout
- ✅ Items deferred from the v7.6.1 audit
- ✅ Memory-backlog reality-check (informational)

See [CHANGELOG.md § 7.6.1](CHANGELOG.md) for details.

## Resolved in v7.6.0

- ✅ Tests / fitness / audits at v7.6.0
- ✅ Items NOT in v7.6.0 (Medium/Low from audit)

See [CHANGELOG.md § 7.6.0](CHANGELOG.md) for details.

## Resolved in v7.5.9

- ✅ Live-fix (added same release after first cloud-test round, 2026-05-04)
- ✅ Tests / fitness / audits at v7.5.9
- ✅ Verified structurally healthy at v7.5.9 (audit findings)
- ✅ Deferred to v7.6+

See [CHANGELOG.md § 7.5.9](CHANGELOG.md) for details.

## Resolved in v7.5.8

- ✅ Tests / fitness / audits at v7.5.8
- ✅ Files

See [CHANGELOG.md § 7.5.8](CHANGELOG.md) for details.

## Resolved in v7.5.7

- ✅ Retroactive closes from earlier Open items
- ✅ Tests / fitness / audits at v7.5.7
- ✅ Files

See [CHANGELOG.md § 7.5.7](CHANGELOG.md) for details.

## Resolved in v7.5.6

- ✅ Boy-Scout cleanups
- ✅ Items reviewed and closed without code change

See [CHANGELOG.md § 7.5.6](CHANGELOG.md) for details.

## Open items from v7.5.5

- ✅ Closeout / cleanup

See [CHANGELOG.md § 7.5.5](CHANGELOG.md) for details.

## Resolved in v7.5.3

- ✅ Closeout / cleanup

See [CHANGELOG.md § 7.5.3](CHANGELOG.md) for details.

## Backlog (added in v7.5.3)

- ✅ Closeout / cleanup

See [CHANGELOG.md § 7.5.3](CHANGELOG.md) for details.

## Resolved in v7.5.2

- ✅ Closeout / cleanup

See [CHANGELOG.md § 7.5.2](CHANGELOG.md) for details.

## Backlog (added in v7.5.2)

- ✅ Closeout / cleanup

See [CHANGELOG.md § 7.5.2](CHANGELOG.md) for details.

## Resolved in v7.5.1

- ✅ Security
- ✅ Structural
- ✅ Hardening
- ✅ Tests
- ✅ Quality-Sweep (verification analyses run during v7.5.1)
- ✅ Deferred to v7.6+

See [CHANGELOG.md § 7.5.1](CHANGELOG.md) for details.

## Resolved in v7.5.0

- ✅ Closeout / cleanup

See [CHANGELOG.md § 7.5.0](CHANGELOG.md) for details.

## Resolved in v7.4.9

- ✅ Open / new items in v7.4.9
- ✅ Open / deferred (carry-over)

See [CHANGELOG.md § 7.4.9](CHANGELOG.md) for details.

## Resolved in v7.4.8

- ✅ Open / deferred

See [CHANGELOG.md § 7.4.8](CHANGELOG.md) for details.

## Resolved in v7.4.7 — Cleanroom (Settings Hygiene)

- ✅ Items resolved
- ✅ New UI surface (backend already wired)
- ✅ Verification
- ✅ Honest scope note

See [CHANGELOG.md § 7.4.7](CHANGELOG.md) for details.

## Resolved in v7.4.6 — Goal-Pipeline Fixes (real this time)

- ✅ Items resolved
- ✅ Verification
- ✅ Principle added
- ✅ Why this happened (post-mortem)

See [CHANGELOG.md § 7.4.6](CHANGELOG.md) for details.

## Resolved in v7.4.5 — Endurance

- ✅ What was verified
- ✅ Items resolved
- ✅ O-8 status update — REGRESSION (deferred)
- ✅ Items added (open by design)

See [CHANGELOG.md § 7.4.5](CHANGELOG.md) for details.

## Resolved in v7.4.4 — Bookkeeping

- ✅ What was verified
- ✅ Bookkeeping changes
- ✅ Items resolved
- ✅ Items reformulated
- ✅ What was deliberately not done

See [CHANGELOG.md § 7.4.4](CHANGELOG.md) for details.

## Resolved in v7.3.7 – v7.4.2 (Stocktaking-Catch-Up)

- ✅ From v7.3.7 — Setting Up Home
- ✅ From v7.3.8 — Honest Not-Knowing
- ✅ From v7.3.9 — Cleanup
- ✅ From v7.4.0 — In the Now
- ✅ From v7.4.1 — Real Answers
- ✅ From v7.4.1 — **not documented in CHANGELOG** (Erratum)
- ✅ From v7.4.2 — Stocktaking (this release)

See [CHANGELOG.md § 7.3.7](CHANGELOG.md) for details.

## Resolved in v7.1.6 (Post-Release)

- ✅ R-1: shell:complete → shell:outcome Event Mismatch
- ✅ R-2: prompt-evolution:promoted Never Emitted
- ✅ R-3: EmotionalFrontier Double-Injection in Prompt
- ✅ R-4: KG Mutation Without Persistence in _tryMerge
- ✅ R-5: McpTransport Reconnect Timer Leak
- ✅ R-6: 21 Cross-Phase Required Late Bindings
- ✅ R-7: 2 Dangling Late Binding Names

See [CHANGELOG.md § 7.1.6](CHANGELOG.md) for details.

## Open Items

- ✅ O-1: Benchmark Re-Run with InferenceEngine Live
- ✅ O-2: GateStats Sample-Count across Sessions
- ✅ O-3: 31 Legacy Test Files Use Inline Runner
- ✅ O-4: Coverage Plateau (4 modules)
- ✅ O-5: package-lock.json Not Committed
- ✅ O-6: Branch Coverage Threshold Temporarily Lowered
- ✅ O-7: Component D Case 2 — German "ich kann das nachprüfen" ("I can verify that")
- ✅ O-8: Files over 700-LOC warn threshold
- ✅ O-9: GateStats data collection status unverified
- ✅ O-10: docs/ five releases of version drift
- ✅ O-11: Circuit-Breaker uses one global timeout for all backends
- ✅ O-12: PromptBuilderSections re-org bundled with BeliefStore

See [CHANGELOG.md](CHANGELOG.md) for details.

## Resolved Items

- ✅ Monitor Items (from CHANGELOG v7.0.5–v7.0.6)
- ✅ Security Audit Items (from v6.0.3)
- ✅ V7 Roadmap Items
- ✅ File Size Guard Resolutions (v7.1.3)

See [CHANGELOG.md](CHANGELOG.md) for details.

## Audit History

| Version | Scope | Findings | Resolved |
|---------|-------|----------|----------|
| v7.1.3 | Docs audit, File Size Guard, V7-4B, Coverage push | 5 INFO | 5/5 |
| v7.1.2 | @ts-ignore elimination, composition splits, type layer | 0 | — |
| v7.1.1 | InferenceEngine hot-path, benchmark timeout, V7-4B bridge | 0 | — |
| v7.0.8 | lockCritical expansion, security tests, setInterval audit | 7 | 7/7 |
| v7.0.6 | @ts-ignore 336→85, dead events, legacy tests | 3 M-items | 3/3 |
| v7.0.5 | Event schema 100%, test consolidation | 5 M-items | 3/5 |
| v7.0.4 | DisclosurePolicy, identity hardening | 6 F-items | 6/6 |
| v7.0.2 | Fail-honest rollback, event schema fixes | 6 schemas | 6/6 |
| v6.0.3 | IPC validation, sandbox FS, ShellAgent Unicode | 11 items | 11/11 |
| v5.1.0 | Shutdown integrity, DI inversion, security hardening | 19 services | 19/19 |
| v5.0.0 | Organism architecture, shutdown data loss | 14 items | 14/14 |
| v4.12.7 | Full codebase audit (16 findings) | 16 items | 16/16 |
| v4.12.4 | Security audit (Dashboard XSS, SSRF, API masking) | 5 items | 5/5 |
