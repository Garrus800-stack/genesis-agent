// @ts-checked-v5.7 — unbound `this` in prototype-delegation object
// ============================================================
// GENESIS — hexagonal/ChatOrchestratorHelpers.js (v5.6.0)
// Extracted via prototype delegation.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('ChatOrchestrator');



const helpers = {

  /** Multi-round tool execution — keeps calling tools until no more calls */
  async _processToolLoop(response, onChunk) {
    let fullText = response;
    let lastCallSignature = null;

    // BUG FIX v3.5.0: Synthesis was called WITHOUT system prompt — Genesis
    // lost identity, capabilities, and context during tool synthesis rounds.
    // Now passes the system prompt and recent conversation history.
    let systemPrompt = null;
    try {
      systemPrompt = this.promptBuilder.buildAsync
        ? await this.promptBuilder.buildAsync()
        : this.promptBuilder.build();
    } catch (err) { /* best effort — null system prompt is still better than nothing */ }

    for (let round = 0; round < this.maxToolRounds; round++) {
      const { text, toolCalls } = this.tools.parseToolCalls(fullText);
      if (toolCalls.length === 0) break;

      // Detect repeated identical tool calls (LLM stuck in a loop)
      const callSignature = toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.input)}`).sort().join('|');
      if (callSignature === lastCallSignature) {
        _log.debug('[CHAT] Duplicate tool calls detected, breaking loop at round', round + 1);
        break;
      }
      lastCallSignature = callSignature;

      onChunk(`\n\n*${this.lang.t('chat.tools_executing')}*\n`);
      const results = await this.tools.executeToolCalls(toolCalls);

      const resultSummary = results.map(r =>
        r.success ? `[${r.name}]: ${JSON.stringify(r.result).slice(0, 500)}`
                  : `[${r.name}]: ${this.lang.t('agent.error').toUpperCase()} - ${r.error}`
      ).join('\n');

      // Synthesize with tool results — now WITH system prompt and conversation context
      const synthesisMessages = [
        { role: 'user', content: `Previous response:\n${text.slice(0, 1500)}\n\nTool results (round ${round + 1}):\n${resultSummary}\n\nSummarize the tool results and respond to the user. Use additional tools if needed.` },
      ];

      const synthesis = await this.model.chat(
        systemPrompt || 'You are Genesis. Respond in the user\'s language.',
        synthesisMessages,
        'chat'
      );

      onChunk('\n' + synthesis);
      fullText = text + '\n\n' + synthesis;
    }

    // Strip any remaining tool markup before returning (for clean history)
    return this._cleanForHistory(fullText);
  },

  _extractCodeBlocks(response) {
    const blocks = [];
    let idx = 0;
    response.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const trimmed = code.trim();
      if (trimmed.length < 30) return;
      idx++;
      const language = lang || this._detectLang(trimmed);
      const ext = { javascript: '.js', python: '.py', shell: '.sh', bat: '.bat',
        php: '.php', html: '.html', css: '.css', json: '.json', typescript: '.ts',
        ruby: '.rb', lua: '.lua', sql: '.sql', yaml: '.yml', markdown: '.md',
      }[language] || '.txt';
      blocks.push({ filename: `genesis_${idx}${ext}`, content: trimmed, language });
    });
    return blocks;
  },

  _detectLang(code) {
    if (/^#!.*python|^\s*def\s+\w+|^\s*import\s+\w+/m.test(code)) return 'python';
    if (/^#!.*bash/m.test(code)) return 'shell';
    if (/^<\?php/m.test(code)) return 'php';
    if (/^@echo\s+off/im.test(code)) return 'bat';
    if (/^\s*<html|^\s*<!DOCTYPE/im.test(code)) return 'html';
    if (/class\s+\w+|const\s+\w+|=>\s*{/m.test(code)) return 'javascript';
    return 'plaintext';
  },

  _trimHistory() {
    if (this.history.length <= this.maxHistory) return;

    // Semantic pruning: score each message by relevance to recent conversation
    const lastUserMsg = [...this.history].reverse().find(m => m.role === 'user');
    const queryWords = lastUserMsg
      ? new Set(lastUserMsg.content.toLowerCase().replace(/[^a-zäöüß0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2))
      : new Set();

    // Always keep last 6 messages (current context) and first 2 (session start)
    const keepStart = 2;
    const keepEnd = 6;
    const protected_ = new Set([
      ...Array.from({ length: keepStart }, (_, i) => i),
      ...Array.from({ length: keepEnd }, (_, i) => this.history.length - keepEnd + i),
    ]);

    // Score middle messages by relevance
    const scored = this.history.map((msg, idx) => {
      if (protected_.has(idx)) return { msg, idx, score: Infinity };
      const words = msg.content.toLowerCase().replace(/[^a-zäöüß0-9\s]/g, '').split(/\s+/);
      let score = 0;
      // Relevance to current query
      for (const w of words) { if (queryWords.has(w)) score += 2; }
      // Recency bonus (newer = higher)
      score += (idx / this.history.length) * 3;
      // Code blocks and errors are important
      if (msg.content.includes('```') || msg.content.includes('Error')) score += 3;
      return { msg, idx, score };
    });

    // Sort by score, keep top maxHistory messages
    scored.sort((a, b) => b.score - a.score);
    const toKeep = scored.slice(0, this.maxHistory);
    const toEvict = scored.slice(this.maxHistory);

    // Archive evicted messages
    if (this.memory && toEvict.length >= 2) {
      try {
        const evictedMsgs = toEvict.sort((a, b) => a.idx - b.idx).map(s => s.msg);
        this.memory.addEpisode(evictedMsgs);
      } catch (err) {
        _log.debug('[CHAT] Episode archival failed:', err.message);
      }
    }

    // Rebuild history in original order
    this.history = toKeep.sort((a, b) => a.idx - b.idx).map(s => s.msg);
  },

  // v3.5.0: Record conversation as episode (called after successful chat)
  _recordEpisode(message, response, intent) {
    if (!this.episodicMemory) return;
    try {
      if (message.length < 20 && response.length < 100) return;
      this.episodicMemory.recordEpisode({
        topic: message.slice(0, 80),
        summary: response.slice(0, 200),
        outcome: 'success',
        duration: 0,
        toolsUsed: [],
        tags: [intent || 'chat'],
      });
    } catch (_e) { _log.debug('[catch] episodic context build:', _e.message); }
  },

  async _withRetry(fn, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt === maxRetries || !this._isRetryable(err)) throw err;
        const delay = 1000 * (attempt + 1);
        _log.debug(`[CHAT] Retryable error (attempt ${attempt + 1}/${maxRetries}): ${err.message}, waiting ${delay}ms`);
        this.bus.fire('chat:retry', { attempt: attempt + 1, error: err.message, delayMs: delay }, { source: 'ChatOrchestrator' });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  },

  _isRetryable(err) {
    return /ECONNREFUSED|ECONNRESET|socket hang up|timeout|EPIPE|EAI_AGAIN|fetch failed/i.test(err.message);
  },

};

module.exports = { helpers };
