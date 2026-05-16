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
   * @param {'echo'|'scripted'|'json'|'error'|'chunked'} [options.mode='echo']
   * @param {string[]} [options.responses] - For 'scripted' mode
   * @param {object[]} [options.jsonResponses] - For 'json' mode
   * @param {object[]} [options.chunkedScripts] - For 'chunked' mode (v7.8.9).
   *   Each script: { chunks: string[], delayMs?: number, doneReason?: string|null, terminateAt?: number|null }
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
    this._chunkedScripts = options.chunkedScripts || [];
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

  async chat(systemPrompt, messages, temperature, modelName, maxTokens) {
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

  async stream(systemPrompt, messages, onChunk, abortSignal, temperature, modelName, maxTokens, onDone) {
    this.calls.push({
      method: 'stream',
      systemPrompt,
      messages: [...messages],
      temperature,
      modelName,
      maxTokens,
      timestamp: Date.now(),
    });

    // v7.8.9 (llm-resilience-v789 contract): chunked mode for precise stream tests.
    // Lets a test specify exact chunks, inter-chunk delays, and a done_reason
    // (including null to simulate TCP-drop where no terminal chunk arrives).
    if (this._mode === 'chunked') {
      const script = this._chunkedScripts[this._callIndex % this._chunkedScripts.length];
      this._callIndex++;
      if (!script) {
        if (typeof onDone === 'function') onDone('stop');
        return;
      }
      const { chunks = [], delayMs = 0, doneReason = 'stop', terminateAt = null } = script;
      for (let i = 0; i < chunks.length; i++) {
        if (abortSignal?.aborted) {
          if (typeof onDone === 'function') onDone('abort');
          return;
        }
        if (terminateAt !== null && i === terminateAt) {
          // Simulate TCP-drop: no further chunks, no terminal chunk, no onDone
          // (matches OllamaBackend behavior on abort/timeout)
          if (typeof onDone === 'function') onDone(null);
          return;
        }
        if (delayMs > 0) {
          await new Promise(r => setTimeout(r, delayMs));
        }
        onChunk(chunks[i]);
      }
      if (typeof onDone === 'function') onDone(doneReason);
      return;
    }

    const response = await this.chat(systemPrompt, messages, temperature, modelName);
    // Remove the duplicate chat call from history
    this.calls.pop();

    // Simulate token-by-token streaming
    const words = response.split(' ');
    for (const word of words) {
      if (abortSignal?.aborted) {
        if (typeof onDone === 'function') onDone('abort');
        return;
      }
      if (this._latencyMs > 0) {
        await new Promise(r => setTimeout(r, Math.min(this._latencyMs, 10)));
      }
      onChunk(word + ' ');
    }
    if (typeof onDone === 'function') onDone('stop');
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

  /** v7.8.9: Set chunked-mode scripts and switch into 'chunked' mode. */
  setChunkedScripts(scripts) {
    this._chunkedScripts = Array.isArray(scripts) ? scripts : [scripts];
    this._mode = 'chunked';
    this._callIndex = 0;
  }

  /** Switch mode */
  setMode(mode) {
    this._mode = mode;
    this._callIndex = 0;
  }
}

module.exports = { MockBackend };
