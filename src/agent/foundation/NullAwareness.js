// GENESIS — foundation/NullAwareness.js
// ═══════════════════════════════════════════════════════════════
// Default no-op implementation of AwarenessPort.
// Registered as 'awareness' in the DI container.
// Zero overhead, zero side effects, all queries return safe defaults.
// ═══════════════════════════════════════════════════════════════

'use strict';

const { AwarenessPort } = require('../ports/AwarenessPort');

class NullAwareness extends AwarenessPort {
  /** @param {{ bus?: * }} [deps] */
  constructor({ bus } = {}) {
    super();
    this.bus = bus || null;
  }

  // All methods inherited from AwarenessPort return safe defaults.
  // Nothing to start, stop, or load.
}

module.exports = { NullAwareness };
