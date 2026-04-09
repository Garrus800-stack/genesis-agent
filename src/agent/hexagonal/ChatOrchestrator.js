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

    // v6.0.4: Cognitive budget + provenance (late-bound)
    /** @type {*} */ this._cognitiveBudget = null;
    /** @type {*} */ this._provenance = null;
    /** @type {*} */ this.lessonsStore = null;

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



  /* c8 ignore stop */

  registerHandler(intentType, handler) {
    this.handlers.set(intentType, handler);
  }

  async handleChat(message) {
    this.history.push({ role: 'user', content: message });
    this._trimHistory();
    this.lang.detect(message);
    // FIX v3.5.0: Non-critical telemetry events use fire() (non-blocking)
    this.bus.fire('user:message', { length: message.length }, { source: 'ChatOrchestrator' });

    // v6.0.4: Cognitive budget + provenance (same as handleStream)
    const budget = this._cognitiveBudget?.assess?.(message) || null;
    const traceId = this._provenance?.beginTrace?.(message) || '';
    if (traceId && budget) this._provenance.recordBudget(traceId, budget);
    const t0 = Date.now();

    try {
      // Async classification: regex → fuzzy → LLM
      const intent = await this.router.classifyAsync(message);
      this.bus.fire('intent:classified', { type: intent.type, confidence: intent.confidence }, { source: 'ChatOrchestrator' });
      if (traceId) this._provenance.recordIntent(traceId, { type: intent.type, confidence: intent.confidence || 0.5, method: intent.method || 'regex' });

      let response;
      const handler = this.handlers.get(intent.type);

      if (handler) {
        response = await handler(message, { history: this.history, intent });
      } else {
        // v6.0.4: Pass intent + budget to PromptBuilder
        if (this.promptBuilder.setIntent) this.promptBuilder.setIntent(intent.type);
        if (this.promptBuilder.setBudget && budget) this.promptBuilder.setBudget(budget);
        response = await this._generalChat(message);
      }

      if (intent.type === 'general' && this.uncertainty) {
        response = this.uncertainty.wrapResponse(response, message);
      }

      this.history.push({ role: 'assistant', content: response });
      this._saveHistory();
      // v3.5.0: Record conversation as episodic memory
      // @ts-ignore — prototype-delegated method (Object.assign, invisible to checkJs)
      this._recordEpisode(message, response, intent.type);
      this.bus.fire('chat:completed', { message, response, intent: intent.type, success: !response.startsWith('**' + this.lang.t('agent.error')) }, { source: 'ChatOrchestrator' });
      // v6.0.4: End provenance trace — success
      if (traceId) {
        this._provenance.recordModel(traceId, { name: this.model.activeModel || 'unknown', backend: this.model.activeBackend || 'unknown' });
        this._provenance.endTrace(traceId, { tokens: Math.ceil(response.length / 3.5), latencyMs: Date.now() - t0, outcome: 'success' });
      }
      return { text: response, intent: intent.type };
    } catch (err) {
      // v6.0.4: End provenance trace — error
      if (traceId) this._provenance.endTrace(traceId, { latencyMs: Date.now() - t0, error: err.message });
      const errMsg = this.lang.t('chat.error', { message: err.message });
      this.history.push({ role: 'assistant', content: errMsg });
      this._saveHistory();
      this.bus.fire('chat:error', { message: err.message }, { source: 'ChatOrchestrator' });
      return { text: errMsg, intent: 'error' };
    }
  }

  async handleStream(message, onChunk, onDone) {
    this.history.push({ role: 'user', content: message });
    this._trimHistory();
    this.abortController = new AbortController();
    this.lang.detect(message);
    this.bus.fire('user:message', { length: message.length }, { source: 'ChatOrchestrator' });

    // v6.0.5: Cognitive budget — assess complexity before doing work
    const budget = this._cognitiveBudget?.assess?.(message) || null;

    // v6.0.5: Execution provenance — begin causal trace
    const traceId = this._provenance?.beginTrace?.(message) || '';
    if (traceId && budget) {
      this._provenance.recordBudget(traceId, budget);
    }

    const t0 = Date.now();

    try {
      // Async intent — still fast for regex matches, LLM only if uncertain
      const intent = await this.router.classifyAsync(message);
      this.bus.fire('intent:classified', { type: intent.type }, { source: 'ChatOrchestrator' });
      if (traceId) this._provenance.recordIntent(traceId, { type: intent.type, confidence: intent.confidence || 0.5, method: intent.method || 'regex' });

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
      // v6.0.4: Pass intent + budget to PromptBuilder for adaptive section optimization
      if (this.promptBuilder.setIntent) this.promptBuilder.setIntent(intent.type);
      if (this.promptBuilder.setBudget && budget) this.promptBuilder.setBudget(budget);
      const systemPrompt = this.promptBuilder.buildAsync
        ? await this.promptBuilder.buildAsync()
        : this.promptBuilder.build();

      // v6.0.4: Record prompt sections in provenance trace (closes the feedback loop)
      if (traceId && this.promptBuilder._lastBuildMeta) {
        this._provenance.recordPrompt(traceId, this.promptBuilder._lastBuildMeta);
      }

      const ctx = this.context.buildAsync
        ? await this.context.buildAsync({
          task: message, intent: intent.type, history: this.history,
          systemPrompt,
          toolPrompt: this.tools.generateToolPrompt(),
        })
        : this.context.build({
          task: message, intent: intent.type, history: this.history,
          systemPrompt,
          toolPrompt: this.tools.generateToolPrompt(),
        });

      let fullResponse = '';

      // @ts-ignore — prototype-delegated method (Object.assign, invisible to checkJs)
      await this._withRetry(() => this.cb.execute(
        () => this.model.streamChat(ctx.system, ctx.messages, (chunk) => {
          if (this.abortController?.signal.aborted) return;
          fullResponse += chunk;
          onChunk(chunk);
        // @ts-ignore — prototype-delegated method (Object.assign, invisible to checkJs)
        }, this.abortController.signal)
      ));

      // Multi-round tool execution loop
      // @ts-ignore — prototype-delegated method (Object.assign, invisible to checkJs)
      fullResponse = await this._processToolLoop(fullResponse, onChunk);

      this.history.push({ role: 'assistant', content: fullResponse });
      this._saveHistory();
      this.bus.fire('chat:completed', { message, response: fullResponse, intent: intent.type, success: true }, { source: 'ChatOrchestrator' });

      // v6.0.5: End provenance trace — success
      if (traceId) {
        this._provenance.recordModel(traceId, { name: this.model.activeModel || 'unknown', backend: this.model.activeBackend || 'unknown' });
        this._provenance.endTrace(traceId, { tokens: Math.ceil(fullResponse.length / 3.5), latencyMs: Date.now() - t0, outcome: 'success' });
      }

      // Route code blocks to editor
      // @ts-ignore — prototype-delegated method (Object.assign, invisible to checkJs)
      const codeBlocks = this._extractCodeBlocks(fullResponse);
      if (codeBlocks.length > 0) {
        const primary = codeBlocks.sort((a, b) => b.content.length - a.content.length)[0];
        this.bus.emit('editor:open', primary, { source: 'ChatOrchestrator' });
      }

      onDone();
    } catch (err) {
      // v6.0.5: End provenance trace — error
      if (traceId) {
        this._provenance.endTrace(traceId, { latencyMs: Date.now() - t0, error: err.message });
      }
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
    // @ts-ignore — prototype-delegated method (Object.assign, invisible to checkJs)
    return this._withRetry(async () => {
      const systemPrompt = this.promptBuilder.buildAsync
        ? await this.promptBuilder.buildAsync()
        : this.promptBuilder.build();
      const ctx = this.context.buildAsync
        ? await this.context.buildAsync({
          task: message, intent: 'general', history: this.history,
          systemPrompt, toolPrompt: this.nativeToolUse ? '' : this.tools.generateToolPrompt(),
        })
        : this.context.build({
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
        if (this.nativeToolUse) {
          const result = await this.nativeToolUse.chat(ctx.system, ctx.messages, 'chat');
          return result.text;
        }

        // FIX v6.1.1: Fallback text-based tool loop — parse <tool_call> tags,
        // execute tools, feed results back to LLM. Closes the tool loop.
        let response = await this.model.chat(ctx.system, ctx.messages, 'chat');
        let history = [...ctx.messages];
        const MAX_TOOL_ROUNDS = 5;

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const parsed = this.tools.parseToolCalls(response);
          if (parsed.toolCalls.length === 0) return response; // No tools → done

          // Execute each tool call and LEARN from outcomes
          const toolResults = [];
          for (const call of parsed.toolCalls) {
            try {
              const result = await this.tools.execute(call.name, call.input);
              toolResults.push(`[Tool: ${call.name}] Result: ${JSON.stringify(result).slice(0, 1500)}`);
              // FIX v6.1.1: Record success in LessonsStore
              if (this.lessonsStore) {
                this.lessonsStore.record({
                  category: 'tool-usage',
                  insight: `Tool "${call.name}" with input ${JSON.stringify(call.input).slice(0, 100)} succeeded`,
                  strategy: { tool: call.name, input: call.input },
                  tags: ['tool', call.name],
                  source: 'chat-tool-loop',
                  evidence: { successRate: 1, confidence: 0.7, sampleSize: 1 },
                });
              }
            } catch (err) {
              toolResults.push(`[Tool: ${call.name}] Error: ${err.message}`);
              // Record failure so Genesis learns what doesn't work
              if (this.lessonsStore) {
                this.lessonsStore.record({
                  category: 'tool-failure',
                  insight: `Tool "${call.name}" failed: ${err.message}`,
                  strategy: { tool: call.name, input: call.input, error: err.message },
                  tags: ['tool-failure', call.name],
                  source: 'chat-tool-loop',
                  evidence: { successRate: 0, confidence: 0.6, sampleSize: 1 },
                });
              }
            }
          }

          // Feed results back to LLM for next response
          history.push({ role: 'assistant', content: response });
          history.push({ role: 'user', content: `Tool results:\n${toolResults.join('\n')}\n\nContinue based on these results. Do NOT repeat the tool calls.` });
          response = await this.model.chat(ctx.system, history, 'chat');
        }

        return response;
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
