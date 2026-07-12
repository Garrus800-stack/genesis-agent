'use strict';
// ============================================================
// ProjectFileResolver — v7.9.37 pass 5 (X1)
//
// One robust file resolver shared by the chat handlers (read/view,
// open, summarize). Field 2026-07-10 (M2 chat): the user supplied
// "ARCHITECTURE.md" four times in four phrasings and got the same
// template question back four times — the old extractors demanded
// trigger words, probed only rootDir flat (docs/ was unreachable),
// and had no memory. This module fixes the finding, not the wording:
//   1 match  → act.   2–5 → numbered choice.   0 → one smart question.
//
// Windows/Linux: comparisons run on lower-cased, forward-slash
// normalized relative paths; returned paths are the real fs paths.
// ============================================================

const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.genesis', '.genesis-backups', '.genesis-lessons',
  'dist', 'snapshots', 'coverage', '.vscode', '.idea',
]);
const MAX_FILES = 8000;
const CACHE_TTL_MS = 30 * 1000;
const _cache = new Map(); // rootDir → { ts, list: [{ abs, rel, base }] }

/** Recursive project listing, cached. rel uses forward slashes. */
function listProjectFiles(rootDir) {
  const key = path.resolve(rootDir || process.cwd());
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.list;
  const list = [];
  const walk = (dir, rel) => {
    if (list.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (list.length >= MAX_FILES) return;
      if (e.name.startsWith('.') && IGNORE_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) walk(abs, r);
      } else if (e.isFile()) {
        list.push({ abs, rel: r, base: e.name.toLowerCase(), relLower: r.toLowerCase() });
      }
    }
  };
  walk(key, '');
  _cache.set(key, { ts: Date.now(), list });
  return list;
}

/** For tests / after external file changes. */
function clearResolverCache() { _cache.clear(); }

/**
 * Pull file-looking tokens out of a chat message: path-ish tokens
 * (contain / or \) and bare names with an extension. Quotes and
 * trailing punctuation are stripped; duplicates removed.
 */
function extractFileTokens(message) {
  const text = String(message || '');
  const out = [];
  const push = (t) => {
    const clean = t.replace(/^["'„“]+|["'„“.,;:!?]+$/g, '').trim();
    if (clean.length >= 3 && /\.[A-Za-z0-9]{1,6}$/.test(clean) && !out.includes(clean)) out.push(clean);
  };
  // path-ish first (may contain spaces only when quoted — quoted handled by callers)
  for (const m of text.matchAll(/[\w.()\-]+(?:[\\/][\w.()\-]+)+\.[A-Za-z0-9]{1,6}/g)) push(m[0]);
  // bare filename tokens
  for (const m of text.matchAll(/[\w()\-]+\.[A-Za-z0-9]{1,6}/g)) push(m[0]);
  return out;
}

/**
 * Resolve tokens against the real project tree.
 * @returns {{status:'one'|'many'|'none', token:string|null, matches:Array<{abs:string,rel:string}>}}
 */
function resolveFileToken(message, rootDir) {
  const tokens = extractFileTokens(message);
  if (tokens.length === 0) return { status: 'none', token: null, matches: [] };
  const files = listProjectFiles(rootDir);
  for (const token of tokens) {
    const norm = token.replace(/\\/g, '/').toLowerCase();
    const base = norm.split('/').pop();
    const matches = files.filter(f =>
      f.base === base || f.relLower === norm || f.relLower.endsWith('/' + norm));
    if (matches.length === 0) continue;
    // exact basename first, then shortest relative path
    matches.sort((a, b) => (a.base === base ? 0 : 1) - (b.base === base ? 0 : 1) || a.rel.length - b.rel.length);
    if (matches.length === 1) return { status: 'one', token, matches: matches.map(m => ({ abs: m.abs, rel: m.rel })) };
    return { status: 'many', token, matches: matches.slice(0, 5).map(m => ({ abs: m.abs, rel: m.rel })) };
  }
  return { status: 'none', token: tokens[0], matches: [] };
}

module.exports = { listProjectFiles, extractFileTokens, resolveFileToken, clearResolverCache };
