// ============================================================
// GENESIS — innerSpeech/RingBuffer.js (v7.7.9)
//
// Bounded ring buffer for InnerSpeech thoughts. When push() exceeds
// capacity, the oldest item is displaced and returned to caller (so
// caller can decide what to do with it — typically: write to overflow).
//
// Pure data structure. No side effects, no I/O, no event bus.
// Single-threaded JS — no locks needed.
// ============================================================

'use strict';

class RingBuffer {
  /**
   * @param {number} capacity — max items held in memory. Default 200.
   */
  constructor(capacity = 200) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('RingBuffer: capacity must be a positive integer');
    }
    this.capacity = capacity;
    this._buf = new Array(capacity);
    this._head = 0;       // next write position
    this._size = 0;       // current count
  }

  /**
   * Push an item. If at capacity, the oldest item is displaced and returned.
   * Otherwise returns null.
   * @param {*} item
   * @returns {*|null} the displaced item (when ring was full), else null
   */
  push(item) {
    let displaced = null;
    if (this._size === this.capacity) {
      displaced = this._buf[this._head];
    }
    this._buf[this._head] = item;
    this._head = (this._head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;
    return displaced;
  }

  /**
   * Return all items in chronological order (oldest → newest).
   * Does not consume the ring.
   * @returns {Array}
   */
  toArray() {
    if (this._size < this.capacity) {
      return this._buf.slice(0, this._size);
    }
    return this._buf.slice(this._head).concat(this._buf.slice(0, this._head));
  }

  /** Drop everything. */
  clear() {
    this._head = 0;
    this._size = 0;
    this._buf = new Array(this.capacity);
  }

  /** @returns {number} current count of items */
  get size() { return this._size; }
}

module.exports = { RingBuffer };
