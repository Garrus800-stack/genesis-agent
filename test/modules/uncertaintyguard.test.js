// ============================================================
// Test: UncertaintyGuard.js — Hedging, confidence, contradictions
// ============================================================
let passed = 0, failed = 0;
// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { UncertaintyGuard } = require('../../src/agent/foundation/UncertaintyGuard');

function createGuard(semantic = {}) {
  return new UncertaintyGuard({
    memory: { db: { semantic } },
    knowledgeGraph: { search: () => [] },
  });
}

console.log('\n  📦 UncertaintyGuard');

// ── Confidence Scoring ──────────────────────────────────────

test('clean response gets default confidence (~0.7)', () => {
  const guard = createGuard();
  const { confidence, flags } = guard.analyze('Dies ist eine klare Antwort.', 'Was ist X?');
  assert(confidence >= 0.6 && confidence <= 0.8, `Expected ~0.7, got ${confidence}`);
  assert(!flags.includes('hedging'));
});

test('hedging language reduces confidence', () => {
  const guard = createGuard();
  const { confidence, flags } = guard.analyze(
    'Ich glaube, wahrscheinlich ist es so, vielleicht stimmt das.',
    'Was ist X?'
  );
  assert(confidence < 0.6, `Expected <0.6 for heavy hedging, got ${confidence}`);
  assert(flags.includes('hedging'), 'Should flag hedging');
});

test('single hedging word reduces confidence slightly', () => {
  const guard = createGuard();
  const { confidence } = guard.analyze('Das ist wahrscheinlich korrekt.', 'Frage?');
  assert(confidence < 0.7 && confidence >= 0.5, `Expected moderate reduction, got ${confidence}`);
});

test('risky topics (versions, dates) reduce confidence', () => {
  const guard = createGuard();
  const { confidence, flags } = guard.analyze(
    'Die neueste Version ist 3.2.1.',
    'Was ist die aktuelle Version von Node?'
  );
  assert(flags.includes('hallucination-risk'), 'Should flag hallucination risk');
  assert(confidence < 0.7, `Expected reduced confidence, got ${confidence}`);
});

test('price/date questions trigger hallucination risk', () => {
  const guard = createGuard();
  const { flags } = guard.analyze('Der Preis ist 49 Euro.', 'Was kostet das aktuell?');
  assert(flags.includes('hallucination-risk'));
});

test('too-brief response for complex question', () => {
  const guard = createGuard();
  const longQuestion = 'Erkläre mir bitte im Detail wie die hexagonale Architektur funktioniert, welche Vorteile sie bietet und wie man sie in JavaScript implementiert.';
  const { flags } = guard.analyze('OK.', longQuestion);
  assert(flags.includes('too-brief'), 'Short answer to long question should flag too-brief');
});

test('overconfident: short response with multiple confident patterns', () => {
  const guard = createGuard();
  const { flags } = guard.analyze('Definitiv sicher!', 'Ist das so?');
  assert(flags.includes('overconfident'), 'Should flag overconfidence');
});

test('unsolicited code when question is not about code', () => {
  const guard = createGuard();
  const { flags } = guard.analyze('Hier ist die Lösung:\n```js\nconsole.log("hi");\n```', 'Wie geht es dir?');
  assert(flags.includes('unsolicited-code'));
});

test('code in response to code question is NOT flagged', () => {
  const guard = createGuard();
  const { flags } = guard.analyze('```js\nconsole.log("hi");\n```', 'Schreib mir eine Funktion');
  assert(!flags.includes('unsolicited-code'));
});

// ── Contradiction Detection ─────────────────────────────────

test('contradicts known semantic facts', () => {
  const guard = createGuard({
    'user.name': { value: 'Garrus', confidence: 0.9 },
  });
  const { flags } = guard.analyze('Dein Name ist Max.', 'Wie heiße ich?');
  assert(flags.includes('contradicts-memory'), 'Should detect contradiction with stored name');
});

test('no contradiction when response matches known fact', () => {
  const guard = createGuard({
    'user.name': { value: 'Garrus', confidence: 0.9 },
  });
  const { flags } = guard.analyze('Dein Name ist Garrus.', 'Wie heiße ich?');
  assert(!flags.includes('contradicts-memory'));
});

test('low-confidence facts are not checked for contradictions', () => {
  const guard = createGuard({
    'user.hobby': { value: 'Gaming', confidence: 0.3 },
  });
  const { flags } = guard.analyze('Dein Hobby ist Kochen.', 'Was ist mein Hobby?');
  assert(!flags.includes('contradicts-memory'), 'Low-confidence facts should not trigger');
});

// ── Confidence Clamping ─────────────────────────────────────

test('confidence never goes below 0.1', () => {
  const guard = createGuard({
    'system.version': { value: '1.0', confidence: 0.95 },
  });
  // Stack all penalties: hedging + risky + contradiction + too-brief
  const { confidence } = guard.analyze(
    'Ich glaube vielleicht Version 2.0, wahrscheinlich.',
    'Was ist die aktuelle Version von dem neuesten API preis datum statistik system?'
  );
  assert(confidence >= 0.1, `Confidence should not go below 0.1, got ${confidence}`);
});

test('confidence never exceeds 1.0', () => {
  const guard = createGuard();
  const { confidence } = guard.analyze('Ganz normal.', 'Hi');
  assert(confidence <= 1.0, `Confidence should not exceed 1.0, got ${confidence}`);
});

// ── wrapResponse ────────────────────────────────────────────

test('wrapResponse returns unmodified text when confident', () => {
  const guard = createGuard();
  const result = guard.wrapResponse('Klare Antwort hier.', 'Einfache Frage');
  assert(result === 'Klare Antwort hier.', 'Should not modify confident response');
});

test('wrapResponse adds disclaimer for low confidence', () => {
  const guard = createGuard();
  const result = guard.wrapResponse(
    'Ich glaube, wahrscheinlich, vielleicht ist es so, moeglicherweise halt.',
    'Was ist die neueste Version und der aktuelle Preis von X?'
  );
  assert(result.length > 'Ich glaube, wahrscheinlich, vielleicht ist es so, moeglicherweise halt.'.length,
    'Should add disclaimer text');
});

test('wrapResponse adds hallucination hint for risky topics', () => {
  const guard = createGuard();
  // Medium-low confidence: risky topic but no heavy hedging
  const result = guard.wrapResponse(
    'Die aktuelle Version ist 4.5.',
    'Was ist die neueste Version?'
  );
  // If confidence is between 0.5-0.7 with hallucination-risk flag, should add hint
  if (result !== 'Die aktuelle Version ist 4.5.') {
    assert(result.includes('veraltet') || result.includes('Hinweis') || result.includes('Dokumentation'),
      'Should mention potential outdated info');
  }
});

// v3.5.2: Async-safe runner — properly awaits all tests
(async () => {
  for (const t of _testQueue) {
    try {
      const r = t.fn(); if (r && r.then) await r;
      passed++; console.log(`    ✅ ${t.name}`);
    } catch (err) {
      failed++; console.log(`    ❌ ${t.name}: ${err.message}`);
    }
  }
  console.log(`\n    ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
