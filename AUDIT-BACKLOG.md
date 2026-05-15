# Genesis Agent — Audit Backlog

> Version: 7.8.5 · Audit findings, monitor items, and resolution status.

This document tracks all audit findings, monitor items, and their resolution status.
Referenced from [ARCHITECTURE.md](ARCHITECTURE.md). Per-version details in [CHANGELOG.md](CHANGELOG.md).

---


## Open backlog (added in v7.8.5)

*(Currently no open backlog items.)*

---


## Resolved in v7.8.6

### Two focused items — ModelBridge refactor + sidebar splitter

- **Item 1 — ModelBridge `_prepareCallContext` split + `_dispatch`
  merge.** Four call-context helpers extracted into
  `ModelBridgeContext.js` mixin. `_dispatchChat` + `_dispatchStream`
  collapsed into `_dispatch({ mode })` with thin wrappers preserved.
  `ModelBridge.js` shrinks from 697 to 643 LOC.
  (`modelbridge-v786 contract:` prefix, 42 tests.)
- **Item 2 — Sidebar splitter.** Three resizeable splitters between
  the four main-layout panels with mouse / touch / keyboard drag +
  dblclick reset. Widths persisted in `ui.panelWidths`. Splitter
  visibility uses smart sibling-traversal: shows whenever its
  data-prev panel is visible AND any later panel is also visible —
  so toggling an intermediate panel off doesn't orphan the splitter,
  it just attaches to the next visible panel instead. 7px wide with
  transparent default background and a visible grip line (`::before`
  pseudo, accent-coloured on hover/focus/drag). **Reset panel widths**
  button in Settings → Behavior tab.
  (`sidebar-splitter contract:` prefix, 22 tests.)

### Backlog tidy

- **ColonyOrchestrator worker-pool-cap bug** (struck) — fixed in v7.7.9 Phase 1c.
- **F8 / D1+D2 — Slash-Discipline coverage extension** (struck) —
  `SECURITY_REQUIRED_SLASH` now contains 13 intents, all enforced.
  Duplicate entry in two sections both removed.
- **stale-refs.json deduplication** — `effective-model contract:` and
  `effective-model-ui contract:` were each registered twice; gone.

See [CHANGELOG.md § 7.8.6](CHANGELOG.md) for full details.

---


## Resolved in v7.8.5

### Five items — failover transparency end-to-end + release hygiene

- **Item 1 — `effectiveModel` end-to-end.** ModelBridge tracks
  `lastEffectiveModel`, `lastEffectiveBackend`,
  `lastFailoverReason` as persistent state.
  Updated on every chat()/streamChat() success and on every
  successful failover. Downstream: warn log interpolates fallback
  model name; `model:failover` payload gains `effectiveModel` +
  `preferredModel`; `llm:call-complete` gains `effectiveModel`;
  `cost:recorded` persists it; `AgentCoreHealth.getHealth()`
  exposes `model.effective` + `model.failoverReason`; the UI
  dropdown shows the model actually answering, in the same slot
  the preferred model normally occupies. (`effective-model contract:` 14 + `effective-model-ui contract:` 8 tests.)
- **Item 2 — Backlog audit.** Four items struck as obsolete:
  `ImpactForecast`/`fragilityDelta`, `Layer-Truncation
  LLM-Output`, `CostStream failover field`, UI dual-path
  `renderer.js`.
- **Item 3 — `audit-platform-tests.js`.** New reporting tool that
  scans test files for `process.platform` skip patterns and
  produces a matrix. Replaces pattern-matched test-count
  estimates with measured data. JSON snapshot at
  `scripts/platform-tests-baseline.json`. Not a strict CI gate.
  (`platform-tests-audit contract:` 6 tests.)
- **Item 4 — Release hygiene.** `plugins/` gains a `.gitkeep`
  marker with explanatory header. `sandbox/` added to
  `.gitignore` — previously a stray sandbox/ could ship in the
  release ZIP. CONTRIBUTING.md documents both under "Special
  directories (runtime-managed)". (`release-hygiene contract:`
  3 tests.)
- **Item 5 — CHANGELOG split.** 14,739 lines / 906 KB
  CHANGELOG.md split into per-major archives:
  `CHANGELOG-v7.md` (78), `CHANGELOG-v6.md` (12),
  `CHANGELOG-v5.md` (17), `CHANGELOG-archive.md` (v0–v4, 29).
  Master `CHANGELOG.md` keeps only the newest entry inline plus
  index. Genesis' `ChatOrchestratorSourceRead._readChangelogLatestSection`
  keeps working — the newest `## [x.y.z]` header is still at the
  top. Cleaned a pre-existing duplicate `## [7.1.6]` header.
  (`changelog-split contract:` 7 tests.)

---


## Resolved in v7.8.4

### Six focused items — no themed release wrapper

Two correctness fixes in the agent loop, one diagram-rendering
hardening, one toolchain bump, one installer-URL resilience pass,
and a new pre-deletion-audit capability with auto-hook and slash
command. Each item stands alone — no cross-cutting theme tying
them together.

- **Item 1 — Verification-reporting contradiction.** `AgentLoopSteps._stepCode`
  pre-declared `test passed` before verification ran. Fix: neutral output
  in `_stepCode`, `[verification failed]` overlay in `AgentLoopPursuit`
  on failure. (`step-reporting contract:` prefix, 4 tests.)
- **Item 2 — DELEGATE warning dead-code removal.** Validator warning
  for an impossible state (v7.3.5 `canDelegate` gate + `_stepDelegate`
  fallback already cover it). (`plan-validator contract:` prefix, 3 tests.)
- **Item 3 — Mermaid SVG sanitisation.** `DOMPurify.sanitize()` wraps
  mermaid output before `diagramEl.innerHTML`. SVG profile +
  `foreignObject` re-allowed for mermaid HTML-in-SVG labels.
  (`mermaid-safety contract:` prefix, 3 tests.)
- **Item 4 — mermaid v10 → v11.** Toolchain bump. Bundle-copy in
  `build-bundle.js` made resilient against future filename renames
  (probes `mermaid.min.js` / `.js` / `.esm.min.mjs`).
  (`mermaid-version contract:` prefix, 4 tests.)
- **Item 5 — Node v22 LTS lazy resolution.** `NodeVersionResolver`
  capability replaces hardcoded v22.22.2 URLs with `nodejs.org/dist/`
  index lookup. 24h cache, four-tier fallback chain, pinned to v22
  major. (`install-db contract:` prefix, 10 tests.)
- **Item 6 — Pre-deletion-audit (B4 four layers).** `CleanupVerifier`
  capability + `AgentLoopSteps` auto-hook + `/cleanup-check` slash
  command + `docs/CLEANUP-PROTOCOL.md`. New telemetry event
  `cleanup-verifier:scan-complete`. (`cleanup-verifier contract:`
  prefix, 29 tests.)
- **Item 7 — Test isolation from real Ollama daemon.** Long-standing
  bug (since v5.1.0) where the legacy ModelBridge test silently fell
  back to the default Ollama URL on its `chat()` failover path. Hidden
  while cloud models were in use; surfaced when a local model was
  selected and Ollama loaded it into RAM during `npm test`.
  `OllamaBackend._httpGet`/`_httpPost` now honour
  `GENESIS_OFFLINE_TESTS=1`; `test/index.js` sets the flag before
  spawning child test processes so they inherit it. Live verification:
  zero real HTTP calls to Ollama during full test runs.
  (`test-isolation contract:` prefix, 5 tests.)

See [CHANGELOG.md § 7.8.4](CHANGELOG.md) for full file change list
and verification numbers.

---


## Resolved in v7.7.8

### Goal-awareness release — clearer perception, not restriction

A live session on a Win-Hauptstandort showed Genesis interpreting a
casual conversation closing — *"das kannst du machen oder etwas ganz
anderes :-)"* — as a goal. Genesis built a 15-step plan including
hallucinated SELF_MODIFY and DELEGATE steps. Plan-validator flagged
four unknown-step-type blockers; they were auto-approved at trust 3;
the goal eventually failed silently with `Goal failed. undefined`. No
reflection. No lesson recorded. No transparent self-report.

v7.7.8 wires five fixes — not external blockers, but better
perception so Genesis distinguishes goal from conversation itself.

**G1 — Conversation-permission-closing recognition.**
`IntentRouter._conversationalSignalsCheck` learns a new stage
`conversational-permission-closing`. Smileys, optional-permission verbs,
open-ended-redirects, acknowledgment-continuations — DE + EN. ≥2
markers + length<200 + no action verb = closing → no pursuit, IdleMind
handles. Single markers fall through; action verbs (`refactor`,
`integrate`, …) veto closing even with multiple markers. Slash commands
bypass entirely.

**G2 — `plan-has-issues` never auto-approved.**
`TrustLevelSystem` gains a new risk category `'blocking'`. Absent from
every `LEVEL_AUTO_APPROVE` entry including FULL_AUTONOMY. Structural
plan issues now pause for explicit user judgment regardless of trust
level.

**G3 — FormalPlanner step-type schema sharper.**
Prompt lists the seven canonical step types explicitly, plus an
anti-pattern list calling out the five LLM-invented types observed in
the live-session (`ASK_USER`, `RUN_TESTS`, `GIT_SNAPSHOT`,
`CODE_GENERATE`/`WRITE_FILE`, `SHELL_EXEC`) plus `SELF_MODIFY` (not a
step type at all — runs through a separate pipeline). Old hardcoded
`Include GIT_SNAPSHOT before WRITE_FILE` line removed; Genesis has
built-in `SnapshotManager` + `GenesisBackup`.

**G4 — Self-modification trigger-sanity-check.**
`SelfModificationPipelineModify.modify()` accepts an optional
`originContext`. If `intentClass.startsWith('conversational-')` and
`viaSlashCommand !== true`, the pipeline refuses, fires
`selfmod:trigger-sanity-blocked`, and self-closes the origin goal as
`obsolete` via `goalStack.markObsolete()`. Genesis-internal triggers
(`originContext=null`) proceed normally. Defense-in-depth.

**G5 — Plan-failure reflection.**
`AgentLoopPursuit._emitFailure` no longer ends silently. Three new
steps after the existing `agent-loop:complete`: classify the error
into one of five categories (`structural`, `execution`, `external`,
`user-action`, `unclassified`), fire `agent:goal-failed-classified`
for telemetry, record via `LessonsStore.add()` if classification
stable plus `selfStatementLog.append({kind:'plan-failure-reflection',
…})` so Genesis can later recall the failure. Reflection logic
extracted to `AgentLoopPursuitReflection.js` to keep
`AgentLoopPursuit.js` under the 700-LOC fitness limit.

**Test coverage:**

`test/modules/v778-goal-awareness.contract.test.js` — 22 subtests.

Retired (stage-marker pins): `v777-audit-extension.contract` A1
(version-pin) and A4 (test-stats pin) — single-version + count pins
become obsolete when the next release ships.

---

## Deferred from v7.7.8 live-session findings

These three came out of the same Win live session that motivated
v7.7.8 but did not fit the goal-awareness theme. Each deserves its own
focused fix.

- **Verification-reporting contradiction.** Step output shows
  `[error] Verification failed: Unexpected token (1:5)` followed by
  `[step-complete] Code written: experimental-module.js (136 lines,
  test passed)` in the same step. One state must win.
- **DELEGATE step planned without peer pre-check.** Plan validator
  emits the peer-availability finding as a hint not a blocker.
  Promoting to blocker is its own decision.

---

## Deferred from v7.7.6 audit (carried forward)

**Pre-existing (carried from v7.7.4+):**

- **monaco-editor's bundled DOMPurify** (2 moderate XSS, formerly 8).
  Not self-fixable; depends on monaco upstream. Documentation entry
  only — does not count as an open backlog item.

---


## Resolved in v7.7.7

### Audit cleanup — doc-drift fixes + audit-doc-drift extension + 2 code hardenings

The v7.7.6 full-codebase audit (28 categories, 904 files, manual
verification) surfaced eight findings. v7.7.7 closes the four where the
fix was small and the risk-vs-reward favoured shipping now. The other
four are deferred with their own scope (see "Deferred from v7.7.6 audit"
section below).

**Doc-drift bugs fixed (slipped past audit-doc-drift's existing pins):**

1. `docs/GATE-INVENTORY.md` Z.13 — claimed "9 SECURITY_REQUIRED_SLASH
   (v7.5.1)" while the live `Set` in `IntentPatterns.js` had grown to 12
   (v7.5.5 added `self-recall`; v7.5.9 added `install-software` and
   `open-software`). Updated to "12 SECURITY_REQUIRED_SLASH (v7.5.9)".
   Sister-claim in this file: `AUDIT-BACKLOG.md` had three references
   to "9" in the slash-discipline deferred-item block; all updated to
   "12"
2. `docs/CAPABILITIES.md` + `docs/ARCHITECTURE-DEEP-DIVE.md` +
   `README.md` + `docs/banner.svg` — test-file count was "413" /
   tests-count "6917"; live values are 418 / 6943 (v7.7.6 baseline).
   All five doc surfaces updated to match live values

**audit-doc-drift extension:**

3. New check #26: pins the SECURITY_REQUIRED_SLASH count claimed in
   `GATE-INVENTORY.md` against the actual `Set` size in
   `src/agent/intelligence/IntentPatterns.js`. Prevents the same drift
   from recurring silently. Baseline is now 55 strict-checked claims
   (was 54)
4. `TEST_FILES` constant converted from a literal `= 413` to dynamic
   counting via `fs.readdirSync` walking `test/`. The pre-v7.7.7 setup
   was a drift-blind tautology: if the doc and the constant happened to
   agree on the same wrong number, the check passed. Now the constant
   is computed at run time, so any addition or removal of a
   `*.test.js` file is caught the next time `audit-doc-drift` runs.
   `TESTS_WIN` and `TESTS_WIN_BASELINE` (and the badge-string
   "6917 passing") all bumped to 6943

**Code hardenings (both LOW severity, both from v7.7.6 audit):**

5. `EffectorRegistry.js` headless-`shell.openExternal` fallback —
   `exec(cmd)` with template-string-interpolated URL replaced by
   `execFile(bin, [url])` array-args. URL was already allowlist-filtered
   so risk was very low; the change brings the pattern in line with the
   rest of the codebase (where `execFile` with array-args is the
   universal pattern)
6. `AgentLoopSteps.js` shell-arg parser — `MAX_COMMAND_LEN = 2000`
   length-cap added before the regex match. Removes the theoretical
   quadratic-backtracking surface entirely (realistic risk was
   negligible: LLM-generated input, `execFile` output, surrounding
   timeout, but the cap costs only 3 LOC)

**Test coverage:**

`test/modules/v777-audit-extension.contract.test.js` — 9 subtests:

- A1 package.json version 7.7.7
- A2 GATE-INVENTORY says "12 SECURITY_REQUIRED_SLASH"
- A3 AUDIT-BACKLOG says "12", not "9"
- A4 docs say "418 test files" and "6943 tests"
- A5a audit-doc-drift TEST_FILES is dynamic (no literal)
- A5b audit-doc-drift TESTS_WIN === 6943
- B1 EffectorRegistry no longer has `exec(string)` pattern
- B3 AgentLoopSteps has length-guard before regex
- D1 audit-doc-drift baseline ≥ 55 strict-checked claims

**Retired:**

- `v776-toolchain-refresh.contract` A1 (single-version pin on 7.7.6) —
  obsolete with v7.7.7 ship
- `v773-cleanup.contract` A2 (TESTS_WIN_BASELINE/TESTS_WIN/TEST_FILES
  pinned to 6917/6917/413) — obsolete after baseline bump and dynamic
  TEST_FILES conversion

---

## Deferred from v7.7.6 audit

The v7.7.6 full-codebase audit surfaced eight findings. v7.7.7 closed
six (F1+F2 doc drift, A3+A5 drift-blind audit-pin extension, F3 EffectorRegistry,
F4 AgentLoopSteps). The remaining items are deferred to focused follow-up
releases where each gets its own scope and risk evaluation:

- **F5 / C1 — Mermaid SVG `innerHTML` without DOMPurify**. Defense-in-
  depth fix in `src/ui/modules/chat.js` Z.340. Cannot reuse the
  monaco-bundled DOMPurify (which carries the unfixable XSS advisories);
  needs a runtime `dompurify` dependency decision. Will be its own
  defense-in-depth release
- **F6 / B2 — Hardcoded Node v22.22.2 in
  `CommandHandlersInstallDB.js`**. Not currently stale (v22.22.2 is
  latest v22 LTS as of v7.7.7), but the hardcoded pattern will drift by
  every Node maintenance release. Needs an LTS strategy decision: dynamic
  fetch from `nodejs.org/dist/index.json` with fallback / `latest-v22.x`
  symlink / re-evaluate v22 → v24 Active LTS bump. Will be its own
  Node-LTS-strategy release
- **B4 — `CLEANUP-PROTOCOL.md` formalization**. Pre-existing
  documentation TODO from earlier audits; not from v7.7.6
- **mermaid ^10.9.1 → v11 evaluation**. No CVE; one major behind
  current. Eigene Toolchain-Maintenance-Release wie electron-builder /
  monaco / esbuild

**Pre-existing (carried from v7.7.4+):**

- **monaco-editor's bundled DOMPurify** (2 moderate XSS, formerly 8).
  Not self-fixable; depends on monaco upstream releasing an updated
  bundle. `npm audit fix --force` would downgrade monaco to 0.53 to
  "fix" it, which is not a real fix
- **Sidebar splitter not draggable**. Pre-existing UI issue, unrelated
  to audit. Eigene UI-Release oder v7.7.8

---

## Resolved in v7.7.6

### Build-toolchain refresh — npm audit clears the build-pipeline chain

After v7.7.5 closed the Monaco AMD → ESM migration the remaining audit
findings clustered in three older-major dev-dependencies. v7.7.6 raises
them all to current stable in a single focused release.

**Three dev-dependency bumps** (all in `package.json`, no code changes):

1. `electron-builder ^25.1.8 → ^26.8.2`

   Transitive chain that gets cleaned up by this single bump:
   - **Vulnerabilities removed** (HIGH severity): tar@6 (Path traversal +
     symlink overwrite), @tootallnate/once (ReDoS), app-builder-lib chain,
     dmg-builder chain, electron-builder-squirrel-windows chain, node-gyp,
     @electron/rebuild, make-fetch-happen, http-proxy-agent, cacache
   - **Deprecation notices removed**: uuid@9.0.1 (no longer supported),
     npmlog@6.0.2, gauge@4.0.4, are-we-there-yet@3.0.1, rimraf@3.0.2,
     glob@7.2.3 + @8.1.0 + @10.5.0, @npmcli/move-file@2.0.1, inflight@1.0.6

2. `esbuild ^0.24.2 → ^0.28.0`

   - **Vulnerability removed** (moderate severity): esbuild < 0.25 advisory
   - API-compatibility verified: build-bundle.js uses only the stable
     `esbuild.build()` and `esbuild.context()` surface that has been
     unchanged since 0.17. No removed `startService` calls, no deprecated
     `incremental: true` flag, no old `watch: { ... }` pattern. Pinned
     against re-introduction by `v776-toolchain-refresh.contract` C1

3. `puppeteer ^23.0.0 → ^24.15.0`

   - **Deprecation notice removed**: "< 24.15.0 is no longer supported"
   - **Transitive deprecation removed**: whatwg-encoding@3.1.1
   - Risk profile: defensive usage in `src/agent/capabilities/WebPerception.js`
     wraps the require in try/catch and falls back to lightweight HTTP-fetch
     mode if puppeteer is unavailable or misbehaves. Even subtle behavioural
     changes in 24.x cannot break Genesis runtime — they would only silently
     reduce web-perception capability

**No changes** in `src/`, `scripts/`, `main.js`, `preload.js`. Pure
`package.json` refresh.

**Expected after-state on user machine:**

- `npm install` deprecation notices: **13 → 0**
- `npm audit` vulnerabilities: **14 (2 low, 3 moderate, 9 high) → ~1**
- The single remaining vulnerability is the monaco-editor-bundled
  `dompurify`, which is not self-fixable. It requires monaco upstream
  to release a build with an updated bundle. Tracked under deferred
  monitor items below

**Test coverage:**

`test/modules/v776-toolchain-refresh.contract.test.js` — 6 subtests:
- A1 package.json version 7.7.6
- B1 electron-builder major ≥ 26
- B2 esbuild minor ≥ 0.28
- B3 puppeteer ≥ 24.15
- C1 build-bundle.js esbuild-API surface stable-only (no removed/deprecated calls)
- D1 audit-doc-drift baseline still ≥ 53 claims (no regression)

**Out of scope:**

- electron stays on `^42.0.0` (current stable)
- monaco-editor stays on `^0.55.0` (current stable)
- mermaid, typescript, c8, @types/node — no audit findings, no churn
- `npm run build` (electron-builder dist-pipeline) — not on the release
  test path. Win/Linux dist should work; macOS dmg-builder path requires
  verification by macOS users (release machine has no Mac)

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

- **Slash-Discipline 12 SECURITY_REQUIRED_SLASH extension.** The
  current Slash-Discipline contract covers 4 of the 12 SECURITY_REQUIRED_SLASH
  intents. Extending coverage to all 12 is real security-design work
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

- **Electron-builder toolchain bumps.** ✅ Resolved in v7.7.6 — see above.
  electron-builder ^25 → ^26.8.2, esbuild ^0.24 → ^0.28, puppeteer ^23 → ^24.15.
  All three transitive chains cleaned, npm audit dropped from 14 to ~1
  (only monaco-bundled dompurify remains, not self-fixable).

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
