## [7.9.12]

Cloud-quota blindness and 429-failover hardening. When a cloud model throttles or all models go unreachable, Genesis previously kept hammering dead endpoints every five minutes, accumulating frustration over an external condition it could do nothing about, and in-flight goal steps errored mid-execution instead of pausing cleanly. This release lengthens the rate-limit cooldown to match how provider windows actually behave, teaches IdleMind to rest instead of looping when no model is reachable, makes the resource layer pause goals on an all-models-down condition so they resume automatically on recovery, dampens the emotional response to failover bursts, gives Ollama-proxied cloud models a longer response ceiling than local ones, and surfaces the previously log-only cloud-without-fallback warning as a UI toast. Each change targets a concrete behaviour observed against the v7.9.7 outpost trace or the v7.9.11 Windows field-trace.

### Rate-limit cooldown raised to 60 minutes

The unavailable-marker TTL for `rate-limit` was five minutes — short enough that Genesis would retry a throttled model twelve times an hour, each retry producing another 429. Provider rate-limit windows are rarely shorter than an hour, so the short TTL bought nothing but noise; the same reasoning that gave `quota-exhausted` a 24-hour TTL applies here in miniature. The value is now 60 minutes. Manual recovery via `clearUnavailable()` remains available for the rare case where a window turns out shorter in practice. A behaviour-level contract test drives a real 429 through `_handleFailoverError` and asserts the resulting marker carries the 60-minute TTL, so the value can't be silently weakened without a deliberate test update.

### IdleMind rest-mode when no model is reachable

Nothing in the autonomy layer reacted to all models being marked unavailable. IdleMind kept picking LLM-backed activities every tick, each one failing, each failure feeding the frustration loop. A new shared predicate `ModelBridge.areAllModelsUnavailable()` distinguishes marker-exhaustion (every discovered model is marked) from the boot/no-model case (an empty model list, already handled by the existing `activeModel` guards). IdleMind consults it between the active-model guard and the thought counter — so rest-mode ticks don't inflate `thoughtCount` — and short-circuits into rest-mode rather than running an activity. The transition is announced once via a private `rest-mode` InnerSpeech note (blocklisted in the PSE HardGates so it never reaches the user) and a `model:rest-mode-entered` event; recovery is driven by a `model:unavailable-cleared` listener for immediate exit, with a second tick-driven exit as a fallback. Both transitions are idempotent, so a burst of recovery events produces exactly one entry and one exit note. The predicate also doubles as an expiry sweep — checking each model lazily clears any marker whose TTL has elapsed and fires the cleared event, so a window that simply timed out recovers without external prompting.

### Goal steps pause cleanly on an all-models-down condition

`ResourceRegistry.isAvailable('service:llm')` previously checked only that an active backend was configured. With a backend present but every model marked, it returned available, so a goal step requiring `service:llm` passed the pre-execution check and then errored mid-run. The resolver now also returns unavailable when `areAllModelsUnavailable()` is true. The subtle part is the recovery signal: `service:llm` is resolved live and never cached, so `_update()` — the only thing that emits `resource:available` / `resource:unavailable` — was never called for it organically, meaning a goal blocked on `service:llm` during an outage would never receive the unblock signal `GoalDriver` listens for. Two bridge listeners close that loop: on every `model:marked-unavailable` and `model:unavailable-cleared`, the registry re-derives the `service:llm` token state and lets `_update()` emit the flip. A single-model mark while others remain available is a no-op; only the all-down and first-recovery transitions flip the token.

### Failover-burst emotional dampening

Every failover bumped frustration by the same amount regardless of cause, so a five-retry 429 burst within ten seconds accumulated a 0.30 frustration spike over a single external event. ModelBridge now tracks failover timestamps per reason in a 30-second sliding window; once a reason reaches three failovers in the window, the `model:failover` event carries a `cluster` marker. EmotionalState reads the marker and applies a gentle +0.02 bump instead of the full +0.06 for clustered failovers — the first one or two in a window still bump normally, so Genesis notices once that something is wrong, but the burst no longer compounds. Tracking is per-reason, so a rate-limit burst doesn't trip a timeout cluster, and old timestamps prune on each call so the map stays bounded. The four existing `model:failover` listeners are untouched: the marker is additive, not a suppression, so dashboard, telemetry, and learning paths see every event exactly as before.

### Longer response ceiling for Ollama-proxied cloud models

The v7.9.11 Windows trace showed `qwen3-vl:235b-cloud` hitting a 180-second timeout before its first response on congested days. The timeout that fired was `OllamaBackend`'s HTTP idle-timeout, not the streaming first-chunk timer — cloud models proxied through Ollama use the same backend as local models and inherited the 180-second `LLM_RESPONSE_LOCAL` ceiling despite their structurally higher latency (Ollama proxies to its cloud backend, and the cloud-side model may cold-load). OllamaBackend now distinguishes cloud-suffixed model names (`*-cloud` / `*:cloud`) via a local detector and applies a separate `cloudTimeoutMs`, defaulting to a new `LLM_RESPONSE_CLOUD_OLLAMA` constant of 300 seconds; local models keep the 180-second ceiling unchanged. The value threads through from settings (`llm.cloudTimeoutMs`) via the boot manifest to the backend, is overridable per install, and applies to both the streaming and non-streaming paths. Both `llm.localTimeoutMs` and `llm.cloudTimeoutMs` are now declared in the settings defaults tree and the UI field registry with validation ranges.

### Cloud-without-fallback warning surfaced in the UI

The `model:cloud-without-fallback` event has fired at boot since v7.5.7 when a cloud model is preferred with no fallback chain configured — a setup that leaves Genesis stalled the moment that model gets gated — but it only reached logs and the event bus. It now bridges through to the renderer as both a transient warning status and a persistent toast, with an i18n message (English, German, French, Spanish) pointing the user to the fallback-chain setting.

### Notes

- New events: `model:rest-mode-entered`, `model:rest-mode-exited` (catalogued in `EventTypes.js`, schema'd in `EventPayloadSchemas.js`); `model:failover` schema gains an optional `cluster` field
- New constant: `TIMEOUTS.LLM_RESPONSE_CLOUD_OLLAMA` (300000)
- New settings: `llm.cloudTimeoutMs` (default 300000), `llm.localTimeoutMs` now declared in defaults (was read since v7.5.9 without a default entry)
- New IPC channel: `model:cloud-without-fallback` (push-only, allow-listed in both preloads)
- Test files: 506 → 513 (seven v7.9.12 contract suites); event catalog 489 → 491
- Documentation updates: `README.md`, `docs/CAPABILITIES.md`, `docs/COMMUNICATION.md`, `docs/ARCHITECTURE-DEEP-DIVE.md` (event counts, test-file count)

---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
