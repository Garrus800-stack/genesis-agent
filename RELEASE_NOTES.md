# Genesis Agent v7.8.3 — **Bug-Sweep + Loose-Ends + Convention-Audit-Closeout.**

**Bug-Sweep + Loose-Ends + Convention-Audit-Closeout.**

The release lands in two passes documented together as one entry.
The first pass (Blocks 1-5) closes long-standing v7.5.8 / v7.6+ /
v7.4.x backlog items. The second pass (Findings F1-F9, ground-truth
review) closes the gaps the first pass introduced or left open plus
findings from an external audit of the v7.8.3 ZIP — same
release-cycle, same artefact, no separate version bump.

---

### First pass — five backlog blocks

### Block 1 — openPath app-launch + Unicode word-boundary

Two bugs in the same regex, both from the v7.5.8 backlog.

The greedy capture `(\w[\w\s.-]*\w)` matched whitespace, so
"öffne firefox bitte" tried to launch the literal app
`firefox bitte` and failed. Same pattern broke "starte chrome jetzt"
and "open word now". The capture is now `([\w][\w.-]*)` — a single
word with optional dot/dash — and filler tokens
(`bitte`, `mal`, `please`, `now`, `the`, `den`, `mir`, …) are
consumed between verb and app-name via optional repetition.

Separately the verb regex had no word-boundary, so "reopen the
window" matched `open` mid-word and "teststart firefox" matched
`start`. A plain `\b` would not have helped because JavaScript
`\b` is ASCII-only — it does not see "öffne" as a word at all and
the verb regex would have missed German entirely. The new
explicit `(?:^|[^\w])` prefix is Unicode-safe.

Live-tested with 23 DE/EN/quoted/articles/boundary/null cases.
File: `src/agent/hexagonal/CommandHandlersShell.js`. Constants
hoisted to module scope so the mixin stays under its size guard.

### Block 2 — Vague-reference soft hint

Also v7.5.8 backlog. When the user says "öffne das" or "open it"
with no antecedent in this message or the last two turns, downstream
planners would invent a referent (hallucinated paths, made-up file
names). v7.8.0 added prompt-level guardrails for the planner; what
was missing was an *early-stage detector* that flagged the message
as vague before it reached the LLM.

New `src/agent/foundation/VagueReferenceDetector.js` matches three
ingredients: an action verb (öffne/open/starte/zeige/lies/lade/
lösche/...), a vague pronoun (es/das/it/that/this/...), and the
absence of a concrete antecedent. Antecedents are concrete nouns
(datei/file/ordner/path/skill/...) or quoted strings — checked
in the current message after stripping the pronoun, and in the
last two conversation turns.

`ChatOrchestrator` calls the detector and passes the result through
to `PromptBuilder.setVagueReference()`. `PromptBuilderSectionsAwareness`
renders it as a soft hint in the same style as the v7.8.1 explicit-
tool hint — Genesis decides whether to ask, or to act with care
after naming what was assumed. No hard block; autonomy preserved.

### Block 3 — CloudSyncSafety shared helper + boot warning

Generalises the v7.5.8 OneDrive Files-On-Demand fix. Pre-v7.8.3
the cloud-sync detection + read-timeout wrapper lived as private
helpers inside `SelfModelSourceRead.js`, used only for idle-time
source reads. Other boot-path callers (`SkillManager` manifests,
`PluginRegistry` plugin manifests, `HotReloader` watched files)
had no awareness — if Genesis was installed under OneDrive,
boot could hang for tens of seconds as the OS pulled placeholders
on first touch.

New `src/agent/foundation/CloudSyncSafety.js` exports the same
markers + timeout wrapper as shared API. `SelfModelSourceRead.js`
delegates with no behaviour change. `SkillManager`, `PluginRegistry`,
`HotReloader` now log a clear `[CLOUD-SYNC]` warning when their
working directory is under a cloud-sync root. `AgentCoreBoot`
detects rootDir under cloud-sync and emits a one-shot
`system:cloud-sync-root-detected` event plus a prominent boot-log
warning — three lines that explain the problem and how to fix it.

Three marker gaps closed at the same time:
  - Mac iCloud canonical path
    (`/Library/Mobile Documents/com~apple~CloudDocs/`)
  - Mac and Linux Dropbox via `/Dropbox/`
  - Google Drive alt no-space form `/GoogleDrive/`

### Block 4 — CostStream failover dimension

v7.8.1 / v7.8.2 tightened cloud-failover handling. What was missing
was a way to *see* how often failover actually fires in production.
The `llm:call-complete` payload and `CostStream` row schemas now
carry a `failover` field — `'none'` for original-backend calls,
otherwise the classified reason
(`quota-exhausted` / `rate-limit` / `subscription-required` /
`auth` / `timeout` / `connection-error` / `other`). Persisted into
the cost shards so post-hoc analysis can see failover rate per
backend, per model, per week without re-instrumenting.

`ModelBridge._handleFailoverError` stamps `options.failover` with
the classified reason; `LLMPort._emitCallComplete` reads it during
the next emit. Schemas marked `optional` to keep back-compat with
emitters that don't carry the field.

### Block 5 — check-stale-refs Mode 3: auto-detect unregistered contracts

The `contracts` list in `scripts/stale-refs.json` is hand-maintained.
When a developer adds a new behavioural-contract test prefix
(e.g. `chat contract: escapes HTML`), they have to add an entry
here. Burn-in surfaced that this step was quietly skipped: the
XSS-escape tests in `ui-bundle-modules.test.js` used a `chat contract:`
prefix that had no stale-ref entry guarding them. A later rename
or cleanup could have lost the safety net silently.

`check-stale-refs.js` Mode 3 scans test files for
`(test|it)('<word> contract: '` patterns, counts occurrences, and
fails (with `--strict`) when a prefix is seen ≥2 times but is
absent from the contracts list. The `chat contract:` gap that
motivated this is now registered (`minCount: 2`).

### Verification

7333 tests passed, 0 failed (5 new files: 19 + 22 + 25 + 7 + 5
cases). Fitness 130/130. Audit-doc-drift clean (55 doc claims,
test files 439 → 444, events 460 → 461, schemas 460 → 461).
Audit-future-version-refs clean. Stale-refs Mode 3 clean (13
prefixes seen, all registered).

---

### Second pass — F1-F9 follow-ups

After the first pass shipped, an external audit on the ZIP surfaced
nine findings — two CI-blocking, four UX/precision issues, three
internal-quality items. The follow-up is folded into the same
release because none of it changed user-visible behaviour beyond
fixing what the first pass introduced.

**F1 — audit-contracts strict-mode failure (CI-blocker).** Seven
test names asserted security properties without a `<x> contract: `
prefix: five in `v779-pse-gates.test.js` (PSE HardGate fail-closed
invariants) and two in the newly added `v783-cloud-sync-safety.test.js`
(path-marker discipline and timeout error-code). Renamed all seven
with new prefixes `hardgate contract:` (minCount 5) and
`cloud-safety contract:` (minCount 2), both registered in
`stale-refs.json`. The first pass already added Mode 3 of
`check-stale-refs.js` for this drift class — but `audit-contracts.js`
is a separate audit with its own ratchet, and the first-pass tests
themselves had the prefix gap. CI now exits 0 on `npm run ci`.

**F2 — channel mismatch (silent).** The `genesis:self-message`
push channel (PSE pipeline pushing self-statement bubbles to chat)
was emitted from `AgentCoreWire.js` and received in
`renderer-main.js`, but missing from the `CHANNELS` contract block
in `main.js`. `validate-channels.js` reported it as a warning but
did not block — because the script was not run in `--strict` mode
in the CI chain. Same class of drift the v7.6.0 fix addressed.
Added the channel entry; enabled `--strict` in both `ci` and
`ci:full` so the next drift fails the build instead of warning.

**F3 — APP_LAUNCH_RE common-noun trap (UX regression in first pass).**
First-pass Block 1 added `the/den/die/das` as filler tokens. Side
effect: "open the document" captured "document" as the app name
and tried to `start "" "document"` — silent failure on Windows.
"öffne die Datei test.txt" captured "Datei". "starte den Browser
firefox" captured "Browser". Three rejection gates added: (1)
common-noun set covering generic concrete nouns (`document`,
`Datei`, `Browser`, `Editor`, `Terminal`, …) using the same
vocabulary as VagueReferenceDetector's antecedent list; (2)
filename-in-message check (`*.txt`, `*.md`, `*.pdf`, … 35
extensions) that defers to the path-fallback route; (3) verb
discrimination — the filename check applies only to `open`/`öffne`
verbs, not `start`/`starte`, because "starte node.js" and "start
chrome.exe" are legitimate app-launches with dot-bearing names.
The app-launch logic itself extracted to a new file
`src/agent/hexagonal/OpenPathAppLaunch.js` (helper module owned by
openPath alone) so the mixin stays under its size guard.

**F4 — VagueReferenceDetector false-positives (precision regression
in first pass).** The first-pass detector used a fixed antecedent
whitelist of 17 words. "öffne das Buch" flagged as vague because
`Buch` was not in the list. "öffne das" after "die test.txt" in
the previous turn also flagged as vague because `test.txt` was
not matched. Whitelist extended to 35 generic nouns plus two
heuristic checks: (1) filename-like tokens via the same extension
list F3 uses; (2) path-like tokens covering POSIX paths, Windows
drive paths (`C:\…`), and home-relative paths (`~/…`). Both
checks applied to current message and the last two history turns.
13 additional contract-prefixed test cases pin the new behaviour
(22 → 35 total).

**F5 — failover field semantic collision (brittle, not yet harmful).**
First-pass Block 4 had `ModelBridge._handleFailoverError` setting
`options.failover` to a string reason for LLMPort, then later
spreading `{ ...options, failover: true }` (boolean) into the
meta-outcome record. Currently harmless because `_recordMetaOutcome`
ignores the field — but any future MetaLearning reader of
`options.failover` would collide on the same key with two
incompatible types. Renamed: `options._failoverReason` for the
LLMPort path, `isFailoverRetry: true` for the meta-outcome path.
The event payload field stays `failover` for back-compat with
CostStream readers.

**F6 — KindTriggers coverage gap (first pass shipped without test).**
The v7.7.9 Phase 3 `KindTriggers.js` service (138 LOC, owns the
`goal:completed → goal-closure-thought` and `planner:complete →
self-formulated-plan` translations) had no dedicated test file.
Architectural-fitness scored 10/10 on coverage gap (the threshold
is ≥99%, score not affected) but the file itself was uncovered.
New `v783-kind-triggers.test.js` with 15 cases covering lifecycle
(constructor / start-idempotent / stop / subscribed events), both
emit paths, the significance formulas (lenBoost cap, validBoost,
stepBoost cap), and the try/catch error swallow.

**F7 — dead-code duplicate (pre-v7.8.3 carry-over from v7.5.4).**
`src/agent/capabilities/shell/ShellSafety.js` and
`src/agent/core/shell/ShellSafety.js` were bytegleich (same MD5,
469 LOC). The `capabilities/` copy had zero importers — all
references used the `core/` path. Likely v7.5.4-split residue.
Deleted.

**F8 — vague-reference signal swallowed by handler (logic gap from
first pass).** The first-pass consolidation put
`promptBuilder.setVagueReference()` inside the `if (!response)`
fallback block. Side effect: any handler that returned a truthy
help string (e.g. `openPath`'s "Welchen Ordner ..." for "öffne
das") swallowed the signal, so the LLM never saw the soft hint
in exactly the cases the detector was built for. Detection lifted
above the handler check, computed once, passed both into the
handler context bag (so handlers can be context-sensitive about
their help message) and into PromptBuilder on the fallback path.

**F9 — LLMPort latency-based cache-hit heuristic (pre-v7.8.3,
exposed by Block 4).** `LLMPort` decided `cached: true` for any
call with latency < 5ms. Local Ollama with GPU + short prompt can
hit that bound on a real call. False-positive `cached:true` then
sets tokens to 0 in the CostStream row, while the new `failover`
field from first-pass Block 4 stays — inconsistent row. Fix:
`ModelBridge.chat` stamps `options._cached = true` on cache hit
before returning the cached value. LLMPort prefers the explicit
flag, falls back to the latency check as a safety net for callers
that bypass ModelBridge.

### Verification (final)

All 17 strict-mode audits clean. v742-structure mixin guard 9/9.
v783-* tests: 27 (openpath) + 35 (vague-ref) + 25 (cloud-sync) +
7 (coststream) + 5 (stale-refs) + 15 (kind-triggers) = 114 cases
across 6 files. v779-pse-gates renames preserve all 20 cases.
audit-contracts strict-mode clean. Stale-refs 15 prefixes
registered. CHANGELOG covers both passes under one version
entry.

### File changes — first pass

- modified: `src/agent/hexagonal/CommandHandlersShell.js` (Block 1: regex + boundary)
- modified: `src/agent/hexagonal/ChatOrchestrator.js` (Block 2: detector wiring + setter cluster consolidation)
- modified: `src/agent/intelligence/PromptBuilder.js` (Block 2: setVagueReference setter)
- modified: `src/agent/intelligence/PromptBuilderSectionsAwareness.js` (Block 2: vague-reference hint section)
- modified: `src/agent/foundation/SelfModelSourceRead.js` (Block 3: delegate to CloudSyncSafety)
- modified: `src/agent/capabilities/SkillManager.js` (Block 3: cloud-sync warning at load)
- modified: `src/agent/capabilities/PluginRegistry.js` (Block 3: cloud-sync warning at load)
- modified: `src/agent/capabilities/HotReloader.js` (Block 3: cloud-sync warning at watch)
- modified: `src/agent/AgentCoreBoot.js` (Block 3: rootDir cloud-sync detection + event)
- modified: `src/agent/foundation/ModelBridge.js` (Block 4: stamp failover reason on options)
- modified: `src/agent/ports/LLMPort.js` (Block 4: failover field in emit)
- modified: `src/agent/foundation/CostStream.js` (Block 4: failover field in row)
- modified: `src/agent/core/EventTypes.js` (Block 3: system:cloud-sync-root-detected catalogue entry)
- modified: `src/agent/core/EventPayloadSchemas.js` (Blocks 3 + 4: schema entries)
- modified: `scripts/check-stale-refs.js` (Block 5: Mode 3)
- modified: `scripts/stale-refs.json` (Block 5: chat contract entry)
- new: `src/agent/foundation/VagueReferenceDetector.js` (Block 2)
- new: `src/agent/foundation/CloudSyncSafety.js` (Block 3)
- new: `test/modules/v783-openpath-app-launch.test.js` (Block 1: 19 cases)
- new: `test/modules/v783-vague-reference.test.js` (Block 2: 22 cases)
- new: `test/modules/v783-cloud-sync-safety.test.js` (Block 3: 25 cases)
- new: `test/modules/v783-coststream-failover-field.test.js` (Block 4: 7 cases)
- new: `test/modules/v783-stale-refs-auto-detect.test.js` (Block 5: 5 cases)
- modified: `test/modules/v758-fix.test.js` (point cloud-sync-markers presence test at new location)
- modified: `test/modules/v742-structure.test.js` (raise mixin soft guard 320 → 340 for Block 1)

### File changes — second pass

- modified: `main.js` (F2: `genesis:self-message` push channel entry)
- modified: `package.json` (F2: `validate-channels.js --strict` in `ci` and `ci:full` chains)
- modified: `src/agent/hexagonal/CommandHandlersShell.js` (F3: route app-launch through OpenPathAppLaunch helper)
- modified: `src/agent/hexagonal/ChatOrchestrator.js` (F8: vague-reference detection lifted above handler)
- modified: `src/agent/foundation/VagueReferenceDetector.js` (F4: extended whitelist + filename/path heuristics)
- modified: `src/agent/foundation/ModelBridge.js` (F5: rename `failover` → `_failoverReason` vs `isFailoverRetry`; F9: stamp `options._cached` on cache-hit)
- modified: `src/agent/ports/LLMPort.js` (F5: read renamed field; F9: prefer explicit cached flag)
- modified: `test/modules/v783-vague-reference.test.js` (F4: 13 new cases, 22 → 35)
- modified: `test/modules/v783-openpath-app-launch.test.js` (F3: 8 new cases, 19 → 27)
- modified: `test/modules/v783-cloud-sync-safety.test.js` (F1: 2 test names → `cloud-safety contract:` prefix)
- modified: `test/modules/v779-pse-gates.test.js` (F1: 5 test names → `hardgate contract:` prefix)
- modified: `test/modules/v783-coststream-failover-field.test.js` (F5: update assertions to renamed field)
- modified: `test/modules/v742-structure.test.js` (F3: mixin soft guard restored — CommandHandlersShell now under 340 after extraction)
- modified: `scripts/stale-refs.json` (F1: `cloud-safety contract:` minCount 2 + `hardgate contract:` minCount 5)
- new: `src/agent/hexagonal/OpenPathAppLaunch.js` (F3: app-launch helper)
- new: `test/modules/v783-kind-triggers.test.js` (F6: 15 cases for KindTriggers)
- deleted: `src/agent/capabilities/shell/ShellSafety.js` (F7: dead-code duplicate, zero importers)

---

---

**Full Changelog**: See [CHANGELOG.md](https://github.com/Garrus800-stack/genesis-agent/blob/main/CHANGELOG.md)

**Installation**:
```bash
git clone https://github.com/Garrus800-stack/genesis-agent.git
cd genesis-agent
npm install
npm start        # Electron desktop
node cli.js      # Headless CLI
```
