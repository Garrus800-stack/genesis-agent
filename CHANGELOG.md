## [7.9.3]

**Settings consistency pass: 22 dashboard/setting bugs fixed, 30 boot-only settings now show a restart hint, Architecture Graph opens in a fullscreen modal, Trust-level dropdown promises hold, Ollama embedding context size matches model capacity.**

### Trust-level map

- `LEVEL_AUTO_APPROVE` aligned with the UI dropdown promise. `AUTONOMOUS` now auto-approves `['safe', 'medium', 'high', 'blocking']` — only the three genuinely critical actions (`DEPLOY`, `EXTERNAL_API`, `EMAIL_SEND`) still prompt. `FULL_AUTONOMY` auto-approves everything including `blocking` (so `plan-has-issues` no longer breaks the "never ask" promise).
- `SELF_MODIFY` stays classified as `'high'`. Self-modification is a core feature, not a critical exception.
- Default risk for unknown actions stays `'high'`.

### Dashboard property alignment

Renderers were reading properties the backend never produced. Each path is now wired to the actual `getStats()` / `getReport()` output, with legacy aliases kept where useful:

- Energy panel (`OrganismRenderers._renderEnergy`) reads `metabolism.callCount`, `metabolism.totalEnergySpent`, `energy.state`.
- Cognitive panel (`AgentRenderers._renderCognitive`) reads `metaLearning.totalRecords` / `recommendationCount` and `episodicMemory.totalEpisodes`.
- Memory panel (`SystemRenderers._renderMemory`) reads `m.totalEpisodes` for episode count.
- System panel reads `shell.total` for command count.
- Tool Synthesis renders `stats.generated` and `stats.evicted` from `DynamicToolSynthesis`.
- Project Intelligence reads `conv.namingStyle` (and `conv.srcLayout`).
- Goal tree status icons cover all 8 backend states: active, completed, failed, paused, abandoned, blocked, stalled, obsolete.
- Storage panel reads `health.storage.writes` (and `reads`), now produced by `StorageService.getStats()`.
- Values panel reads `vals.conflictCount` first.

`CognitiveMonitor.getReport()` was extended in this release to surface `anomalies` (from `circularity.alertCount`) and `confidenceAvg` (from `decisionQuality.rollingQuality`, 0–1) so the dead-read dashboard fields show real data.

### Service starts and lifecycle

- `costGuard.start()` is now called during boot in `AgentCoreWire`. Without this call the four CostGuard UI settings (`sessionTokenLimit`, `dailyTokenLimit`, `warnThreshold`, `enabled`) stayed at constructor defaults regardless of what the UI was set to.
- `ArchitectureReflection.getSnapshot()` emits `phases` as `{phaseNum: [serviceNames]}` so the Architecture panel's `Array.isArray(svcs) ? svcs.length : 0` produces real counts (was always 0 before).
- `GoalStack` reads `idleMind.maxActiveGoals` from settings at construction time (was hardcoded to 10).
- `UnifiedMemory.recall()` increments `_searchCount`; exposed in `getStats()` as `searchCount` — drives the "Unified queries" dashboard stat.

### chat:completed payload

All four `chat:completed` fire sites in `ChatOrchestrator` now include `tokens` (estimated from response length) and `latencyMs` (elapsed since turn start). `Metabolism._onChatCompleted` was already prepared to read these with default fallbacks; the values are now real.

### Settings system

- `timeouts.approvalSec` default raised from 60s to 300s — matches the UI registry default; prevents premature approval timeout during slow operations.
- Three install-related settings added to `FIELD_REGISTRY` so they participate in default-hint, validation and reset flow: `agency.installAuto`, `agency.installFull`, `agency.installScope`.
- 30 boot-only settings flagged with `requiresRestart: true`. `buildDefaultHint()` appends a localized `(takes effect after restart)` badge for these.
- `i18n.ui.takes_effect_after_restart` and `i18n.ui.requires_restart` provided in EN + DE.
- The six inline `setting-restart-hint` spans previously hard-coded in `index.html` are removed — the `FIELD_REGISTRY` flag is now the single source of truth.
- 11 previously-missing i18n keys added to EN + DE (statusbar showed `Daemon: health.active` as raw key text).
- `ui.editorFontSize` and `ui.chatFontSize` now apply live to the Monaco editor and chat container both on settings load and on save.
- Fixed `_decorateField()` clobbering every `.setting-default-hint` in a tab when any single field was decorated. Each field now manages only its own hint, so all boot-only settings keep their `(takes effect after restart)` badge instead of only the last-decorated field in each tab.
- CHANGELOG.md indexes per-major archive files (`CHANGELOG-v7.md`, `docs/CHANGELOG-v6.md`, `docs/CHANGELOG-v5.md`, `docs/CHANGELOG-archive.md`) — restores the v785-changelog-split contract.

### Health endpoints

`HealthServer` now serves `/metrics` (metabolism, storage, metaLearning, costGuard, unifiedMemory, episodicMemory, knowledgeGraph, shell, toolSynthesis stats) and `/events` (eventStore stats, bus listener counts). The previous "Use /health or /health/full" 404 message advertised endpoints the UI settings hint had already promised.

### Architecture Graph

Opens in a fullscreen modal (90vw × 85vh) on click. ResizeObserver redraws as the window resizes. Legend uses fixed 12px font so it stays readable at any zoom. ESC / backdrop click / X-button to close.

### Ollama context size

`OllamaBackend.chat()` / `.stream()` and `EmbeddingService` now pass `num_ctx` model-aware: embedding models (nomic-embed-text, mxbai, minilm) receive 2048, chat models receive 8192. The repeated `requested context size too large for model` warnings on every boot are gone.

### Documentation

`docs/SETTINGS.md` extended with a runtime-vs-restart section listing all runtime and all boot-only settings by tab.


---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — earlier history
