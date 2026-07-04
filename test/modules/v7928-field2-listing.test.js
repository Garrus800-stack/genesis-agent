'use strict';
// v7.9.28 field-fix C — folder listing.
//
// The field showed "welche datein sind enthalten" / "welche datein sind dort
// enthalten" produced an EMPTY answer: the listing regex only knew
// "wieviele dateien", "liste inhalt", "was ist drin" and missed the natural
// "welche dateien … enthalten" phrasing (and the common misspelling "datein").
// Now those must list the last-opened folder via the source-read fast-path.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { sourceRead } = require(path.join(__dirname, '..', '..', 'src/agent/hexagonal/ChatOrchestratorSourceRead'));
const { setLastDoc, clearLastDoc } = require(path.join(__dirname, '..', '..', 'src/agent/hexagonal/LastDocStore'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-listing-'));
fs.writeFileSync(path.join(tmp, 'alpha.txt'), 'x');
fs.writeFileSync(path.join(tmp, 'beta.md'), 'y');
fs.mkdirSync(path.join(tmp, 'subdir'));

function newCtx() {
  const attached = [];
  const ctx = Object.assign(Object.create(sourceRead), {
    promptBuilder: { attachSourceContent: (o) => attached.push(o) },
    _cachedRootDir: tmp,
    storage: { baseDir: path.join(tmp, '.genesis') },
    _lastSourceReadAttempted: false,
    _attached: attached,
  });
  return ctx;
}

let passed = 0, failed = 0;
function ok(label, cond) { if (cond) passed++; else { failed++; console.log('    \u274c ' + label); } }

function listingFor(message) {
  clearLastDoc();
  setLastDoc(tmp, 'folder');
  const ctx = newCtx();
  sourceRead._maybeReadSourceSync.call(ctx, message, { type: 'general' });
  return ctx._attached;
}

for (const m of ['welche datein sind enthalten', 'welche datein sind dort enthalten',
                 'welche dateien sind enthalten', 'welche dateien', 'was ist dort enthalten',
                 'wieviele dateien sind drin', 'liste den inhalt']) {
  const at = listingFor(m);
  ok('lists on: "' + m + '"', at.length === 1
    && /Ordner-Inhalt/.test(at[0].label)
    && /alpha\.txt/.test(at[0].content) && /beta\.md/.test(at[0].content)
    && /subdir/.test(at[0].content));
}

// negative: "welche version" must NOT be treated as a listing (it has its own
// package.json version branch) — with no package.json in tmp it attaches nothing.
{
  const at = listingFor('welche version');
  ok('"welche version" is not a folder listing', !at.some((a) => /Ordner-Inhalt/.test(a.label || '')));
}

// cleanup
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.28 field-fix C folder listing');
process.exit(failed > 0 ? 1 : 0);
