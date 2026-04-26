# Gate Inventory

> v7.4.4 — Vollständige Auflistung aller bewusst blockierenden bzw. observierenden Code-Pfade in Genesis.
> Erstellt durch systematisches Grep nach `blocked`, `rejected`, `denied`,
> `throw new Error`, und ähnlichen Patterns mit Block-Charakter.

## Instrumentiert (zentrale GateStats-Aufzeichnung seit v7.3.6)

| # | Gate                      | Ort                                             | Verdict-Semantik           | Charakter             |
|---|---------------------------|-------------------------------------------------|----------------------------|-----------------------|
| 1 | `injection-gate`          | `ChatOrchestratorHelpers._processToolLoop`      | safe→pass, warn, block     | blockierend           |
| 2 | `tool-call-verification`  | `ChatOrchestratorHelpers._processToolLoop`      | verified→pass, _→warn      | detektiv              |
| 3 | `self-gate`               | `core/self-gate.js`                             | pass / warn (nie block)    | telemetry-only by design |
| 4 | `slash-discipline`        | 13 Slash-Handlers (settings/journal/plans/...)  | pass / block               | präventiv             |
| 5 | `self-mod:circuit-breaker`| `SelfModificationPipelineModify`                | pass / block               | blockierend           |
| 6 | `self-mod:consciousness`  | `SelfModificationPipelineModify`                | pass / block (wenn coherence < 0.4) | **strukturell inert** mit `NullAwareness`-Default (`getCoherence()` → 1.0) |
| 7 | `self-mod:energy`         | `SelfModificationPipelineModify`                | pass / block               | blockierend           |

Integration-Test: `test/modules/gate-stats-integration.test.js` — end-to-end
Coverage dass `recordGate()` durch echte ChatOrchestrator-Flüsse getriggert wird.

> **Wichtig zum AwarenessPort-Gate (Zeile 6):** Solange die Default-Implementierung
> `NullAwareness` registriert ist, gibt `getCoherence()` konstant `1.0` zurück. Mit
> `THRESHOLDS.SELFMOD_COHERENCE_MIN = 0.4` ist die Bedingung `1.0 < 0.4` immer falsch,
> das Gate kann nicht blocken. Es wird wirksam, sobald eine echte AwarenessPort-Implementation
> registriert wird (z.B. eine HeuristicAwareness aus selfmod-Failure-Rate, Frustration,
> kontradizierten Lessons). Self-Modification ist bis dahin durch Energy-Gate, CircuitBreaker,
> PreservationInvariants und sandboxed Verification geschützt.

## Weitere Gate-Kandidaten im Codebase (nicht instrumentiert)

### Sicherheits-Gates (höchste Priorität)

| Ort                                           | Gate-Name-Vorschlag         | Pattern                            |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `foundation/Sandbox.js:447`                   | `sandbox:module-path`       | Module-Pfad außerhalb Root         |
| `foundation/Sandbox.js:471`                   | `sandbox:read`              | Read-Access auf geschütztes File   |
| `foundation/Sandbox.js:477`                   | `sandbox:write`             | Write-Access außerhalb Workspace   |
| `foundation/Sandbox.js:543`                   | `sandbox:fs-method`         | Blockierte fs-API (unlink etc.)    |
| `foundation/StorageService.js:64`             | `storage:path-traversal`    | Path-Traversal-Attempt             |
| `capabilities/FileProcessor.js:332`           | `file:path-traversal`       | Path-Traversal bei Import          |
| `capabilities/_self-worker.js:133`            | `self-worker:path-traversal`| Path-Traversal im Self-Worker      |
| `kernel/SafeGuard.js (validateWrite)`         | `safeguard:write`           | Kernel/Critical-File-Schutz        |

### Netzwerk-Gates

| Ort                                           | Gate-Name-Vorschlag         | Pattern                            |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `capabilities/EffectorRegistry.js:351`        | `effector:url-scheme`       | Nicht-HTTP/HTTPS-Scheme            |
| `capabilities/EffectorRegistry.js:355`        | `effector:raw-ip`           | Raw-IP-URL                         |
| `capabilities/EffectorRegistry.js:359`        | `effector:localhost`        | Localhost-URL                      |
| `capabilities/EffectorRegistry.js:366`        | `effector:allowlist`        | Domain nicht in Allowlist          |
| `capabilities/McpTransport.js:110`            | `mcp:ssrf-host`             | SSRF-Block (Hostname)              |
| `capabilities/McpTransport.js:117`            | `mcp:ssrf-ip`               | SSRF-Block (numerische IP)         |

### Self-Modification-Gates

| Ort                                           | Gate-Name-Vorschlag         | Pattern                            |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `hexagonal/SelfModificationPipeline.js:342+`  | `self-mod:circuit-breaker`  | Frozen nach mehreren Fehlern       |
| `hexagonal/SelfModificationPipeline.js:357+`  | `self-mod:consciousness`    | Awareness-Coherence zu niedrig     |
| `hexagonal/SelfModificationPipeline.js:371+`  | `self-mod:energy`           | Homeostasis-Energy zu niedrig      |
| `hexagonal/SelfModificationPipeline.js:441+`  | `self-mod:code-safety`      | CodeSafetyScanner blockt           |
| `hexagonal/SelfModificationPipeline.js:459+`  | `self-mod:verification`     | VerificationEngine fail            |

Note: SelfModificationPipeline hat bereits eigenes `_gateStats`-Objekt mit
spezialisierten Countern. Bei Migration darauf achten dass die bestehende
`getGateStats()`-API erhalten bleibt (wird im UI angezeigt).

### Command-/Shell-Gates

| Ort                                           | Gate-Name-Vorschlag         | Pattern                            |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `capabilities/ShellAgent.js:129`              | `shell:command-block`       | Command nicht erlaubt              |
| `capabilities/PluginRegistry.js:131`          | `plugin:code-safety`        | Plugin-Code unsicher               |
| `intelligence/VerificationEngine.js:495`      | `verification:permission`   | Permission denied                  |

### Effector-Gates (allgemein)

| Ort                                           | Gate-Name-Vorschlag         | Pattern                            |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `capabilities/EffectorRegistry.js:141+`       | `effector:pre-check`        | Pre-Check schlägt fehl (vielfältig)|
| `capabilities/EffectorRegistry.js:163+`       | `effector:post-check`       | Post-Check schlägt fehl            |
| `capabilities/FileProcessor.js:205`           | `file:import-blocked`       | Import-Block                       |

### Homeostasis-/Circuit-Breaker-Gates

| Ort                                           | Gate-Name-Vorschlag         | Pattern                            |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `autonomy/IdleMind.js:196`                    | `idle:homeostasis-block`    | Autonomie blockiert wg. Energy     |
| `autonomy/HealthMonitor.js (circuit)`         | `health:circuit-breaker`    | Service-Gesundheit-Kreis offen     |
| `autonomy/ServiceRecovery.js (circuit)`       | `service:circuit-breaker`   | Recovery-Circuit offen             |
| `core/CircuitBreaker.js`                      | `circuit:global`            | Generischer Circuit-Breaker        |
| `cognitive/CognitiveHealthTracker.js`         | `cognitive:health-circuit`  | Cognitive-Circuit offen            |
| `cognitive/GoalSynthesizer.js`                | `goal:synthesis-circuit`    | Goal-Synthesis-Circuit             |

### Hot-Path-Gates (Sampling empfohlen)

| Ort                                           | Gate-Name-Vorschlag         | Sample-Rate Empfehlung             |
|-----------------------------------------------|-----------------------------|------------------------------------|
| `core/EventPayloadSchemas.validate`           | `event:schema-validate`     | 1:100 oder 1:1000                  |
| `core/Logger.js redaction`                    | `log:redaction`             | 1:50                               |

## Instrumentierungs-Aufwand geschätzt

Alle oben (~28 Gates außer Sampling-Kategorie): 2-3 Tage fokussierte Arbeit.
Jeder Gate: ~3 LOC + Tests wo Gate-Logik komplex ist.

Gruppierung nach Charakter (keine Reihenfolge vorgegeben):
- Sicherheits-Gates (8 Stellen) — Block-Charakter, hoch Priorität für Audit
- Netzwerk-Gates (6 Stellen)
- Self-Modification-Gates (5 Stellen) — Migration des bestehenden _gateStats-Systems
- Command-/Shell-Gates (3 Stellen)
- Effector + Homeostasis (7 Stellen)
- Hot-Path mit Sampling (2 Stellen) — nur wenn Bedarf sichtbar wird

## Design-Notizen

- `GateStats`-Klasse in `src/agent/cognitive/GateStats.js` ist hot-path-safe
  durch eingebautes Sampling und minimale Datenstruktur (Map + Counter-Objekt).
- Optional-Injection-Pattern (`this.gateStats?.recordGate(...)`) macht
  Instrumentation zu einem risikoarmen Refactor — bestehende Tests brechen
  nicht, DI-Wiring kann nachgezogen werden ohne Rush.
- Verdict-Mapping: `safe` → `pass`, `warn` bleibt, `block` bleibt. Nur
  drei Verdicts sind valide; alles andere wird silently discarded.
- `summary()` sortiert nach total desc — hottest Gate steht oben im Dashboard.
