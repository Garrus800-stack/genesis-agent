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
const { detectVagueReference: _detectVagueRef } = require('../foundation/VagueReferenceDetector');
const { LIMITS } = require('../core/Constants');
const { safeJsonParse, atomicWriteFileSync } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const { createToolCallStreamFilter } = require('../core/tool-call-stream-filter');
const { createThinkingBlockStreamFilter, stripThinkingBlocks } = require('../core/thinking-block-stream-filter');
const { mapHistoryForPersistence, buildSelfMessageEntry } = require('./ChatHistoryMapper');
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
      // v7.5.9 ZIP7: route slash-discipline rewrites to slash-hint handler.
      const handlerKey = (intent._wasSlashOnlyRewrite && this.handlers.has('slash-hint')) ? 'slash-hint' : intent.type;
      const handler = this.handlers.get(handlerKey);

      // v7.8.3 follow-up (F8): vague-reference detection lifted ABOVE
      // the handler check so a handler that returns a truthy help
      // string (e.g. openPath for "öffne das") cannot swallow the
      // signal. Computed once, passed both to the handler (via context)
      // and to PromptBuilder (fallback path).
      const vagueSignal = _detectVagueRef(message, this.history);

      if (handler) {
        response = await handler(message, { history: this.history, intent, vagueSignal });
      }
      // v7.1.9: handler missing or null → general-chat fallback.
      // v7.8.3: setter cluster collapsed into one block so paths agree.
      if (!response) {
        if (this.promptBuilder.setQuery) this.promptBuilder.setQuery(message);
        if (this.promptBuilder.setIntent) this.promptBuilder.setIntent(intent.type);
        if (this.promptBuilder.setExplicitTool) this.promptBuilder.setExplicitTool(intent.explicitTool || null);
        if (this.promptBuilder.setVagueReference) {
          this.promptBuilder.setVagueReference(vagueSignal);
        }
        if (this.promptBuilder.setBudget && budget) this.promptBuilder.setBudget(budget);
        if (this.promptBuilder.setHistoryLength) this.promptBuilder.setHistoryLength(Math.max(0, this.history.length - 1)); // v7.9.4
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
      // v7.5.9 B4: success is structurally true here — we reached this line
      // without an exception. Pre-fix used a fragile string-sniff
      // (`!response.startsWith('**' + agent.error)`) which missed
      // handler-emitted soft-failures like "⚠️ ...", "❌ Skill failed",
      // "Fehler: ..." and contaminated SelfStatementLog / MetaLearning
      // telemetry. Hard failures throw, are caught below, and emit
      // chat:completed with success: false there.
      this.bus.fire('chat:completed', { message, response, intent: intent.type, success: true, tokens: Math.ceil((response || '').length / 3.5), latencyMs: Date.now() - t0 }, { source: 'ChatOrchestrator' });
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

      // v7.5.9 B4: emit chat:completed even on failure path so listeners
      // (SelfStatementLog, MetaLearning, telemetry) get a consistent
      // signal. Pre-fix this branch was silent and the success-flag in
      // the try-branch was string-sniffed; together that meant failure
      // telemetry was either missing or wrong.
      this.bus.fire('chat:completed', { message, response: result.text, intent: result.isSystemMessage ? 'system-error' : 'error', success: false, tokens: Math.ceil((result.text || '').length / 3.5), latencyMs: Date.now() - t0 }, { source: 'ChatOrchestrator' });

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
      // v7.5.9 ZIP7: route to slash-hint if guard rewrote intent.
      const handlerKey = (intent._wasSlashOnlyRewrite && this.handlers.has('slash-hint')) ? 'slash-hint' : intent.type;
      const handler = this.handlers.get(handlerKey);
      if (handler) {
        let response = await handler(message, { history: this.history, intent });
        // v7.3.3: If a handler returns null (LLM timeout, circuit breaker, empty stream),
        // fall through to the streaming general-chat path instead of surfacing
        // "no response generated" to the user. This way Genesis actually speaks.
        if (response != null) {
          onChunk(response);
          this.history.push({ role: 'assistant', content: response });
          this._saveHistory();
          this.bus.fire('chat:completed', { message, response, intent: intent.type, success: true, tokens: Math.ceil((response || '').length / 3.5), latencyMs: Date.now() - t0 }, { source: 'ChatOrchestrator' });
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
      if (this.promptBuilder.setExplicitTool) this.promptBuilder.setExplicitTool(intent.explicitTool || null);
      if (this.promptBuilder.setBudget && budget) this.promptBuilder.setBudget(budget);
      if (this.promptBuilder.setHistoryLength) this.promptBuilder.setHistoryLength(Math.max(0, this.history.length - 1)); // v7.9.4 chat-identity-threading
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

      let cleanResponse = '';
      const _h = /** @type {any} */ (this); // ChatOrchestratorHelpers mixin cast
      // v7.3.4: tool-call markup filter — keeps <tool_call>...</tool_call> blocks
      // out of the streamed UI output while still letting the response variable
      // capture them for the tool-execution loop.
      // v7.5.6: thinking-block filter (must run BEFORE tool-call filter).
      // Reasoning models (DeepSeek-R1, QwQ, nemotron-3-nano) emit
      // <think>...</think> blocks before the answer. These must be stripped
      // from BOTH the UI stream AND the response text — otherwise the
      // tool-loop would see `<tool_call>` tags inside the reasoning and
      // execute phantom tools the model only thought about.
      const thinkingFilter = createThinkingBlockStreamFilter();
      const toolCallFilter = createToolCallStreamFilter();
      await _h._withRetry(() => this.cb.execute(
        () => this.model.streamChat(ctx.system, ctx.messages, (chunk) => {
          if (this.abortController?.signal.aborted) return;
          const noThink = thinkingFilter.push(chunk);
          if (!noThink) return;
          cleanResponse += noThink;
          const noTool = toolCallFilter.push(noThink);
          if (noTool) onChunk(noTool);
        }, this.abortController.signal, 'chat', { _userChat: true })  // v7.5.2: protect direct user chat from auto-routing
      ));
      // Flush in correct order: thinking first, then tool-call
      const thinkTail = thinkingFilter.flush();
      if (thinkTail) {
        cleanResponse += thinkTail;
        const tcOut = toolCallFilter.push(thinkTail);
        if (tcOut) onChunk(tcOut);
      }
      const tcTail = toolCallFilter.flush();
      if (tcTail) onChunk(tcTail);

      const reasoningTrace = thinkingFilter.getReasoning();

      // Multi-round tool execution loop
      // v7.5.1: pass intent.type so intent-tool-coherence can cross-check
      // tool-category against the IntentRouter classification.
      cleanResponse = await _h._processToolLoop(cleanResponse, onChunk, message, intent.type);

      this.history.push({ role: 'assistant', content: cleanResponse });
      this._saveHistory();
      this.bus.fire('chat:completed', { message, response: cleanResponse, intent: intent.type, success: true, tokens: Math.ceil((cleanResponse || '').length / 3.5), latencyMs: Date.now() - t0 }, { source: 'ChatOrchestrator' });

      // v6.0.5: End provenance trace — success
      if (traceId) {
        this._provenance.recordModel(traceId, { name: this.model.activeModel || 'unknown', backend: this.model.activeBackend || 'unknown' });
        this._provenance.endTrace(traceId, { tokens: Math.ceil(cleanResponse.length / 3.5), latencyMs: Date.now() - t0, outcome: 'success' });
      }

      // Route code blocks to editor (ChatOrchestratorHelpers mixin)
      const codeBlocks = _h._extractCodeBlocks(cleanResponse);
      if (codeBlocks.length > 0) {
        const primary = codeBlocks.sort((a, b) => b.content.length - a.content.length)[0];
        this.bus.fire('editor:open', primary, { source: 'ChatOrchestrator' });
      }

      // v7.5.6: emit reasoning trace (telemetry, ReasoningTracer subscribes)
      if (reasoningTrace) {
        this.bus.fire('model:thinking-trace', {
          text: reasoningTrace,
          modelName: this.model.activeModel || 'unknown',
        }, { source: 'ChatOrchestrator' });
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

  /**
   * v7.7.9 Phase 2: append a self-initiated message from Genesis (proactive).
   * Construction extracted to ChatHistoryMapper.buildSelfMessageEntry.
   *
   * @param {{ text: string, kind: string, score: number,
   *           sourceRef?: object, thoughtId?: string }} msg
   */
  appendSelfMessage(msg) {
    const entry = buildSelfMessageEntry(msg);
    if (!entry) return;
    this.history.push(entry);
    this._saveHistory();
    try {
      this.bus.fire('chat:self-message-appended', entry, { source: 'ChatOrchestrator' });
    } catch (_e) { /* bus failure must not break self-message append */ }
  }

  getHistory() { return this.history; }

  // ── Private ──────────────────────────────────────────────

  async _generalChat(message) {
    const _h = /** @type {any} */ (this);
    // v7.9.4: pass full PromptBuilder output so reasoning:solve doesn't fall back to ReasoningEngine's identity-stripping mini-prompt.
    let systemPrompt = ''; try { systemPrompt = this.promptBuilder.buildAsync ? await this.promptBuilder.buildAsync() : this.promptBuilder.build(); }
    catch (e) { _log.debug('[CHAT] PromptBuilder failed in _generalChat:', e.message); }
    try {
      return (await this.cb.execute(
        () => this.bus.request('reasoning:solve', { task: message, history: this.history, systemPrompt })
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

      // v3.5.0/v4.10.0: ModelRouter auto-switching is intentionally
      // OFF for direct user chat — the user's UI model selection wins.
      // ModelRouter still drives task-routing in AgentLoop.

      try {
        // FIX v3.5.0: Use NativeToolUse when available (was registered but never connected).
        if (this.nativeToolUse) {
          const result = await this.nativeToolUse.chat(ctx.system, ctx.messages, 'chat');
          return result.text;
        }

        // FIX v6.1.1: Fallback text-based tool loop — parse <tool_call> tags,
        // execute tools, feed results back to LLM. Closes the tool loop.
        // v7.5.6: strip <think>...</think> from each model.chat() response so
        // reasoning-models (DeepSeek-R1, QwQ, nemotron-3-nano) can't sneak
        // phantom <tool_call>s past parseToolCalls. Reasoning is collected and
        // fired as a single aggregated event after the tool-loop ends.
        const reasoningParts = [];
        let raw = await this.model.chat(ctx.system, ctx.messages, 'chat', { _userChat: true });  // v7.5.2
        let stripped = stripThinkingBlocks(raw);
        if (stripped.reasoning) reasoningParts.push(stripped.reasoning);
        let response = stripped.clean;

        let history = [...ctx.messages];
        const MAX_TOOL_ROUNDS = 5;
        // v7.5.9 ZIP1 Phase 0.3: track whether we've already issued the
        // "you said you'd use a tool but didn't" re-prompt for this turn.
        // We allow at most one such re-prompt per turn; further failures
        // fall through to normal "no tools" behavior.
        let _toolIntentReprompted = false;

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const parsed = this.tools.parseToolCalls(response);
          if (parsed.toolCalls.length === 0) {
            // v7.5.9 ZIP1 Phase 0.3: before giving up, check if the LLM
            // signaled tool intent ("Tools ausführen...", "let me use ...")
            // without emitting an actual call block. If yes AND we haven't
            // re-prompted yet this turn, send one corrective message and
            // try again.
            if (!_toolIntentReprompted
                && typeof this.tools.detectToolIntentWithoutCall === 'function'
                && this.tools.detectToolIntentWithoutCall(response)) {
              _toolIntentReprompted = true;
              this.bus.fire('tool-use:reprompt-needed', {
                round,
                excerpt: response.slice(0, 200),
              }, { source: 'ChatOrchestrator' });

              const isDE = this.lang && this.lang.current === 'de';
              const correctiveMsg = isDE
                ? 'Du hast geschrieben, dass du ein Tool nutzen möchtest, aber keinen <tool_call>-Block gesendet. Sende den Tool-Call jetzt im exakt diesem Format:\n<tool_call>{"name": "tool-name", "input": {"param": "value"}}</tool_call>\nWenn doch kein Tool nötig ist, antworte direkt ohne Tool-Call.'
                : 'You indicated you want to use a tool but did not send a <tool_call> block. Send the tool call now in this exact format:\n<tool_call>{"name": "tool-name", "input": {"param": "value"}}</tool_call>\nIf no tool is actually needed, just answer directly without a tool call.';

              history.push({ role: 'assistant', content: response });
              history.push({ role: 'user', content: correctiveMsg });
              raw = await this.model.chat(ctx.system, history, 'chat', { _userChat: true });
              stripped = stripThinkingBlocks(raw);
              if (stripped.reasoning) reasoningParts.push(stripped.reasoning);
              response = stripped.clean;
              continue;  // re-evaluate at top of loop
            }

            // No tools (and no re-prompt warranted) → done.
            if (reasoningParts.length > 0) {
              this.bus.fire('model:thinking-trace', {
                text: reasoningParts.join('\n---\n'),
                modelName: this.model.activeModel || 'unknown',
              }, { source: 'ChatOrchestrator' });
            }
            return response;
          }

          // Execute each tool call and LEARN from outcomes
          const toolResults = [];
          for (const call of parsed.toolCalls) {
            try {
              const result = await this.tools.execute(call.name, call.input);
              // v7.5.9 ZIP2 Phase 3: post-process tool result to surface
              // structured failures (sandbox-block, exists:false, etc.) as
              // *actionable* feedback rather than naked JSON. The LLM gets
              // the raw result + a humanly-readable next-step hint so it
              // can adjust its strategy on the next round.
              const enriched = this._enrichToolResult(call, result);
              toolResults.push(enriched);
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
          raw = await this.model.chat(ctx.system, history, 'chat', { _userChat: true });  // v7.5.2
          stripped = stripThinkingBlocks(raw);
          if (stripped.reasoning) reasoningParts.push(stripped.reasoning);
          response = stripped.clean;
        }

        // Loop exhausted MAX_TOOL_ROUNDS — still emit any collected reasoning.
        if (reasoningParts.length > 0) {
          this.bus.fire('model:thinking-trace', {
            text: reasoningParts.join('\n---\n'),
            modelName: this.model.activeModel || 'unknown',
          }, { source: 'ChatOrchestrator' });
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
      const toSave = mapHistoryForPersistence(this.history, this.maxPersisted);
      if (this.storage) return this.storage.writeJSONDebounced(this._historyFile, toSave, 1000);
      this._writeHistoryToDisk(toSave, false);
    } catch (err) { _log.debug('[CHAT] History save failed:', err.message); }
  }

  _saveHistorySync() {
    try {
      const toSave = mapHistoryForPersistence(this.history, this.maxPersisted);
      if (this.storage) return this.storage.writeJSON(this._historyFile, toSave);
      this._writeHistoryToDisk(toSave, true);
    } catch (err) { _log.debug('[CHAT] History sync save failed:', err.message); }
  }

  _writeHistoryToDisk(toSave, sync) {
    if (!this._historyPath) return;
    const dir = path.dirname(this._historyPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const json = JSON.stringify(toSave, null, 2);
    if (sync) { atomicWriteFileSync(this._historyPath, json); return; }
    const { atomicWriteFile } = require('../core/utils');
    atomicWriteFile(this._historyPath, json, 'utf-8')
      .catch(err => _log.debug('[CHAT] History save failed:', err.message));
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

}

module.exports = { ChatOrchestrator };

// v7.3.9 + v7.5.9 ZIP2: helpers + source-read methods are extracted to
// sibling modules and prototype-delegated to keep this file under the
// 700-LOC threshold. External API unchanged.
const { helpers: _coHelpers } = require('./ChatOrchestratorHelpers');
const { sourceRead: _coSourceRead } = require('./ChatOrchestratorSourceRead');
Object.assign(ChatOrchestrator.prototype, _coHelpers, _coSourceRead);
