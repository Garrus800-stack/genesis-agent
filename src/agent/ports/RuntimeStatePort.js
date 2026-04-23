// ============================================================
// GENESIS — RuntimeStatePort (v7.4.0 "Im Jetzt")
//
// Collects in-memory snapshots from registered services and
// presents them to PromptBuilder as a single synchronous call.
//
// Design principles:
//
//   - Opt-in per service: a service joins by implementing
//     `getRuntimeSnapshot()`. No method, no participation.
//   - No caching: every call re-reads fresh state. This is
//     required by Leitprinzip 0.6 ("Genesis lives in the now
//     of its services"). A cache would mean two questions
//     400ms apart could return identical answers even though
//     EmotionalState moved in between.
//   - Defensive against null: missing/broken services are
//     silently skipped, never filled with fake data.
//   - Sensitive-data filter lives in the source: each service's
//     getRuntimeSnapshot decides what to expose. The port does
//     not inspect content.
//   - Every snapshot gets a _capturedAt timestamp so the LLM
//     knows the state is a snapshot, not live.
//
// Boot-wiring: registered in phase11-extended.js. All 8 source
// services exist by phase 11, so late-binding is not normally
// needed — it stays only as a safety-net for graceful degradation.
// ============================================================

class RuntimeStatePort {
  /**
   * @param {object} deps
   * @param {object} [deps.clock] - Injectable clock for tests.
   *                                 Must have a now() method.
   *                                 Defaults to Date.
   */
  constructor({ clock } = {}) {
    this._sources = new Map();
    this._clock = clock || Date;
    // v7.4.0: Candidate services set by Container via
    // lateBindings. Real registration happens on first
    // snapshot() call (lazy). Reason: the Container has no
    // post-wire hook, so we register ourselves the moment
    // somebody actually needs the data.
    this._lazyRegistered = false;
    // Slots for late-binding — set by Container after all
    // phases have booted.
    this.settings = null;
    this.daemon = null;
    this.idleMind = null;
    this.peerNetwork = null;
    this.emotionalState = null;
    this.needsSystem = null;
    this.metabolism = null;
    this.goalStack = null;
  }

  /**
   * Perform lazy registration of all late-bound services.
   * Idempotent: only runs once. Services without a
   * getRuntimeSnapshot() method are silently skipped.
   */
  _lazyRegister() {
    if (this._lazyRegistered) return;
    this._lazyRegistered = true;
    const candidates = [
      ['settings',       this.settings],
      ['daemon',         this.daemon],
      ['idleMind',       this.idleMind],
      ['peerNetwork',    this.peerNetwork],
      ['emotionalState', this.emotionalState],
      ['needsSystem',    this.needsSystem],
      ['metabolism',     this.metabolism],
      ['goalStack',      this.goalStack],
    ];
    for (const [name, svc] of candidates) {
      this.register(name, svc);
    }
  }

  /**
   * Register a service as a snapshot source. Services without
   * a `getRuntimeSnapshot()` method are rejected silently —
   * a service that doesn't opt in remains invisible.
   *
   * @param {string} name   - Key under which the snapshot
   *                           appears in the aggregated result.
   * @param {object} service - Service instance with optional
   *                           getRuntimeSnapshot() method.
   * @returns {boolean} true if registered, false otherwise.
   */
  register(name, service) {
    if (typeof name !== 'string' || !name) return false;
    if (!service || typeof service.getRuntimeSnapshot !== 'function') {
      return false;
    }
    this._sources.set(name, service);
    return true;
  }

  /**
   * Remove a source. Used primarily for tests and for
   * graceful shutdown.
   */
  unregister(name) {
    return this._sources.delete(name);
  }

  /**
   * Return names of all currently-registered sources.
   * Order is insertion order (Map guarantees this).
   */
  sourceNames() {
    return Array.from(this._sources.keys());
  }

  /**
   * Synchronously collect snapshots from all registered
   * sources. Failures in individual sources are swallowed
   * silently — a broken service does not break the prompt.
   *
   * Each snapshot is tagged with `_capturedAt` (ms since
   * epoch) so downstream formatting can render age.
   *
   * @returns {object} Map of source-name to snapshot object.
   *                   Empty object if no sources registered
   *                   or all sources failed.
   */
  snapshot() {
    // v7.4.0: On first call, pick up services that were
    // late-bound by Container. Subsequent calls are cheap
    // (just the _lazyRegistered guard).
    this._lazyRegister();

    const out = {};
    const now = this._clock.now();
    for (const [name, svc] of this._sources) {
      try {
        const s = svc.getRuntimeSnapshot();
        // Defensive: must be a non-null object. Primitives
        // and arrays are rejected — snapshots are structured.
        if (s && typeof s === 'object' && !Array.isArray(s)) {
          out[name] = { ...s, _capturedAt: now };
        }
      } catch (_) {
        // Intentional silence. A failing service is worse
        // than no data — but the failure is caught so the
        // prompt still builds.
      }
    }
    return out;
  }

  /**
   * Diagnostic helper: how many sources currently registered.
   */
  size() {
    return this._sources.size;
  }
}

module.exports = { RuntimeStatePort };
