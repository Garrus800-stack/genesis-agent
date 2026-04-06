// ============================================================
// GENESIS — src/agent/index.js (v3.5.0 — Compatibility Barrel)
//
// Re-exports all modules from their new subdirectory locations.
// This allows existing test files and external code to continue
// using require("../../src/agent/ModuleName") without changes.
//
// Subdirectories: core, foundation, intelligence, capabilities,
//   planning, hexagonal, autonomy, organism, revolution
// ============================================================


// ── revolution ──
Object.defineProperty(exports, "AgentLoop", { get() { return require("./revolution/AgentLoop"); } });
Object.defineProperty(exports, "AgentLoopDelegate", { get() { return require("./revolution/AgentLoopDelegate"); } });
Object.defineProperty(exports, "AgentLoopPlanner", { get() { return require("./revolution/AgentLoopPlanner"); } });
Object.defineProperty(exports, "AgentLoopSteps", { get() { return require("./revolution/AgentLoopSteps"); } });

// ── planning ──
Object.defineProperty(exports, "Anticipator", { get() { return require("./planning/Anticipator"); } });

// ── foundation ──
Object.defineProperty(exports, "ASTDiff", { get() { return require("./foundation/ASTDiff"); } });

// ── autonomy ──
Object.defineProperty(exports, "AutonomousDaemon", { get() { return require("./autonomy/AutonomousDaemon"); } });

// ── foundation ──
Object.defineProperty(exports, "CapabilityGuard", { get() { return require("./foundation/CapabilityGuard"); } });

// ── hexagonal ──
Object.defineProperty(exports, "ChatOrchestrator", { get() { return require("./hexagonal/ChatOrchestrator"); } });

// ── intelligence ──
Object.defineProperty(exports, "CircuitBreaker", { get() { return require("./core/CircuitBreaker"); } });

// ── capabilities ──
Object.defineProperty(exports, "CloneFactory", { get() { return require("./capabilities/CloneFactory"); } });

// ── intelligence ──
Object.defineProperty(exports, "CodeAnalyzer", { get() { return require("./intelligence/CodeAnalyzer"); } });

// ── autonomy ──
Object.defineProperty(exports, "CognitiveMonitor", { get() { return require("./autonomy/CognitiveMonitor"); } });

// ── hexagonal ──
Object.defineProperty(exports, "CommandHandlers", { get() { return require("./hexagonal/CommandHandlers"); } });

// ── core ──
Object.defineProperty(exports, "Constants", { get() { return require("./core/Constants"); } });
Object.defineProperty(exports, "Container", { get() { return require("./core/Container"); } });

// ── intelligence ──
Object.defineProperty(exports, "ContextManager", { get() { return require("./intelligence/ContextManager"); } });

// ── foundation ──
Object.defineProperty(exports, "ConversationMemory", { get() { return require("./foundation/ConversationMemory"); } });
Object.defineProperty(exports, "DesktopPerception", { get() { return require("./foundation/DesktopPerception"); } });
Object.defineProperty(exports, "EmbeddingService", { get() { return require("./foundation/EmbeddingService"); } });

// ── organism ──
Object.defineProperty(exports, "EmotionalState", { get() { return require("./organism/EmotionalState"); } });

// ── hexagonal ──
Object.defineProperty(exports, "EpisodicMemory", { get() { return require("./hexagonal/EpisodicMemory"); } });

// ── core ──
Object.defineProperty(exports, "EventBus", { get() { return require("./core/EventBus"); } });

// ── foundation ──
Object.defineProperty(exports, "EventStore", { get() { return require("./foundation/EventStore"); } });

// ── core ──
Object.defineProperty(exports, "EventTypes", { get() { return require("./core/EventTypes"); } });

// ── capabilities ──
Object.defineProperty(exports, "FileProcessor", { get() { return require("./capabilities/FileProcessor"); } });

// ── revolution ──
Object.defineProperty(exports, "FormalPlanner", { get() { return require("./revolution/FormalPlanner"); } });

// ── intelligence ──
Object.defineProperty(exports, "GenericWorker", { get() { return require("./intelligence/GenericWorker"); } });

// ── planning ──
Object.defineProperty(exports, "GoalStack", { get() { return require("./planning/GoalStack"); } });

// ── foundation ──
Object.defineProperty(exports, "GraphStore", { get() { return require("./foundation/GraphStore"); } });

// ── autonomy ──
Object.defineProperty(exports, "HealthMonitor", { get() { return require("./autonomy/HealthMonitor"); } });

// ── organism ──
Object.defineProperty(exports, "Homeostasis", { get() { return require("./organism/Homeostasis"); } });

// ── capabilities ──
Object.defineProperty(exports, "HotReloader", { get() { return require("./capabilities/HotReloader"); } });

// ── revolution ──
Object.defineProperty(exports, "HTNPlanner", { get() { return require("./revolution/HTNPlanner"); } });

// ── autonomy ──
Object.defineProperty(exports, "IdleMind", { get() { return require("./autonomy/IdleMind"); } });

// ── intelligence ──
Object.defineProperty(exports, "IntentRouter", { get() { return require("./intelligence/IntentRouter"); } });

// ── core ──
Object.defineProperty(exports, "IntervalManager", { get() { return require("./core/IntervalManager"); } });

// ── foundation ──
Object.defineProperty(exports, "KnowledgeGraph", { get() { return require("./foundation/KnowledgeGraph"); } });

// ── core ──
Object.defineProperty(exports, "Language", { get() { return require("./core/Language"); } });

// ── hexagonal ──
Object.defineProperty(exports, "LearningService", { get() { return require("./hexagonal/LearningService"); } });

// ── core ──
Object.defineProperty(exports, "Logger", { get() { return require("./core/Logger"); } });

// ── capabilities ──
Object.defineProperty(exports, "McpClient", { get() { return require("./capabilities/McpClient"); } });
Object.defineProperty(exports, "McpServer", { get() { return require("./capabilities/McpServer"); } });
Object.defineProperty(exports, "McpServerToolBridge", { get() { return require("./capabilities/McpServerToolBridge"); } });
Object.defineProperty(exports, "McpTransport", { get() { return require("./capabilities/McpTransport"); } });

// ── planning ──
Object.defineProperty(exports, "MetaLearning", { get() { return require("./planning/MetaLearning"); } });

// ── foundation ──
Object.defineProperty(exports, "ModelBridge", { get() { return require("./foundation/ModelBridge"); } });

// ── revolution ──
Object.defineProperty(exports, "ModelRouter", { get() { return require("./revolution/ModelRouter"); } });
Object.defineProperty(exports, "ModuleRegistry", { get() { return require("./revolution/ModuleRegistry"); } });
Object.defineProperty(exports, "MultiFileRefactor", { get() { return require("./revolution/MultiFileRefactor"); } });
Object.defineProperty(exports, "NativeToolUse", { get() { return require("./revolution/NativeToolUse"); } });

// ── organism ──
Object.defineProperty(exports, "NeedsSystem", { get() { return require("./organism/NeedsSystem"); } });
Object.defineProperty(exports, "HomeostasisEffectors", { get() { return require("./organism/HomeostasisEffectors"); } });
Object.defineProperty(exports, "Metabolism", { get() { return require("./organism/Metabolism"); } });
Object.defineProperty(exports, "ImmuneSystem", { get() { return require("./organism/ImmuneSystem"); } });
Object.defineProperty(exports, "BodySchema", { get() { return require("./organism/BodySchema"); } });
Object.defineProperty(exports, "EmbodiedPerception", { get() { return require("./organism/EmbodiedPerception"); } });
Object.defineProperty(exports, "EmotionalSteering", { get() { return require("./organism/EmotionalSteering"); } });

// ── hexagonal ──
Object.defineProperty(exports, "PeerNetwork", { get() { return require("./hexagonal/PeerNetwork"); } });

// ── intelligence ──
Object.defineProperty(exports, "PromptBuilder", { get() { return require("./intelligence/PromptBuilder"); } });

// ── foundation ──
Object.defineProperty(exports, "PromptEngine", { get() { return require("./foundation/PromptEngine"); } });

// ── intelligence ──
Object.defineProperty(exports, "ReasoningEngine", { get() { return require("./intelligence/ReasoningEngine"); } });

// ── planning ──
Object.defineProperty(exports, "Reflector", { get() { return require("./planning/Reflector"); } });

// ── foundation ──
Object.defineProperty(exports, "Sandbox", { get() { return require("./foundation/Sandbox"); } });
Object.defineProperty(exports, "SelfModel", { get() { return require("./foundation/SelfModel"); } });

// ── hexagonal ──
Object.defineProperty(exports, "SelfModificationPipeline", { get() { return require("./hexagonal/SelfModificationPipeline"); } });

// ── planning ──
Object.defineProperty(exports, "SelfOptimizer", { get() { return require("./planning/SelfOptimizer"); } });

// ── revolution ──
Object.defineProperty(exports, "SessionPersistence", { get() { return require("./revolution/SessionPersistence"); } });

// ── foundation ──
Object.defineProperty(exports, "Settings", { get() { return require("./foundation/Settings"); } });

// ── capabilities ──
Object.defineProperty(exports, "ShellAgent", { get() { return require("./capabilities/ShellAgent"); } });
Object.defineProperty(exports, "SkillManager", { get() { return require("./capabilities/SkillManager"); } });

// ── planning ──
Object.defineProperty(exports, "SolutionAccumulator", { get() { return require("./planning/SolutionAccumulator"); } });

// ── foundation ──
Object.defineProperty(exports, "StorageService", { get() { return require("./foundation/StorageService"); } });

// ── hexagonal ──
Object.defineProperty(exports, "TaskDelegation", { get() { return require("./hexagonal/TaskDelegation"); } });

// ── capabilities ──
Object.defineProperty(exports, "ToolBootstrap", { get() { return require("./capabilities/ToolBootstrap"); } });

// ── intelligence ──
Object.defineProperty(exports, "ToolRegistry", { get() { return require("./intelligence/ToolRegistry"); } });

// ── foundation ──
Object.defineProperty(exports, "UncertaintyGuard", { get() { return require("./foundation/UncertaintyGuard"); } });

// ── hexagonal ──
Object.defineProperty(exports, "UnifiedMemory", { get() { return require("./hexagonal/UnifiedMemory"); } });

// ── core ──
Object.defineProperty(exports, "utils", { get() { return require("./core/utils"); } });

// ── revolution ──
Object.defineProperty(exports, "VectorMemory", { get() { return require("./revolution/VectorMemory"); } });

// ── intelligence ──
Object.defineProperty(exports, "VerificationEngine", { get() { return require("./intelligence/VerificationEngine"); } });

// ── foundation ──
Object.defineProperty(exports, "WebFetcher", { get() { return require("./foundation/WebFetcher"); } });

// ── intelligence ──
Object.defineProperty(exports, "WorkerPool", { get() { return require("./intelligence/WorkerPool"); } });

// ── foundation ──
Object.defineProperty(exports, "WorldState", { get() { return require("./foundation/WorldState"); } });

// ── awareness (v7.6.0: replaces Phase 13 consciousness) ──
Object.defineProperty(exports, "AwarenessPort", { get() { return require("./ports/AwarenessPort"); } });
Object.defineProperty(exports, "NullAwareness", { get() { return require("./foundation/NullAwareness"); } });

// ── root ──
Object.defineProperty(exports, "AgentCore", { get() { return require("./AgentCore"); } });
Object.defineProperty(exports, "ContainerManifest", { get() { return require("./ContainerManifest"); } });
