// GENESIS — ports/DaemonControlPort.js
// ═══════════════════════════════════════════════════════════════
// V7-4A: Abstract port for external daemon control.
// Default implementation: DaemonController (Unix Socket / Named Pipe).
//
// All consumers depend on this contract, never on the transport.
// ═══════════════════════════════════════════════════════════════

'use strict';

/**
 * @typedef {object} ControlRequest
 * @property {string}        id     - Caller-assigned request ID
 * @property {string}        method - RPC method name
 * @property {object|null}   params - Method parameters (optional)
 */

/**
 * @typedef {object} ControlResponse
 * @property {string}        id     - Echoed request ID
 * @property {*}             [result] - Success payload
 * @property {{ code: number, message: string }} [error] - Error payload
 */

/**
 * Abstract control port.
 * Implementations must override start(), stop(), and isListening().
 */
class DaemonControlPort {

  /** Start accepting connections. */
  start() {}

  /** Stop accepting connections and close all clients. */
  stop() {}

  /** @returns {boolean} Whether the control channel is active. */
  isListening() { return false; }

  /** @returns {string|null} The address/path the server is bound to. */
  getAddress() { return null; }

  /** @returns {number} Number of currently connected clients. */
  getClientCount() { return 0; }
}

module.exports = { DaemonControlPort };
