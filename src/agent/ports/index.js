// ============================================================
// GENESIS — ports/index.js
// Barrel export for all hexagonal port interfaces + adapters.
// ============================================================

const { LLMPort, ModelBridgeAdapter, MockLLM } = require('./LLMPort');
const { MemoryPort, ConversationMemoryAdapter, MockMemory } = require('./MemoryPort');
const { KnowledgePort, KnowledgeGraphAdapter, MockKnowledge } = require('./KnowledgePort');
const { SandboxPort, SandboxAdapter, MockSandbox } = require('./SandboxPort');
const { CodeSafetyPort, CodeSafetyAdapter, MockCodeSafety } = require('./CodeSafetyPort');

module.exports = {
  // Interfaces
  LLMPort, MemoryPort, KnowledgePort, SandboxPort, CodeSafetyPort,
  // Adapters
  ModelBridgeAdapter, ConversationMemoryAdapter, KnowledgeGraphAdapter, SandboxAdapter, CodeSafetyAdapter,
  // Mocks (for tests)
  MockLLM, MockMemory, MockKnowledge, MockSandbox, MockCodeSafety,
};
