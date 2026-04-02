// ============================================================
// GENESIS - backends/MockBackend.js (v4.10.0)
//
// Deterministic LLM mock for testing modules that depend on
// ModelBridge: ChatOrchestrator, AgentLoop, DreamCycle,
// SelfNarrative, IntentRouter, FormalPlanner.
//
// MODES:
//   1. Echo:    Returns the user's last message (default)
//   2. Scripted: Returns pre-configured responses in sequence
//   3. JSON:    Returns valid JSON for chatStructured() tests
//   4. Error:   Always throws (for failover/circuit-breaker tests)
//
// Usage in tests:
//   const { MockBackend } = require('../src/agent/foundation/backends/MockBackend');
//   const mock = new MockBackend({ mode: 'scripted', responses: ['Hello', 'World'] });
//
//   const { ModelBridge } = require('../src/agent/foundation/ModelBridge');
//   const bridge = new ModelBridge();
//   bridge.backends.ollama = mock;
//   bridge.activeBackend = 'ollama';
//   bridge.activeModel = 'mock';
//   bridge.availableModels = [{ name: 'mock', backend: 'ollama' }];
//
//   const result = await bridge.chat('system', [{ role: 'user', content: 'hi' }]);
//   // result === 'Hello' (first scripted response)
// ============================================================

class MockBackend {
  /**
   * @param {object} [options]
   * @param {'echo'|'scripted'|'json'|'error'} [options.mode='echo']
   * @param {string[]} [options.responses] - For 'scripted' mode
   * @param {object[]} [options.jsonResponses] - For 'json' mode
   * @param {string} [options.errorMessage] - For 'error' mode
   * @param {number} [options.latencyMs=0] - Simulated latency
   */
  constructor(options = {}) {
    this.name = 'Mock';
    this.type = 'mock';
    this.baseUrl = 'mock://localhost';
    this.defaultModel = 'mock-model';

    this._mode = options.mode || 'echo';
    this._responses = options.responses || [];
    this._jsonResponses = options.jsonResponses || [];
    this._errorMessage = options.errorMessage || 'Mock backend error';
    this._latencyMs = options.latencyMs || 0;
    this._callIndex = 0;

    // Call history for assertions
    this.calls = [];
  }

  isConfigured() { return true; }

  configure() { /* no-op for mock */ }

  getModels() {
    return [{ name: 'mock-model', backend: 'mock', size: 0, quantization: 'mock' }];
  }

  async listModels() {
    return this.getModels();
  }

  async chat(systemPrompt, messages, temperature, modelName) {
    if (this._latencyMs > 0) {
      await new Promise(r => setTimeout(r, this._latencyMs));
    }

    this.calls.push({
      method: 'chat',
      systemPrompt,
      messages: [...messages],
      temperature,
      modelName,
      timestamp: Date.now(),
    });

    switch (this._mode) {
      case 'echo': {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        return lastUser?.content || '[no user message]';
      }
      case 'scripted': {
        const response = this._responses[this._callIndex % this._responses.length];
        this._callIndex++;
        return response || '[no scripted response]';
      }
      case 'json': {
        const jsonResp = this._jsonResponses[this._callIndex % this._jsonResponses.length];
        this._callIndex++;
        return JSON.stringify(jsonResp || { mock: true });
      }
      case 'error':
        throw new Error(this._errorMessage);
      default:
        return 'mock response';
    }
  }

  async stream(systemPrompt, messages, onChunk, abortSignal, temperature, modelName) {
    this.calls.push({
      method: 'stream',
      systemPrompt,
      messages: [...messages],
      temperature,
      modelName,
      timestamp: Date.now(),
    });

    const response = await this.chat(systemPrompt, messages, temperature, modelName);
    // Remove the duplicate chat call from history
    this.calls.pop();

    // Simulate token-by-token streaming
    const words = response.split(' ');
    for (const word of words) {
      if (abortSignal?.aborted) break;
      if (this._latencyMs > 0) {
        await new Promise(r => setTimeout(r, Math.min(this._latencyMs, 10)));
      }
      onChunk(word + ' ');
    }
  }

  // ── Test Utilities ──────────────────────────────────────

  /** Reset call history and response index */
  reset() {
    this.calls = [];
    this._callIndex = 0;
  }

  /** Get the Nth call (0-indexed) */
  getCall(n) {
    return this.calls[n] || null;
  }

  /** Get the last call */
  get lastCall() {
    return this.calls[this.calls.length - 1] || null;
  }

  /** How many times was chat/stream called? */
  get callCount() {
    return this.calls.length;
  }

  /** Set new scripted responses */
  setResponses(responses) {
    this._responses = responses;
    this._callIndex = 0;
  }

  /** Switch mode */
  setMode(mode) {
    this._mode = mode;
    this._callIndex = 0;
  }
}

module.exports = { MockBackend };
