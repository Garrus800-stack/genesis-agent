# Genesis — Graceful Degradation Matrix

Generated: 2026-03-23T22:32:57.857Z
Services: 72 | Bindings: 255

## Critical Services (removal breaks dependents)

| Service | Phase | Required By | Dependents |
|---------|-------|-------------|------------|
| eventStore | P1 | 18 | shellAgent, mcpClient, anticipator, selfOptimizer, unifiedMemory, selfModPipeline, learningService, taskDelegation, idleMind, healthMonitor, cognitiveMonitor, agentLoop, multiFileRefactor, htnPlanner, formalPlanner, cognitiveHealthTracker, surpriseAccumulator, dreamCycle |
| memory | P1 | 17 | uncertaintyGuard, embeddingService, mem, promptBuilder, context, shellAgent, anticipator, solutionAccumulator, selfOptimizer, unifiedMemory, chatOrchestrator, learningService, daemon, idleMind, sessionPersistence, agentLoop, failureAnalyzer |
| selfModel | P1 | 16 | promptBuilder, context, analyzer, reflector, cloner, network, shellAgent, selfModPipeline, daemon, idleMind, agentLoop, multiFileRefactor, htnPlanner, formalPlanner, failureAnalyzer, selfNarrative |
| llm | P1 | 16 | promptBuilder, reasoning, analyzer, skills, reflector, cloner, network, goalStack, anticipator, chatOrchestrator, selfModPipeline, daemon, nativeToolUse, sessionPersistence, multiFileRefactor, formalPlanner |
| knowledgeGraph | P1 | 14 | uncertaintyGuard, embeddingService, kg, promptBuilder, shellAgent, mcpClient, anticipator, solutionAccumulator, unifiedMemory, learningService, idleMind, agentLoop, failureAnalyzer, dreamCycle |
| sandbox | P1 | 13 | sbx, skills, reflector, fileProcessor, shellAgent, mcpClient, selfModPipeline, commandHandlers, daemon, agentLoop, multiFileRefactor, htnPlanner, formalPlanner |
| prompts | P1 | 10 | reasoning, analyzer, skills, reflector, cloner, network, goalStack, selfModPipeline, daemon, idleMind |
| settings | P1 | 8 | model, worldState, mcpClient, commandHandlers, emotionalState, homeostasis, needsSystem, agentLoop |
| model | P1 | 8 | llm, context, shellAgent, idleMind, agentLoop, modelRouter, dreamCycle, selfNarrative |
| tools | P2 | 7 | reasoning, mcpClient, chatOrchestrator, selfModPipeline, nativeToolUse, agentLoop, formalPlanner |
| worldState | P1 | 5 | desktopPerception, formalPlanner, modelRouter, expectationEngine, mentalSimulator |
| goalStack | P4 | 5 | selfOptimizer, commandHandlers, taskDelegation, idleMind, agentLoop |
| emotionalState | P7 | 5 | promptBuilder, idleMind, homeostasis, needsSystem, selfNarrative |
| skills | P3 | 4 | promptBuilder, network, selfModPipeline, daemon |
| metaLearning | P4 | 4 | modelRouter, expectationEngine, dreamCycle, selfNarrative |
| schemaStore | P4 | 3 | expectationEngine, dreamCycle, selfNarrative |
| episodicMemory | P5 | 3 | surpriseAccumulator, dreamCycle, selfNarrative |
| astDiff | P1 | 2 | selfModPipeline, multiFileRefactor |
| circuitBreaker | P2 | 2 | chatOrchestrator, healthMonitor |
| reflector | P3 | 2 | selfModPipeline, daemon |
| network | P3 | 2 | commandHandlers, taskDelegation |
| shellAgent | P3 | 2 | commandHandlers, agentLoop |
| unifiedMemory | P5 | 2 | promptBuilder, chatOrchestrator |
| learningService | P5 | 2 | promptBuilder, idleMind |
| homeostasis | P7 | 2 | promptBuilder, idleMind |
| needsSystem | P7 | 2 | promptBuilder, idleMind |
| webFetcher | P1 | 1 | commandHandlers |
| uncertaintyGuard | P1 | 1 | chatOrchestrator |
| intentRouter | P2 | 1 | chatOrchestrator |
| workerPool | P2 | 1 | healthMonitor |
| promptBuilder | P2 | 1 | chatOrchestrator |
| context | P2 | 1 | chatOrchestrator |
| reasoning | P2 | 1 | selfModPipeline |
| analyzer | P2 | 1 | commandHandlers |
| verifier | P2 | 1 | formalPlanner |
| cloner | P3 | 1 | selfModPipeline |
| fileProcessor | P3 | 1 | commandHandlers |
| hotReloader | P3 | 1 | selfModPipeline |
| anticipator | P4 | 1 | promptBuilder |
| solutionAccumulator | P4 | 1 | promptBuilder |
| selfOptimizer | P4 | 1 | promptBuilder |
| selfModPipeline | P5 | 1 | agentLoop |
| daemon | P6 | 1 | commandHandlers |
| idleMind | P6 | 1 | commandHandlers |
| vectorMemory | P8 | 1 | promptBuilder |
| sessionPersistence | P8 | 1 | promptBuilder |
| expectationEngine | P9 | 1 | mentalSimulator |

## Optional Services (graceful degradation)

| Service | Phase | Consumers | Lost Features |
|---------|-------|-----------|---------------|
| mcpClient | P3 | 2 | promptBuilder.mcpClient, idleMind.mcpClient |
| taskDelegation | P5 | 1 | agentLoop.taskDelegation |
| cognitiveMonitor | P6 | 1 | promptBuilder.cognitiveMonitor |
| nativeToolUse | P8 | 1 | chatOrchestrator.nativeToolUse |
| htnPlanner | P8 | 1 | agentLoop.htnPlanner |
| formalPlanner | P8 | 1 | agentLoop.formalPlanner |
| modelRouter | P8 | 1 | chatOrchestrator.modelRouter |
| cognitiveHealthTracker | P9 | 1 | agentLoop.cognitiveHealthTracker |
| surpriseAccumulator | P9 | 2 | dreamCycle.surpriseAccumulator, selfNarrative.surpriseAccumulator |
| mentalSimulator | P9 | 1 | agentLoop.mentalSimulator |
| dreamCycle | P9 | 1 | idleMind.dreamCycle |
| selfNarrative | P9 | 2 | promptBuilder.selfNarrative, idleMind.selfNarrative |

## Leaf Services (no dependents)

| Service | Phase | Tags |
|---------|-------|------|
| capabilityGuard | P1 | foundation, security |
| embeddingService | P1 | foundation |
| desktopPerception | P1 | foundation, perception |
| moduleSigner | P1 | foundation, security |
| mem | P1 | port, foundation |
| kg | P1 | port, foundation |
| sbx | P1 | port, foundation |
| chatOrchestrator | P5 | hexagonal |
| commandHandlers | P5 | hexagonal |
| healthMonitor | P6 | autonomy |
| agentLoop | P8 | revolution, autonomy |
| multiFileRefactor | P8 | revolution |
| failureAnalyzer | P8 | revolution, ci |