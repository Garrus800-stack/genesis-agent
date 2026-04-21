// @ts-checked-v5.9
// ============================================================
// GENESIS — ConversationCompressor.js (v5.9.7)
//
// V6-5 Context Window Manager — Overflow Protection
//
// PROBLEM: ContextManager._compressHistory() truncates old
// messages to 80 chars and drops content. This destroys
// context critical for multi-step tasks. A 7B model working
// on step 8 of a 12-step plan loses steps 1-4 entirely.
//
// SOLUTION: LLM-based summarization that preserves semantic
// content. When the conversation exceeds the budget threshold,
// older segments are summarized into compact paragraphs that
// retain decisions, code references, and task state.
//
// Architecture:
//   ContextManager.build()
//     → _compressHistory() calls ConversationCompressor
//     → compressor checks token budget
//     → if over threshold: LLM summarizes older segments
//     → returns [summary_msg, ...recent_msgs]
//
// Integration:
//   ContextManager receives compressor via late-binding.
//   Falls back to existing truncation if compressor absent.
//
// Cache: Recent summaries are cached by content hash to avoid
//   re-summarizing the same history on consecutive calls.
//
// Events:
//   context:compressed         — summary generated
//   context:overflow-prevented — budget would have been exceeded
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');

const _log = createLogger('ConversationCompressor');

// ── Summary prompt template ─────────────────────────────────
const SUMMARY_SYSTEM = `You are a conversation summarizer for an AI agent.
Condense the following conversation into a brief summary that preserves:
1. Key decisions made
2. Code files or functions mentioned (with names)
3. Current task state and progress
4. Any errors encountered and their resolutions
5. User preferences or constraints expressed

Output ONLY the summary paragraph — no preamble, no bullet points.
Keep it under 200 words. Use the same language as the conversation.`;

const CACHE_MAX = 8;

class ConversationCompressor {
  /**
   * @param {{ bus: *, model?: *, config?: object }} deps
   */
  constructor({ bus, model, config }) {
    /** @type {import('../core/EventBus').EventBus} */
    this.bus = bus;
    /** @type {*} LLM port for summarization */
    this.model = model || null;

    /** @type {{ thresholdRatio: number, minHistoryForCompression: number, recentKeep: number, maxSummaryTokens: number }} */
    this.config = {
      thresholdRatio: 0.8,           // compress when history > 80% of budget
      minHistoryForCompression: 6,   // don't compress fewer than 6 messages
      recentKeep: 4,                 // always keep last 4 messages verbatim
      maxSummaryTokens: 400,         // target summary size
      ...config,
    };

    /** @type {Map<string, { summary: string, timestamp: number }>} */
    this._cache = new Map();

    /** @type {{ compressions: number, cacheHits: number, tokensSaved: number }} */
    this.stats = { compressions: 0, cacheHits: 0, tokensSaved: 0 };
  }
  // ── Lifecycle ───────────────────────────────────────────

  boot() {
    // No event subscriptions needed — called by ContextManager
  }

  stop() {
    this._cache.clear();
  }

  // ── Core API (called by ContextManager) ─────────────────

  /**
   * Compress conversation history to fit within a token budget.
   * Returns an array of messages that fits the budget, with older
   * messages summarized if needed.
   *
   * @param {Array<{ role: string, content: string }>} history
   * @param {number} tokenBudget   available tokens for history
   * @param {{ estimateTokens: (text: string) => number }} tokenizer
   * @returns {Promise<Array<{ role: string, content: string }>>}
   */
  async compress(history, tokenBudget, tokenizer) {
    if (!history || history.length === 0) return [];

    const est = (text) => tokenizer.estimateTokens(text);

    // Always keep the most recent messages
    const keepCount = Math.min(this.config.recentKeep, history.length);
    const recent = history.slice(-keepCount);
    const recentTokens = recent.reduce((sum, m) => sum + est(m.content), 0);

    // If recent messages alone exceed budget, just trim them
    if (recentTokens >= tokenBudget || history.length <= keepCount) {
      return this._trimMessages(recent, tokenBudget, est);
    }

    const older = history.slice(0, -keepCount);
    const olderTokens = older.reduce((sum, m) => sum + est(m.content), 0);
    const totalTokens = recentTokens + olderTokens;
    const remainingBudget = tokenBudget - recentTokens;

    // Below threshold — no compression needed
    if (totalTokens <= tokenBudget || older.length < this.config.minHistoryForCompression - keepCount) {
      // Fit what we can from older messages
      return [...this._trimMessages(older, remainingBudget, est), ...recent];
    }

    // ── Compression needed ──────────────────────────────
    this.bus.emit('context:overflow-prevented', {
      totalTokens,
      budget: tokenBudget,
      messagesCompressed: older.length,
    });

    // Check cache
    const cacheKey = this._hashMessages(older);
    const cached = this._cache.get(cacheKey);
    if (cached) {
      this.stats.cacheHits++;
      const summaryMsg = { role: 'system', content: cached.summary };
      return [summaryMsg, ...recent];
    }

    // LLM-based summarization
    const summary = await this._summarize(older, remainingBudget, est);

    // Cache result
    this._cacheResult(cacheKey, summary);

    const tokensSaved = olderTokens - est(summary);
    if (tokensSaved > 0) this.stats.tokensSaved += tokensSaved;
    this.stats.compressions++;

    this.bus.emit('context:compressed', {
      originalTokens: olderTokens,
      compressedTokens: est(summary),
      messagesCompressed: older.length,
      tokensSaved: Math.max(0, tokensSaved),
    });

    const summaryMsg = { role: 'system', content: summary };
    return [summaryMsg, ...recent];
  }

  // ── Summarization ───────────────────────────────────────

  /**
   * @param {Array<{ role: string, content: string }>} messages
   * @param {number} targetTokens
   * @param {(text: string) => number} est
   * @returns {Promise<string>}
   */
  async _summarize(messages, targetTokens, est) {
    // Format messages for the LLM
    const formatted = messages.map(m =>
      `[${m.role}]: ${m.content.slice(0, 500)}`
    ).join('\n\n');

    // If no LLM available, fall back to extractive summary
    if (!this.model || typeof this.model.chat !== 'function') {
      return this._extractiveFallback(messages, targetTokens, est);
    }

    try {
      const response = await this.model.chat(
        SUMMARY_SYSTEM,
        `Summarize this conversation segment:\n\n${formatted}`,
        { maxTokens: this.config.maxSummaryTokens }
      );

      const text = typeof response === 'string'
        ? response
        : response?.content || response?.message || '';

      if (text.length > 0) {
        return `CONVERSATION SUMMARY (${messages.length} earlier messages):\n${text.trim()}`;
      }
    } catch (e) {
      _log.debug('LLM summarization failed, using extractive fallback:', e.message);
    }

    return this._extractiveFallback(messages, targetTokens, est);
  }

  /**
   * Non-LLM fallback: extract key sentences heuristically.
   * Better than the old 80-char truncation — preserves full
   * sentences that mention code, decisions, or errors.
   *
   * @param {Array<{ role: string, content: string }>} messages
   * @param {number} targetTokens
   * @param {(text: string) => number} est
   * @returns {string}
   */
  _extractiveFallback(messages, targetTokens, est) {
    const keyPhrases = /\b(function|class|file|error|decided|plan|step|created|modified|fixed|bug|feature|test)\b/i;
    const parts = [];
    let tokens = 0;
    const headerBudget = Math.min(40, Math.floor(targetTokens * 0.2));
    const availableTokens = Math.max(targetTokens - headerBudget, Math.floor(targetTokens * 0.5));

    for (const msg of messages) {
      const sentences = msg.content
        .split(/(?<=[.!?])\s+/)
        .filter(s => s.length > 10);

      for (const sentence of sentences) {
        if (keyPhrases.test(sentence)) {
          const trimmed = sentence.slice(0, 200);
          const cost = est(trimmed);
          if (tokens + cost > availableTokens) break;
          parts.push(`[${msg.role}]: ${trimmed}`);
          tokens += cost;
        }
      }
      if (tokens >= availableTokens) break;
    }

    if (parts.length === 0) {
      // Last resort: first 100 chars of each message
      for (const msg of messages) {
        const preview = msg.content.slice(0, 100).replace(/\n/g, ' ');
        const cost = est(preview);
        if (tokens + cost > availableTokens) break;
        parts.push(`[${msg.role}]: ${preview}...`);
        tokens += cost;
      }
    }

    return `CONVERSATION SUMMARY (${messages.length} earlier messages):\n${parts.join('\n')}`;
  }

  // ── Helpers ─────────────────────────────────────────────

  /**
   * Trim messages array to fit token budget (newest first).
   * @param {Array<{ role: string, content: string }>} messages
   * @param {number} tokenBudget
   * @param {(text: string) => number} est
   * @returns {Array<{ role: string, content: string }>}
   */
  _trimMessages(messages, tokenBudget, est) {
    let total = 0;
    const result = [];

    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = est(messages[i].content);
      if (total + tokens > tokenBudget) {
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

  /**
   * Simple content hash for cache key.
   * @param {Array<{ role: string, content: string }>} messages
   * @returns {string}
   */
  _hashMessages(messages) {
    let hash = 0;
    const str = messages.map(m => m.role + m.content.length).join('|');
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return `cc-${hash}-${messages.length}`;
  }

  /**
   * @param {string} key
   * @param {string} summary
   */
  _cacheResult(key, summary) {
    this._cache.set(key, { summary, timestamp: Date.now() });
    // Evict oldest if over cap
    if (this._cache.size > CACHE_MAX) {
      const oldest = this._cache.keys().next().value;
      if (oldest) this._cache.delete(oldest);
    }
  }
}

module.exports = { ConversationCompressor };
