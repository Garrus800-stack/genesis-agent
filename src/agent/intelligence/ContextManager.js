// @ts-checked-v5.6
// ============================================================
// GENESIS AGENT — ContextManager.js
// Smart context windowing. THE critical piece for making
// small models (7-9B) perform like large ones.
//
// The trick: a 9B model with perfect context beats a 70B
// model with noisy context. This module ensures every token
// in the context window EARNS its place.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('ContextManager');

class ContextManager {
  constructor(model, selfModel, memory, bus, lang) {
    this.bus = bus || NullBus;
    this.model = model;
    this.selfModel = selfModel;
    this.memory = memory;
    // FIX v3.5.4: Use Language.js estimateTokens() for more accurate estimation
    // (character-class-aware: German ~3.2, code ~3.5, punctuation ~1)
    this.lang = lang || null;

    // v4.10.0: DynamicContextBudget — set via late-binding or manually
    this._dynamicBudget = null;
    this._activeGoalCount = 0;

    // Context budget (conservative for small models)
    this.config = {
      maxContextTokens: 6000,   // Leave headroom for response
      budgets: {
        system: 800,             // System prompt + personality
        memory: 600,             // Past conversations + facts
        code: 2500,              // Code context (largest chunk)
        conversation: 1500,      // Recent chat history
        tools: 400,              // Tool descriptions
        reserved: 200,           // Safety margin
      },
      compressionThreshold: 0.8, // Compress when >80% budget used
    };
  }

  /**
   * Build an optimized context window for a given task
   * @param {object} params
   * @param {string} params.task - Current user message
   * @param {string} params.intent - Detected intent type
   * @param {Array} params.history - Conversation history
   * @param {string} params.systemPrompt - Base system prompt
   * @param {string} params.toolPrompt - Tool descriptions
   * @returns {{ system: string, messages: Array, stats: object }}
   */
  build({ task, intent, history = [], systemPrompt = '', toolPrompt = '' }) {
    const stats = { total: 0, allocations: {} };

    // v4.10.0: Use DynamicContextBudget if available for intent-based allocation
    let budgets = this.config.budgets;
    if (this._dynamicBudget) {
      try {
        budgets = this._dynamicBudget.allocate(intent || 'general', {
          totalBudget: this.config.maxContextTokens,
          activeGoals: this._activeGoalCount || 0,
          hasCode: ['self-inspect', 'self-modify', 'self-repair', 'analyze-code', 'code-gen'].includes(intent),
        });
      } catch (_e) { console.debug('[catch] fallback to static budgets:', _e.message); }
    }

    // ── 1. System prompt (always included, trimmed if needed) ──
    const system = this._fitToBudget(systemPrompt, budgets.system);
    stats.allocations.system = this._estimateTokens(system);

    // ── 2. Memory context (relevant to current task) ──
    let memoryBlock = '';
    if (this.memory) {
      memoryBlock = this._buildMemoryContext(task, intent);
      memoryBlock = this._fitToBudget(memoryBlock, budgets.memory);
    }
    stats.allocations.memory = this._estimateTokens(memoryBlock);

    // ── 3. Code context (only for code-related intents) ──
    let codeBlock = '';
    if (['self-inspect', 'self-modify', 'self-repair', 'analyze-code'].includes(intent)) {
      codeBlock = this._buildCodeContext(task, intent);
      codeBlock = this._fitToBudget(codeBlock, budgets.code);
    }
    stats.allocations.code = this._estimateTokens(codeBlock);

    // ── 4. Tool descriptions (only if tools exist) ──
    const tools = this._fitToBudget(toolPrompt, budgets.tools);
    stats.allocations.tools = this._estimateTokens(tools);

    // ── 5. Conversation history (compressed to fit) ──
    const usedTokens = Object.values(stats.allocations).reduce((a, b) => a + b, 0);
    const remainingBudget = this.config.maxContextTokens - usedTokens - (budgets.reserved || this.config.budgets.reserved);
    const messages = this._compressHistory(history, Math.max(500, remainingBudget));
    stats.allocations.conversation = messages.reduce(
      (sum, m) => sum + this._estimateTokens(m.content), 0
    );

    // ── Assemble final system prompt ──
    const fullSystem = [system, memoryBlock, codeBlock, tools]
      .filter(Boolean)
      .join('\n\n');

    stats.total = Object.values(stats.allocations).reduce((a, b) => a + b, 0);
    stats.utilization = (stats.total / this.config.maxContextTokens * 100).toFixed(1) + '%';

    this.bus.fire('context:built', stats, { source: 'ContextManager' });

    return { system: fullSystem, messages, stats };
  }

  // ── Memory Context Builder ───────────────────────────────

  _buildMemoryContext(task, intent) {
    if (!this.memory) return '';
    const parts = [];

    // Episodic: relevant past conversations
    const episodes = this.memory.recallEpisodes(task, 2);
    if (episodes.length > 0) {
      parts.push('ERINNERUNGEN:');
      for (const ep of episodes) {
        parts.push(`[${ep.timestamp.split('T')[0]}] ${ep.summary.slice(0, 150)}`);
      }
    }

    // Semantic: relevant facts (top 5)
    const facts = this.memory.searchFacts(task).slice(0, 5);
    if (facts.length > 0) {
      parts.push('GELERNTE FAKTEN:');
      for (const f of facts) {
        parts.push(`${f.key}: ${f.value}`);
      }
    }

    // Procedural: relevant patterns
    const pattern = this.memory.recallPattern(task);
    if (pattern && pattern.successRate > 0.5) {
      parts.push(`BEWÄHRTES VORGEHEN: ${pattern.action} (${Math.round(pattern.successRate * 100)}% Erfolg)`);
    }

    return parts.join('\n');
  }

  // ── Code Context Builder (RAG over own codebase) ─────────

  _buildCodeContext(task, intent) {
    if (!this.selfModel) return '';

    // Identify which files/modules are relevant to the task
    const relevantModules = this._findRelevantCode(task);

    if (relevantModules.length === 0) {
      // Compact summary — don't dump every module into the LLM context
      const modules = this.selfModel.getModuleSummary();
      const categories = {};
      for (const m of modules) {
        const cat = m.file.split('/')[2] || 'other'; // e.g. 'core', 'foundation', etc.
        categories[cat] = (categories[cat] || 0) + 1;
      }
      return `ARCHITEKTUR-ÜBERSICHT: ${modules.length} Module in ${Object.keys(categories).length} Kategorien: ${
        Object.entries(categories).map(([k, v]) => `${k} (${v})`).join(', ')
      }.\nAntworte in natürlicher Sprache. Liste NICHT einzelne Module auf.`;
    }

    // Include full code of most relevant module, summaries of others
    const parts = [];
    const [primary, ...secondary] = relevantModules;

    if (primary) {
      const code = this.selfModel.readModule(primary.file);
      if (code) {
        // If a specific function is mentioned, focus on it
        const funcMatch = task.match(/(?:funktion|function|methode|method)\s+(\w+)/i);
        const focused = funcMatch
          ? this._focusOnFunction(code, funcMatch[1])
          : this._truncateCode(code, 80); // Max 80 lines
        parts.push(`RELEVANTER CODE (${primary.file}):\n\`\`\`javascript\n${focused}\n\`\`\``);
      }
    }

    if (secondary.length > 0) {
      parts.push('VERWANDTE MODULE:');
      for (const mod of secondary.slice(0, 3)) {
        parts.push(`- ${mod.file}: ${mod.description || mod.classes.join(', ')}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Find code modules relevant to a task using keyword matching
   * (This is a lightweight RAG — no embeddings needed)
   */
  _findRelevantCode(task) {
    const taskWords = task.toLowerCase()
      .replace(/[^a-zäöüß0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2);

    const modules = this.selfModel.getModuleSummary();
    const scored = modules.map(mod => {
      let score = 0;
      const modText = `${mod.file} ${mod.classes.join(' ')} ${mod.description || ''} ${(mod.requires || []).join(' ')}`.toLowerCase();

      for (const word of taskWords) {
        if (modText.includes(word)) score += 2;
        // Partial match
        if (mod.classes.some(c => c.toLowerCase().includes(word))) score += 3;
      }

      // Bonus for exact class/file name match
      for (const cls of mod.classes) {
        if (task.includes(cls)) score += 5;
      }
      if (task.includes(mod.file)) score += 5;

      return { ...mod, score };
    });

    return scored
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
  }

  // ── Conversation Compression ─────────────────────────────

  /**
   * Compress conversation history to fit within token budget.
   * Strategy:
   * 1. Always keep the latest 2 turns (current context)
   * 2. Keep system-critical messages (errors, modifications)
   * 3. Summarize older turns into one condensed message
   */
  _compressHistory(history, tokenBudget) {
    if (!history || history.length === 0) return [];

    // Always keep last 2 exchanges (4 messages)
    const recent = history.slice(-4);
    const recentTokens = recent.reduce((sum, m) => sum + this._estimateTokens(m.content), 0);

    if (recentTokens >= tokenBudget || history.length <= 4) {
      // Trim recent messages if even they exceed budget
      return this._trimMessages(recent, tokenBudget);
    }

    // Older messages: compress into summary
    const older = history.slice(0, -4);
    const remainingBudget = tokenBudget - recentTokens;

    if (older.length === 0) return recent;

    // Build a compressed summary of older messages
    const summaryParts = [];
    for (const msg of older) {
      const preview = msg.content.slice(0, 80).replace(/\n/g, ' ');
      summaryParts.push(`[${msg.role}]: ${preview}...`);
    }

    const summary = {
      role: 'system',
      content: `GESPRÄCHSVERLAUF (zusammengefasst):\n${summaryParts.join('\n')}`,
    };

    const summaryTokens = this._estimateTokens(summary.content);
    if (summaryTokens > remainingBudget) {
      // Just truncate the summary
      summary.content = summary.content.slice(0, remainingBudget * 3); // ~3 chars per token
    }

    return [summary, ...recent];
  }

  _trimMessages(messages, tokenBudget) {
    let total = 0;
    const result = [];

    // Work backwards (newest first) to keep most recent context
    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = this._estimateTokens(messages[i].content);
      if (total + tokens > tokenBudget) {
        // Truncate this message to fit
        const remaining = tokenBudget - total;
        if (remaining > 50) {
          result.unshift({
            ...messages[i],
            content: messages[i].content.slice(0, remaining * 3) + '...',
          });
        }
        break;
      }
      total += tokens;
      result.unshift(messages[i]);
    }

    return result;
  }

  // ── Utility ──────────────────────────────────────────────

  _estimateTokens(text) {
    if (!text) return 0;
    // FIX v3.5.4: Use Language.js for character-class-aware estimation
    // (~15-20% more accurate for German/code-mixed content)
    if (this.lang && typeof this.lang.estimateTokens === 'function') {
      return this.lang.estimateTokens(text);
    }
    // Fallback: German text ~3.5 chars per token
    return Math.ceil(text.length / 3.5);
  }

  _fitToBudget(text, maxTokens) {
    if (!text) return '';
    const tokens = this._estimateTokens(text);
    if (tokens <= maxTokens) return text;
    // Truncate to fit
    const maxChars = maxTokens * 3.5;
    return text.slice(0, maxChars) + '\n[... truncated]';
  }

  _truncateCode(code, maxLines) {
    const lines = code.split('\n');
    if (lines.length <= maxLines) return code;
    const half = Math.floor(maxLines / 2);
    return [
      ...lines.slice(0, half),
      `\n// ... (${lines.length - maxLines} Zeilen ausgelassen) ...\n`,
      ...lines.slice(-half),
    ].join('\n');
  }

  _focusOnFunction(code, functionName) {
    const lines = code.split('\n');
    let start = -1, end = -1, depth = 0;

    for (let i = 0; i < lines.length; i++) {
      if (start === -1 && lines[i].includes(functionName)) {
        start = Math.max(0, i - 3);
      }
      if (start !== -1) {
        depth += (lines[i].match(/{/g) || []).length;
        depth -= (lines[i].match(/}/g) || []).length;
        if (depth <= 0 && i > start + 1) { end = i + 1; break; }
      }
    }

    if (start === -1) return code.slice(0, 2000);
    end = end === -1 ? Math.min(lines.length, start + 60) : end;

    return [
      `// Zeilen ${start + 1}-${end} von ${lines.length}`,
      ...lines.slice(start, end),
    ].join('\n');
  }

  /**
   * Adjust budgets based on model capabilities
   */
  /**
   * FIX v3.5.3: Dynamic context budget scaling.
   * Previous: only maxContextTokens was scaled, sub-budgets used a linear ratio
   * that over-allocated for large models and under-allocated for small ones.
   * Now: sqrt scaling prevents over-allocation, explicit model-class matching,
   * and support for 32K/128K context windows (Anthropic, OpenAI, large Ollama).
   */
  // v5.2.0: Declarative model → context window mapping.
  // Replaces the CC=50 if/else chain with a table lookup.
  // Each entry: [pattern (string or regex), windowTokens]
  // First match wins. Order: specific models → families → context-size hints → default.
  /** @type {Array<[string|RegExp, number]>} */
  static MODEL_CONTEXT_MAP = [
    // Cloud APIs — large context
    ['claude',           128000],
    ['gpt-4',            128000],
    ['gpt-4o',           128000],
    ['deepseek',         128000],
    ['deep-seek',        128000],
    ['command-r',        128000],
    ['cohere',           128000],
    ['kimi',             128000],
    ['moonshot',         128000],
    // Context-size hints in model name
    ['128k',             131072],
    ['32k',              32768],
    // Large local models
    ['mistral-large',    32768],
    ['mistral-medium',   32768],
    ['mixtral',          32768],
    [/llama.?3.*70b/i,   128000],  // must be before generic '70b'
    ['70b',              32768],
    ['llama-3',          8192],
    ['llama3',           8192],
    // Medium local models
    [/qwen.*7b/i,        32768],
    ['qwen',             131072],
    ['qwen2',            131072],
    ['yi-',              32768],
    ['yi:',              32768],
    ['32b',              32768],
    // Small local models
    ['gemma',            8192],
    ['7b',               8192],
    ['8b',               8192],
    ['9b',               8192],
    ['13b',              8192],
    ['14b',              8192],
    ['27b',              8192],
  ];

  configureForModel(modelName) {
    const lower = (modelName || '').toLowerCase();

    // Table lookup — first match wins
    let windowTokens = 8192; // Conservative default
    for (const [pattern, tokens] of ContextManager.MODEL_CONTEXT_MAP) {
      if (typeof pattern === 'string' ? lower.includes(pattern) : pattern.test(lower)) {
        windowTokens = tokens;
        break;
      }
    }

    _log.info(`[CONTEXT] Model "${modelName}" → ${windowTokens} token window → ${Math.min(Math.round(windowTokens * 0.75), 48000)} usable`);

    // Use 75% of window for context (leave 25% for response generation)
    // v4.12.8: Raised cap from 32K to 48K. With DeepSeek/Qwen/Kimi (128K windows),
    // 32K was unnecessarily restrictive. 48K gives room for full consciousness +
    // organism + safety context without crowding conversation history.
    this.config.maxContextTokens = Math.min(Math.round(windowTokens * 0.75), 48000);

    // ── Scale sub-budgets with sqrt (diminishing returns) ──
    // Baseline: 6000 tokens for gemma2:9b (8K window)
    const BASELINE = 6000;
    const BASELINE_BUDGETS = { system: 800, memory: 600, code: 2500, conversation: 1500, tools: 400, reserved: 200 };
    const scale = Math.sqrt(this.config.maxContextTokens / BASELINE);

    for (const [key, baseValue] of Object.entries(BASELINE_BUDGETS)) {
      this.config.budgets[key] = Math.round(baseValue * scale);
    }

    // Ensure total budgets don't exceed maxContextTokens
    const totalBudget = Object.values(this.config.budgets).reduce((a, b) => a + b, 0);
    if (totalBudget > this.config.maxContextTokens) {
      const shrink = this.config.maxContextTokens / totalBudget;
      for (const key of Object.keys(this.config.budgets)) {
        this.config.budgets[key] = Math.round(this.config.budgets[key] * shrink);
      }
    }
  }
}

module.exports = { ContextManager };
