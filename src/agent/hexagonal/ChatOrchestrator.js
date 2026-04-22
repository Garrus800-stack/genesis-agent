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
const { createToolCallStreamFilter } = require('../core/tool-call-stream-filter');
const _log = createLogger('ChatOrchestrator');

class ChatOrchestrator {
  constructor({ lang, bus,  intentRouter, model, context, tools, circuitBreaker, promptBuilder, uncertaintyGuard, memory, unifiedMemory, storageDir, storage, gateStats, selfGate}) {
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

    // v7.3.6 #6: Central gate-stats — optional injection. Services that gate
    // decisions call this.gateStats?.recordGate(name, verdict). When null,
    // instrumentation is silent (optional chaining).
    this.gateStats = gateStats || null;

    // v7.3.6 #2: Self-Gate — optional telemetry on own tool calls.
    // Never blocks; events/logs only. If null, the check is skipped.
    this.selfGate = selfGate || null;

    // v7.3.6 #9: SelfModel — late-bound. Used to signal chat-turn boundaries
    // to the source-read budget (startReadSourceTurn resets the per-turn
    // counter; currentTurnId is propagated into read-source:called events).
    this.selfModel = null;

    // FIX v3.5.0: NativeToolUse integration (late-bound from AgentCore)
    this.nativeToolUse = null; // Set by AgentCore._wireAndStart()

    // v3.5.0: ModelRouter + EpisodicMemory (late-bound)
    this.modelRouter = null;
    this.episodicMemory = null;

    // v7.3.7: ActiveReferences port — late-bound. Used to claim
    // episodes referenced in the current turn so DreamCycle Phase 4c
    // skips them during background consolidation.
    this.activeRefs = null;

    // v7.3.8: Tracks whether _maybeReadSourceSync successfully loaded
    // a source file during the current turn. Read by _handleMainResponseError
    // to populate the sourceReadAttempted field in chat:llm-failure events.
    this._lastSourceReadAttempted = false;

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
    // v7.3.6 #9: Signal new chat turn to source-read budget. Uses traceId
    // as turnId when available, otherwise falls back to a timestamp.
    // Safe-op when selfModel not late-bound yet.
    try {
      this.selfModel?.startReadSourceTurn(traceId || `turn-${Date.now()}`);
    } catch (_e) { /* optional */ }
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
        // v7.1.9: If handler returns null/empty, fall through to general chat
        // (e.g. retry with nothing to retry → treat as normal message)
        if (!response) {
          if (this.promptBuilder.setQuery) this.promptBuilder.setQuery(message);
          if (this.promptBuilder.setIntent) this.promptBuilder.setIntent(intent.type);
          if (this.promptBuilder.setBudget && budget) this.promptBuilder.setBudget(budget);
          this._maybeAttachSourceHint(message, intent);  // v7.3.7
          this._maybeReadSourceSync(message, intent);    // v7.3.8
          response = await this._generalChat(message);
        }
      } else {
        // v6.0.4: Pass intent + budget to PromptBuilder
        // v7.3.3: setQuery — lets sourceAccessContext detect file/class/service references
        if (this.promptBuilder.setQuery) this.promptBuilder.setQuery(message);
        if (this.promptBuilder.setIntent) this.promptBuilder.setIntent(intent.type);
        if (this.promptBuilder.setBudget && budget) this.promptBuilder.setBudget(budget);
        this._maybeAttachSourceHint(message, intent);  // v7.3.7
        this._maybeReadSourceSync(message, intent);    // v7.3.8
        response = await this._generalChat(message);
      }

      if (intent.type === 'general' && this.uncertainty) {
        response = this.uncertainty.wrapResponse(response, message);
      }

      // v7.3.3: Graceful fallback when the LLM stream ends without output
      // (circuit breaker opened, stream timeout, all retries exhausted).
      // The schema requires a response field, so we can't return null, but
      // we can at least say something human instead of a raw error string.
      if (response == null) {
        response = this.lang.current === 'de'
          ? 'Ich konnte gerade keine Antwort formulieren — Modell vielleicht kurz weg. Probier es nochmal.'
          : "I couldn't produce a response just now — the model may be briefly unavailable. Try again.";
      }

      this.history.push({ role: 'assistant', content: response });
      this._saveHistory();
      // v3.5.0: Record conversation as episodic memory (ChatOrchestratorHelpers mixin)
      (/** @type {any} */ (this))._recordEpisode(message, response, intent.type);
      this.bus.fire('chat:completed', { message, response, intent: intent.type, success: !response.startsWith('**' + this.lang.t('agent.error')) }, { source: 'ChatOrchestrator' });
      // v7.3.7: Release any active-reference claims made during this turn
      // so DreamCycle Phase 4c stops skipping those episodes.
      if (this.activeRefs && traceId) {
        try { this.activeRefs.releaseTurn(traceId); } catch { /* best-effort */ }
      }
      // v6.0.4: End provenance trace — success
      if (traceId) {
        this._provenance.recordModel(traceId, { name: this.model.activeModel || 'unknown', backend: this.model.activeBackend || 'unknown' });
        this._provenance.endTrace(traceId, { tokens: Math.ceil(response.length / 3.5), latencyMs: Date.now() - t0, outcome: 'success' });
      }
      return { text: response, intent: intent.type };
    } catch (err) {
      // v6.0.4: End provenance trace — error
      if (traceId) this._provenance.endTrace(traceId, { latencyMs: Date.now() - t0, error: err.message });

      // v7.3.8: Central error handler. For hard LLM failures: renders
      // system-message and returns it WITHOUT pushing to history
      // (avoids "LLM sees its own error as prior statement" class of bugs).
      // For other errors: same behavior as before — generic error text
      // IS pushed to history (preserves continuity for non-LLM failures).
      const _h = /** @type {any} */ (this);
      const result = _h._handleMainResponseError(err, {
        stage: 'main-response',
        sourceReadAttempted: this._lastSourceReadAttempted === true,
      });

      if (!result.isSystemMessage) {
        // Existing behavior for non-LLM errors: push to history
        this.history.push({ role: 'assistant', content: result.text });
        this._saveHistory();
      }
      // For isSystemMessage=true: do NOT push to history. User sees it,
      // next turn doesn't reference it.

      return { text: result.text, intent: result.isSystemMessage ? 'system-error' : 'error' };
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
    // v7.3.6 #9: Signal new chat turn to source-read budget.
    try {
      this.selfModel?.startReadSourceTurn(traceId || `turn-${Date.now()}`);
    } catch (_e) { /* optional */ }

    const t0 = Date.now();

    try {
      // Async intent — still fast for regex matches, LLM only if uncertain
      const intent = await this.router.classifyAsync(message);
      this.bus.fire('intent:classified', { type: intent.type }, { source: 'ChatOrchestrator' });
      if (traceId) this._provenance.recordIntent(traceId, { type: intent.type, confidence: intent.confidence || 0.5, method: intent.method || 'regex' });

      // Check for registered handler (non-streaming path)
      const handler = this.handlers.get(intent.type);
      if (handler) {
        let response = await handler(message, { history: this.history, intent });
        // v7.3.3: If a handler returns null (LLM timeout, circuit breaker, empty stream),
        // fall through to the streaming general-chat path instead of surfacing
        // "no response generated" to the user. This way Genesis actually speaks.
        if (response != null) {
          onChunk(response);
          this.history.push({ role: 'assistant', content: response });
          this._saveHistory();
          this.bus.fire('chat:completed', { message, response, intent: intent.type, success: true }, { source: 'ChatOrchestrator' });
          onDone();
          return;
        }
        // Handler returned null — log and continue into the regular streaming path below.
        if (traceId) this._provenance.recordIntent(traceId, { type: intent.type, note: 'handler-null-fallback-to-general' });
      }

      // Build context for streaming (also reached when a handler returned null above)
      // v6.0.4: Pass intent + budget to PromptBuilder for adaptive section optimization
      // v7.3.3: setQuery — lets sourceAccessContext detect file/class/service references
      if (this.promptBuilder.setQuery) this.promptBuilder.setQuery(message);
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
      const _h = /** @type {any} */ (this); // ChatOrchestratorHelpers mixin cast
      // v7.3.4: Tool-call markup filter extracted to core/tool-call-stream-filter.js
      // as a pure, unit-testable function. Keeps <tool_call>...</tool_call> blocks
      // out of the streamed output while still letting fullResponse capture them
      // for the tool-execution loop.
      const toolCallFilter = createToolCallStreamFilter();
      const filteredOnChunk = (chunk) => {
        const out = toolCallFilter.push(chunk);
        if (out) onChunk(out);
      };
      await _h._withRetry(() => this.cb.execute(
        () => this.model.streamChat(ctx.system, ctx.messages, (chunk) => {
          if (this.abortController?.signal.aborted) return;
          fullResponse += chunk;
          filteredOnChunk(chunk);
        }, this.abortController.signal)
      ));
      // Flush any safe tail buffered at end of stream
      const tail = toolCallFilter.flush();
      if (tail) onChunk(tail);

      // Multi-round tool execution loop
      fullResponse = await _h._processToolLoop(fullResponse, onChunk, message);

      this.history.push({ role: 'assistant', content: fullResponse });
      this._saveHistory();
      this.bus.fire('chat:completed', { message, response: fullResponse, intent: intent.type, success: true }, { source: 'ChatOrchestrator' });

      // v6.0.5: End provenance trace — success
      if (traceId) {
        this._provenance.recordModel(traceId, { name: this.model.activeModel || 'unknown', backend: this.model.activeBackend || 'unknown' });
        this._provenance.endTrace(traceId, { tokens: Math.ceil(fullResponse.length / 3.5), latencyMs: Date.now() - t0, outcome: 'success' });
      }

      // Route code blocks to editor (ChatOrchestratorHelpers mixin)
      const codeBlocks = _h._extractCodeBlocks(fullResponse);
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
        // v7.3.8: Use central error handler — system-messages for hard
        // LLM failures, existing behavior for others. In streaming path
        // we deliver the text via onChunk like other chunks.
        const _h = /** @type {any} */ (this);
        const result = _h._handleMainResponseError(err, {
          stage: 'main-response',
          sourceReadAttempted: this._lastSourceReadAttempted === true,
        });

        if (result.isSystemMessage) {
          // System-message: deliver as a distinct block, no history write
          onChunk(`\n\n${result.text}`);
        } else {
          // Existing behavior: generic error appended to the stream
          onChunk(`\n\n**${this.lang.t('agent.error')}:** ${err.message}`);
        }
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
    const _h = /** @type {any} */ (this);
    try {
      return (await this.cb.execute(
        () => this.bus.request('reasoning:solve', { task: message, history: this.history })
      ))?.answer || await this._directChat(message);
    } catch (err) {
      // v7.3.8: If the reasoning:solve path failed due to a hard LLM
      // error (HTTP 4xx/5xx, timeout, network, empty body, JSON error),
      // do NOT fall through to _directChat — it would hit the same
      // error with a second LLM call, doubling the pain for zero gain.
      // Only fall through for internal/bus-level errors where
      // _directChat might actually succeed.
      if (_h._classifyLlmError(err)) {
        _log.debug('[CHAT] Hard LLM error in reasoning path — skipping _directChat fallback:', err.message);
        throw err;  // caller (handleChat/handleStream) will render system-message
      }
      _log.debug('[CHAT] Reasoning fallback to direct chat (non-LLM error):', err.message);
      return this._directChat(message);
    }
  }

  async _directChat(message) {
    const _h = /** @type {any} */ (this); // ChatOrchestratorHelpers mixin cast
    return _h._withRetry(async () => {
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

  /**
   * v7.3.7: Detect if the message pattern suggests a specific source
   * file that would help answer it. DOES NOT read the file — only
   * places a hint in the prompt so Genesis can choose whether to read.
   * This keeps source-read budget under Genesis's control.
   *
   * @param {string} message
   * @param {object} intent
   */
  _maybeAttachSourceHint(message, intent) {
    if (!this.promptBuilder?.attachSourceHint) return;
    this.promptBuilder.clearSourceHint?.();

    if (intent.type !== 'general') return;
    if (typeof message !== 'string') return;

    const lower = message.toLowerCase();

    // "was hat sich geändert", "was ist neu", "was gibt's neues"
    if (/was\s+(hat\s+sich|ist\s+neu|gibt.*neu)/.test(lower)) {
      this.promptBuilder.attachSourceHint({
        path: 'CHANGELOG.md',
        reason: 'die Frage nach Änderungen',
      });
      return;
    }

    // "welche version", "aktuelle version"
    if (/welche?\s+version|aktuelle\s+version/.test(lower)) {
      this.promptBuilder.attachSourceHint({
        path: 'package.json',
        reason: 'die Versionsfrage',
      });
      return;
    }

    // No match — clear any previous hint
  }

  /**
   * v7.3.8: If the user query matches one of the known source-file
   * patterns, read the file synchronously and attach its content to
   * the prompt. This gives the LLM actual ground-truth instead of
   * relying on a hint it might ignore.
   *
   * Runs BEFORE _generalChat. Sets this._lastSourceReadAttempted for
   * chat:llm-failure payload observability.
   *
   * Sources are cached in-memory with mtime-based invalidation.
   *
   * @param {string} message
   * @param {object} intent
   */
  _maybeReadSourceSync(message, intent) {
    // Clear previous turn's state
    if (this.promptBuilder?.clearSourceContent) {
      this.promptBuilder.clearSourceContent();
    }
    this._lastSourceReadAttempted = false;

    if (!this.promptBuilder?.attachSourceContent) return;
    if (intent.type !== 'general') return;
    if (typeof message !== 'string') return;

    const lower = message.toLowerCase();
    const rootDir = this._rootDir();

    // Pattern 1: "was hat sich geändert" / "was ist neu" → CHANGELOG.md
    if (/was\s+(hat\s+sich|ist\s+neu|gibt.*neu)/.test(lower)) {
      const section = this._readChangelogLatestSection(path.join(rootDir, 'CHANGELOG.md'));
      if (section) {
        this.promptBuilder.attachSourceContent({
          content: section,
          label: 'CHANGELOG.md (neuester Versions-Abschnitt)',
        });
        this._lastSourceReadAttempted = true;
      }
      return;
    }

    // Pattern 2: "welche version" → package.json version field
    if (/welche?\s+version|aktuelle\s+version/.test(lower)) {
      const version = this._readPackageVersion(path.join(rootDir, 'package.json'));
      if (version) {
        this.promptBuilder.attachSourceContent({
          content: `"version": "${version}"`,
          label: 'package.json',
        });
        this._lastSourceReadAttempted = true;
      }
    }
  }

  /**
   * Compute the project root directory. Prefers explicit storageDir,
   * falls back to cwd.
   */
  _rootDir() {
    if (this._cachedRootDir) return this._cachedRootDir;
    // storageDir points to .genesis/, root is one level up
    const candidate = this.storage?.baseDir
      ? path.dirname(this.storage.baseDir)
      : process.cwd();
    this._cachedRootDir = candidate;
    return candidate;
  }

  /**
   * Read a file with mtime-based caching. Returns string or null on any error.
   */
  _readSourceCached(filePath) {
    if (!this._sourceReadCache) this._sourceReadCache = new Map();
    try {
      const stat = fs.statSync(filePath);
      const cached = this._sourceReadCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.content;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      this._sourceReadCache.set(filePath, { content, mtimeMs: stat.mtimeMs });
      return content;
    } catch (e) {
      _log.debug('[CHAT] Source read failed:', filePath, '—', e.message);
      return null;
    }
  }

  /**
   * Extract the latest version section from CHANGELOG.md: from the first
   * ## [x.y.z] header to the second (exclusive). If only one header
   * exists, extract to end of file.
   *
   * Truncates to 6000 chars if longer, with a hint about further content.
   */
  _readChangelogLatestSection(filePath) {
    const full = this._readSourceCached(filePath);
    if (!full) return null;

    // Match headers like ## [7.3.8] or ## [7.3.8] — "title"
    const headerRegex = /^## \[/gm;
    const headers = [];
    let match;
    while ((match = headerRegex.exec(full)) !== null) {
      headers.push(match.index);
      if (headers.length >= 2) break;
    }

    if (headers.length === 0) return null;  // no version headers found
    const start = headers[0];
    const end = headers[1] !== undefined ? headers[1] : full.length;
    let section = full.slice(start, end).trim();

    const MAX_LENGTH = 6000;
    if (section.length > MAX_LENGTH) {
      section = section.slice(0, MAX_LENGTH)
        + '\n\n[Gekürzt — ganze Datei ist CHANGELOG.md, weitere Abschnitte am Ende.]';
    }
    return section;
  }

  /**
   * Extract the version field from package.json. Returns the version
   * string or null on any error (including JSON parse failure).
   */
  _readPackageVersion(filePath) {
    const full = this._readSourceCached(filePath);
    if (!full) return null;
    try {
      const pkg = JSON.parse(full);
      return typeof pkg.version === 'string' ? pkg.version : null;
    } catch (e) {
      _log.debug('[CHAT] package.json parse failed:', e.message);
      return null;
    }
  }
}

module.exports = { ChatOrchestrator };

const { helpers: _coHelpers } = require('./ChatOrchestratorHelpers');
Object.assign(ChatOrchestrator.prototype, _coHelpers);
