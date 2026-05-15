# v7.8.5 — Failover transparency end-to-end + release hygiene

Five items.

---

## Item 1 — `effectiveModel` end-to-end

When `ModelBridge` fails over from the user's preferred model to
a fallback (e.g. cloud rate-limited → local), every layer now
identifies the model that is actually answering. Behavior is
unchanged — same fallback selection, same retry path, same
cache. This release only fixes what was invisible.

### Backend state

`ModelBridge` gains three persistent properties:

- `lastEffectiveModel` — the model that actually answered
- `lastEffectiveBackend` — the backend that served it
- `lastFailoverReason` — `null` on a clean call, classified
  reason on a failover

The `chat()`/`streamChat()` success paths set them to
`calledModel` with `lastFailoverReason = null`.
`_handleFailoverError` sets them to the fallback name + reason
after a successful retry. A clean call following a failover
clears the reason — so the dropdown display goes back to the
preferred model automatically.

### Log line

```
[MODEL] Stream ollama failed, falling back to ollama (qwen3-coder-next): HTTP 429 ...
```

Previously the line ended at the backend tier and gave no hint
which local model Ollama actually loaded into RAM.

### Events

- `model:failover` gains `effectiveModel` + `preferredModel`
- `llm:call-complete` gains `effectiveModel`
- `cost:recorded` persists `effectiveModel`

Schemas updated for all three. Backward compatible — `model`
field keeps its v7.8.3 meaning (user-preferred). Existing
listeners on `model:failover` that only read `data.from /
data.to / data.error` are unaffected.

### Health endpoint

```js
model: {
  active,            // unchanged
  available, routing, // unchanged
  effective,         // lastEffectiveModel || activeModel
  failoverReason,    // null when active answered directly
}
```

### UI

The model dropdown shows the model that is currently answering.
Same slot the preferred model normally occupies. No badge, no
flashing, no extra DOM.

When `failoverReason` is set AND `effective !== active`,
`select.value` is programmatically set to the effective model.
Programmatic `.value` assignment does **not** fire the `change`
event — HTML spec — so the user's preferred setting in settings
is never rewritten by this display update.

The `change` listener on the dropdown only fires on real user
input. Switching to a different model from the dropdown works
exactly as before, calls `agent:switch-model`, writes to
settings.

Refreshed after every `agent:stream-done` and once on boot.

---

## Item 2 — Backlog audit

Four obsolete items struck after source grep:

| Item | State | Action |
|---|---|---|
| `ImpactForecast` / `fragilityDelta` | No references anywhere | Removed |
| `Layer-Truncation LLM-Output` | No references; streaming covers this | Removed |
| `CostStream failover field` | Already shipped v7.8.3 | Removed |
| UI dual-path `renderer.js` | File no longer exists | Removed |

One item moved from "low priority" to **open backlog** in
`AUDIT-BACKLOG.md`: `ModelBridge._prepareCallContext` extract +
`_dispatchChat` / `_dispatchStream` merge. ModelBridge is hot
path; the refactor needs its own focused cycle.

---

## Item 3 — `audit-platform-tests.js`

New reporting script that scans `test/modules/*.test.js` for
`if (process.platform === '...') return;` patterns and reports
which subtests skip on which platform. Output:

- Human-readable matrix on stdout
- JSON snapshot at `scripts/platform-tests-baseline.json`
- Single number: `linuxTestCountDeltaFromWin32`

Replaces pattern-matched release-notes estimates with measured
data. Not a strict CI gate.

Result for v7.8.5: **Linux runs −1 test vs Windows** (linux-sandbox.test.js defines 3 tests in its non-linux branch but only 2 in its linux branch).

---

## Item 4 — Release hygiene

- `plugins/` gains a `.gitkeep` marker whose header explains
  the directory's role (PluginRegistry discovery root). Without
  the marker the directory would not be tracked by git and
  would disappear from fresh clones / release ZIPs.
- `sandbox/` is a runtime workspace `Sandbox.js` creates on
  demand for test execution. Previously it could end up in the
  release ZIP if the developer had run tests locally before
  building. Now in `.gitignore`, excluded from ZIP builds.
- Both directories documented under "Special directories
  (runtime-managed)" in `CONTRIBUTING.md`.

---

## Item 5 — CHANGELOG split

`CHANGELOG.md` had grown to **14,739 lines / 906 KB** with 136
release entries. Split into per-major archives:

| File | Contents | Entries |
|---|---|---|
| `CHANGELOG.md` | Newest entry inline + index | 1 + index |
| `CHANGELOG-v7.md` | All v7.x.x releases | 78 |
| `CHANGELOG-v6.md` | All v6.x.x releases | 12 |
| `CHANGELOG-v5.md` | All v5.x.x releases | 17 |
| `CHANGELOG-archive.md` | v0.x.x – v4.x.x | 29 |

The newest `## [x.y.z]` header stays at the top of
`CHANGELOG.md`, so Genesis'
`ChatOrchestratorSourceRead._readChangelogLatestSection` still
finds "was hat sich geändert" without changes to the parser.

Cleaned a pre-existing duplicate header (`## [7.1.6]` appeared
twice in the original — a stub plus the full entry) along the
way.

---

## Files touched

### Source
- `src/agent/foundation/ModelBridge.js`
- `src/agent/ports/LLMPort.js`
- `src/agent/foundation/CostStream.js`
- `src/agent/AgentCoreHealth.js`
- `src/agent/core/EventPayloadSchemas.js`
- `src/ui/renderer-main.js`

### Tests (five new contract prefixes, 38 tests)
- `test/modules/v785-effective-model.test.js` (14)
- `test/modules/v785-effective-model-ui.test.js` (8)
- `test/modules/v785-platform-tests-audit.test.js` (6)
- `test/modules/v785-release-hygiene.test.js` (3)
- `test/modules/v785-changelog-split.test.js` (7)

### Scripts
- `scripts/audit-platform-tests.js` (new)
- `scripts/platform-tests-baseline.json` (new)
- `scripts/split-changelog.js` (one-shot migration tool)
- `scripts/audit-doc-drift.js` — test counts
- `scripts/stale-refs.json` — five new contract prefixes

### Repo structure
- `plugins/.gitkeep` (new)
- `.gitignore` — `sandbox/` entry
- `CHANGELOG.md` — slim index
- `CHANGELOG-v7.md`, `CHANGELOG-v6.md`, `CHANGELOG-v5.md`,
  `CHANGELOG-archive.md` (new archives)
- `CONTRIBUTING.md` — "Special directories" section
- `AUDIT-BACKLOG.md` — ModelBridge refactor as open backlog +
  v7.8.5 resolved section + four obsolete items struck
- `RELEASE_NOTES.md` — this file
- `docs/banner.svg`, `README.md` — version + test badge
- `docs/CAPABILITIES.md`, `docs/ARCHITECTURE-DEEP-DIVE.md`,
  `docs/COMMUNICATION.md` — counts + failover capability bullet
- `docs/EVENT-FLOW.md` — `model:failover` entry with new fields

---

## Verification targets

|  | Windows | Linux |
|---|---|---|
| Tests | **7475** passing, 0 failed | **7474** passing, 0 failed |
| Fitness | 130/130 | 130/130 |
| Strict CI audits | 10/10 green | 10/10 green |
| Contract prefixes | 27 (5 new) | 27 |
| Source modules | 358 | 358 |
| Test files | 456 (5 new) | 456 |
| Doc-drift | all 56 claims match live values | same |

---

## Migration notes

- No settings changes. No new keys, no schema migrations, no
  `.genesis/` state changes.
- Event payload additions are optional — existing listeners are
  not broken.
- No API breaks. ModelBridge and LLMPort public surfaces
  unchanged.
- The UI dropdown's `change` listener is untouched. Only the
  programmatic `.value` assignment path is new, and it cannot
  trigger settings writes by HTML spec.
- `CHANGELOG.md` split is non-destructive — history preserved
  across four archive files plus the inline newest entry.
- Genesis' own `ChatOrchestratorSourceRead` continues to find
  the latest CHANGELOG section without parser changes.
