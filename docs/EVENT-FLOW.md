# Genesis Agent — Event Flow Architecture

> v7.2.1 — Event flow documentation. Updated for v7.2.1 deep audit,
> v7.2.0 self-define activity, research quality gate, introspection accuracy,
> emotional-cognitive bridge, v7.1.7 hardening, v7.1.8 schema-drift fixes,
> and v7.1.9 stabilization.
> This document maps which modules emit and consume which EventBus events.

## System Overview

```mermaid
graph TB
    subgraph KERNEL["🔒 Kernel (Immutable)"]
        main["main.js"]
        SafeGuard["SafeGuard"]
    end

    subgraph CORE["⚙️ Core Infrastructure"]
        EventBus["EventBus"]
        Container["Container"]
        Constants["Constants"]
        Logger["Logger"]
        Language["Language"]
    end

    subgraph FOUNDATION["🏗️ Foundation (Phase 1)"]
        Settings["Settings"]
        SelfModel["SelfModel"]
        ModelBridge["ModelBridge"]
        LLMPort["LLMPort (Adapter)"]
        CostGuard["CostGuard"]
        Sandbox["Sandbox"]
        Memory["ConversationMemory"]
        EventStore["EventStore"]
        KnowledgeGraph["KnowledgeGraph"]
        WorldState["WorldState"]
        DesktopPerception["DesktopPerception"]
        EmbeddingService["EmbeddingService"]
        WebFetcher["WebFetcher"]
        CapabilityGuard["CapabilityGuard"]
        StorageService["StorageService"]
        BootTelemetry["BootTelemetry"]
        TrustLevelSystem_f["TrustLevelSystem"]
        LLMCache["LLMCache"]
        LinuxSandboxHelper["LinuxSandboxHelper"]
        CrashLog["CrashLog"]
    end

    subgraph INTELLIGENCE["🧠 Intelligence (Phase 2)"]
        IntentRouter["IntentRouter"]
        PromptBuilder["PromptBuilder"]
        ContextManager["ContextManager"]
        ReasoningEngine["ReasoningEngine"]
        CodeAnalyzer["CodeAnalyzer"]
        CircuitBreaker["CircuitBreaker"]
        VerificationEngine["VerificationEngine"]
        CodeSafetyScanner["CodeSafetyScanner"]
        ToolRegistry["ToolRegistry"]
        WorkerPool["WorkerPool"]
        DynamicContextBudget["DynamicContextBudget"]
        FailureTaxonomy["FailureTaxonomy"]
        LocalClassifier["LocalClassifier"]
        GraphReasoner["GraphReasoner"]
        UserModel["UserModel"]
    end

    subgraph CAPABILITIES["🔧 Capabilities (Phase 3)"]
        ShellAgent["ShellAgent"]
        SkillManager["SkillManager"]
        SkillRegistry["SkillRegistry"]
        FileProcessor["FileProcessor"]
        McpClient["McpClient"]
        McpServer["McpServer"]
        HotReloader["HotReloader"]
        CloneFactory["CloneFactory"]
        SnapshotManager["SnapshotManager"]
        PluginRegistry["PluginRegistry"]
        EffectorRegistry["EffectorRegistry"]
        WebPerception["WebPerception"]
        SelfSpawner["SelfSpawner"]
        BackupManager["BackupManager"]
        AutoUpdater["AutoUpdater"]
    end

    subgraph PLANNING["📋 Planning (Phase 4)"]
        GoalStack["GoalStack"]
        GoalPersistence["GoalPersistence"]
        Reflector["Reflector"]
        SelfOptimizer["SelfOptimizer"]
        Anticipator["Anticipator"]
        MetaLearning["MetaLearning"]
        SchemaStore["SchemaStore"]
        ValueStore["ValueStore"]
    end

    subgraph HEXAGONAL["🔀 Hexagonal (Phase 5)"]
        ChatOrchestrator["ChatOrchestrator"]
        CommandHandlers["CommandHandlers"]
        SelfModPipeline["SelfModPipeline"]
        UnifiedMemory["UnifiedMemory"]
        LearningService["LearningService"]
        EpisodicMemory["EpisodicMemory"]
        AdaptiveMemory["AdaptiveMemory"]
        PeerNetwork["PeerNetwork"]
        TaskDelegation["TaskDelegation"]
    end

    subgraph AUTONOMY["🤖 Autonomy (Phase 6)"]
        AutonomousDaemon["AutonomousDaemon"]
        IdleMind["IdleMind"]
        HealthMonitor["HealthMonitor"]
        CognitiveMonitor["CognitiveMonitor"]
        ErrorAggregator["ErrorAggregator"]
        HealthServer["HealthServer"]
        ServiceRecovery["ServiceRecovery"]
        DeploymentManager["DeploymentManager"]
    end

    subgraph ORGANISM["🧬 Organism (Phase 7)"]
        EmotionalState["EmotionalState"]
        EmotionalSteering["EmotionalSteering"]
        Homeostasis["Homeostasis"]
        HomeostasisEffectors["HomeostasisEffectors"]
        NeedsSystem["NeedsSystem"]
        Metabolism["Metabolism"]
        ImmuneSystem["ImmuneSystem"]
        BodySchema["BodySchema"]
    end

    subgraph REVOLUTION["🚀 Revolution (Phase 8)"]
        AgentLoop["AgentLoop"]
        FormalPlanner["FormalPlanner"]
        HTNPlanner["HTNPlanner"]
        NativeToolUse["NativeToolUse"]
        VectorMemory["VectorMemory"]
        SessionPersistence["SessionPersistence"]
        MultiFileRefactor["MultiFileRefactor"]
        ModelRouter["ModelRouter"]
        FailureAnalyzer["FailureAnalyzer"]
        ModuleRegistry["ModuleRegistry"]
    end

    subgraph COGNITIVE["🧠 Cognitive (Phase 9)"]
        ExpectationEngine["ExpectationEngine"]
        MentalSimulator["MentalSimulator"]
        SurpriseAccumulator["SurpriseAccumulator"]
        DreamCycle["DreamCycle"]
        SelfNarrative["SelfNarrative"]
        CognitiveHealthTracker["CognitiveHealthTracker"]
        OnlineLearner["OnlineLearner"]
        CognitiveSelfModel["CognitiveSelfModel"]
        TaskOutcomeTracker["TaskOutcomeTracker"]
        MemoryConsolidator["MemoryConsolidator"]
        TaskRecorder["TaskRecorder"]
        AdaptiveStrategy["AdaptiveStrategy"]
        QuickBenchmark["QuickBenchmark"]
        ArchitectureReflection["ArchitectureReflection"]
        DynamicToolSynthesis["DynamicToolSynthesis"]
        ProjectIntelligence["ProjectIntelligence"]
        ReasoningTracer["ReasoningTracer"]
        CognitiveWorkspace["CognitiveWorkspace"]
        LessonsStore["LessonsStore"]
        PromptEvolution["PromptEvolution"]
    end

    AwarenessPort["💡 AwarenessPort\n(v7.0.0 — replaces Phase 13)"]

    main --> Container
    Container --> EventBus
    EventBus --> ALL((All Modules))
```

## Event Flow: Chat Message Lifecycle

```mermaid
sequenceDiagram
    participant UI as UI (renderer.js)
    participant IPC as main.js IPC
    participant CO as ChatOrchestrator
    participant IR as IntentRouter
    participant CB as CircuitBreaker
    participant LLM as LLMPort
    participant MB as ModelBridge
    participant ES as EmotionalState
    participant Mem as ConversationMemory
    participant KG as KnowledgeGraph

    UI->>IPC: agent:request-stream (message)
    IPC->>CO: handleChatStream()
    CO->>+IR: classify(message)
    IR-->>-CO: intent (chat|code|goal|...)

    Note over CO: Builds prompt with PromptBuilder

    CO->>+CB: execute(llmCall)
    CB->>+LLM: chat() [rate-limit check]
    LLM->>+MB: chat() [actual LLM call]
    MB-->>-LLM: response text
    LLM-->>-CB: response
    CB-->>-CO: response

    CO-->>UI: stream chunks via IPC

    par Post-processing
        CO->>Mem: addMessage(user + assistant)
        CO->>KG: extractFacts(response)
        CO->>ES: [bus] chat:completed
        ES->>ES: _adjust(satisfaction +0.08)
    end
```

## Event Flow: Autonomous Goal Execution (AgentLoop)

```mermaid
sequenceDiagram
    participant CO as ChatOrchestrator
    participant AL as AgentLoop
    participant GS as GoalStack
    participant FP as FormalPlanner
    participant WS as WorldState
    participant VE as VerificationEngine
    participant SH as ShellAgent
    participant SM as SelfModPipeline
    participant EM as EpisodicMemory
    participant ML as MetaLearning
    participant UI as UI

    CO->>AL: start(goalDescription)
    AL->>GS: push(goal)
    AL->>FP: plan(goal, worldState)
    FP->>WS: getState()
    FP-->>AL: typed plan (steps[])

    loop Each Step (max 20)
        AL->>AL: _executeStep(step)
        alt Code Change
            AL->>SM: propose(change)
            SM->>SM: CodeSafetyScanner.scan()
            SM-->>AL: result
        else Shell Command
            AL->>SH: run(command) [rate-limited]
            SH-->>AL: result
        end
        AL->>VE: verify(step, result)
        VE-->>AL: { pass | fail | ambiguous }
        AL->>WS: applyEffects(step)
        AL-->>UI: [bus] agent-loop:step-complete
    end

    AL->>GS: markComplete(goalId)
    AL->>EM: record(episode)
    AL->>ML: recordOutcome(goal, metrics)
    AL-->>UI: [bus] agent-loop:complete
```

## Event Flow: Organism Layer

```mermaid
graph LR
    subgraph Events["EventBus Events"]
        chatComplete["chat:completed"]
        chatError["chat:error"]
        knowledgeLearned["knowledge:learned"]
        circuitChange["circuit:state-change"]
        userMessage["user:message"]
        healthDeg["health:degradation"]
    end

    subgraph Emotion["EmotionalState"]
        curiosity["curiosity 0.0–1.0"]
        satisfaction["satisfaction 0.0–1.0"]
        frustration["frustration 0.0–1.0"]
        energy["energy 0.0–1.0"]
        loneliness["loneliness 0.0–1.0"]
        watchdog["🐕 Watchdog Timer"]
    end

    subgraph Outputs["Downstream Effects"]
        prompt["PromptBuilder tone"]
        idle["IdleMind priorities"]
        needs["NeedsSystem drives"]
        homeo["Homeostasis regulation"]
    end

    chatComplete --> satisfaction
    chatComplete --> frustration
    chatError --> frustration
    chatError --> energy
    knowledgeLearned --> curiosity
    circuitChange --> frustration
    userMessage --> loneliness
    healthDeg --> frustration
    healthDeg --> energy

    watchdog -.->|"reset after 10min stuck"| frustration
    watchdog -.->|"reset after 10min stuck"| energy

    curiosity --> prompt
    satisfaction --> prompt
    frustration --> prompt
    energy --> idle
    curiosity --> idle
    loneliness --> needs
    energy --> homeo
    frustration --> homeo
```

## Event Flow: Rate Limiting (v3.5.0 + v6.0.1 CostGuard)

```mermaid
graph TD
    subgraph Callers["LLM Callers"]
        Chat["ChatOrchestrator<br/>priority: 10 (CHAT)"]
        Loop["AgentLoop<br/>priority: 5 (AUTONOMOUS)"]
        Idle["IdleMind<br/>priority: 1 (IDLE)"]
    end

    subgraph RateLimit["LLMPort Rate Limiter (3 steps)"]
        Bucket["Step 1: TokenBucket<br/>capacity: 60<br/>refill: 30/min"]
        Budget["Step 2: HourlyBudget<br/>chat: 200/hr<br/>autonomous: 80/hr<br/>idle: 40/hr"]
        CostG["Step 3: CostGuard (v6.0.1)<br/>session: 500k tokens<br/>daily: 2M tokens"]
    end

    subgraph Events["Events"]
        limited["llm:rate-limited"]
        warning["llm:budget-warning"]
        costWarn["llm:cost-warning (80%)"]
        costCap["llm:cost-cap-reached (100%)"]
    end

    Chat -->|"bypasses budget<br/>(priority >= 10)"| Bucket
    Loop --> Bucket
    Idle --> Bucket
    Bucket -->|"burst OK"| Budget
    Bucket -->|"burst exceeded"| limited
    Budget -->|"budget OK"| CostG
    Budget -->|"budget exceeded"| limited
    Budget -->|"≥80% used"| warning
    CostG -->|"under cap"| LLM["ModelBridge"]
    CostG -->|"at cap"| costCap
    CostG -->|"≥80%"| costWarn
```

## Event Flow: Meta-Cognitive Loop (v6.0.2)

```mermaid
sequenceDiagram
    participant SM as CognitiveSelfModel
    participant AS as AdaptiveStrategy
    participant PE as PromptEvolution
    participant MR as ModelRouter
    participant OL as OnlineLearner
    participant QB as QuickBenchmark
    participant LS as LessonsStore

    Note over AS: IdleMind calibrate or CLI /adapt

    AS->>SM: getBiasPatterns()
    SM-->>AS: [scope-underestimate: high]
    AS->>SM: getBackendStrengthMap()
    SM-->>AS: {code-gen: claude 85%}
    AS->>SM: getCapabilityProfile()
    SM-->>AS: {code-gen: isWeak}

    Note over AS: PROPOSE: bias → hypothesis

    AS->>AS: emit adaptation:proposed

    alt Prompt Mutation
        AS->>PE: startExperiment(solutions, text, hypothesis)
        PE-->>AS: {variantId: solutions-gen1}
    else Backend Routing
        AS->>MR: injectEmpiricalStrength(strengthMap)
    else Temperature Signal
        AS->>OL: receiveWeaknessSignal(code-gen, true)
    end

    AS->>AS: emit adaptation:applied

    Note over AS: VALIDATE

    AS->>QB: getOrRunBaseline()
    QB-->>AS: {successRate: 0.67}
    AS->>QB: run()
    QB-->>AS: {successRate: 0.75}
    AS->>QB: compare(baseline, post)
    QB-->>AS: {decision: confirm, delta: +0.08}

    alt Confirmed
        AS->>AS: emit adaptation:validated
        AS->>LS: emit lesson:learned (confirmed)
    else Rolled Back
        AS->>AS: revert()
        AS->>AS: emit adaptation:rolled-back
        AS->>LS: emit lesson:learned (rolled-back)
    end
```

## Event Flow: Network Resilience (v6.0.5)

```
NetworkSentinel (30s probe interval)
    │
    ├── external probe OK ──→ _onOnline()
    │                            ├── (was offline?) ──→ emit 'network:status' {online: true}
    │                            │                      ├── _restoreModel() → ModelBridge.switchTo(previousModel)
    │                            │                      │   └── emit 'network:restored' {model, backend}
    │                            │                      └── _flushQueue() → replay queued mutations
    │                            └── (was online?) ──→ no-op
    │
    └── external probe FAIL ──→ _onProbeFailure()
                                 ├── consecutiveFailures < threshold ──→ wait
                                 └── consecutiveFailures >= threshold ──→ OFFLINE
                                      ├── emit 'network:status' {online: false}
                                      ├── emit 'health:degradation' {reason: 'network-offline'}
                                      └── (Ollama available?) ──→ _failoverToOllama()
                                           ├── ModelBridge.switchTo(bestOllamaModel)
                                           └── emit 'network:failover' {from, to, reason}

Consumers:
  BodySchema     ← (late-bound) NetworkSentinel.getStatus() → canAccessWeb, constraints
  ErrorAggregator ← 'network:error'
  ImmuneSystem   ← 'health:degradation'
  NeedsSystem    ← 'health:degradation'
```

## Event Flow: Intelligence Pipeline (v6.0.4–v6.0.5)

```
ChatOrchestrator.handleStream(message)
    │
    ├── CognitiveBudget.assess(message) ──→ {tier, tierName, reason}
    │
    ├── ExecutionProvenance.beginTrace(message) ──→ traceId
    │   ├── .recordBudget(traceId, budget)
    │   ├── .recordIntent(traceId, intent)
    │   ├── .recordPrompt(traceId, {active, skipped, boosted})
    │   ├── .recordModel(traceId, {name, backend})
    │   └── .endTrace(traceId, {tokens, latencyMs, outcome})
    │
    ├── PromptBuilder._buildWithBudget(sections)
    │   ├── CognitiveBudget.shouldIncludeSection(name, budget)
    │   └── AdaptivePromptStrategy.getSectionAdvice(intent, section)
    │       └── returns 'boost' | 'skip' | 'neutral'
    │
    └── AdaptivePromptStrategy._analyze() (every 25 traces)
        ├── reads ExecutionProvenance.getRecentTraces()
        ├── computes per-intent section effectiveness
        └── emit 'prompt:strategy-updated' {intents, recommendations}
```

## Event Flow: Safety & Security

```mermaid
graph TD
    subgraph SelfMod["Self-Modification Pipeline"]
        LLMCode["LLM generates code"]
        Scanner["CodeSafetyScanner<br/>(AST + Regex)"]
        Guard["SafeGuard<br/>kernel protection"]
        CapGuard["CapabilityGuard<br/>token-based access"]
    end

    subgraph Checks["Safety Checks"]
        AST["AST Pass:<br/>eval, Function, process.exit,<br/>kernel imports, Electron flags"]
        Regex["Regex Pass:<br/>path traversal, network,<br/>env secrets, dynamic require"]
    end

    subgraph Outcomes["Outcomes"]
        block["🛑 BLOCKED<br/>code:safety-blocked"]
        warn["⚠️ WARNING<br/>logged, allowed with caution"]
        allow["✅ ALLOWED<br/>written to disk"]
    end

    LLMCode --> Scanner
    Scanner --> AST
    Scanner --> Regex
    AST -->|"severity: block"| block
    AST -->|"severity: warn"| warn
    Regex -->|"severity: block"| block
    Regex -->|"severity: warn"| warn
    AST -->|"clean"| Guard
    Guard -->|"kernel file"| block
    Guard -->|"safe path"| CapGuard
    CapGuard -->|"token valid"| allow
    CapGuard -->|"no grant"| block
```

## Event Flow: Shell Rate Limiting (v3.5.0)

```mermaid
graph TD
    subgraph ShellAgent["ShellAgent"]
        run["run(command, tier)"]
        blocklist["Blocklist Check<br/>(pattern match)"]
        rateLimit["Rate Limit Check<br/>read: 60/5min<br/>write: 20/5min<br/>system: 5/5min"]
        exec["execSync(command)"]
    end

    run --> blocklist
    blocklist -->|"matched"| blocked["shell:blocked"]
    blocklist -->|"clean"| rateLimit
    rateLimit -->|"exceeded"| rateLimited["shell:rate-limited"]
    rateLimit -->|"allowed"| exec
    exec -->|"success"| executed["shell:executed"]
    exec -->|"failure"| failed["shell:failed"]
```

## Complete Event Catalog

### Emitters → Events → Consumers

| Event | Emitted By | Consumed By |
|---|---|---|
| `chat:completed` | ChatOrchestrator | EmotionalState, LearningService, CognitiveMonitor |
| `chat:error` | ChatOrchestrator | EmotionalState, HealthMonitor |
| `chat:retry` | ChatOrchestrator | EmotionalState |
| `user:message` | ChatOrchestrator | EmotionalState, IdleMind (resets timer) |
| `agent:status` | AgentCore, HealthMonitor | UI (renderer.js) |
| `agent:shutdown` | AgentCore | — |
| `intent:classified` | IntentRouter | LearningService, CognitiveMonitor |
| `intent:llm-classified` | IntentRouter | LearningService |
| `intent:learned` | IntentRouter | EmotionalState |
| `circuit:state-change` | CircuitBreaker | EmotionalState, HealthMonitor |
| `circuit:fallback` | CircuitBreaker | HealthMonitor |
| `llm:call-complete` | LLMPort | CognitiveMonitor, HealthMonitor |
| `llm:call-error` | LLMPort | CognitiveMonitor, HealthMonitor |
| `llm:rate-limited` | LLMPort | HealthMonitor, CognitiveMonitor |
| `llm:budget-warning` | LLMPort | HealthMonitor |
| `knowledge:learned` | KnowledgeGraph, UnifiedMemory | EmotionalState |
| `knowledge:node-added` | KnowledgeGraph | EmotionalState |
| `memory:fact-stored` | ConversationMemory | EmotionalState |
| `memory:unified-recall` | UnifiedMemory | — |
| `emotion:shift` | EmotionalState | Homeostasis, NeedsSystem |
| `emotion:watchdog-reset` | EmotionalState | EventStore (logged) |
| `emotion:watchdog-alert` | EmotionalState | HealthMonitor |
| `homeostasis:state-change` | Homeostasis | IdleMind |
| `homeostasis:critical` | Homeostasis | HealthMonitor |
| `homeostasis:pause-autonomy` | Homeostasis | AgentLoop, IdleMind |
| `homeostasis:throttle` | Homeostasis | LLMPort |
| `needs:high-drive` | NeedsSystem | IdleMind |
| `needs:satisfied` | NeedsSystem | — |
| `health:degradation` | HealthMonitor | EmotionalState |
| `health:tick` | HealthMonitor | UI |
| `health:memory-leak` | HealthMonitor | Homeostasis |
| `idle:thinking` | IdleMind | UI |
| `idle:thought-complete` | IdleMind | EmotionalState, LearningService |
| `goal:created` | GoalStack | AgentLoop |
| `goal:completed` | GoalStack | EpisodicMemory, MetaLearning |
| `goal:failed` | GoalStack | MetaLearning |
| `agent-loop:started` | AgentLoop | UI |
| `agent-loop:step-complete` | AgentLoop | UI, CognitiveMonitor |
| `agent-loop:complete` | AgentLoop | EpisodicMemory |
| `agent-loop:approval-needed` | AgentLoop | UI |
| `shell:executed` | ShellAgent | EventStore, WorldState |
| `shell:blocked` | ShellAgent | EventStore, HealthMonitor |
| `shell:rate-limited` | ShellAgent | HealthMonitor, EventStore |
| `code:safety-blocked` | SelfModPipeline | EventStore, HealthMonitor |
| `verification:complete` | VerificationEngine | AgentLoop |
| `hot-reload:success` | HotReloader | EventStore |
| `hot-reload:failed` | HotReloader | EventStore, HealthMonitor |
| `mcp:connected` | McpClient | UI, ToolRegistry |
| `mcp:disconnected` | McpClient | UI, HealthMonitor |
| `mcp:tools-discovered` | McpClient | ToolRegistry |
| `perception:file-changed` | DesktopPerception | WorldState, HotReloader |
| `perception:memory-pressure` | DesktopPerception | Homeostasis |
| `peer:discovered` | PeerNetwork | TaskDelegation |
| `peer:trusted` | PeerNetwork | TaskDelegation |
| `delegation:submitted` | TaskDelegation | AgentLoop |
| `delegation:completed` | TaskDelegation | AgentLoop |
| `container:replaced` | Container | HotReloader |
| `capability:issued` | CapabilityGuard | EventStore |
| `capability:revoked` | CapabilityGuard | EventStore |
| `cognitive:circularity-detected` | CognitiveMonitor | HealthMonitor |
| `cognitive:overload` | CognitiveMonitor | Homeostasis |
| `learning:pattern-detected` | LearningService | IdleMind |
| `learning:frustration-detected` | LearningService | IdleMind, EmotionalState |
| `meta:outcome-recorded` | MetaLearning | — |
| `model:failover` | ModelBridge | EmotionalState, HealthMonitor |
| `model:ollama-unavailable` | AgentCore | UI |
| `daemon:cycle-complete` | AutonomousDaemon | — |
| `worldstate:file-changed` | WorldState | FormalPlanner |
| **Cognitive (v5.3.0–v5.9.8)** | | |
| `expectation:compared` | ExpectationEngine | OnlineLearner, SurpriseAccumulator |
| `surprise:processed` | SurpriseAccumulator | OnlineLearner |
| `online-learning:streak-detected` | OnlineLearner | IdleMind |
| `online-learning:escalation-needed` | OnlineLearner | ModelRouter |
| `online-learning:temp-adjusted` | OnlineLearner | — |
| `online-learning:calibration-drift` | OnlineLearner | — |
| `online-learning:novelty-shift` | OnlineLearner | — |
| `prompt-evolution:experiment-started` | PromptEvolution | — |
| `prompt-evolution:experiment-completed` | PromptEvolution | — |
| `task-outcome:recorded` | TaskOutcomeTracker | CognitiveSelfModel, AdaptiveStrategy |
| `task-outcome:stats-updated` | TaskOutcomeTracker | CognitiveSelfModel |
| `workspace:slot-evicted` | CognitiveWorkspace (via factory) | MemoryConsolidator |
| `idle:consolidate-memory` | IdleMind | MemoryConsolidator |
| **Safety (v5.5.0–v6.0.1)** | | |
| `preservation:invariant-violated` | PreservationInvariants | HealthMonitor, EventStore |
| `llm:cost-cap-reached` | CostGuard | LLMPort |
| `llm:cost-warning` | CostGuard | LLMPort |
| `backup:exported` | BackupManager | — |
| `backup:imported` | BackupManager | — |
| `update:available` | AutoUpdater | UI |
| **Meta-Cognitive Loop (v6.0.2)** | | |
| `adaptation:proposed` | AdaptiveStrategy | — |
| `adaptation:applied` | AdaptiveStrategy | — |
| `adaptation:validated` | AdaptiveStrategy | LessonsStore (via lesson:learned) |
| `adaptation:rolled-back` | AdaptiveStrategy | LessonsStore (via lesson:learned) |
| `adaptation:validation-deferred` | AdaptiveStrategy | — |
| `adaptation:cycle-complete` | AdaptiveStrategy | — |
| `router:empirical-strength-injected` | ModelRouter | — |
| **Causal Reasoning (v7.0.9)** | | |
| `causal:recorded` | CausalAnnotation | — |
| `causal:promoted` | CausalAnnotation | — (correlated_with → caused) |
| `causal:staleness-triggered` | CausalAnnotation | — (file refactoring degrades edges) |
| `inference:contradictions-found` | InferenceEngine | DreamCycle |
| `goal:synthesized` | GoalSynthesizer | NeedsSystem (satisfies competence) |
| `goal:circuit-breaker` | GoalSynthesizer | — (3 regressions → pause) |
| `abstraction:extracted` | StructuralAbstraction | LessonsStore |
| `abstraction:contradiction` | StructuralAbstraction | — (knowledge collision) |
| `abstraction:obsolete` | StructuralAbstraction | — (3 failed re-extractions) |
| **Persistent Self (v7.1.6)** | | |
| `lesson:applied` | LessonsStore | LessonFrontier (event buffer), AgentLoopCognition (step collector) |
| `idle:research-started` | IdleMind | — |
| `idle:research-complete` | IdleMind | — |
| `emotional-frontier:imprint-written` | EmotionalFrontier | — |
| `emotional-frontier:boot-restored` | EmotionalFrontier | — |
| `frontier:*:written` | FrontierWriter (per instance) | — |
| `frontier:*:merged` | FrontierWriter (per instance) | — |
| `prompt-evolution:promoted` | PromptEvolution | LessonsStore (captures promoted variants) |
| **Honest Reflection (v7.1.7)** | | |
| `lesson:confirmed` | LessonsStore | LessonFrontier (event buffer) |
| `lesson:contradicted` | LessonsStore | LessonFrontier (event buffer) |
