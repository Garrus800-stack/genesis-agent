## [7.8.5]

**Failover transparency end-to-end + release hygiene.**

Five items.

### Item 1 — `effectiveModel` end-to-end

When `ModelBridge` fails over from the user's preferred model to
a fallback, every layer now identifies the model that is actually
answering — log, events, health endpoint, and UI.

- **Backend state.** `ModelBridge` gains `lastEffectiveModel`,
  `lastEffectiveBackend`, `lastFailoverReason`. Updated by
  chat()/streamChat() success paths and by `_handleFailoverError`.
  Clean call after a failover clears all three.
- **Log line.** Interpolates the fallback model name:
  `falling back to ollama (qwen3-coder-next): ...`
- **Events.** `model:failover` payload gains `effectiveModel` +
  `preferredModel`. `llm:call-complete` gains `effectiveModel`.
  `cost:recorded` persists `effectiveModel`. Backward compatible.
- **Health endpoint.** `model.effective`, `model.failoverReason`.
- **UI.** The model dropdown shows the model that is currently
  answering — in the same slot the preferred model normally
  occupies. Programmatic `.value` assignment does not fire
  `change`, so the user's preferred setting is not rewritten.
  Switching to any other model via the dropdown works as before.

### Item 2 — Backlog audit

Four obsolete items struck:
- `ImpactForecast` / `fragilityDelta` (no references anywhere)
- `Layer-Truncation LLM-Output` (streaming covers this)
- `CostStream failover field` (already shipped v7.8.3)
- UI dual-path `renderer.js` (file no longer exists)

`ModelBridge._prepareCallContext` + `_dispatchChat`/`_dispatchStream`
consolidation is on the open backlog in `AUDIT-BACKLOG.md`.

### Item 3 — `audit-platform-tests.js`

New reporting tool that scans `test/modules/*.test.js` for
`if (process.platform === '...') return;` patterns and produces a
matrix of which subtests skip on which platform. Output:
human-readable summary + JSON snapshot at
`scripts/platform-tests-baseline.json`. Replaces pattern-matched
release-notes estimates with measured data. Not a strict CI gate.

### Item 4 — Release hygiene

- `plugins/` gains a `.gitkeep` marker with an explanatory header so
  the directory is tracked but not confused with a build artefact.
- `sandbox/` is now in `.gitignore`. Previously a stray `sandbox/`
  directory could ship in the release ZIP when the user had run
  tests locally before building. `CONTRIBUTING.md` documents both
  directories under "Special directories (runtime-managed)".

### Item 5 — CHANGELOG split

The previous `CHANGELOG.md` had grown to 14,739 lines / 906 KB.
This release splits it into per-major archives:

- `CHANGELOG.md` — keeps only the newest entry inline plus an
  index pointing to the major files. Genesis'
  `ChatOrchestratorSourceRead._readChangelogLatestSection` keeps
  working because the newest `## [x.y.z]` header is still at the
  top of `CHANGELOG.md`.
- `CHANGELOG-v7.md`, `CHANGELOG-v6.md`, `CHANGELOG-v5.md`,
  `CHANGELOG-archive.md` (v0–v4) — full historical archives.

---

---

---

## Older releases

For prior version history, see the archive files:

- [**CHANGELOG-v7.md**](CHANGELOG-v7.md) — all v7.x.x releases (78 entries)
- [**CHANGELOG-v6.md**](CHANGELOG-v6.md) — all v6.x.x releases (12 entries)
- [**CHANGELOG-v5.md**](CHANGELOG-v5.md) — all v5.x.x releases (17 entries)
- [**CHANGELOG-archive.md**](CHANGELOG-archive.md) — v0.x.x – v4.x.x (29 entries)

This index file (`CHANGELOG.md`) keeps only the newest release inline so
the file stays readable. The major-version archives carry the full
history.
