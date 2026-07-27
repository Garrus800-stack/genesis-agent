// @ts-checked-v5.9
// ============================================================
// GENESIS — VestibuleGate.js (v7.9.46 — stages V2/V3/V4)
//
// Circle resolution, triple gate (tools/list + tools/call +
// resources), per-visitor knock window, shield, visit book.
//
// Keys are never stored in clear: circles.json maps
// sha256(bearer) → { name, circle, since, note }.
// Plan H1: once circles.json exists, the open-default of the
// MCP server is OFF — no key means 401, unknown key means 401.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VESTIBULE_TOOL = 'vestibule-status';
const BOOK_CAP_BYTES = 512 * 1024;

class VestibuleGate {
  /** @param {{ genesisDir: string }} opts */
  constructor({ genesisDir }) {
    this.dir = path.join(genesisDir, 'vorhalle');
    this.circlesPath = path.join(this.dir, 'circles.json');
    this.bookPath = path.join(this.dir, 'besuche.jsonl');
    /** @type {{ map: Record<string, any>, mtime: number }|null} */
    this._cache = null;
    /** @type {Record<string, number>} last knock ts per visitor (plan H4) */
    this._knockTs = {};
  }

  _load() {
    let st = null;
    try { st = fs.statSync(this.circlesPath); } catch { this._cache = null; return null; }
    if (this._cache && this._cache.mtime === st.mtimeMs) return this._cache.map;
    try {
      const map = JSON.parse(fs.readFileSync(this.circlesPath, 'utf-8'));
      this._cache = { map: (map && typeof map === 'object') ? map : {}, mtime: st.mtimeMs };
      return this._cache.map;
    } catch { return this._cache ? this._cache.map : {}; }
  }

  invalidate() { this._cache = null; }
  hasCircles() { return this._load() !== null; }

  /** Resolve a bearer to { circle, name }. 'legacy' = no circles.json (old behaviour). */
  circleFor(bearer) {
    const map = this._load();
    if (map === null) return { circle: 'legacy', name: null };
    if (!bearer) return { circle: 'none', name: null };
    const h = crypto.createHash('sha256').update(String(bearer)).digest('hex');
    const e = map[h];
    if (!e) return { circle: 'none', name: null };
    return { circle: e.circle === 'blocked' ? 'blocked' : (e.circle === 'middle' ? 'middle' : 'outer'), name: e.name || 'unknown' };
  }

  /** Triple gate (plan L4): what a circle may see/do. */
  filterTools(schemas, circle) {
    if (circle === 'full' || circle === 'legacy') return schemas;
    if (circle === 'outer' || circle === 'middle') return (schemas || []).filter((t) => t && t.name === VESTIBULE_TOOL);
    return [];
  }
  allowCall(name, circle) {
    if (circle === 'full' || circle === 'legacy') return true;
    return (circle === 'outer' || circle === 'middle') && name === VESTIBULE_TOOL;
  }
  allowResources(circle) { return circle === 'full' || circle === 'legacy'; }

  /** Per-visitor knock window: one model-backed knock per minute (plan H4). */
  knockAllowed(name, now = Date.now()) {
    const last = this._knockTs[name] || 0;
    if (now - last < 60_000) return false;
    this._knockTs[name] = now;
    return true;
  }

  /** v7.9.46: drop a visitor's knock window. Called when the visitor is
   *  removed, so a later namesake does not inherit a stale timestamp and get
   *  the absent line on their very first knock. */
  forgetKnock(name) { delete this._knockTs[name]; }

  /** Visit book — append-only with a size cap (plan H9). */
  record(entry) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      try { const st = fs.statSync(this.bookPath); if (st.size > BOOK_CAP_BYTES) fs.renameSync(this.bookPath, this.bookPath + '.1'); } catch { /* fresh */ }
      fs.appendFileSync(this.bookPath, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
    } catch { /* the book must never break the door */ }
  }
}

module.exports = { VestibuleGate, VESTIBULE_TOOL };
