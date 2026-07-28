// ============================================================
// GENESIS — v7.9.47 hygiene contract
//
// The growth watch and the parking-lot harvest. What these pins guard is
// not behaviour — this release changes none — but the two failure modes a
// structural split produces:
//
//   1. A reader that was taught nothing. Three scripts and eighteen test
//      files read IntentPatterns.js and Settings.js BY PATH and search
//      their TEXT. A split that moves content without moving its readers
//      blinds them, and two of those readers fail SILENTLY.
//   2. A guard that quietly stops guarding. audit-slash-discipline parsed
//      an empty security set and still exited 0 the moment the set moved.
//
// Both are the v7.9.46 lesson in a new coat: a check that agrees with the
// defect is worse than no check.
// ============================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
let pass = 0; let fail = 0;

function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fail++; }
}

const loc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').length;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

(async () => {
  console.log('\nv7.9.47 — hygiene: growth watch and parking-lot harvest\n');

  // ── H1: the intent split ──────────────────────────────────
  t('H1: IntentPatterns is under the 700-LOC guard and keeps every export', () => {
    assert.ok(loc('src/agent/intelligence/IntentPatterns.js') < 700,
      'IntentPatterns must stay under 700 LOC — the guard fires above it and the next intent could not be added');
    const m = require(path.join(ROOT, 'src/agent/intelligence/IntentPatterns.js'));
    for (const name of ['INTENT_DEFINITIONS', 'SLASH_ONLY_INTENTS', 'SAFE_SLASH_FALLTHROUGH',
      'SECURITY_REQUIRED_SLASH', 'enforceSlashDiscipline']) {
      assert.ok(m[name] !== undefined, `${name} must stay reachable from IntentPatterns — importers keep one address`);
    }
    assert.strictEqual(typeof m.enforceSlashDiscipline, 'function');
    assert.ok(m.SECURITY_REQUIRED_SLASH.size > 0, 'the security set must not arrive empty');
  });

  t('H1: the slash-discipline half lives in its own module', () => {
    const d = read('src/agent/intelligence/IntentSlashDiscipline.js');
    assert.ok(/const SECURITY_REQUIRED_SLASH = new Set\(\[/.test(d),
      'the security set must be declared here — audit-doc-drift parses it out of this file by regex');
    assert.ok(/function enforceSlashDiscipline/.test(d));
    // and the guard's own pattern travelled with it — a source pin follows its subject
    assert.ok(/\^\\s\*\\\/\[a-z\]\[\\w-\]\*\\b/.test(d),
      'the start-anchored slash-position pattern must be in the file the guard now lives in');
  });

  // ── The silent-guard class ────────────────────────────────
  t('H1: audit-slash-discipline still sees both halves — and dies if it does not', () => {
    const src = read('scripts/audit-slash-discipline.js');
    assert.ok(/IntentSlashDiscipline\.js/.test(src),
      'the audit must read the file the set moved to');
    assert.ok(/securitySet\.size === 0[\s\S]{0,200}process\.exit\(1\)/.test(src),
      'an empty security set must FAIL — it previously parsed as 0 entries and still exited 0');
    const out = execFileSync('node', [path.join(ROOT, 'scripts/audit-slash-discipline.js')],
      { cwd: ROOT, encoding: 'utf8' });
    const m = /Security set\D*(\d+) entries/.exec(out.replace(/\u001b\[[0-9;]*m/g, ''));
    assert.ok(m, 'the audit must report a security-set size');
    assert.ok(Number(m[1]) > 0, `security set parsed as ${m && m[1]} — the audit went blind`);
  });

  t('H1: audit-doc-drift reads the security set from its new home', () => {
    const src = read('scripts/audit-doc-drift.js');
    assert.ok(/IntentSlashDiscipline\.js/.test(src),
      'a miss here does not fail — it silently skips the check, which is worse');
  });

  // ── H2: the settings split ────────────────────────────────
  t('H2: Settings is under the guard and its defaults are byte-identical', () => {
    assert.ok(loc('src/agent/foundation/Settings.js') < 700, 'Settings under 700 LOC');
    const { DEFAULTS, defaultSettings } = require(path.join(ROOT, 'src/agent/foundation/SettingsDefaults.js'));
    assert.ok(DEFAULTS && typeof DEFAULTS === 'object');
    const a = defaultSettings(); const b = defaultSettings();
    a.daemon.enabled = '__mutated__';
    assert.notStrictEqual(b.daemon.enabled, '__mutated__',
      'each Settings instance must get a fresh deep copy — a shared tree would leak across instances');
  });

  t('H2: the text pins followed the defaults into the new file', () => {
    const both = read('src/agent/foundation/Settings.js') + read('src/agent/foundation/SettingsDefaults.js');
    for (const probe of ['numCtxCap:', 'scoreNormalization:', 'recurrenceBonus:']) {
      assert.ok(both.includes(probe), `${probe} must still be findable across the two files`);
    }
    // every test that reads Settings.js as text must read the defaults too
    const dir = path.join(ROOT, 'test', 'modules');
    const offenders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.test.js') && f !== 'v7947-hygiene.contract.test.js')
      .filter((f) => {
        const s = fs.readFileSync(path.join(dir, f), 'utf8');
        // A suite that asserts something is ABSENT from Settings.js must keep
        // reading only Settings.js — widening it would make the pin unfalsifiable.
        if (/no longer holds|must not contain|is absent from/i.test(s)) return false;
        return /readFileSync\([^)]*foundation\/Settings\.js/.test(s) && !/SettingsDefaults\.js/.test(s);
      });
    assert.deepStrictEqual(offenders, [],
      `these suites read Settings.js as text but not SettingsDefaults.js: ${offenders.join(', ')}`);
  });

  // ── H3: the exclude list ──────────────────────────────────
  t('H3: every file entry in _excludePaths resolves, and the check enforces it', () => {
    const cfg = JSON.parse(read('scripts/stale-refs.json'));
    const files = (cfg._excludePaths || []).filter((e) => path.basename(e).includes('.'));
    assert.ok(files.length >= 5, 'the changelog archives must be excluded');
    for (const e of files) {
      assert.ok(fs.existsSync(path.join(ROOT, e)),
        `dead exclude entry: ${e} — a wrong path prefix looks present while doing nothing`);
    }
    assert.ok(/checkExcludePaths/.test(read('scripts/check-stale-refs.js')),
      'the check itself must guard the list — the v7 archive sat there without its docs/ prefix for months');
  });

  // ── H4: /crashlog ─────────────────────────────────────────
  t('H4: /crashlog exists in chat, not only in the CLI', () => {
    const { allCommandNames } = require(path.join(ROOT, 'src/agent/intelligence/slash-commands'));
    assert.ok(allCommandNames().includes('crashlog'), 'registered as a slash command');
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    assert.strictEqual(new IntentRouter({}).classify('/crashlog 5').type, 'crashlog');
    assert.ok(/registerHandler\('crashlog'/.test(read('src/agent/hexagonal/CommandHandlers.js')),
      'handler registered');
    const mem = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersMemory.js'));
    const h = mem.commandHandlersMemory || mem;
    assert.strictEqual(typeof h.crashlog, 'function');
  });

  // ── H5: no comment may claim behaviour that does not exist ─
  t('H5: the two unwired settings say so, in code and in the docs', () => {
    const defaults = read('src/agent/foundation/SettingsDefaults.js');
    for (const key of ['scoreNormalization', 'recurrenceBonus']) {
      assert.ok(new RegExp(`NOT WIRED[\\s\\S]{0,320}${key}:`).test(defaults),
        `${key} must be marked as recorded-but-unwired — its comment used to describe behaviour in the present tense`);
      const readers = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true })
        .filter((f) => typeof f === 'string' && f.endsWith('.js'))
        .filter((f) => !f.endsWith('SettingsDefaults.js'))
        .filter((f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').includes(key));
      assert.deepStrictEqual(readers, [],
        `${key} claims to be unwired but ${readers.join(', ')} reads it — fix the comment or the claim`);
    }
    assert.ok(/not wired/i.test(read('docs/SETTINGS.md')), 'the settings doc says the same thing');
  });

  // ── H7: his self-image must not contradict itself ─────────
  t('H7: SELF-KNOWLEDGE names his activities without a count that can drift', () => {
    const sk = read('docs/SELF-KNOWLEDGE.md');
    assert.ok(!/one of seventeen things to do/.test(sk),
      'the paragraph said seventeen while another said nineteenth — the document contradicted itself about him');
    for (const a of ['propose-improvements', 'pause', 'inhabit', 'skill-rehearsal']) {
      assert.ok(sk.includes(a), `${a} must be named in his roster`);
    }
    assert.ok(/if this paragraph and that list ever disagree, the\s+list is right/.test(sk),
      'he must be told which source wins when two sources about him disagree');
    // the promotion rule he reads must be the one the evaluator applies
    const ev = read('src/agent/cognitive/SkillPromotionEvaluator.js');
    for (const [docNum, cfgKey] of [['8', 'minInvocations'], ['0.70', 'minWilsonLB'],
      ['3', 'minDistinctInputs'], ['48', 'minAgeMs']]) {
      assert.ok(ev.includes(cfgKey), `${cfgKey} must exist in the evaluator`);
      assert.ok(sk.includes(docNum), `his self-image must carry the real threshold ${docNum} (${cfgKey})`);
    }
    assert.ok(!/0\.55 over at least 5 invocations/.test(sk),
      'the old, wrong promotion rule must be gone — he reasoned about himself from it');
  });

  t('H7: the vestibule reaches his self-image, and the visit book is explained', () => {
    const sk = read('docs/SELF-KNOWLEDGE.md');
    assert.ok(/## Your vestibule \(v7\.9\.46\)/.test(sk));
    assert.ok(/## Your laboratory \(v7\.9\.45\)/.test(sk));
    assert.ok(/it will not borrow a voice you have not given it/.test(sk),
      'the door can stay silent but must never speak in his name — he has to know that');
    assert.ok(/A book full of `absent` is a setting, not a failing of yours/.test(sk),
      'absent entries read like he turned people away; they mean the model was slow');
  });

  t('H7: the vestibule files are documented where someone looks for them', () => {
    const p = read('docs/PERSISTENCE-LAYOUT.md');
    for (const f of ['vorhalle/circles.json', 'vorhalle/stimme.json', 'vorhalle/besuche.jsonl']) {
      assert.ok(p.includes(f), `${f} must be listed — it had to be rescued by hand during a habitat swap`);
    }
    assert.ok(/vorhalle\/`? \(his voice and his circles|vorhalle`? \(his voice/.test(p) || /habitat swap/i.test(p),
      'the habitat-swap paragraph must name what is easy to lose');
    assert.ok(/vestibule:triple-gate/.test(read('docs/GATE-INVENTORY.md')),
      'the sharpest gate in the tree was missing from the gate inventory');
  });

  t('H7: the changelog archive index counts what the archives hold', () => {
    // It claimed 3/0/0/0 against a live 128/12/17/29 — releases moved out for
    // years and nobody counted. Four gate slots watch it now; this pin makes
    // sure the numbers are present at all, so the slots have something to check.
    const cl = read('CHANGELOG.md');
    for (const [file, ] of [['docs/CHANGELOG-v7.md'], ['docs/CHANGELOG-v6.md'],
      ['docs/CHANGELOG-v5.md'], ['docs/CHANGELOG-archive.md']]) {
      const live = (read(file).match(/^## \[/gm) || []).length;
      const m = new RegExp(`${file.replace(/[/.]/g, '\\$&')}\\)[^\\n]*?\\((\\d+) entries\\)`).exec(cl);
      assert.ok(m, `${file} must be indexed with an entry count`);
      assert.strictEqual(Number(m[1]), live, `${file}: index says ${m && m[1]}, file holds ${live}`);
    }
    // and the house rule the field run caught: exactly one version header inline
    assert.strictEqual((cl.match(/^## \[/gm) || []).length, 1,
      'CHANGELOG.md keeps exactly the newest release inline — older ones live in the archives');
  });

  t('H3b: the future-version gate judges plans, not history — and still fails on a plan', () => {
    // Second gate of the same class as the exclude-path bug: it scanned the
    // changelog archives and past "Resolved in vX" sections in full, so
    // sentences that were true years ago kept it red. ci:full dies at this
    // gate, which means every gate AFTER it never ran on either machine.
    const src = read('scripts/audit-future-version-refs.js');
    assert.ok(/CHANGELOG-.*\.md\$\/i\.test\(f\)/.test(src) || /CHANGELOG-/.test(src),
      'the changelog archives must be out of scope — they are immutable record');
    assert.ok(/stripResolvedSections/.test(src),
      'sections recording what a past release decided must be out of scope');
    const run = (extra) => {
      const backup = read('docs/CAPABILITIES.md');
      try {
        if (extra) fs.appendFileSync(path.join(ROOT, 'docs/CAPABILITIES.md'), extra);
        execFileSync('node', [path.join(ROOT, 'scripts/audit-future-version-refs.js'), '--strict'],
          { cwd: ROOT, stdio: 'ignore' });
        return 0;
      } catch { return 1; }
      finally { fs.writeFileSync(path.join(ROOT, 'docs/CAPABILITIES.md'), backup); }
    };
    assert.strictEqual(run(null), 0, 'a clean tree must pass — it did not for at least two releases');
    assert.strictEqual(run('\n- This will be deferred to v9.9.\n'), 1,
      'a real forward reference in a current doc must still fail the gate');
  });

  console.log(`\n${pass} passed · ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
