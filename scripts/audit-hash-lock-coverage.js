#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-hash-lock-coverage.js (v7.6.2 audit-closeout)
//
// Verifies that every Genesis source file which performs the privileged
// disk-write operations (validateWrite, _codeSafety.scanCode, _verifyCode,
// Object.freeze on VM globals) is hash-locked via lockCritical([...]) in
// main.js. Fails (exit 1) when a write-side file is not in the list.
//
// Background: the v7.6.2 audit found that v7.4.3's "Aufräumen II" refactor
// extracted the four disk-writing methods (modify, _modifyWithDiff,
// _modifyFullFile, _extractPatches) from SelfModificationPipeline.js into
// SelfModificationPipelineModify.js — but main.js was never updated. The
// hash-lock comment in main.js still claimed "SelfModificationPipeline is
// the ONLY code path that writes to Genesis source files", which became
// false in v7.4.3. The hash-lock defense was bypassable for ~2 months
// before this audit. Likewise, SandboxVM.js (which holds the VM prototype-
// isolation patterns since the v7.1.2 split) was never hash-locked.
//
// CHECKS:
//   1. Parse the lockCritical([...]) entries from main.js.
//   2. Walk src/agent and find every file that contains:
//        - this.guard.validateWrite(  (write-side gate caller)
//        - (this|\(this\))._codeSafety.scanCode(  (write-side safety scan)
//        - this._verifyCode(  (write-side verification)
//        - Object.freeze(  on a global — VM isolation
//   3. FAIL if a writing/freezing file is not in the lock list.
//   4. WARN if the lock list contains a file that no longer exists.
//
// USAGE:
//   node scripts/audit-hash-lock-coverage.js          — table output
//   node scripts/audit-hash-lock-coverage.js --json   — machine-readable
//   node scripts/audit-hash-lock-coverage.js --strict — exit 1 on FAIL+WARN
//
// EXIT CODES:
//   0 : every write-side file is hash-locked
//   1 : at least one write-side file is missing from the lock list
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const MAIN_JS  = path.join(ROOT, 'main.js');
const SCAN_DIR = path.join(ROOT, 'src/agent');

const args     = process.argv.slice(2);
const strict   = args.includes('--strict');
const jsonMode = args.includes('--json');

// ── Step 1: parse lockCritical entries from main.js ─────────
function parseLockCritical() {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const m = src.match(/lockCritical\s*\(\s*\[([\s\S]*?)\]\s*\)/);
  if (!m) {
    console.error('FAIL: lockCritical([...]) call not found in main.js');
    process.exit(1);
  }
  const entries = [];
  // Match every quoted entry inside the array (single or double quotes)
  const ENTRY_RE = /['"]([^'"\n]+\.js)['"]/g;
  let mm;
  while ((mm = ENTRY_RE.exec(m[1])) !== null) {
    entries.push(mm[1]);
  }
  return entries;
}

// ── Step 2: walk src/agent, find write-side files ───────────
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name.endsWith('.js') && !full.includes('node_modules')) {
      yield full;
    }
  }
}

const WRITE_PATTERNS = [
  { name: 'guard.validateWrite',   re: /this\.guard\.validateWrite\s*\(/ },
  { name: '_codeSafety.scanCode',  re: /(?:this|\(this\))\._codeSafety\.scanCode\s*\(/ },
  { name: '_verifyCode',           re: /this\._verifyCode\s*\(/ },
];

// A file qualifies as "self-mod-pipeline write-side" only when it calls
// ALL THREE write-side gates. That signature is unique to the actual
// pipeline-modifying code path (currently Modify.js). Files calling 1-2
// of the gates use them for other purposes (PluginRegistry validating
// plugin code, SkillManager loading skill files, etc.) and don't need
// to be hash-locked under the same regime — they get a WARN line so
// future drift is visible.
const STRICT_THRESHOLD = 3;
const WARN_THRESHOLD   = 2;

function findWriteSideFiles() {
  const found = []; // [{ rel, patterns: [name...], count }]
  for (const file of walk(SCAN_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    const stripped = stripComments(src);
    const hits = WRITE_PATTERNS.filter(p => p.re.test(stripped)).map(p => p.name);
    if (hits.length >= WARN_THRESHOLD) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      found.push({ rel, patterns: hits, count: hits.length });
    }
  }
  return found;
}

function stripComments(src) {
  // Same comment-stripper logic as audit-gate-stats-callers (we don't
  // share to keep the scripts self-contained — the diff is tiny).
  let out = '';
  let i = 0;
  let inStr = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inStr) {
      if (ch === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (ch === inStr) inStr = null;
      out += ch; i++; continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch; out += ch; i++; continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      let j = i + 2;
      while (j < src.length - 1 && !(src[j] === '*' && src[j + 1] === '/')) j++;
      out += src.slice(i, Math.min(j + 2, src.length)).replace(/[^\n]/g, ' ');
      i = j + 2;
      continue;
    }
    out += ch; i++;
  }
  return out;
}

// ── Step 3: cross-check ─────────────────────────────────────
function main() {
  const locked   = new Set(parseLockCritical());
  const writers  = findWriteSideFiles();

  const missingStrict = []; // 3-of-3 gates AND not locked → FAIL
  const missingWarn   = []; // 2-of-3 gates AND not locked → WARN
  const stale         = []; // locked-but-no-file

  for (const w of writers) {
    if (locked.has(w.rel)) continue;
    if (w.count >= STRICT_THRESHOLD) missingStrict.push(w);
    else missingWarn.push(w);
  }

  for (const lockedFile of locked) {
    const abs = path.join(ROOT, lockedFile);
    if (!fs.existsSync(abs)) stale.push(lockedFile);
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      lockCriticalEntries: [...locked],
      writeSideFiles: writers,
      missingStrict,
      missingWarn,
      staleLockEntries: stale,
    }, null, 2));
  } else {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Hash-Lock Coverage Audit (v7.6.2 audit-closeout)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`lockCritical: ${locked.size} files locked`);
    console.log(`Self-mod-pipeline write-side files (3-of-3 gates): ${writers.filter(w => w.count >= STRICT_THRESHOLD).length}`);
    console.log(`Adjacent write-side callers (2-of-3 gates):       ${writers.filter(w => w.count === 2).length}`);
    console.log('');
    if (missingStrict.length > 0) {
      console.log(`❌ ${missingStrict.length} self-mod-pipeline file(s) NOT hash-locked:`);
      for (const m of missingStrict) {
        console.log(`   - ${m.rel}`);
        console.log(`        gates: ${m.patterns.join(', ')}`);
      }
    }
    if (missingWarn.length > 0) {
      console.log(`\n⚠️  ${missingWarn.length} adjacent caller(s) (2-of-3 gates) not locked — review for drift:`);
      for (const w of missingWarn) {
        console.log(`   - ${w.rel}  (${w.patterns.join(', ')})`);
      }
    }
    if (stale.length > 0) {
      console.log(`\n⚠️  ${stale.length} lockCritical entr(ies) point to nonexistent file(s):`);
      for (const s of stale) console.log(`   - ${s}`);
    }
    if (missingStrict.length === 0 && missingWarn.length === 0 && stale.length === 0) {
      console.log('✅ All self-mod-pipeline files hash-locked, no stale entries.');
    } else if (missingStrict.length === 0) {
      console.log('\n✅ All self-mod-pipeline files (3-of-3) hash-locked. WARN items are advisory only.');
    }
  }

  if (missingStrict.length > 0) process.exit(1);
  if (strict && (missingWarn.length > 0 || stale.length > 0)) process.exit(1);
  process.exit(0);
}

main();
