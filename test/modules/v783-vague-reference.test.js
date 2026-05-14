// ============================================================
// GENESIS — test/modules/v783-vague-reference.test.js (v7.8.3)
//
// Tests for the VagueReferenceDetector (v7.5.8-backlog item):
// Catches "öffne das" / "open it" patterns where the user's
// pronoun has no antecedent. Soft-hint output; surfaced by
// PromptBuilderSectionsAwareness so Genesis asks instead of
// inventing a referent.
// ============================================================

'use strict';

const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

const { detectVagueReference } = require('../../src/agent/foundation/VagueReferenceDetector');

// ── Vague-detection happy path (DE) ─────────────────────────

test('DE: "öffne das" with empty history → vague', () => {
  const r = detectVagueReference('öffne das', []);
  assert.ok(r); assert.strictEqual(r.vague, true);
  assert.strictEqual(r.pronoun, 'das');
});

test('DE: "zeig es mir" → vague', () => {
  const r = detectVagueReference('zeig es mir', []);
  assert.ok(r); assert.strictEqual(r.pronoun, 'es');
});

test('DE: "starte das bitte" → vague', () => {
  const r = detectVagueReference('starte das bitte', []);
  assert.ok(r); assert.strictEqual(r.pronoun, 'das');
});

test('DE: "lösche das" → vague (lösche must trigger despite umlaut)', () => {
  const r = detectVagueReference('lösche das', []);
  assert.ok(r); assert.strictEqual(r.pronoun, 'das');
});

// ── Vague-detection happy path (EN) ─────────────────────────

test('EN: "open it" → vague', () => {
  const r = detectVagueReference('open it', []);
  assert.ok(r); assert.strictEqual(r.pronoun, 'it');
});

test('EN: "show that" → vague', () => {
  const r = detectVagueReference('show that', []);
  assert.ok(r); assert.strictEqual(r.pronoun, 'that');
});

test('EN: "open it for me" → vague (filler does not defeat)', () => {
  const r = detectVagueReference('open it for me', []);
  assert.ok(r); assert.strictEqual(r.pronoun, 'it');
});

// ── Antecedent in same message (must NOT flag) ──────────────

test('DE: "öffne die datei test.txt" → not vague (datei = antecedent)', () => {
  assert.strictEqual(detectVagueReference('öffne die datei test.txt', []), null);
});

test('EN: "open the file foo.md" → not vague (file = antecedent)', () => {
  assert.strictEqual(detectVagueReference('open the file foo.md', []), null);
});

test('DE: "zeig mir die funktion" → not vague (funktion = antecedent)', () => {
  assert.strictEqual(detectVagueReference('zeig mir die funktion', []), null);
});

test('EN: "load the skill" → not vague (skill = antecedent)', () => {
  assert.strictEqual(detectVagueReference('load the skill', []), null);
});

// ── Antecedent via quotes (must NOT flag) ───────────────────

test('DE: quoted name defeats vague: "öffne das \\"foo.txt\\""', () => {
  assert.strictEqual(detectVagueReference('öffne das "foo.txt"', []), null);
});

test('EN: quoted name defeats vague: "open it: \'config.json\'"', () => {
  assert.strictEqual(detectVagueReference("open it: 'config.json'", []), null);
});

// ── Antecedent in last 2 history turns ──────────────────────

test('DE: history within 2 turns provides antecedent', () => {
  const r = detectVagueReference('öffne das', [
    { content: 'ich habe eine datei erstellt' },
  ]);
  assert.strictEqual(r, null);
});

test('EN: history with "file" in last turn defeats vague', () => {
  const r = detectVagueReference('open it', [
    { content: 'I created a file' },
  ]);
  assert.strictEqual(r, null);
});

test('history older than 2 turns does NOT defeat vague', () => {
  const r = detectVagueReference('öffne das', [
    { content: 'datei foo' },  // 4 turns ago
    { content: 'hallo' },
    { content: 'wie gehts' },
    { content: 'gut' },
  ]);
  assert.ok(r, 'older history should not provide antecedent — pronoun still vague');
});

// ── Non-vague verbs / non-action sentences ──────────────────

test('"was meinst du damit" → not vague (no action verb)', () => {
  assert.strictEqual(detectVagueReference('was meinst du damit', []), null);
});

test('"wie geht es" → not vague (no action verb; "es" is idiomatic)', () => {
  assert.strictEqual(detectVagueReference('wie geht es', []), null);
});

test('"wie geht es dir" → not vague even with longer form', () => {
  assert.strictEqual(detectVagueReference('wie geht es dir', []), null);
});

test('"das ist gut" → not vague (no vague-action verb)', () => {
  assert.strictEqual(detectVagueReference('das ist gut', []), null);
});

// ── Defensive ───────────────────────────────────────────────

test('empty / null / non-string message returns null', () => {
  assert.strictEqual(detectVagueReference('', []), null);
  assert.strictEqual(detectVagueReference(null, []), null);
  assert.strictEqual(detectVagueReference(undefined, []), null);
  assert.strictEqual(detectVagueReference(42, []), null);
});

test('missing history defaults to no antecedent', () => {
  const r = detectVagueReference('öffne das');
  assert.ok(r); assert.strictEqual(r.pronoun, 'das');
});

// ── v7.8.3 follow-up (F4): extended antecedent detection ──────

test('contract: extended whitelist — "öffne das Buch" is NOT vague', () => {
  assert.strictEqual(detectVagueReference('öffne das Buch', []), null);
});

test('contract: extended whitelist — "zeig mir das Bild" is NOT vague', () => {
  assert.strictEqual(detectVagueReference('zeig mir das Bild', []), null);
});

test('contract: extended whitelist — "öffne die Email" is NOT vague', () => {
  assert.strictEqual(detectVagueReference('öffne die Email', []), null);
});

test('contract: extended whitelist — "lies das Foto" is NOT vague', () => {
  assert.strictEqual(detectVagueReference('lies das Foto', []), null);
});

test('contract: extended whitelist — "öffne das Video" is NOT vague', () => {
  assert.strictEqual(detectVagueReference('öffne das Video', []), null);
});

test('contract: filename-like in current message — "lade die notes.md hoch" is NOT vague', () => {
  assert.strictEqual(detectVagueReference('lade die notes.md hoch', []), null);
});

test('contract: filename-like in history — "öffne das" after "die test.txt" mention is NOT vague', () => {
  assert.strictEqual(
    detectVagueReference('öffne das', [{ role: 'user', content: 'die test.txt' }]),
    null
  );
});

test('contract: home-relative path in history — "öffne das" after "~/Documents/foo.pdf" is NOT vague', () => {
  assert.strictEqual(
    detectVagueReference('öffne das', [{ role: 'user', content: '~/Documents/foo.pdf' }]),
    null
  );
});

test('contract: Windows path in history — "öffne das" after "C:\\Users\\Garrus\\Desktop" is NOT vague', () => {
  assert.strictEqual(
    detectVagueReference('öffne das', [{ role: 'user', content: 'C:\\Users\\Garrus\\Desktop' }]),
    null
  );
});

test('contract: unix path in current message — "öffne das in /tmp/foo" is NOT vague', () => {
  assert.strictEqual(detectVagueReference('öffne das in /tmp/foo', []), null);
});

test('contract: filename takes precedence over no-context — "lade das foo.json" is NOT vague', () => {
  assert.strictEqual(detectVagueReference('lade das foo.json', []), null);
});

test('contract: still vague — "öffne das" with no concrete signal anywhere remains vague', () => {
  const r = detectVagueReference('öffne das', [
    { role: 'user', content: 'irgendwas vages ohne konkretes' },
    { role: 'assistant', content: 'ok' },
  ]);
  assert.ok(r); assert.strictEqual(r.pronoun, 'das');
});

test('contract: false-extension guard — "öffne das z.B. später" is NOT mistaken for filename', () => {
  // 'z.B.' shouldn't be a filename. The extension list is narrow,
  // 'b.' is not in it, so the abbreviation passes through. The
  // sentence is genuinely vague (no concrete antecedent), so the
  // expected result is vague.
  const r = detectVagueReference('öffne das z.B. später', []);
  assert.ok(r, 'should remain vague (no concrete antecedent)');
});

// ── summary ────────────────────────────────────────────────

if (failed > 0) {
  console.log(`\n  ${failed} failure(s):`);
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`    ${passed} passed`);
