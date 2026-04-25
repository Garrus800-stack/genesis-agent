# Genesis — Graceful Degradation Matrix

Generated: 2026-04-25T11:55:51.009Z
Services: 151 | Bindings: 569

## Critical Services (removal breaks dependents)

| Service | Phase | Required By | Dependents |
|---------|-------|-------------|------------|
| eventStore | P1 | 25 | shellAgent, mcpClient, anticipator, selfOptimizer, unifiedMemory, selfModPipeline, learningService, taskDelegation, peerConsensus, idleMind, healthMonitor, cognitiveMonitor, agentLoop, multiFileRefactor, htnPlanner, formalPlanner, cognitiveHealthTracker, surpriseAccumulator, dreamCycle, goalPersistence, failureTaxonomy, fitnessEvaluator, effectorRegistry, webPerception, selfSpawner |
| knowledgeGraph | P1 | 19 | uncertaintyGuard, embeddingService, kg, promptBuilder, shellAgent, mcpClient, anticipator, solutionAccumulator, unifiedMemory, learningService, idleMind, agentLoop, failureAnalyzer, emotionalFrontier, unfinishedWorkFrontier, dreamCycle, suspicionFrontier, lessonFrontier, graphReasoner |
| selfModel | P1 | 18 | promptBuilder, context, analyzer, reflector, cloner, network, shellAgent, selfModPipeline, daemon, idleMind, agentLoop, multiFileRefactor, htnPlanner, formalPlanner, failureAnalyzer, selfNarrative, architectureReflection, graphReasoner |
| memory | P1 | 17 | uncertaintyGuard, embeddingService, mem, promptBuilder, context, shellAgent, anticipator, solutionAccumulator, selfOptimizer, unifiedMemory, chatOrchestrator, learningService, daemon, idleMind, sessionPersistence, agentLoop, failureAnalyzer |
| llm | P1 | 16 | promptBuilder, reasoning, analyzer, skills, reflector, cloner, network, goalStack, anticipator, chatOrchestrator, selfModPipeline, daemon, nativeToolUse, sessionPersistence, multiFileRefactor, formalPlanner |
| sandbox | P1 | 14 | sbx, skills, reflector, fileProcessor, shellAgent, mcpClient, pluginRegistry, selfModPipeline, commandHandlers, daemon, agentLoop, multiFileRefactor, htnPlanner, formalPlanner |
| settings | P1 | 10 | model, worldState, mcpClient, commandHandlers, healthServer, emotionalState, homeostasis, needsSystem, agentLoop, trustLevelSystem |
| model | P1 | 10 | llmCache, llm, context, shellAgent, idleMind, agentLoop, modelRouter, colonyOrchestrator, dreamCycle, selfNarrative |
| prompts | P1 | 10 | reasoning, analyzer, skills, reflector, cloner, network, goalStack, selfModPipeline, daemon, idleMind |
| tools | P2 | 9 | reasoning, mcpClient, pluginRegistry, mcpToolBridge, chatOrchestrator, selfModPipeline, nativeToolUse, agentLoop, formalPlanner |
| goalStack | P4 | 6 | selfOptimizer, commandHandlers, taskDelegation, idleMind, agentLoop, goalPersistence |
| worldState | P1 | 5 | desktopPerception, formalPlanner, modelRouter, expectationEngine, mentalSimulator |
| codeSafety | P2 | 5 | skills, cloner, network, pluginRegistry, selfModPipeline |
| metaLearning | P4 | 5 | modelRouter, expectationEngine, dreamCycle, selfNarrative, promptEvolution |
| emotionalState | P7 | 5 | homeostasis, needsSystem, emotionalFrontier, selfNarrative, emotionalSteering |
| skills | P3 | 3 | network, selfModPipeline, daemon |
| schemaStore | P4 | 3 | expectationEngine, dreamCycle, selfNarrative |
| episodicMemory | P5 | 3 | surpriseAccumulator, dreamCycle, selfNarrative |
| astDiff | P1 | 2 | selfModPipeline, multiFileRefactor |
| circuitBreaker | P2 | 2 | chatOrchestrator, healthMonitor |
| reflector | P3 | 2 | selfModPipeline, daemon |
| network | P3 | 2 | commandHandlers, taskDelegation |
| shellAgent | P3 | 2 | commandHandlers, agentLoop |
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
| unifiedMemory | P5 | 1 | chatOrchestrator |
| selfModPipeline | P5 | 1 | agentLoop |
| daemon | P6 | 1 | daemonController |
| expectationEngine | P9 | 1 | mentalSimulator |

## Optional Services (graceful degradation)

| Service | Phase | Consumers | Lost Features |
|---------|-------|-----------|---------------|
| selfGate | P1 | 2 | goalStack.selfGate, chatOrchestrator.selfGate |
| activeReferences | P1 | 2 | chatOrchestrator.activeRefs, dreamCycle.activeRefs |
| genesisBackup | P1 | 1 | selfModPipeline._genesisBackup |
| llmCache | P1 | 2 | homeostasisEffectors.llmCache, immuneSystem.llmCache |
| moduleSigner | P1 | 1 | promptEvolution.moduleSigner |
| preservation | P1 | 1 | selfModPipeline._preservation |
| costGuard | P1 | 2 | llm._costGuard, quickBenchmark.costGuard |
| awareness | P1 | 2 | promptBuilder.awareness, selfModPipeline._awareness |
| cognitiveBudget | P2 | 3 | promptBuilder._cognitiveBudget, executionProvenance.cognitiveBudget, chatOrchestrator._cognitiveBudget |
| executionProvenance | P2 | 2 | adaptivePromptStrategy._provenance, chatOrchestrator._provenance |
| adaptivePromptStrategy | P2 | 1 | promptBuilder._adaptiveStrategy |
| symbolicResolver | P2 | 1 | agentLoop._symbolicResolver |
| disclosurePolicy | P2 | 1 | promptBuilder.disclosurePolicy |
| mcpClient | P3 | 4 | promptBuilder.mcpClient, mcpToolBridge._mcpClient, idleMind.mcpClient, bodySchema.mcpClient |
| snapshotManager | P3 | 1 | deploymentManager._snapshotManager |
| anticipator | P4 | 1 | promptBuilder.anticipator |
| solutionAccumulator | P4 | 1 | promptBuilder.solutions |
| selfOptimizer | P4 | 1 | promptBuilder.optimizer |
| valueStore | P4 | 2 | promptBuilder.valueStore, dreamCycle.valueStore |
| learningService | P5 | 2 | promptBuilder.learningService, idleMind.learningService |
| taskDelegation | P5 | 2 | agentLoop.taskDelegation, colonyOrchestrator.delegation |
| peerConsensus | P5 | 2 | network.peerConsensus, colonyOrchestrator.consensus |
| idleMind | P6 | 5 | promptBuilder._idleMind, selfModPipeline._idleMind, commandHandlers.idleMind, emotionalFrontier._idleMind, runtimeStatePort.idleMind |
| healthMonitor | P6 | 2 | serviceRecovery.healthMonitor, deploymentManager.healthMonitor |
| cognitiveMonitor | P6 | 1 | promptBuilder.cognitiveMonitor |
| errorAggregator | P6 | 1 | promptBuilder.errorAggregator |
| deploymentManager | P6 | 1 | autoUpdater._deploymentManager |
| networkSentinel | P6 | 1 | bodySchema.networkSentinel |
| homeostasis | P7 | 6 | promptBuilder.homeostasis, idleMind._homeostasis, bodySchema.homeostasis, homeostasisEffectors.homeostasis, metabolism.homeostasis, immuneSystem.homeostasis |
| needsSystem | P7 | 6 | promptBuilder.needsSystem, idleMind.needsSystem, metabolism.needsSystem, contextCollector.needsSystem, emotionalSteering.needsSystem, runtimeStatePort.needsSystem |
| bodySchema | P7 | 2 | promptBuilder.bodySchema, emotionalSteering.bodySchema |
| embodiedPerception | P7 | 1 | bodySchema.embodiedPerception |
| metabolism | P7 | 5 | promptBuilder._metabolism, selfModPipeline._metabolism, idleMind._metabolism, fitnessEvaluator.metabolism, runtimeStatePort.metabolism |
| immuneSystem | P7 | 2 | promptBuilder.immuneSystem, fitnessEvaluator.immuneSystem |
| genome | P7 | 6 | promptBuilder._genome, cloner.genome, selfModPipeline._genome, idleMind._genome, metabolism.genome, fitnessEvaluator.genome |
| nativeToolUse | P8 | 1 | chatOrchestrator.nativeToolUse |
| vectorMemory | P8 | 2 | promptBuilder.vectorMemory, homeostasisEffectors.vectorMemory |
| sessionPersistence | P8 | 2 | promptBuilder.sessionPersistence, emotionalFrontier._sessionPersistence |
| agentLoop | P8 | 2 | daemonController.agentLoop, goalPersistence.agentLoop |
| htnPlanner | P8 | 1 | agentLoop.htnPlanner |
| formalPlanner | P8 | 1 | agentLoop.formalPlanner |
| modelRouter | P8 | 5 | chatOrchestrator.modelRouter, onlineLearner.modelRouter, adaptiveStrategy.modelRouter, failureTaxonomy.modelRouter, emotionalSteering.modelRouter |
| colonyOrchestrator | P8 | 1 | agentLoop._colonyOrchestrator |
| emotionalFrontier | P8 | 3 | promptBuilder._emotionalFrontier, idleMind._emotionalFrontier, sessionPersistence._emotionalFrontier |
| unfinishedWorkFrontier | P8 | 4 | promptBuilder._unfinishedWorkFrontier, idleMind._unfinishedWorkFrontier, sessionPersistence._unfinishedWorkFrontier, goalSynthesizer._unfinishedWorkFrontier |
| cognitiveHealthTracker | P9 | 1 | agentLoop.cognitiveHealthTracker |
| surpriseAccumulator | P9 | 2 | dreamCycle.surpriseAccumulator, selfNarrative.surpriseAccumulator |
| journalWriter | P9 | 3 | contextCollector.journalWriter, dreamCycle.journalWriter, wakeUpRoutine.journalWriter |
| pendingMomentsStore | P9 | 3 | contextCollector.pendingMomentsStore, dreamCycle.pendingMomentsStore, wakeUpRoutine.pendingMomentsStore |
| contextCollector | P9 | 2 | dreamCycle.contextCollector, wakeUpRoutine.contextCollector |
| mentalSimulator | P9 | 1 | agentLoop.mentalSimulator |
| dreamCycle | P9 | 4 | promptBuilder._dreamCycle, idleMind.dreamCycle, contextCollector.dreamCycle, wakeUpRoutine.dreamCycle |
| selfNarrative | P9 | 2 | promptBuilder.selfNarrative, idleMind.selfNarrative |
| promptEvolution | P9 | 3 | promptBuilder.promptEvolution, onlineLearner.promptEvolution, adaptiveStrategy.promptEvolution |
| onlineLearner | P9 | 1 | adaptiveStrategy.onlineLearner |
| lessonsStore | P9 | 12 | promptBuilder.lessonsStore, symbolicResolver.lessonsStore, mcpToolBridge._lessonsStore, goalStack.lessonsStore, chatOrchestrator.lessonsStore, idleMind.lessonsStore, networkSentinel._lessonsStore, agentLoop.lessonsStore, cognitiveSelfModel.lessonsStore, memoryConsolidator.lessonsStore, structuralAbstraction.lessonsStore, goalSynthesizer.lessonsStore |
| reasoningTracer | P9 | 1 | cognitiveSelfModel.reasoningTracer |
| workspaceFactory | P9 | 1 | agentLoop._createWorkspace |
| architectureReflection | P9 | 2 | promptBuilder.architectureReflection, mcpToolBridge._archReflection |
| dynamicToolSynthesis | P9 | 1 | tools._toolSynthesis |
| projectIntelligence | P9 | 2 | promptBuilder.projectIntelligence, mcpToolBridge._projectIntel |
| taskOutcomeTracker | P9 | 3 | promptBuilder.taskOutcomeTracker, cognitiveSelfModel.taskOutcomeTracker, goalSynthesizer.tracker |
| cognitiveSelfModel | P9 | 4 | promptBuilder.cognitiveSelfModel, idleMind._cognitiveSelfModel, adaptiveStrategy.cognitiveSelfModel, goalSynthesizer.selfModel |
| coreMemories | P9 | 4 | commandHandlers.coreMemories, contextCollector.coreMemories, dreamCycle.coreMemories, wakeUpRoutine.coreMemories |
| quickBenchmark | P9 | 1 | adaptiveStrategy.quickBenchmark |
| causalAnnotation | P9 | 1 | agentLoop._causalAnnotation |
| inferenceEngine | P9 | 3 | reasoning._inferenceEngine, symbolicResolver._inferenceEngine, goalSynthesizer.inferenceEngine |
| patternMatcher | P9 | 1 | lessonsStore._patternMatcher |
| suspicionFrontier | P9 | 3 | promptBuilder._suspicionFrontier, idleMind._suspicionFrontier, goalSynthesizer._suspicionFrontier |
| lessonFrontier | P9 | 3 | promptBuilder._lessonFrontier, idleMind._lessonFrontier, goalSynthesizer._lessonFrontier |
| gateStats | P9 | 2 | selfGate.gateStats, chatOrchestrator.gateStats |
| dynamicContextBudget | P10 | 2 | context._dynamicBudget, homeostasisEffectors.dynamicContextBudget |
| conversationCompressor | P10 | 1 | context._compressor |
| emotionalSteering | P10 | 4 | promptBuilder.emotionalSteering, formalPlanner._emotionalSteering, modelRouter._emotionalSteering, adaptiveStrategy.emotionalSteering |
| localClassifier | P10 | 1 | intentRouter._localClassifier |
| userModel | P10 | 3 | promptBuilder.userModel, disclosurePolicy.userModel, needsSystem.userModel |
| trustLevelSystem | P11 | 7 | disclosurePolicy.trustLevelSystem, daemon.trustLevelSystem, idleMind._trustLevelSystem, bodySchema.trustLevelSystem, agentLoop.trustLevelSystem, earnedAutonomy.trustLevelSystem, effectorRegistry.trustLevel |
| effectorRegistry | P11 | 1 | bodySchema.effectorRegistry |
| selfSpawner | P11 | 1 | colonyOrchestrator.selfSpawner |
| runtimeStatePort | P11 | 1 | promptBuilder.runtimeStatePort |
| graphReasoner | P12 | 1 | reasoning._graphReasoner |

## Leaf Services (no dependents)

| Service | Phase | Tags |
|---------|-------|------|
| capabilityGuard | P1 | foundation, security |
| embeddingService | P1 | foundation |
| desktopPerception | P1 | foundation, perception |
| mem | P1 | port, foundation |
| kg | P1 | port, foundation |
| sbx | P1 | port, foundation |
| telemetry | P1 | monitoring |
| skillRegistry | P3 | capability, skills, v6-6 |
| pluginRegistry | P3 | capability, plugins |
| mcpToolBridge | P3 | capability, mcp |
| chatOrchestrator | P5 | hexagonal |
| commandHandlers | P5 | hexagonal |
| serviceRecovery | P6 | autonomy, recovery |
| healthServer | P6 | autonomy, monitoring |
| daemonController | P6 | autonomy, control |
| backupManager | P6 | autonomy, backup |
| autoUpdater | P6 | autonomy, update |
| homeostasisEffectors | P7 | organism, homeostasis, effectors |
| multiFileRefactor | P8 | revolution |
| failureAnalyzer | P8 | revolution, ci |
| memoryConsolidator | P9 | cognitive, memory, v6-7 |
| taskRecorder | P9 | cognitive, replay, v6-8 |
| adaptiveStrategy | P9 | cognitive, metacognition, v6-0-2 |
| structuralAbstraction | P9 | cognitive, learning, abstraction |
| goalSynthesizer | P9 | cognitive, autonomy, goals |
| wakeUpRoutine | P9 | cognitive, lifecycle |
| goalPersistence | P10 | planning, persistence |
| failureTaxonomy | P10 | intelligence, error-handling |
| fitnessEvaluator | P10 | organism, evolution, fitness |
| earnedAutonomy | P11 | autonomy, trust |
| webPerception | P11 | capabilities, perception |
