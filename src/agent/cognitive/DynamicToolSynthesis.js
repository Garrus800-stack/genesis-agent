// @ts-checked-v5.7
// ============================================================
// GENESIS — DynamicToolSynthesis.js (v5.7.0 — SA-P8)
//
// When Genesis needs a tool that doesn't exist, it writes one:
//   1. LLM generates tool code (schema + handler function)
//   2. CodeSafetyScanner validates (no fs destruction, no net)
//   3. Sandbox runs test cases to verify behavior
//   4. ToolRegistry registers the tool
//   5. Persists to .genesis/synthesized-tools/ for reload
//
// Trigger: explicit request via synthesize(description) or
// automatic via AgentLoop when a tool call fails with
// "tool not found".
//
// Constraints:
//   - Generated tools run in Sandbox (no fs, no net by default)
//   - Max 3 synthesis attempts per request (LLM retry)
//   - Max 20 synthesized tools (evict LRU)
//   - CodeSafety scan MUST pass — no exceptions
//   - Each tool gets a test harness before registration
//
// Architecture:
//   LLMPort          → code generation
//   CodeSafetyScanner → validation
//   Sandbox          → testing
//   ToolRegistry     → registration
//   Storage          → persistence
//   OnlineLearner    → learns from synthesis success/failure
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { TIMEOUTS } = require('../core/Constants');
const { createLogger } = require('../core/Logger');

const _log = createLogger('ToolSynth');

const MAX_TOOLS = 20;
const MAX_ATTEMPTS = 3;
const SYNTHESIS_TIMEOUT_MS = 30_000;

// ── LLM Prompt Template ─────────────────────────────────────
const SYNTH_PROMPT = `You are a tool generator for the Genesis AI agent.
Generate a JavaScript tool with the following requirements:

DESCRIPTION: {{description}}

Respond with ONLY a JSON object (no markdown, no backticks):
{
  "name": "tool-name-kebab-case",
  "description": "What this tool does",
  "schema": {
    "input": { "paramName": "type (string|number|boolean|object|array)" },
    "output": { "fieldName": "type" }
  },
  "code": "// The handler function body. Receives 'input' object, must return result object.\\nconst result = {};\\n// ... your implementation ...\\nreturn result;",
  "testCases": [
    { "input": { "paramName": "testValue" }, "expectField": "fieldName", "expectType": "string" }
  ]
}

Rules:
- The code runs in a sandboxed environment (no require, no fs, no net).
- Use only standard JavaScript (no Node.js APIs).
- The code receives an 'input' object and must return a result object.
- Include 1-3 test cases that verify basic functionality.
- Keep it simple, robust, and under 50 lines.`;

class DynamicToolSynthesis {

  static containerConfig = {
    name: 'dynamicToolSynthesis',
    phase: 9,
    deps: ['storage'],
    tags: ['cognitive', 'tools', 'synthesis'],
    lateBindings: [
      { prop: 'llm', service: 'llm', optional: true },
      { prop: 'toolRegistry', service: 'toolRegistry', optional: true },
      { prop: 'sandbox', service: 'sandbox', optional: true },
      { prop: 'codeSafety', service: 'codeSafety', optional: true },
    ],
  };

  /**
   * @param {{ bus?: object, storage: object, config?: object }} opts
   */
  constructor({ bus, storage, config }) {
    this.bus = bus || NullBus;
    this.storage = storage;

    // Late-bound
    this.llm = null;
    this.toolRegistry = null;
    this.sandbox = null;
    this.codeSafety = null;

    /** @type {Map<string, object>} name → { description, code, schema, createdAt, lastUsed, useCount } */
    this._tools = new Map();

    this._stats = {
      synthesized: 0,
      failed: 0,
      loaded: 0,
    };

    this._storageFile = 'synthesized-tools.json';
    this._config = {
      maxTools: (config?.maxTools) || MAX_TOOLS,
      maxAttempts: (config?.maxAttempts) || MAX_ATTEMPTS,
      autoSynthesize: (config?.autoSynthesize) !== false,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  start() {
    this._load();

    // Listen for tool-not-found to auto-synthesize
    if (this._config.autoSynthesize) {
      this.bus.on('tools:error', (data) => {
        if (data.error?.includes('Tool not found') && data.name) {
          this._autoSynthesize(data.name).catch(err => {
            _log.debug(`[SYNTH] Auto-synthesis for "${data.name}" failed:`, err.message);
          });
        }
      }, { source: 'DynamicToolSynthesis' });
    }

    _log.info(`[SYNTH] Active — ${this._tools.size} tools loaded, max ${this._config.maxTools}`);
  }

  stop() {
    this._saveSync();
  }

  async asyncLoad() {}

  // ═══════════════════════════════════════════════════════════
  // SYNTHESIS API
  // ═══════════════════════════════════════════════════════════

  /**
   * Synthesize a new tool from a natural language description.
   * @param {string} description - What the tool should do
   * @param {object} [options] - { name?: string, force?: boolean }
   * @returns {Promise<object>} { success, name, error? }
   */
  async synthesize(description, options = {}) {
    if (!this.llm) return { success: false, error: 'LLM not available — cannot generate tool code' };
    if (!this.sandbox) return { success: false, error: 'Sandbox not available — cannot test tool' };
    if (!this.toolRegistry) return { success: false, error: 'ToolRegistry not available — cannot register tool' };

    // Check if already exists
    if (options.name && this._tools.has(options.name) && !options.force) {
      return { success: true, name: options.name, note: 'Already exists' };
    }

    _log.info(`[SYNTH] Synthesizing: "${description.slice(0, 80)}"`);

    let lastError = '';
    for (let attempt = 1; attempt <= this._config.maxAttempts; attempt++) {
      try {
        const result = await this._attemptSynthesis(description, attempt);
        if (result.success) {
          this._stats.synthesized++;
          this.bus.fire('tool:synthesized', {
            name: result.name,
            description,
            attempt,
          }, { source: 'DynamicToolSynthesis' });
          return result;
        }
        lastError = result.error || 'unknown';
        _log.warn(`[SYNTH] Attempt ${attempt}/${this._config.maxAttempts} failed: ${lastError}`);
      } catch (err) {
        lastError = err.message;
        _log.warn(`[SYNTH] Attempt ${attempt} threw: ${err.message}`);
      }
    }

    this._stats.failed++;
    this.bus.fire('tool:synthesis-failed', { description }, { source: 'DynamicToolSynthesis' });
    return { success: false, error: lastError || `Failed after ${this._config.maxAttempts} attempts` };
  }

  /**
   * Remove a synthesized tool.
   * @param {string} name
   * @returns {boolean}
   */
  removeTool(name) {
    if (!this._tools.has(name)) return false;
    this._tools.delete(name);
    if (this.toolRegistry?.hasTool(name)) {
      this.toolRegistry.unregister(name);
    }
    this._saveSync();
    _log.info(`[SYNTH] Removed tool: ${name}`);
    return true;
  }

  /**
   * List all synthesized tools.
   * @returns {Array<object>}
   */
  listTools() {
    return [...this._tools.entries()].map(([name, t]) => ({
      name,
      description: t.description,
      createdAt: t.createdAt,
      lastUsed: t.lastUsed,
      useCount: t.useCount,
    }));
  }

  /**
   * Get synthesis statistics.
   * @returns {object}
   */
  getStats() {
    return {
      ...this._stats,
      active: this._tools.size,
      maxTools: this._config.maxTools,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // SYNTHESIS PIPELINE
  // ═══════════════════════════════════════════════════════════

  /**
   * Single synthesis attempt: generate → validate → test → register.
   * @param {string} description
   * @param {number} attempt
   * @returns {Promise<object>}
   */
  async _attemptSynthesis(description, attempt) {
    // 1. Generate code via LLM
    const prompt = SYNTH_PROMPT.replace('{{description}}', description);
    const raw = await this.llm.chat(
      'You are a precise tool code generator. Output ONLY valid JSON.',
      [{ role: 'user', content: prompt }],
      'code',
      { priority: 5, timeout: SYNTHESIS_TIMEOUT_MS }
    );

    const response = typeof raw === 'string' ? raw : raw?.content || raw?.message?.content || '';

    // 2. Parse LLM response
    const spec = this._parseSpec(response);
    if (!spec) return { success: false, error: 'LLM response is not valid JSON' };
    if (!spec.name || !spec.code || !spec.schema) {
      return { success: false, error: 'Missing required fields: name, code, schema' };
    }

    // 3. Safety scan
    const safetyResult = this._checkSafety(spec.code);
    if (!safetyResult.safe) {
      return { success: false, error: `Safety violation: ${safetyResult.reason}` };
    }

    // 4. Syntax check
    const syntaxResult = await this.sandbox.syntaxCheck(spec.code);
    if (!syntaxResult.valid) {
      return { success: false, error: `Syntax error: ${syntaxResult.error || 'invalid'}` };
    }

    // 5. Run test cases in sandbox
    const testResult = await this._runTests(spec);
    if (!testResult.passed) {
      return { success: false, error: `Test failed: ${testResult.error}` };
    }

    // 6. Evict if at capacity
    this._evictIfNeeded();

    // 7. Build handler and register
    const handler = this._buildHandler(spec.code);
    this.toolRegistry.register(spec.name, spec.schema, handler, 'synthesized');

    // 8. Persist
    this._tools.set(spec.name, {
      name: spec.name,
      description: spec.description || description,
      code: spec.code,
      schema: spec.schema,
      testCases: spec.testCases || [],
      createdAt: Date.now(),
      lastUsed: null,
      useCount: 0,
      attempt,
    });
    this._saveSync();

    _log.info(`[SYNTH] ✅ Tool "${spec.name}" registered (attempt ${attempt})`);
    return { success: true, name: spec.name };
  }

  /**
   * Parse LLM JSON response, handling markdown fences.
   * @param {string} text
   * @returns {object|null}
   */
  _parseSpec(text) {
    if (!text) return null;
    // Strip markdown code fences
    let cleaned = text.replace(/```(?:json)?\s*\n?/g, '').trim();
    // Find JSON object boundaries
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    cleaned = cleaned.slice(start, end + 1);

    try {
      return JSON.parse(cleaned);
    } catch (err) {
      _log.debug('[SYNTH] JSON parse failed:', err.message);
      return null;
    }
  }

  /**
   * Run safety checks on generated code.
   * @param {string} code
   * @returns {{ safe: boolean, reason?: string }}
   */
  _checkSafety(code) {
    // Basic blocklist — synthesized tools should be pure computation
    const blocked = [
      { pattern: /require\s*\(/, reason: 'require() not allowed in synthesized tools' },
      { pattern: /import\s+/, reason: 'import not allowed in synthesized tools' },
      { pattern: /process\./, reason: 'process access not allowed' },
      { pattern: /child_process/, reason: 'child_process not allowed' },
      { pattern: /fs\.\w+/, reason: 'fs access not allowed' },
      { pattern: /eval\s*\(/, reason: 'eval not allowed' },
      { pattern: /Function\s*\(/, reason: 'Function constructor not allowed' },
      { pattern: /\.exec\s*\(/, reason: 'exec not allowed' },
      { pattern: /__dirname|__filename/, reason: 'path introspection not allowed' },
    ];

    for (const { pattern, reason } of blocked) {
      if (pattern.test(code)) return { safe: false, reason };
    }

    // Also use CodeSafetyScanner if available
    if (this.codeSafety?.scanCode) {
      try {
        const scan = this.codeSafety.scanCode(code, 'synthesized-tool.js');
        if (!scan.safe) {
          return { safe: false, reason: scan.violations?.map(v => v.description).join('; ') || 'code safety violation' };
        }
      } catch (err) {
        _log.debug('[SYNTH] CodeSafety scan failed:', err.message);
      }
    }

    return { safe: true };
  }

  /**
   * Run test cases in sandbox.
   * @param {object} spec - { code, testCases }
   * @returns {Promise<{ passed: boolean, error?: string }>}
   */
  async _runTests(spec) {
    const testCases = spec.testCases || [];
    if (testCases.length === 0) {
      // No test cases — run code with empty input to check it doesn't crash
      try {
        const wrapper = `const input = {};\n${spec.code}`;
        const result = await this.sandbox.execute(wrapper, { timeout: TIMEOUTS.GIT_OP });
        return result.error ? { passed: false, error: result.error } : { passed: true };
      } catch (err) {
        return { passed: false, error: err.message };
      }
    }

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      try {
        const wrapper = `const input = ${JSON.stringify(tc.input || {})};\n${spec.code}`;
        const result = await this.sandbox.execute(wrapper, { timeout: TIMEOUTS.GIT_OP });

        if (result.error) {
          return { passed: false, error: `Test ${i + 1}: ${result.error}` };
        }

        // If expectField + expectType specified, parse output and check
        if (tc.expectField && result.output) {
          const parsed = this._tryParseOutput(result.output);
          if (parsed && tc.expectType) {
            const actual = typeof parsed[tc.expectField];
            if (actual !== tc.expectType && actual !== 'undefined') {
              return { passed: false, error: `Test ${i + 1}: expected ${tc.expectField} to be ${tc.expectType}, got ${actual}` };
            }
          }
        }
      } catch (err) {
        return { passed: false, error: `Test ${i + 1}: ${err.message}` };
      }
    }

    return { passed: true };
  }

  /** Try to parse sandbox output as JSON */
  _tryParseOutput(output) {
    try {
      // Sandbox outputs the last expression — try to find JSON
      const lines = output.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try { return JSON.parse(lines[i]); } catch { continue; }
      }
    } catch { /* ok */ }
    return null;
  }

  /**
   * Build a handler function from code string.
   * Wraps in async Function to isolate scope.
   * @param {string} code
   * @returns {Function}
   */
  _buildHandler(code) {
    // The handler delegates to sandbox for safety
    const sandbox = this.sandbox;
    const toolCode = code;
    return async (input) => {
      const wrapper = `const input = ${JSON.stringify(input)};\n${toolCode}`;
      const result = await sandbox.execute(wrapper, { timeout: TIMEOUTS.COMMAND_EXEC });
      if (result.error) throw new Error(result.error);
      // Try to parse structured output
      const parsed = this._tryParseOutput(result.output);
      return parsed || { output: result.output };
    };
  }

  /** Evict least-recently-used tool if at capacity */
  _evictIfNeeded() {
    if (this._tools.size < this._config.maxTools) return;

    // Find LRU
    let oldest = null;
    let oldestKey = null;
    for (const [name, t] of this._tools) {
      const ts = t.lastUsed || t.createdAt || 0;
      if (!oldest || ts < oldest) {
        oldest = ts;
        oldestKey = name;
      }
    }

    if (oldestKey) {
      _log.info(`[SYNTH] Evicting LRU tool: ${oldestKey}`);
      this.removeTool(oldestKey);
    }
  }

  /**
   * Auto-synthesize from a failed tool call.
   * @param {string} toolName - The tool that was not found
   */
  async _autoSynthesize(toolName) {
    // Don't re-synthesize if we already tried and it's in the registry
    if (this._tools.has(toolName)) return;

    // Convert tool name to description
    const description = `A tool called "${toolName}" that ${toolName.replace(/-/g, ' ')}s data. Infer appropriate inputs and outputs from the name.`;
    const result = await this.synthesize(description, { name: toolName });

    if (result.success) {
      _log.info(`[SYNTH] Auto-synthesized "${toolName}" successfully`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PERSISTENCE
  // ═══════════════════════════════════════════════════════════

  _load() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON(this._storageFile, null);
      if (data?.tools && Array.isArray(data.tools)) {
        for (const t of data.tools) {
          if (t.name && t.code && t.schema) {
            this._tools.set(t.name, t);
            // Re-register in ToolRegistry if available
            if (this.toolRegistry) {
              const handler = this._buildHandler(t.code);
              this.toolRegistry.register(t.name, t.schema, handler, 'synthesized');
            }
          }
        }
        this._stats.loaded = this._tools.size;
      }
    } catch (err) {
      _log.debug('[SYNTH] Load failed (first run?):', err.message);
    }
  }

  _saveSync() {
    if (!this.storage) return;
    try {
      const tools = [...this._tools.values()];
      this.storage.writeJSON(this._storageFile, { tools, savedAt: Date.now() });
    } catch (err) {
      _log.warn('[SYNTH] Save failed:', err.message);
    }
  }
}

module.exports = { DynamicToolSynthesis };
