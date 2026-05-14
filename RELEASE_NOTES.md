# Genesis Agent v7.8.4 — **Bug-Sweep + Pre-deletion-audit.**

Six focused items: two correctness fixes in the agent loop, one
defense-in-depth hardening for diagram rendering, one toolchain
bump, one resilience pass on Node installer URLs, and a new
pre-deletion-audit capability with auto-hook and slash command.
No themed release wrapper — each item stands alone.

---

## Item 1 — Verification-reporting contradiction

The agent loop used to claim `test passed` in its step output
before verification had even run. When the verifier later failed,
the step log carried two contradicting truths in the same step:
`Code written: X (N lines, test passed)` next to
`Verification failed: …`.

The fix removes the pre-declaration and overlays a
`[verification failed]` prefix onto the output when verification
fails, guarded by a `typeof === 'string'` check so non-string
results are left alone.

## Item 2 — DELEGATE-Step warning removal

HTNPlanner used to warn `DELEGATE step requires reachable peers`
on every plan with a DELEGATE step — regardless of whether peers
were actually available. This was dead code for a state already
prevented by v7.3.5 (`AgentLoopPlanner.canDelegate` gating) and
already cured by `_stepDelegate` falling back to ANALYZE. The
warning is gone. The DELEGATE branch itself stays as a short-
circuit so the unknown-step-type catch-all does not flag DELEGATE.

## Item 3 — Mermaid SVG sanitisation

Mermaid-rendered SVG used to be written directly to
`diagramEl.innerHTML`. A crafted diagram source could embed
`<script>`, `onclick=`, or `javascript:` URIs that would execute
in the Renderer context. SVG output now passes through
`DOMPurify.sanitize()` with the SVG profile, `foreignObject`
re-allowed (mermaid uses it for HTML-in-SVG labels), and `target`
attribute permitted. `dompurify` is a runtime dependency now,
bundled into `renderer.bundle.js` by esbuild.

## Item 4 — mermaid v10 → v11

The mermaid library is bumped from `^10.9.1` to `^11.0.0`. The
breaking changes in v11 (refactored flowchart/state engine,
ESBuild/IIFE output instead of UMD, `useMaxWidth` default true
for gitGraph/sankey) do not affect the diagram types Genesis
actually uses. The bundle-copy step in `scripts/build-bundle.js`
is now resilient against a future filename rename: it probes
`mermaid.min.js` first, then `.js`, then `.esm.min.mjs`.

## Item 5 — Node v22 LTS lazy resolution

The `nodejs` entry in the install database had `v22.22.2` URLs
hardcoded — drifting on every Node maintenance release. A new
`NodeVersionResolver` capability now fetches the latest
`v22.* lts: true` from `nodejs.org/dist/index.json` lazily, with
a 24-hour cache and a graceful fallback chain: fresh cache → live
fetch → stale cache → hardcoded `v22.22.2`. Pinned to the v22
major so a bump to v24 LTS stays an explicit decision, not a
silent drift.

## Item 6 — Pre-deletion-audit (four layers)

A reusable refactoring pattern for code cleanups, replacing the
hand-audited `git grep` + eyeball-diff workflow that handled
file deletions before.

- **Capability** `CleanupVerifier` — emits four finding kinds:
  `importers` (blocking), `entrypoint-pattern` (blocking),
  `identical-siblings` (informational), `sibling-name-matches`
  (informational). `result.safe` flips to `false` when any
  blocking finding is present.
- **Auto-hook** in `AgentLoopSteps._stepShell` — recognises `rm`,
  `unlink`, `Remove-Item`, `del`, `erase` targeting a single file
  inside the project, runs the verifier, surfaces findings in
  the approval prompt before asking for confirmation.
- **Slash command** `/cleanup-check <relative-path>` — manual
  audit without going through a shell step. Bilingual report
  (EN/DE) with ✅ / ⚠ / 🛑 markers depending on findings.
- **External spec** `docs/CLEANUP-PROTOCOL.md` — when the audit
  runs, what each finding kind means, known limits (dynamic
  `require()`/`import()` not detected), evolution rules.

A new `cleanup-verifier:scan-complete` telemetry event fires
after every `verify()` call.

## Item 7 — Test isolation from real Ollama daemon

A long-standing bug (since v5.1.0) was hidden as long as you ran
cloud models. The legacy ModelBridge test — *"should throw on chat
without configured backend"* — called `bridge.chat()` with no
configured backend, which silently fell back to the default Ollama
URL (`127.0.0.1:11434`). If a real Ollama daemon was running on the
developer machine, the call landed. And if the user's preferred
model was a `:cloud`-tagged model that rate-limited and failed
over to a local model, Ollama loaded that local model into RAM
during `npm test`. Two models in RAM simultaneously then exceeded
available memory on the next `npm start`. The same issue applied
to `headless-boot.test.js`, which boots AgentCore → real
`GET /api/tags`.

Fix: `OllamaBackend._httpGet` and `_httpPost` honour
`GENESIS_OFFLINE_TESTS=1` and reject real HTTP calls when set.
`test/index.js` sets the env var before requiring
`child_process`, so all spawned test workers inherit it.
Anthropic and OpenAI backends are already protected by their
own `isConfigured()` guards (no API key → no network calls).
Tested under `test-isolation contract:` prefix with a contract
test that verifies the guard is present, the env var is set at
the right time, and a live runtime check that confirms
`listModels()` is rejected when the flag is on. Live verification
during development: full test run with trace logging behind the
guard produced **zero** real HTTP calls to Ollama.

---

## Verification

- 7437 tests passing on Windows (7436 on Linux)
- Architectural fitness 130/130
- All 17 strict CI audits green
- 22 contract prefixes registered (6 new in this release)
- 462 events catalogued, 462 payload schemas, 100% parity
- 358 source modules, 451 test files

## What's needed to test

`npm install` pulls the new dependencies:

- `dompurify ^3.2.0` (runtime — required for diagram sanitisation)
- `jsdom ^25.0.0` (dev — required for sanitisation tests)
- `mermaid ^11.0.0` (dev — diagram engine bump)

Then `npm test` runs the full suite. `npm run audit` validates
the 17 strict gates.

## Compatibility

No breaking changes for users. Existing `.genesis/` directories,
plans, journal entries, and self-identity remain compatible.
Shell-step approval prompts may now include pre-deletion-audit
findings when a delete command is detected — this is additive
information, the approval flow itself is unchanged.
