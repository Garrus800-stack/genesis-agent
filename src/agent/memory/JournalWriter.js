// GENESIS — memory/JournalWriter.js (v7.3.7)
// ═══════════════════════════════════════════════════════════════
// Append-only journal stream with three visibilities:
//   - private: only Genesis sees it (own thoughts)
//   - shared:  Garrus sees it too (re-entry, dream reports, reflections)
//   - public:  documentable, no rotation, intended for outside readers
//
// STORAGE LAYOUT (in .genesis/journal/):
//   private-2026-04.jsonl    ← monthly rotation (ISO-YM)
//   private-2026-05.jsonl
//   shared-2026-04.jsonl
//   public.jsonl              ← single file, no rotation
//   _index.json               ← {files: {filename: count}, totalEntries}
//
// DESIGN DECISIONS (v7.3.7 spec Sektion 10):
//   - JSONL chosen for crash robustness (one bad line ≠ broken file)
//   - Monthly rotation by date (not size) — predictable, simple
//   - _index.json speeds up "read last N" without scanning all files
//   - Clock-injected (Principle 0.3)
//   - Self-describing entries: {ts, visibility, source, content, tags, meta}
//   - Atomic append via fs.appendFileSync (POSIX append guarantees)
// ═══════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/Logger');
const _log = createLogger('JournalWriter');

const VALID_VISIBILITIES = new Set(['private', 'shared', 'public']);
const VALID_SOURCES = new Set(['genesis', 'dreamcycle', 'wakeup', 'idlemind', 'system']);

class JournalWriter {
  /**
   * @param {object} opts
   * @param {object} opts.bus
   * @param {string} opts.storageDir - .genesis directory root
   * @param {{ now: () => number }} [opts.clock]
   */
  constructor({ bus, storageDir, clock = Date }) {
    if (!storageDir) throw new Error('JournalWriter requires storageDir');
    this.bus = bus || { emit: () => {} };
    this._clock = clock;
    this.dir = path.join(storageDir, 'journal');
    this._ensureDir();
    this._loadIndex();
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async asyncLoad() { /* dir + index already loaded in constructor */ }
  start() { /* no background work */ }
  stop() { this._saveIndex(); }

  // ── Internal: dir + index ─────────────────────────────────

  _ensureDir() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  _indexPath() { return path.join(this.dir, '_index.json'); }

  _loadIndex() {
    const p = this._indexPath();
    if (fs.existsSync(p)) {
      try {
        this._index = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!this._index.files) this._index.files = {};
        if (typeof this._index.totalEntries !== 'number') this._index.totalEntries = 0;
        return;
      } catch (e) {
        _log.warn('[JOURNAL] _index.json corrupt, rebuilding:', e.message);
      }
    }
    this._index = { files: {}, totalEntries: 0 };
  }

  _saveIndex() {
    try {
      fs.writeFileSync(this._indexPath(), JSON.stringify(this._index, null, 2));
    } catch (e) {
      _log.warn('[JOURNAL] failed to persist _index.json:', e.message);
    }
  }

  /**
   * Compute the file path for a given visibility based on current clock.
   * 'public' uses a single file (no rotation).
   * Others use {visibility}-{ISO-YM}.jsonl
   */
  _currentFile(visibility) {
    if (visibility === 'public') return path.join(this.dir, 'public.jsonl');
    const ym = new Date(this._clock.now()).toISOString().slice(0, 7);
    return path.join(this.dir, `${visibility}-${ym}.jsonl`);
  }

  // ── Public API: write ─────────────────────────────────────

  /**
   * Append a journal entry. Synchronous. No-op for empty content.
   *
   * @param {object} entry
   * @param {string} [entry.visibility='shared'] - 'private'|'shared'|'public'
   * @param {string} [entry.source='genesis']
   * @param {string} entry.content
   * @param {string[]} [entry.tags]
   * @param {object} [entry.meta]
   * @returns {object|null} the persisted record, or null on no-op
   */
  write({ visibility = 'shared', source = 'genesis', content, tags = [], meta = {} } = {}) {
    if (!content || typeof content !== 'string') return null;

    if (!VALID_VISIBILITIES.has(visibility)) {
      _log.warn(`[JOURNAL] invalid visibility "${visibility}", using "shared"`);
      visibility = 'shared';
    }
    if (!VALID_SOURCES.has(source)) {
      // Allow unknown sources but log for awareness — extensibility over rigidity
      _log.debug(`[JOURNAL] source "${source}" not in known list (allowing)`);
    }

    const ts = new Date(this._clock.now()).toISOString();
    const record = {
      ts, visibility, source,
      content,
      tags: Array.isArray(tags) ? tags : [],
      meta: meta && typeof meta === 'object' ? meta : {},
    };

    const file = this._currentFile(visibility);
    try {
      fs.appendFileSync(file, JSON.stringify(record) + '\n');
    } catch (e) {
      _log.error(`[JOURNAL] write failed (${file}):`, e.message);
      return null;
    }

    // Index
    const fileKey = path.basename(file);
    this._index.files[fileKey] = (this._index.files[fileKey] || 0) + 1;
    this._index.totalEntries++;
    this._saveIndex();

    this.bus.emit('journal:written', {
      visibility,
      source,
      byteLength: content.length,
      tags: record.tags,
    }, { source: 'JournalWriter' });

    return record;
  }

  // ── Public API: read ──────────────────────────────────────

  /**
   * Read the last N entries of the given visibility from the
   * current rotation file. Use readAcrossMonths() for older data.
   *
   * @param {string} visibility
   * @param {number} [n=10]
   * @returns {object[]}
   */
  readLast(visibility, n = 10) {
    const file = this._currentFile(visibility);
    if (!fs.existsSync(file)) return [];
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      _log.warn(`[JOURNAL] read failed (${file}):`, e.message);
      return [];
    }
    const lines = raw.trim().split('\n').filter(Boolean);
    return lines
      .slice(-n)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  /**
   * Maintenance hook called by DreamCycle. Monthly rotation
   * happens automatically via _currentFile (filename includes
   * ISO-YM). This method only verifies index consistency.
   */
  checkRotation() {
    // Rotation is filename-driven, no explicit move needed.
    // Future enhancement: verify _index.files matches actual on-disk files.
  }

  // ── Diagnostics ───────────────────────────────────────────

  getReport() {
    return {
      dir: this.dir,
      totalEntries: this._index.totalEntries,
      filesCount: Object.keys(this._index.files).length,
      files: this._index.files,
    };
  }
}

module.exports = { JournalWriter };
