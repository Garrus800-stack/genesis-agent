// ============================================================
// GENESIS — hexagonal/ChatOrchestratorErrors.js (v7.9.50)
//
// What happens when a model call goes wrong: the retry wrapper and its
// retryable test, the error classifier, the system-error renderer and the
// main-response handler that decides between a system message and the plain
// error text.
//
// Split out of ChatOrchestratorHelpers.js — 698 lines against a 700-line
// guard, and the most-changed large file in the tree: seven versions, three
// of them since v7.9.40. Its sibling ChatOrchestrator was split in v7.9.48
// and that split searched for five expected names and missed _log, so every
// streamed answer ended in a reference error. This block was resolved for ALL
// free identifiers before it was cut; it needs exactly one, and it is here.
//
// Mixed onto ChatOrchestrator.prototype together with the helpers.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('ChatOrchestrator');

const chatOrchestratorErrors = {
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
};

module.exports = { chatOrchestratorErrors };
