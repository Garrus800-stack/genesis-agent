// ============================================================
// GENESIS — subscription-helper.js (v7.3.4)
//
// Mixin for services that subscribe to EventBus events with
// start/stop lifecycle. Eliminates ~10 LOC of duplicated
// _sub() + stop() boilerplate per service.
//
// Usage:
//
//   const { applySubscriptionHelper } = require('../core/subscription-helper');
//
//   class HealthMonitor {
//     constructor(bus) {
//       this.bus = bus;
//       this._unsubs = [];
//     }
//     start() {
//       this._sub('chat:completed', (data) => this._onChat(data));
//       this._sub('intent:classified', (data) => this._onIntent(data));
//     }
//     stop() {
//       this._unsubAll();
//     }
//   }
//
//   applySubscriptionHelper(HealthMonitor);
//
// The mixin provides:
//   _sub(event, handler, opts)  — subscribes and tracks the unsub
//   _unsubAll()                 — calls every tracked unsub, clears list
//
// Prerequisites on the target class:
//   - this.bus must be an EventBus with .on(event, handler, opts) → unsub fn
//   - this._unsubs = [] must be initialized in the constructor
//
// Design note: we use a mixin rather than inheritance because several
// of the 12 affected services already extend EventEmitter or have
// class hierarchies we do not want to disturb. Mixin keeps the change
// purely additive.
// ============================================================

/**
 * @private Subscribe to bus event; auto-cleanup registered in this._unsubs.
 * @param {string} event
 * @param {Function} handler
 * @param {object} [opts]
 * @returns {Function} unsubscribe
 */
function _sub(event, handler, opts) {
  const unsub = this.bus.on(event, handler, opts);
  this._unsubs.push(typeof unsub === 'function' ? unsub : () => {});
  return unsub;
}

/**
 * @private Call all tracked unsub functions, clear the list. Safe to call
 *   multiple times (second call is a no-op). Individual unsub failures
 *   are swallowed — this is a best-effort teardown.
 */
function _unsubAll() {
  for (const unsub of this._unsubs) {
    try { unsub(); } catch (_) { /* best effort */ }
  }
  this._unsubs = [];
}

/**
 * Apply the subscription-helper mixin to a class.
 * Adds _sub and _unsubAll to the prototype without overwriting
 * existing methods of the same name.
 *
 * @param {Function} TargetClass
 * @param {object}   [options]
 * @param {string}   [options.defaultSource] - if set, every _sub() call
 *   that omits an opts.source will automatically tag with this name.
 *   Preserves the common pattern where a service annotates all its
 *   subscriptions with its own class name for EventBus stats.
 */
function applySubscriptionHelper(TargetClass, options = {}) {
  const proto = TargetClass.prototype;
  const defaultSource = options.defaultSource;

  if (!proto._sub) {
    if (defaultSource) {
      proto._sub = function (event, handler, opts) {
        const merged = (opts && opts.source) ? opts : { ...(opts || {}), source: defaultSource };
        const unsub = this.bus.on(event, handler, merged);
        this._unsubs.push(typeof unsub === 'function' ? unsub : () => {});
        return unsub;
      };
    } else {
      proto._sub = _sub;
    }
  }
  if (!proto._unsubAll) proto._unsubAll = _unsubAll;
}

module.exports = { applySubscriptionHelper, _sub, _unsubAll };
