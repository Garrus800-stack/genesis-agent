# Genesis — Bug Taxonomy (v7.1.1 → v7.1.8)

> 29 bugs found and fixed across 10 audits. This document classifies them
> by root cause to identify where process improvements have the highest ROI.

## Classification

| Category | Count | % | Prevention |
|---|---|---|---|
| **Property-name mismatch** | 9 | 31% | TypeScript strict / Contract Validator (S-2) |
| **Schema drift** | 9 | 31% | Schema CI-Gate (S-9) |
| **Event-name mismatch** | 3 | 10% | Event-Audit Cross-Ref (H-3) |
| **Logic error** | 3 | 10% | Exhaustive unit tests |
| **Missing guard** | 2 | 7% | Code review |
| **Silent failure** | 2 | 7% | Contract Validator (S-2) |
| **Dead code** | 1 | 3% | Linter / dead-code analysis |

## Key Insight

**62% of all bugs (18/29) were naming mismatches** — either property names
against APIs (9) or event schemas against emitters (9). These are the same
class of error: code A expects name X, code B uses name Y, and JavaScript
silently returns `undefined` instead of throwing.

**TypeScript strict-mode would catch 31% at compile time** (the 9 property
mismatches). The Contract Validator (S-2, v7.1.9) catches them at boot time
as a pragmatic intermediate step.

**The Schema CI-Gate (S-9, v7.1.9) catches another 31%** by validating
emit payloads against schemas before release.

**Together, S-2 + S-9 prevent 62% of historical bugs.** That's the
stabilization payoff.

## Detailed Bug List

### Property-Name Mismatches (9)

| Bug | Version | Files |
|---|---|---|
| `snap.serviceCount` → `snap.services` | v7.1.8 B-1 | PromptBuilderSections.js |
| `getMoodTrend()` → `getTrend()` | v7.1.8 B-2 | PromptBuilderSections.js |
| `activityBias.curiosity` → `.explore` | v7.1.8 B-3 | AdaptiveStrategyApply.js |
| `shellAgent._verification` → `verifier` | v7.1.6 | Late binding name |
| `dynamicToolSynthesis.toolRegistry` → `tools` | v7.1.6 | Late binding name |
| `KG _tryMerge` mutated without `_save()` | v7.1.6 | KnowledgeGraph.js |
| EmotionalFrontier double-injection | v7.1.6 | PromptBuilderSections.js |
| `CACHE_PREFETCH` magic number | v7.1.6 | FrontierWriter.js |
| `model` guard missing in research | v7.1.6 | IdleMindActivities.js |

### Schema Drift (9)

| Bug | Version | Files |
|---|---|---|
| `health:metric` name→service+metric | v7.1.8 | EventPayloadSchemas.js |
| `chat:error` error→message | v7.1.8 | EventPayloadSchemas.js |
| `goal:abandoned` goalId+reason→id+description | v7.1.8 | EventPayloadSchemas.js |
| `mcp:degraded` server+reason→name+failRate | v7.1.8 | EventPayloadSchemas.js |
| 5 missing schemas for v7.1.6/7 events | v7.1.8 | EventPayloadSchemas.js |

### Event-Name Mismatches (3)

| Bug | Since | Fixed |
|---|---|---|
| `shell:complete` → `shell:outcome` | v6.1.1 | v7.1.6 |
| `prompt-evolution:promoted` never emitted | v5.3.0 | v7.1.6 |
| `prompt-evolution:promoted` in EXCLUDED_EVENTS | v5.3.0 | v7.1.7 H-3 |

### Logic Errors (3)

| Bug | Version | Files |
|---|---|---|
| `general` in introspection intent filter | v7.1.8 D-1 | PromptBuilderSections.js |
| 21 required late bindings across phases | v7.1.6 | Manifests |
| McpTransport reconnect timer not tracked | v7.1.6 | McpTransport.js |

### Missing Guards (2)

| Bug | Version | Files |
|---|---|---|
| KG decay fallback for unknown types | v7.1.6 | KnowledgeGraph.js |
| FrontierWriter buffer unbounded | v7.1.7 H-1 | FrontierWriter.js |

### Silent Failures (2)

| Bug | Version | Files |
|---|---|---|
| CognitiveEvents duplicate onShellOutcome | v7.1.6 | CognitiveEvents.js |
| `TIMEOUTS` unused import | v7.1.8 | ProjectIntelligence.js |

## Process Recommendations

1. **v7.2.0+: Consider TypeScript migration** — 31% bug prevention at compile time
2. **v7.1.9: Contract Validator deployed** — catches property mismatches at boot
3. **v7.1.9: Schema CI-Gate deployed** — catches payload drift before release
4. **v7.1.7: Event-Audit Cross-Ref deployed** — catches event-name mismatches
5. **Per-release checklist:** New event → schema entry. New late binding → expects array.
