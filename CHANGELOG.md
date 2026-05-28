## [7.9.13]

Configuration and audit consistency. A maintenance release that makes the settings layer honest: it honours two override promises the code made but never wired, removes a stale comment that misdescribed the continuation cap, and surfaces two existing timeout settings in the UI. No behaviour changes — every default resolves to exactly the value it did before. The work came out of a plan-first audit of the v7.9.7 outpost backlog, most of which turned out to have been resolved already in v7.9.7 itself; what remained were these configuration and consistency items.

### Continuation cap comment corrected

A v7.9.9 comment in three files claimed the continuation-attempt cap had been raised from 6 to 10, but the literal stayed 6 everywhere. The investigation found this was not a forgotten edit: v7.9.10 had addressed the cloud-truncation problem a better way. `computeEffectiveMaxContinuations` lifts no-prefill/cloud models to `CLOUD_NO_PREFILL_FLOOR` (10) at run time, while local verified-prefill models keep 6 where it suffices. So 6 is the correct local-prefill floor and the 10 already lives where it belongs, in the cloud path. The stale "6 → 10" comments in `Settings.js`, `ContinuationLoop.js`, and `ModelBridgeContinuation.js` now describe the per-capability mechanism accurately. The value is unchanged.

### Stream timeouts are now settings-driven

`Constants.js` had long promised that the streaming timeouts were overridable via `settings.json` `llm.streamTimeouts.{firstChunk,chunk,total,continuationTotal}`, but no code read that setting — the override interface existed only at the options level. This release wires `settings.json` into those options through `ModelBridgeContinuation`, the same pattern already used for `llm.continuation.maxAttempts`. These timeouts affect only Ollama code-generation calls (`taskType === 'code'`), the single path that routes through `ContinuationLoop` → `StreamingCompletion`, and the comment now names that scope exactly. Four validation bounds were added for the new settings.

### Timeout settings made constant-referenced

To keep the settings tree from drifting away from its source of truth, the `streamTimeouts` defaults reference the `TIMEOUTS` constants directly rather than hardcoding the numbers. The two model-response timeouts introduced in v7.9.12 (`localTimeoutMs`, `cloudTimeoutMs`) were hardcoded duplicates of their constants; they are now constant-referenced too. A guard test asserts all six timeout defaults equal their constants, so a future edit that replaces a reference with a literal is caught.

### Model timeouts surfaced in the UI

`set-local-timeout` and `set-cloud-timeout` have been in the field registry with validation since v7.9.12 but had no input in the settings UI. Both now appear in the Limits tab under a "Model timeouts" section, with their min/max/placeholder matching the registry exactly so display and validation cannot diverge, and i18n in English, German, French, and Spanish. The expert-level `streamTimeouts` stay JSON-only to keep the tab uncluttered.

### Notes

- Test files: 513 → 516 (three v7.9.13 contract suites)
- Documentation updates: `docs/CAPABILITIES.md`, `docs/ARCHITECTURE-DEEP-DIVE.md` (test-file count)

---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
