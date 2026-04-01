// ============================================================
// GENESIS — backends/index.js (v4.10.0)
// Re-exports all backend implementations.
// ============================================================

const { OllamaBackend } = require('./OllamaBackend');
const { AnthropicBackend } = require('./AnthropicBackend');
const { OpenAIBackend } = require('./OpenAIBackend');
const { MockBackend } = require('./MockBackend');

module.exports = { OllamaBackend, AnthropicBackend, OpenAIBackend, MockBackend };
