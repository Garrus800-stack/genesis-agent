// ============================================================
// GENESIS — hexagonal/ChatOrchestratorStream.js (v7.9.48)
//
// The streaming chat path and its session helpers, split out of
// ChatOrchestrator.js. That file stood at 699 lines against a 700-line guard —
// one line of headroom — and carries eight changes from the last eight
// versions; it is the hottest file in the tree. Twice a justification had to
// be squeezed into an end-of-line comment to stay under the limit. This is
// the seam that ends that.
//
// Mixed onto ChatOrchestrator.prototype, exactly like ChatOrchestratorHelpers
// and ChatOrchestratorSourceRead. `this` is the orchestrator throughout.
//
// The five module-scope identifiers the methods use travel with them — without
// those requires the file would break on its first call.
// ============================================================

'use strict';

const path = require('path');
// v7.9.48 (field): handleStream passes the module logger to ensureNonEmptyReply.
// It was declared in ChatOrchestrator.js and did not travel with the method —
// so every streamed answer ended in "Fehler: _log is not defined", caught by
// the chat error handler and shown under his reply. The split checked five
// identifiers by name instead of resolving ALL free identifiers; this is what
// that shortcut cost.
const { createLogger } = require('../core/Logger');
const _log = createLogger('ChatOrchestrator');
const { dedupeSeams } = require('../foundation/backends/ContinuationLoop.js');
const { createToolCallStreamFilter } = require('../core/tool-call-stream-filter');
const { createThinkingBlockStreamFilter } = require('../core/thinking-block-stream-filter');
const { buildSelfMessageEntry } = require('./ChatHistoryMapper');

const chatOrchestratorStream = {
  async handleStream(message, onChunk, onDone) {
    this.history.push({ role: 'user', content: message }); this._observeCorrection && this._observeCorrection(this, message); // v7.9.45 K
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
      const _pk = (this._pendingProbe && (intent.type === 'general' || (intent.confidence || 0) < 0.6)) ? this._pendingProbe() : null; // v7.9.45 field: a fresh pending file-question catches only what the router itself cannot place — real commands („lies x22“) keep their road
      const handlerKey = (_pk && this.handlers.has(_pk)) ? _pk : ((intent._wasSlashOnlyRewrite && this.handlers.has('slash-hint')) ? 'slash-hint' : intent.type);
      const handler = this.handlers.get(handlerKey);
      if (handler) {
        let response = await handler(message, { history: this.history, intent });
        // v7.3.3: If a handler returns null (LLM timeout, circuit breaker, empty stream),
        // fall through to the streaming general-chat path instead of surfacing
        // "no response generated" to the user. This way Genesis actually speaks.
        if (response != null) {
          onChunk(response);
          response = dedupeSeams(response); this.history.push({ role: 'assistant', content: response });
          this._saveHistory();
          this.bus.fire('chat:completed', { message, response, intent: intent.type, success: true, backend: this.model.activeBackend || 'unknown', tokens: Math.ceil((response || '').length / 3.5), latencyMs: Date.now() - t0 }, { source: 'ChatOrchestrator' });
          onDone(response); // v7.9.37 (W4): this branch carries 'response'
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
      cleanResponse = dedupeSeams(cleanResponse); this.history.push({ role: 'assistant', content: cleanResponse });
      require('./LastDocStore').rememberOutput(cleanResponse); // v7.9.28: enable "speichere es"
      this._saveHistory();
      this.bus.fire('chat:completed', { message, response: cleanResponse, intent: intent.type, success: true, backend: this.model.activeBackend || 'unknown', tokens: Math.ceil((cleanResponse || '').length / 3.5), latencyMs: Date.now() - t0 }, { source: 'ChatOrchestrator' });

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

      cleanResponse = _h.ensureNonEmptyReply(cleanResponse, this, onChunk, _log); // v7.9.37 (Y1): silence never reaches the user
      onDone(cleanResponse);
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
      onDone(null); // v7.9.37 (W4): agent-escalation streamed extra text — never replace, just close
    }
  },

  /** Strip tool call markup and status noise from text before storing in history */
  _cleanForHistory(text) {
    return text
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/\n\n\*.*?tools.*?\*\n/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },

  stop() {
    this.abortController?.abort();
    this.abortController = null;
    // FIX v5.5.0 (H-2): Sync persist on shutdown — writeJSONDebounced timer
    // won't fire after process exits. Same class as D-1/C-1.
    this._saveHistorySync();
  },

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
  },

  getHistory() { return this.history; }

  // ── Private ──────────────────────────────────────────────
};

module.exports = { chatOrchestratorStream };
