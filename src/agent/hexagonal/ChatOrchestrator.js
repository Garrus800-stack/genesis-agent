// @ts-checked-v5.8
// ============================================================
// GENESIS — ChatOrchestrator.js (v2 — Async Intent + Tool Loop)
//
// UPGRADE: Uses async intent classification (regex→fuzzy→LLM),
// multi-round tool execution loop, and structured output parsing.
// ============================================================

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { LIMITS } = require('../core/Constants');
const { safeJsonParse } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('ChatOrchestrator');

class ChatOrchestrator {
  constructor({ lang, bus,  intentRouter, model, context, tools, circuitBreaker, promptBuilder, uncertaintyGuard, memory, unifiedMemory, storageDir, storage}) {
    this.lang = lang || { t: (k) => k, detect: () => {}, current: 'en' };
    this.bus = bus || NullBus;
    this.router = intentRouter;
    this.model = model;
    this.context = context;
    this.tools = tools;
    this.cb = circuitBreaker;
    this.promptBuilder = promptBuilder;
    this.uncertainty = uncertaintyGuard;
    this.memory = memory || null;
    this.unifiedMemory = unifiedMemory || null;
    this.storage = storage || null;
    this.abortController = null;

    // FIX v3.5.0: NativeToolUse integration (late-bound from AgentCore)
    this.nativeToolUse = null; // Set by AgentCore._wireAndStart()

    // v3.5.0: ModelRouter + EpisodicMemory (late-bound)
    this.modelRouter = null;
    this.episodicMemory = null;

    this.history = [];
    this.maxHistory = LIMITS.CHAT_HISTORY_MAX;
    this.maxToolRounds = LIMITS.CHAT_MAX_TOOL_ROUNDS;
    this.maxPersisted = LIMITS.CHAT_HISTORY_PERSISTED;

    this.handlers = new Map();

    // Persistent chat history
    this._historyFile = 'chat-history.json';
    this._historyPath = storageDir ? path.join(storageDir, 'chat-history.json') : null;
    this._loadHistory();
  }

  registerHandler(intentType, handler) {
    this.handlers.set(intentType, handler);
  }

  async handleChat(message) {
    this.history.push({ role: 'user', content: message });
    // @ts-ignore — TS strict
    this._trimHistory();
    this.lang.detect(message);
    // FIX v3.5.0: Non-critical telemetry events use fire() (non-blocking)
    this.bus.fire('user:message', { length: message.length }, { source: 'ChatOrchestrator' });

    try {
      // Async classification: regex → fuzzy → LLM
      const intent = await this.router.classifyAsync(message);
      this.bus.fire('intent:classified', { type: intent.type, confidence: intent.confidence }, { source: 'ChatOrchestrator' });

      let response;
      const handler = this.handlers.get(intent.type);

      if (handler) {
        response = await handler(message, { history: this.history, intent });
      } else {
        response = await this._generalChat(message);
      }

      if (intent.type === 'general' && this.uncertainty) {
        response = this.uncertainty.wrapResponse(response, message);
      }

      this.history.push({ role: 'assistant', content: response });
      this._saveHistory();
      // v3.5.0: Record conversation as episodic memory
      // @ts-ignore — TS strict
      this._recordEpisode(message, response, intent.type);
      this.bus.fire('chat:completed', { message, response, intent: intent.type, success: !response.startsWith('**' + this.lang.t('agent.error')) }, { source: 'ChatOrchestrator' });
      return { text: response, intent: intent.type };
    } catch (err) {
      const errMsg = this.lang.t('chat.error', { message: err.message });
      this.history.push({ role: 'assistant', content: errMsg });
      this._saveHistory();
      this.bus.fire('chat:error', { message: err.message }, { source: 'ChatOrchestrator' });
      return { text: errMsg, intent: 'error' };
    }
  }

  async handleStream(message, onChunk, onDone) {
    this.history.push({ role: 'user', content: message });
    // @ts-ignore — TS strict
    this._trimHistory();
    this.abortController = new AbortController();
    this.lang.detect(message);
    this.bus.fire('user:message', { length: message.length }, { source: 'ChatOrchestrator' });

    try {
      // Async intent — still fast for regex matches, LLM only if uncertain
      const intent = await this.router.classifyAsync(message);
      this.bus.fire('intent:classified', { type: intent.type }, { source: 'ChatOrchestrator' });

      // Check for registered handler (non-streaming path)
      const handler = this.handlers.get(intent.type);
      if (handler) {
        const response = await handler(message, { history: this.history, intent });
        onChunk(response);
        this.history.push({ role: 'assistant', content: response });
        this._saveHistory();
        this.bus.fire('chat:completed', { message, response, intent: intent.type, success: true }, { source: 'ChatOrchestrator' });
        onDone();
        return;
      }

      // Build context for streaming
      const systemPrompt = this.promptBuilder.buildAsync
        ? await this.promptBuilder.buildAsync()
        : this.promptBuilder.build();
      const ctx = this.context.build({
        task: message, intent: intent.type, history: this.history,
        systemPrompt,
        toolPrompt: this.tools.generateToolPrompt(),
      });

      let fullResponse = '';

      // @ts-ignore — TS strict
      await this._withRetry(() => this.cb.execute(
        () => this.model.streamChat(ctx.system, ctx.messages, (chunk) => {
          if (this.abortController?.signal.aborted) return;
          fullResponse += chunk;
          onChunk(chunk);
        // @ts-ignore — TS strict
        }, this.abortController.signal)
      ));

      // Multi-round tool execution loop
      // @ts-ignore — TS strict
      fullResponse = await this._processToolLoop(fullResponse, onChunk);

      this.history.push({ role: 'assistant', content: fullResponse });
      this._saveHistory();
      this.bus.fire('chat:completed', { message, response: fullResponse, intent: intent.type, success: true }, { source: 'ChatOrchestrator' });

      // Route code blocks to editor
      // @ts-ignore — TS strict
      const codeBlocks = this._extractCodeBlocks(fullResponse);
      if (codeBlocks.length > 0) {
        const primary = codeBlocks.sort((a, b) => b.content.length - a.content.length)[0];
        this.bus.emit('editor:open', primary, { source: 'ChatOrchestrator' });
      }

      onDone();
    } catch (err) {
      if (err.name !== 'AbortError') {
        onChunk(`\n\n**${this.lang.t('agent.error')}:** ${err.message}`);
        this.bus.fire('chat:error', { message: err.message }, { source: 'ChatOrchestrator' });
      }
      onDone();
    }
  }


  /** Strip tool call markup and status noise from text before storing in history */
  _cleanForHistory(text) {
    return text
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/\n\n\*.*?tools.*?\*\n/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  stop() {
    this.abortController?.abort();
    this.abortController = null;
    // FIX v5.5.0 (H-2): Sync persist on shutdown — writeJSONDebounced timer
    // won't fire after process exits. Same class as D-1/C-1.
    this._saveHistorySync();
  }

  getHistory() { return this.history; }

  // ── Private ──────────────────────────────────────────────

  async _generalChat(message) {
    try {
      return (await this.cb.execute(
        () => this.bus.request('reasoning:solve', { task: message, history: this.history })
      ))?.answer || await this._directChat(message);
    } catch (err) {
      _log.debug('[CHAT] Reasoning fallback to direct chat:', err.message);
      return this._directChat(message);
    }
  }

  async _directChat(message) {
    // @ts-ignore — TS strict
    return this._withRetry(async () => {
      const systemPrompt = this.promptBuilder.buildAsync
        ? await this.promptBuilder.buildAsync()
        : this.promptBuilder.build();
      const ctx = this.context.build({
        task: message, intent: 'general', history: this.history,
        systemPrompt, toolPrompt: this.nativeToolUse ? '' : this.tools.generateToolPrompt(),
      });

      // v3.5.0: ModelRouter auto-switching — DISABLED in v4.10.0.
      // The ModelRouter was silently switching the active model for every chat
      // message (e.g. from Claude back to gemma2:9b), then switching back after.
      // This caused:
      //   1. User selects a cloud model → ModelRouter overrides it with local model
      //   2. Response quality drops because chat goes to wrong model
      //   3. Model dropdown appears to "jump back" to the local model
      // The user's manual model selection via the UI dropdown must be respected.
      // ModelRouter is still available for AgentLoop tasks where auto-routing
      // makes sense (code-gen, planning, etc.) but NOT for direct user chat.

      try {
        // FIX v3.5.0: Use NativeToolUse when available (was registered but never connected).
        // Native tool use sends structured tool schemas to the LLM API instead of
        // relying on regex-parsed <tool_call> tags in text output.
        if (this.nativeToolUse) {
          const result = await this.nativeToolUse.chat(ctx.system, ctx.messages, 'chat');
          return result.text;
        }

        return this.model.chat(ctx.system, ctx.messages, 'chat');
      } catch (err) {
        throw err;
      }
    });
  }



  // ── Helpers → ChatOrchestratorHelpers.js (v5.6.0) ──
  // (prototype delegation, see bottom of file)

  _loadHistory() {
    try {
      if (this.storage) {
        const data = this.storage.readJSON(this._historyFile, null);
        if (Array.isArray(data)) this.history = data.slice(-this.maxPersisted);
        return;
      }
      if (this._historyPath && fs.existsSync(this._historyPath)) {
        const data = safeJsonParse(fs.readFileSync(this._historyPath, 'utf-8'), { messages: [] }, 'ChatOrchestrator');
        if (Array.isArray(data)) this.history = data.slice(-this.maxPersisted);
      }
    } catch (err) {
      _log.debug('[CHAT] History load failed:', err.message);
    }
  }

  _saveHistory() {
    try {
      const toSave = this.history.slice(-this.maxPersisted).map(m => ({
        role: m.role,
        content: m.content.slice(0, 2000),
      }));
      if (this.storage) {
        this.storage.writeJSONDebounced(this._historyFile, toSave, 1000);
        return;
      }
      if (!this._historyPath) return;
      const dir = path.dirname(this._historyPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const { atomicWriteFile } = require('../core/utils');
      atomicWriteFile(this._historyPath, JSON.stringify(toSave, null, 2), 'utf-8')
        .catch(err => _log.debug('[CHAT] History save failed:', err.message));
    } catch (err) {
      _log.debug('[CHAT] History save failed:', err.message);
    }
  }

  _saveHistorySync() {
    try {
      const toSave = this.history.slice(-this.maxPersisted).map(m => ({
        role: m.role,
        content: m.content.slice(0, 2000),
      }));
      if (this.storage) {
        this.storage.writeJSON(this._historyFile, toSave);
        return;
      }
      if (!this._historyPath) return;
      const dir = path.dirname(this._historyPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._historyPath, JSON.stringify(toSave, null, 2), 'utf-8');
    } catch (err) {
      _log.debug('[CHAT] History sync save failed:', err.message);
    }
  }
}

module.exports = { ChatOrchestrator };

const { helpers: _coHelpers } = require('./ChatOrchestratorHelpers');
Object.assign(ChatOrchestrator.prototype, _coHelpers);
