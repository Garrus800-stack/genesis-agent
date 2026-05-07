// @ts-checked-v5.7 — unbound `this` in prototype-delegation object
// ============================================================
// GENESIS — hexagonal/ChatOrchestratorHelpers.js (v5.6.0)
// Extracted via prototype delegation.
// ============================================================

const { createLogger } = require('../core/Logger');
const { scanForInjection, formatGateResponse, formatWarnAnnotation, classifyToolSource, scanToolResult } = require('../core/injection-gate');
const { verifyToolClaims, formatVerificationNote } = require('../core/tool-call-verification');
const { recordCoherenceCheck } = require('../core/intent-tool-coherence');
const { stripThinkingBlocks } = require('../core/thinking-block-stream-filter');
const _log = createLogger('ChatOrchestrator');



const helpers = {

  /** Multi-round tool execution — keeps calling tools until no more calls.
   *  v7.5.1: intentType param added so the intent-tool-coherence layer
   *  can cross-check the IntentRouter classification against the tool
   *  the LLM actually picks. Default 'general' keeps backwards-compat
   *  for any caller that doesn't pass the param. */
  async _processToolLoop(response, onChunk, userMessage, intentType = 'general') {
    let fullText = response;
    let lastCallSignature = null;
    // v7.3.5: Accumulate every tool call fired across rounds, for the
    // post-loop verification check (commit 7).
    const allToolCalls = [];

    // v7.3.5: Scan the user's message once up-front. If two or more injection
    // signals are present, we still let the tool parser detect whether there
    // are tool calls, but we refuse to execute them and return the gate
    // response instead. A single-signal warn is carried into the synthesis
    // so the user sees Genesis noticed and chose to proceed.
    const gateScan = scanForInjection(userMessage || '');
    // v7.3.6 #6 — Central gate-stats recording. 'safe' is mapped to 'pass'
    // since GateStats tracks pass/block/warn only. Optional injection.
    try {
      const v = gateScan.verdict === 'safe' ? 'pass' : gateScan.verdict;
      this.gateStats?.recordGate('injection-gate', v);
    } catch (_) { /* gateStats optional */ }
    if (gateScan.verdict === 'block') {
      const preCheck = this.tools.parseToolCalls(fullText);
      if (preCheck.toolCalls.length > 0) {
        _log.info(`[CHAT:GATE] Tool call blocked by injection gate — ${gateScan.score} signals: ${gateScan.signals.map(s => s.kind).join(', ')}`);
        const gateMsg = formatGateResponse(gateScan);
        onChunk('\n\n' + gateMsg);
        try {
          this.bus.fire('injection:blocked', {
            signals: gateScan.signals.map(s => ({ kind: s.kind, note: s.note })),
            toolCount: preCheck.toolCalls.length,
          }, { source: 'ChatOrchestrator' });
        } catch (_) { /* bus may be NullBus */ }
        return gateMsg;
      }
      // no tool calls → nothing to block; fall through normally.
    }

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

      // v7.3.6 #11 — Multi-Round Gate Re-Check.
      // The initial preCheck at line 30-45 caught block-verdict + tools in the
      // first response. But the loop was running on a single scan: if tools
      // materialized in any later round (synthesis re-emission, mock/test
      // bypass, or any future path that mutates fullText), they would execute
      // unchecked. Safety invariant: once gateScan.verdict === 'block', NO
      // tool executes in this turn — regardless of which round surfaces it.
      // The verdict is based on the immutable user message, so re-scanning
      // is unnecessary; we just honor the original verdict every round.
      // See GATE-BEHAVIOR-CONTRACT tests in chatorchestrator.test.js.
      if (gateScan.verdict === 'block') {
        _log.info(`[CHAT:GATE] Tool call blocked by injection gate at round ${round + 1} — ${gateScan.score} signals: ${gateScan.signals.map(s => s.kind).join(', ')}`);
        const gateMsg = formatGateResponse(gateScan);
        onChunk('\n\n' + gateMsg);
        try {
          this.bus.fire('injection:blocked', {
            signals: gateScan.signals.map(s => ({ kind: s.kind, note: s.note })),
            toolCount: toolCalls.length,
          }, { source: 'ChatOrchestrator' });
        } catch (_) { /* bus may be NullBus */ }
        // Append gate message to fullText with a clear separator — bisheriger
        // Output wurde bereits gestreamt, ersetzen würde die User-Sicht
        // inkonsistent machen.
        fullText = fullText + '\n\n' + gateMsg;
        break;
      }

      // Detect repeated identical tool calls (LLM stuck in a loop)
      const callSignature = toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.input)}`).sort().join('|');
      if (callSignature === lastCallSignature) {
        _log.debug('[CHAT] Duplicate tool calls detected, breaking loop at round', round + 1);
        break;
      }
      lastCallSignature = callSignature;

      // v7.3.5: Track tool calls across rounds for post-loop verification
      for (const tc of toolCalls) allToolCalls.push({ name: tc.name });

      // v7.3.6 #2 — Self-Gate observation. Records pattern-signals on
      // each tool call (reflexivity, user-mismatch) into GateStats
      // and fires self-gate:warned when a signal triggers. The tool
      // call itself always proceeds — this is telemetry, not a filter.
      //
      // Contract with #11: the per-round injection-gate check above
      // IS a filter and must remain in front of this telemetry step.
      // The gate-contract tests ('gate contract: ...') lock that
      // ordering.
      if (this.selfGate) {
        for (const tc of toolCalls) {
          try {
            this.selfGate.check({
              actionType: 'tool-call',
              actionPayload: { label: tc.name, ...tc.input },
              userContext: userMessage,
              triggerSource: text,  // the LLM output that produced this call
            });
          } catch (err) {
            _log.debug('[SELF-GATE] check skipped:', err.message);
          }
        }
      }

      // v7.5.1: Intent-Tool-Coherence — third gate-layer alongside
      // injection-gate (input → blocks) and self-gate (action → observes).
      // Cross-checks IntentRouter classification against the tool category
      // the LLM picked. Emits intent:tool-mismatch telemetry when categories
      // don't match (severity scales by category impact + intent permissiveness).
      // Telemetry-only by design — never blocks, only records for inspection.
      if (this.bus) {
        for (const tc of toolCalls) {
          try {
            const verdict = recordCoherenceCheck(this.bus, intentType, tc.name);
            // v7.6.2 audit-closeout (H1): record on every tool-call (not only
            // mismatches) so blockRate has a meaningful denominator. Pass a
            // valid verdict string ('pass'|'warn') — the previous Object form
            // {verdict:'mismatch'} was silently dropped by GateStats since
            // v7.5.1 (recordGate validates against {'pass','block','warn'}).
            if (this.gateStats) {
              this.gateStats.recordGate('intent-tool-coherence', verdict.coherent ? 'pass' : 'warn');
            }
          } catch (err) {
            _log.debug('[COHERENCE] check skipped:', err.message);
          }
        }
      }

      onChunk(`\n\n*${this.lang.t('chat.tools_executing')}*\n`);
      const results = await this.tools.executeToolCalls(toolCalls);

      // v7.6.3 S1 — Tool-Result-Injection-Scan (warning-only).
      // Pre-fix the injection-gate scanned only userMessage. Tool-results
      // from the open web (web-fetch), MCP servers, and user-uploaded files
      // are passed verbatim to the synthesis LLM, where they can carry
      // authority claims / credential requests / urgency signals that the
      // model will then act on via the next tool-call. The S1 finding in
      // the v7.6.3 erweiterte Analyse-report flagged this as the only gate
      // surface left uncovered. This step:
      //   (1) classifies each tool-result by source heuristic (web/mcp/
      //       file:user/file:internal/sandbox/unknown),
      //   (2) scans content from external sources via scanForInjection,
      //   (3) emits `injection:tool-result-flagged` once per offending
      //       result, replaces the content with a [BLOCKED:...] marker
      //       before it reaches the synthesis prompt.
      // Intentionally non-blocking — the tool-loop continues. This is
      // an Input-Gate extension, not a Self-Gate change (Self-Gate stays
      // observation-only by design).
      for (const r of results) {
        if (!r.success || !r.result) continue;
        const toolInput = (toolCalls.find(tc => tc.name === r.name) || {}).input;
        const source = classifyToolSource(r.name, toolInput);
        const stringified = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
        const { shouldScan, scan } = scanToolResult(stringified, source);
        if (!shouldScan || !scan || scan.verdict === 'safe') continue;
        // Fire warning-only event
        try {
          this.bus?.fire('injection:tool-result-flagged', {
            toolName: r.name,
            toolSource: source,
            signals: scan.signals,
            score: scan.score,
          }, { source: 'ChatOrchestratorHelpers' });
        } catch (_) { /* fire-and-forget telemetry */ }
        // Annotate result with marker — keep enough metadata so synthesis
        // can still describe what happened without quoting the content.
        const kinds = scan.signals.map(s => s.kind).join(',');
        r.result = { _injectionFlagged: true, source, kinds, originalLength: stringified.length };
        try {
          this.gateStats?.recordGate('injection-gate', 'warn');
        } catch (_) { /* gateStats optional */ }
      }

      const resultSummary = results.map(r => {
        if (!r.success) return `[${r.name}]: ${this.lang.t('agent.error').toUpperCase()} - ${r.error}`;
        if (r.result && r.result._injectionFlagged) {
          return `[${r.name}]: [BLOCKED: injection-signal in fetched content from ${r.result.source}; kinds=${r.result.kinds}; ${r.result.originalLength} chars]`;
        }
        return `[${r.name}]: ${JSON.stringify(r.result).slice(0, 500)}`;
      }).join('\n');

      // Synthesize with tool results — now WITH system prompt and conversation context
      const synthesisMessages = [
        { role: 'user', content: `Previous response:\n${text.slice(0, 1500)}\n\nTool results (round ${round + 1}):\n${resultSummary}\n\nSummarize the tool results and respond to the user. Use additional tools if needed.` },
      ];

      const rawSynthesis = await this.model.chat(
        systemPrompt || 'You are Genesis. Respond in the user\'s language.',
        synthesisMessages,
        'chat',
        { _userChat: true }  // v7.5.2: protect tool synthesis (user-facing) from auto-routing
      );
      // v7.5.6: strip <think>...</think> from synthesis output. Without this,
      // reasoning models would (a) leak the block into the streamed UI and
      // (b) inject fake <tool_call> tags that the next round's parseToolCalls
      // would happily execute. Reasoning is discarded here — the initial
      // streaming pass already fired model:thinking-trace once per turn,
      // emitting per-round would just spam the dashboard.
      const { clean: synthesis } = stripThinkingBlocks(rawSynthesis);

      onChunk('\n' + synthesis);
      fullText = text + '\n\n' + synthesis;
    }

    // v7.3.5: If the injection gate flagged exactly one signal earlier, we
    // proceeded (it's legitimate curiosity or a single ambiguous phrase) but
    // still want the user to see that Genesis noticed. Tool loop may not even
    // have run — the annotation only makes sense if a tool actually fired,
    // which we detect via fullText differing from the original response.
    if (gateScan.verdict === 'warn' && fullText !== response) {
      const note = formatWarnAnnotation(gateScan);
      onChunk(note);
      fullText = fullText + note;
    }

    // v7.3.5: Tool-call verification gate. Check whether the final response
    // claims actions that no tool actually performed (agentic hallucination).
    // If so, append a brief note so the user can verify before trusting.
    // This is detective, not preventative — the response still goes through,
    // it just gets a flag. Skipped if injection gate already blocked.
    if (gateScan.verdict !== 'block') {
      try {
        const verification = verifyToolClaims(fullText, allToolCalls);
        // v7.3.6 #6 — Tool-call-verification is its own gate: 'verified'=pass,
        // anything else = warn (detective, not preventative).
        try {
          const gv = verification.verdict === 'verified' ? 'pass' : 'warn';
          this.gateStats?.recordGate('tool-call-verification', gv);
        } catch (_) { /* gateStats optional */ }
        if (verification.verdict !== 'verified') {
          const note = formatVerificationNote(verification);
          if (note) {
            onChunk(note);
            fullText = fullText + note;
            try {
              this.bus.fire('tool-call:unverified', {
                verdict: verification.verdict,
                flagCount: verification.flags.length,
                categories: verification.flags.map(f => f.category),
              }, { source: 'ChatOrchestrator' });
            } catch (_) { /* bus may be NullBus */ }
          }
        }
      } catch (err) {
        _log.debug('[CHAT:VERIFY] verification check skipped:', err.message);
      }
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
    const queryWords = lastUserMsg?.content
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
      // v7.2.3: Guard against null content (tool calls, error responses).
      // Without this, _trimHistory crashes with "Cannot read properties of null
      // (reading 'toLowerCase')" and blocks the entire chat channel.
      const content = msg.content || '';
      const words = content.toLowerCase().replace(/[^a-zäöüß0-9\s]/g, '').split(/\s+/);
      let score = 0;
      // Relevance to current query
      for (const w of words) { if (queryWords.has(w)) score += 2; }
      // Recency bonus (newer = higher)
      score += (idx / this.history.length) * 3;
      // Code blocks and errors are important
      if (content.includes('```') || content.includes('Error')) score += 3;
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
        // v7.3.8: Track retry count on error so _handleMainResponseError
        // can report accurate retriesUsed in chat:llm-failure payload.
        err._retriesUsed = attempt;
        if (attempt === maxRetries || !this._isRetryable(err)) throw err;
        const delay = 1000 * (attempt + 1);
        _log.debug(`[CHAT] Retryable error (attempt ${attempt + 1}/${maxRetries}): ${err.message}, waiting ${delay}ms`);
        this.bus.fire('chat:retry', { attempt: attempt + 1, error: err.message, delayMs: delay }, { source: 'ChatOrchestrator' });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  },

  _isRetryable(err) {
    // v7.3.8: Added \b429\b — rate limits are retryable by definition.
    return /ECONNREFUSED|ECONNRESET|socket hang up|timeout|EPIPE|EAI_AGAIN|fetch failed|\b429\b/i.test(err.message);
  },

  // ════════════════════════════════════════════════════════════
  // v7.3.8 — LLM-Failure Classification
  // ════════════════════════════════════════════════════════════

  /**
   * Classify an error as a "hard LLM failure" or not.
   *
   * Returns null if not a hard LLM failure — caller should use existing
   * chat:error path. Returns an object with errorType/userMessage if it
   * IS a hard LLM failure — caller should render System-Message.
   *
   * Hard failure means: the LLM call itself failed in a way the user
   * needs to know about. Not: internal bus errors, reasoning-engine
   * bugs, tool-call issues.
   *
   * @param {Error} err
   * @returns {{ errorType: string, httpStatus?: number, userMessage: string } | null}
   */
  _classifyLlmError(err) {
    const msg = err?.message || String(err);

    // HTTP status extraction — most backends put "HTTP 403" or "403" in the message
    const httpMatch = msg.match(/\bHTTP\s*(\d{3})\b/i) || msg.match(/\b(40[13]|4[0-9]{2}|5[0-9]{2})\b/);
    const httpStatus = httpMatch ? parseInt(httpMatch[1]) : null;

    if (httpStatus === 401) {
      return { errorType: 'http-401', httpStatus,
        userMessage: 'Authentifizierung fehlgeschlagen. Prüfe den API-Key in den Einstellungen.' };
    }
    if (httpStatus === 403) {
      // Subscription hint if the message contains subscription/upgrade wording
      const needsSubscription = /subscription|upgrade|forbidden/i.test(msg);
      return { errorType: 'http-403', httpStatus,
        userMessage: needsSubscription
          ? 'Dieses Modell verlangt ein Abo. Wechsle ein anderes Modell via /settings oder aktiviere das Abo.'
          : 'Zugriff verweigert. Prüfe die Modell-Einstellungen.' };
    }
    if (httpStatus === 429) {
      // This reaches classifier only after _withRetry exhausted retries
      return { errorType: 'http-429', httpStatus,
        userMessage: 'Rate-Limit erreicht trotz Wiederholung. Warte kurz oder wechsle den Backend.' };
    }
    if (httpStatus === 500 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
      return { errorType: `http-${httpStatus}`, httpStatus,
        userMessage: `Modell-Server antwortet mit HTTP ${httpStatus}. Versuche es in ein paar Minuten erneut oder wechsle den Backend.` };
    }

    // Non-HTTP hard errors
    if (/timeout/i.test(msg)) {
      return { errorType: 'timeout',
        userMessage: 'Modell antwortet nicht (Timeout). Versuche es erneut oder wechsle den Backend.' };
    }
    if (/ECONNREFUSED|ECONNRESET|socket hang up|EPIPE|EAI_AGAIN|fetch failed|ENOTFOUND/i.test(msg)) {
      return { errorType: 'network',
        userMessage: 'Modell nicht erreichbar (Netzwerkfehler). Läuft der Backend-Server?' };
    }
    if (/empty.*body|zero.bytes|no response/i.test(msg)) {
      return { errorType: 'empty-body',
        userMessage: 'Modell hat eine leere Antwort zurückgegeben. Versuche es erneut.' };
    }
    if (/json.*error|invalid.*json|parse.*error/i.test(msg)) {
      return { errorType: 'json-error',
        userMessage: 'Modell-Antwort konnte nicht verarbeitet werden (ungültiges JSON).' };
    }

    // Not a hard LLM failure — caller uses existing chat:error path
    return null;
  },

  /**
   * Render a system-message for a hard LLM failure. This is the text
   * that goes into the chat (visible to user), NOT into history.
   *
   * @param {object} classified - Result of _classifyLlmError
   * @returns {string}
   */
  _renderSystemError(classified) {
    const model = this.model?.activeModel || 'unknown';
    return `⚠ Modell nicht verfügbar\n\n${model}: ${classified.userMessage}`;
  },

  /**
   * Central error handler for main-response failures. Called from both
   * handleChat and handleStream. Returns { text, isSystemMessage }.
   *
   * If isSystemMessage is true, the caller MUST NOT push the text into
   * history — it's a system-level notification, not an assistant turn.
   * The caller SHOULD return the text to the user as visible output.
   *
   * @param {Error} err
   * @param {object} context - { sourceReadAttempted, stage }
   * @returns {{ text: string, isSystemMessage: boolean, classified: object|null }}
   */
  _handleMainResponseError(err, context = {}) {
    const classified = this._classifyLlmError(err);

    if (classified) {
      // Hard LLM failure — emit specific event, then render system message
      this.bus.fire('chat:llm-failure', {
        stage: context.stage || 'main-response',
        errorType: classified.errorType,
        backend: this.model?.activeBackend || 'unknown',
        model: this.model?.activeModel || 'unknown',
        userVisible: context.stage !== 'intent-classify',
        sourceReadAttempted: context.sourceReadAttempted === true,
        retriesUsed: err._retriesUsed || 0,
        details: (err?.message || String(err)).slice(0, 500),
      }, { source: 'ChatOrchestrator' });

      // Also fire generic chat:error for existing listeners (no regression).
      this.bus.fire('chat:error', { message: err.message }, { source: 'ChatOrchestrator' });

      return {
        text: this._renderSystemError(classified),
        isSystemMessage: true,
        classified,
      };
    }

    // Not a hard LLM failure — existing behavior (generic error text, chat:error event)
    this.bus.fire('chat:error', { message: err.message }, { source: 'ChatOrchestrator' });
    return {
      text: this.lang.t('chat.error', { message: err.message }),
      isSystemMessage: false,
      classified: null,
    };
  },

  /**
   * v7.5.9 ZIP2 Phase 3: Post-process a tool-call result before feeding
   * it back to the LLM. Surfaces structured failure patterns (sandbox
   * blocks, exists:false, command-not-found) as actionable hints so the
   * LLM can pick a different approach instead of confabulating.
   *
   * Lives in helpers (not ChatOrchestrator) to keep ChatOrchestrator.js
   * under the 700-LOC structural budget. Same prototype-delegation
   * pattern as the rest of the helpers — `this` is the ChatOrchestrator
   * instance at call time, but this method does not actually use `this`,
   * which is why it's safe to put here.
   *
   * @param {{name: string, input: object}} call
   * @param {*} result - tool execution result
   * @returns {string} formatted line for the tool-result history
   */
  _enrichToolResult(call, result) {
    const name = call.name;
    const inputStr = JSON.stringify(call.input).slice(0, 150);
    const baseLine = `[Tool: ${name}] Input: ${inputStr}`;

    if (result === null || result === undefined) {
      return `${baseLine}\nResult: (empty)`;
    }
    if (typeof result !== 'object') {
      return `${baseLine}\nResult: ${String(result).slice(0, 1500)}`;
    }

    const resJson = JSON.stringify(result).slice(0, 1500);
    const hints = [];

    // Pattern A: file-read / file-list returned exists:false
    if (result.exists === false && (name === 'file-read' || name === 'file-list')) {
      const requested = call.input?.path || call.input?.dir || '<unknown>';
      hints.push(
        `HINT: The literal path "${requested}" was not found. ` +
        `The file-read tool already tries common variants (case, extension, fuzzy). ` +
        `If you're looking for a file with a typo or unusual case, try file-list on the parent directory first to see what's actually there.`
      );
    }

    // Pattern B: shell sandbox block
    if (result.sandboxBlock === true
        || (typeof result.stderr === 'string' && /\[SHELL\]\s+Sandbox/.test(result.stderr))) {
      const reason = (result.stderr || '').replace(/^.*Sandbox:\s*/, '').slice(0, 400);
      hints.push(
        `HINT: Sandbox blocked the path. Reason: ${reason}. ` +
        `Possible alternatives: use a path inside the project rootDir, ` +
        `or (if user-home access is needed) ask the user to raise their trust level. ` +
        `For READ-only listing of folders on Desktop/Documents/Downloads, trust ASSISTED (1) is enough.`
      );
    }

    // Pattern C: shell command not found / unknown
    if (typeof result.stderr === 'string'
        && /command not found|nicht gefunden|nicht erkannt/i.test(result.stderr)) {
      hints.push(
        `HINT: The command does not exist on this system. ` +
        `Different operating systems use different commands — on Windows use 'dir' instead of 'ls', 'type' instead of 'cat', 'where' instead of 'which'. ` +
        `Use the file-list tool for portable directory listing.`
      );
    }

    // Pattern D: read-source budget exhausted
    if (result.blocked === true && name === 'read-source') {
      hints.push(
        `HINT: Source-read budget exhausted for this turn or session. ` +
        `Either continue without reading more files, or ask the user to confirm reading additional sources.`
      );
    }

    let line = `${baseLine}\nResult: ${resJson}`;
    if (hints.length > 0) {
      line += `\n${hints.join('\n')}`;
    }
    return line;
  },

};

module.exports = { helpers };
