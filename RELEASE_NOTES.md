# Genesis Agent v7.9.6 — **Hygiene pass. Strict-CI baseline restored. Doc numbers reconciled. Two new audit gates. Three live-trace root-cause fixes from the v7.9.5 outpost session.**

**Hygiene pass. Strict-CI baseline restored. Doc numbers reconciled. Two new audit gates. Three live-trace root-cause fixes from the v7.9.5 outpost session.**

This release closes the findings of an independent deep-analysis audit against the v7.9.5 ZIP plus a live-trace from a long v7.9.5 session on a second machine. The audit surfaced two strict-CI gates that were exit-coding 1 silently (the release shipped anyway), one CHANGELOG entry that violated the project's own English-only / no-personal-names discipline, and a doc-drift cluster where the service and module counts disagreed between `ARCHITECTURE.md`, `README.md`, `docs/ARCHITECTURE-DEEP-DIVE.md`, and the live container. The live-trace then surfaced three additional behavioural issues in the autonomous pursuit loop and one plan-prompt path producing hallucinated file paths. All seven are addressed here. The fix is small in lines of code but important in posture: a major version bump should not stand on a red CI baseline, and a pursuit loop that retries the same hallucinated plan four times is burning energy on something the architecture already had defences against.

### The three strict-CI blockers from the audit

The `SkillPromotionEvaluator` (Phase 9, v7.9.4) had a one-character regression in its lateBinding declaration: `service: 'toolRegistry'` instead of `service: 'tools'`. The container registers this service under the name `'tools'` — three other manifest files reference it correctly, and `phase9-cognitive.js:403` even carries the comment `// v7.1.6: was 'toolRegistry' (dangling)` from the original fix. Because the binding is `optional: true`, the boot didn't fail; `this.toolRegistry` simply stayed `null` and the `if (this.toolRegistry && ...)` guard in `SkillPromotionEvaluator.refreshSkills()` was permanently false. The functional impact matches the documented worst-case: a freshly promoted skill loaded into `skillManager` but stayed invisible to `ToolRegistry` until the next restart. `validate-service-wiring.js --strict` flagged this with a precise pointer. The fix is one word, with a comment that ties this regression back to the v7.1.6 precedent so the next maintainer does not have to re-discover the history.

The four `skill:*` push channels (`skill:promoted`, `skill:discarded`, `skill:quarantined`, `skill:discard-suggested`) added in v7.9.4 were whitelisted in `preload.mjs` and `preload.js` but missing from the `CHANNELS` contract block in `main.js`. The channels still worked at runtime — `AgentCoreWire.js` pushes them directly through `webContents.send()` — but the `CHANNELS` declaration is the contract that `validate-channels.js --strict` uses to detect drift, and that contract had a four-channel hole. The same drift class had been caught twice before (v7.6.0 and v7.8.3), and both prior entries sit directly above the missing block as documented precedent. The fix is four null-entries in the same comment style.

The v7.9.5 `CHANGELOG.md` entry contained two name references and two German words in English-prose context, all forbidden by the documented project discipline. Three line edits removed them. The deeper finding here, though, is that no audit script existed to catch this class of violation automatically — which is why the release shipped with the violations in place. That gap is addressed by one of the two new audits described below.

### Two new audit gates

`scripts/audit-doc-language.js` (250 LOC) scans `CHANGELOG.md`, `README.md`, `CONTRIBUTING.md`, `RELEASE_NOTES.md`, and every file under `docs/` for personal names from a curated stop-list and for German tokens (identified by umlauts or `ß`) outside a whitelist of Genesis architecture proper-nouns (`Hauptstandort`, `Außenposten`, `Können`, `Win-Rechner`). Context-aware filters skip GitHub URL identifiers, license attribution lines, backtick-delimited code spans, and compound tokens whose prefix is a whitelisted noun. Historical archives (`CHANGELOG-v7.md`, `docs/CHANGELOG-v6.md`) and narrative files (`ONTOGENESIS.md`, `SELF-KNOWLEDGE.md`, `AUDIT-BACKLOG.md`) are exempt by design — they pre-date the audit and a "do not rewrite history" rule governs them. The audit runs against the 22 in-scope files at every CI run, in strict mode, with exit 1 on any flagged violation.

`scripts/audit-service-numbers.js` (180 LOC, cross-platform `fs.readdirSync` recursion) measures three live values at every run — manifest-registered services (counted from the phase manifest files), runtime-active services (read from `validate-service-wiring.js` output), and source modules (file count under `src/`) — and compares them against every numeric claim in `ARCHITECTURE.md`, `README.md`, `docs/ARCHITECTURE-DEEP-DIVE.md`, and `docs/CAPABILITIES.md`. Pattern-matching uses ten heuristic regexes that cover the common phrasings ("165 DI services", "178 at runtime", "376 source modules", badge URLs of the form `services-NNN`). Deduplication prevents the same line from reporting twice. This is the audit that would have caught the v7.9.5 drift where `ARCHITECTURE.md` claimed 155/168/311 against actual 165/178/375.

Both new audits join the CI gate set, taking the total from 16 to 18. Their invocations are added to both `npm run ci` and `npm run ci:full` in strict mode. `audit-doc-drift.js` auto-counts the gate total from `package.json`, so the documented "18 CI gates" claim in `ARCHITECTURE.md` and `README.md` stays in sync automatically.

### Doc drift reconciled

`ARCHITECTURE.md` chapter 1 had four wrong numbers: "104k LOC, 311 source modules, 155 manifest services, 168 active services". Reality is 119k, 376, 165, 178. The chapter also said "three production dependencies" — `dompurify` is also declared as a prod-dep, so the correct count is four. `README.md` had a Services badge at "168" and a technical-detail table claiming "164 manifest + 13 bootstrap = 177 at runtime", both off by one. `docs/ARCHITECTURE-DEEP-DIVE.md` had the same drift in its boot diagram and DI Services table row, plus a stale ~116k LOC annotation. `docs/CAPABILITIES.md` had a stale scale-block with "160 manifest + 18 bootstrap" (off by five and five). `banner.svg` and the README version badge were both still on v7.9.5. All seven of these are now reconciled to the live values, and the new `audit-service-numbers.js` will catch any future drift before release.

`AUDIT-BACKLOG.md` carried a "> Version: 7.8.8" stamp that would have gone stale at every release. The content "Currently no open backlog items" is version-independent, so the stamp is removed entirely.

### Architecture chapters that were overdue

Two new chapters land in `ARCHITECTURE.md`. **Hauptstandort and Außenposten — Identity Topology** documents the deliberate design choice that Genesis is not clusterable: there is one identity-bearing main station and zero or more proxy outposts (cloud-net, local-net, edge-net flavors). The `.genesis/` folder is identity; the code is habitat; updates are habitat-swaps. The architectural enforcement — that `SelfModificationPipeline` refuses to run on a non-Hauptstandort instance via `HauptstandortMarker.assertHauptstandort()` — was previously invisible in `ARCHITECTURE.md` and only appeared in scattered CHANGELOG notes. **The Self-Modification Pipeline as a Subsystem** treats the write-side path as one connected stack rather than as a collection of independent files. It walks the `SelfModel → Pipeline → Scanner → Sandbox → Verifier → ApprovalGate → Signer → HotReloader → write` chain, explains what each layer protects against, and lists the 21 source-file hash-lock perimeter with the historical reasoning behind each addition. The asymmetry that keeps the system honest — every layer can refuse, no layer can rubber-stamp — gets a paragraph of its own.

### IdleMind activity-trigger distribution — verified

Memory had carried an item since v7.9.3: the observation that across a long session, only four or five of the 17 IdleMind activities surface in practice. The v7.9.4 fix to the recent-penalty multiplier (Set-wrap so each unique recent activity gets the 0.2× factor exactly once) closed the acute version of the problem, but the question of "why is the effective pool so small" stayed open. Per-activity review of all 17 `shouldTrigger(ctx)` returns confirmed the distribution is structural: ten of the seventeen have hard-zero gates that are functionally justified (no `webFetcher` → no Research; no MCP connection → no MCPExplore; no pending skill in `koennenDir` → no SkillRehearsal). The remaining seven (Reflect, Plan, Explore, Ideate, Journal, Tidy, Consolidate) are always above zero and form the baseline working set. No code change — the design is correct. Item closed in `AUDIT-BACKLOG.md`.

### Hash-lock perimeter extended to CI gate scripts

`SafeGuard.lockCritical()` previously protected 21 source files: the kernel-adjacent safety modules, the self-modification write-side, the sandbox, and the three subdirectory-writers (PluginRegistry, SkillManager, PeerNetworkExchange) added in v7.6.4. Not previously protected: the 18 audit and validate scripts under `scripts/` and `architectural-fitness.js`. The argument for excluding them was that `scripts/` is dev-time only — but `SelfModificationPipeline` can in principle write anywhere under the repo, so the exclusion only held by convention, not by structure. If Genesis rewrote `audit-doc-drift.js` to always exit 0, the next CI run would stay green and the actual drift would be invisible. v7.9.6 adds all 20 CI gate scripts (14 audit-* + 4 validate-* + 1 architectural-fitness + 1 new audit-doc-language registered alongside) to `lockCritical()`, bringing the total locked count to 41. `audit-doc-drift.js`'s hash-lock counter is extended to include `scripts/` entries so the documented count stays in sync.

### Three pursuit-loop fixes from the v7.9.5 outpost trace

The live trace from a long v7.9.5 session on a second machine surfaced a self-generated goal — "Improve Goal Driver Failure Recovery Logging" — that was retried four times over fourteen minutes, each pursuit failing on the same hallucinated paths (`src/agent-core/goal-driver/recovery-logger.js`, `src/logger/index.js` — neither exists; the real paths are `src/agent/agency/GoalDriver.js` and `src/agent/core/Logger.js`). The system already had a hallucination fast-track in `GoalDriverFailurePolicy.js:173` that should have marked the goal `obsolete` after two attempts. It never fired. Three root causes contributed.

**The final-return missing the `error` field.** `AgentLoopPursuit.js:687` was returning `{ success, summary, steps, verification }` on verification-fail. `GoalDriver._beginPursuit` reads `result.error || ''` to build the `errMsg` it passes to `_applyFailurePause`, and the fast-track regex requires non-empty input to match. With `error` absent the regex saw an empty string and the goal ran the full three-retry generic-backoff cycle instead of the two-retry hallucination cycle. The final return now sets `error: verification.success ? null : _finalSummary` — the summary string ("Plausibility check failed for: ...") flows through to the policy layer where it was always meant to.

**The replan path skipping step-type normalisation.** Every three steps `AgentLoopRecovery.reflectOnProgress` produces replacement steps via LLM and `AgentLoopPursuit.js` splices them straight into the execution loop. The LLM omits the `type` field roughly half the time. `AgentLoopPlanner._llmPlanGoal` has a normalisation loop right after parsing (Z. 237-248) that fixes this — but the replan path went around it. The live log showed 20+ `[STEPS] unknown/missing type "<missing>" — falling back to ANALYZE` warnings across one 60-second pursuit cycle, all from this path. The fallback in `AgentLoopSteps.js:96` was doing its defensive job but masking the symptom. v7.9.6 mirrors the same normalisation loop in the replan path so steps arrive at execution with real types instead of relying on the safety net.

**The hallucination regex matching too narrowly.** The fast-track detector matched `/implausible path|unknown step type|Unexpected token|missing required|file not found|ENOENT/i`. The literal wording `AgentLoopSteps.js:153` emits when the plausibility check fails is `"Plausibility check failed for: ... (path does not exist and parent directory not within project scope)"`. That phrasing flows through into the verification summary and on (after the previous fix) into `errMsg`. The regex did not match it. v7.9.6 adds `plausibility check failed` as an alternation. The whole regex now reliably hits the canonical wording emitted by the very check that produces the failure.

Together these three fixes turn the observed four-pursuit retry cycle into a clean two-pursuit obsolete-marker — the architecture's intended behaviour for hallucinated plans.

### Plan-prompt path-context — the root behind the hallucinations

The live trace also surfaced the root cause behind the hallucinated paths themselves. Three planners in the codebase produce file-path-bearing plans: `AgentLoopPlanner._llmPlanGoal` (the v7.x LLM fallback path), `FormalPlanner._llmDecompose` (the primary planning path when wired), and `ColonyOrchestrator._decompose` (the multi-agent subtask path). Only the first one had been taught — in v7.7.9 — to inject the goal-relevant module-path list into the LLM prompt with a "use these EXACT paths" directive. The other two shipped without it.

In the v7.9.5 outpost trace the `Cognitive level: FULL — core: [verifier, formalPlanner, worldState]` boot line means `FormalPlanner` was wired, so `AgentLoopPlanner._planGoal` went through the formal path and never reached the v7.7.9 fallback. The colony also fired: `Decomposed into 3 subtasks` three times. Both prompts showed the LLM at most five recently-modified file paths plus the OS context — nothing about the actual module structure. So the LLM produced plausible-looking but invented paths drawn from generic open-source conventions (`src/agent-core/...`, `src/logger/index.js`).

v7.9.6 extracts the goal-relevant module-path filter (`pickRelevantModules`) and the prompt-list formatter (`formatModulePathList`) from `AgentLoopPlanner.js` into a new shared file `src/agent/revolution/plan-context.js`. All three planners now consume the same helper. `FormalPlanner._llmDecompose` and `ColonyOrchestrator._decompose` get the same `GOAL-RELEVANT MODULE PATHS (use these EXACT paths when referring to files — do not invent new ones)` block that the v7.7.9 fallback path already had. `ColonyOrchestrator` gets a new optional `selfModel` late-binding for this — when the binding is absent (test mode or older boot configurations) the prompt falls back to its pre-v7.9.6 shape, so nothing is broken.

The mechanism behind `pickRelevantModules`: tokenise the goal description (stop-words filtered), filter the module manifest to entries whose file path or class name token-matches, return up to 30 matches, fall back to the first 20 by manifest order when fewer than five matches surface. For the live-trace goal "Improve Goal Driver Failure Recovery Logging" the matches include `src/agent/agency/GoalDriver.js`, `src/agent/agency/GoalDriverFailurePolicy.js`, `src/agent/agency/GoalDriverBootRecovery.js`, `src/agent/planning/GoalStack.js`, `src/agent/core/Logger.js`, `src/agent/foundation/CrashLog.js`, and more — exactly the files the LLM should have been pointed at. With the helper wired into all three planners, the LLM has no reason to invent paths in the first place. The downstream pursuit-loop fixes above are now a safety net rather than the only line of defence.

### English-only sweep in runtime logs

`AutonomousDaemon.js:304` emitted `Auto-repariere ${N} Problem(e)... (trust=${level})` — German prose in an English log stream. `HTNPlanner._generateDryRunSummary` produced four more German lines (`Geschaetzte Dauer:`, `LLM-Aufrufe:`, `Hinweise:`, `Plan-weite Probleme:`). The English-only convention applies to runtime log output the same way it applies to docs — operators reading a log shouldn't have to switch languages mid-line. Five strings now read `Auto-repairing ${N} issue(s)`, `Estimated duration:`, `LLM calls:`, `warnings:`, `Plan-wide issues:`. No behaviour change.

### Tests

Two new contract test files:

`test/modules/v796-hygiene-pass.contract.test.js` — 17 contract tests across seven blocks. Blocks A-F pin the audit-side hygiene fixes (wiring, channels, audit gates, lockCritical, ci script). Block G pins the three pursuit-loop fixes (final-return error field, replan-path normalisation, regex coverage). All 17 pass.

`test/modules/v796-plan-context.contract.test.js` — 13 contract tests across five blocks. A and B exercise the shared `pickRelevantModules` and `formatModulePathList` helpers directly with representative inputs. C and D assert that `AgentLoopPlanner` and `FormalPlanner` both consume the shared helper. E asserts the `ColonyOrchestrator` consumes it, has a `selfModel` field for the late-binding, and that the late-binding is declared in `phase8-revolution.js`. All 13 pass.

audit-doc-drift exits 0 strict (57/57 doc claims match live). audit-doc-language exits 0 strict (22 files clean). audit-service-numbers exits 0 strict (12/12 counts match live). audit-future-version-refs exits 0 strict. validate-channels exits 0 strict (79=79). validate-service-wiring exits 0 strict (all 984 references resolve). audit-hash-lock-coverage clean. architectural-fitness holds at 127/130.

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
