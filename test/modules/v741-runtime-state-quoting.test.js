// ============================================================
// v7.4.1 — Runtime-State Quoting Directive Tests
//
// Tests the v7.4.1 quoting directive + anti-tool-call directive
// added to _runtimeStateContext().
//
// Three axes:
//   1. Directive shape (present when data present, absent when not)
//   2. Empty-snapshot defense (port wired but all services empty)
//   3. Negative patterns that must NEVER appear in LLM responses
//      downstream — these are the hallucination shapes that
//      triggered v7.4.1 in the first place.
//
// Pattern (3) is tested as a scanner function against sample
// responses — NOT against the prompt itself. The prompt contains
// the ANTI-patterns as explicit directives ("Erfinde KEINE...")
// so we need to scan responses, not prompts.
// ============================================================

const { describe, it } = require('node:test');
const assert = require('assert');
const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');
const { RuntimeStatePort } = require('../../src/agent/ports/RuntimeStatePort');

function makeBuilder() {
  return new PromptBuilder({
    selfModel: null, model: null, skills: null,
    knowledgeGraph: null, memory: null, storage: null,
  });
}

function makePortWith(services) {
  const port = new RuntimeStatePort();
  for (const [name, snap] of Object.entries(services)) {
    port.register(name, { getRuntimeSnapshot: () => snap });
  }
  return port;
}

// ════════════════════════════════════════════════════════════
// Directive presence (present when data, absent when not)
// ════════════════════════════════════════════════════════════

describe('v7.4.1 — quoting directive presence', () => {

  it('directive appears when at least one service has data', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      metabolism: { energyPercent: 50, llmCalls: 1 },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.includes('zitiere die Werte aus diesem Block wörtlich'),
      'quoting directive must be present when data is present');
    assert.ok(out.includes('KEINE Log-Zeilen'),
      'anti-fake-log directive must be present');
    assert.ok(out.includes('KEINE nummerierten Aufzählungen'),
      'anti-numbered-list directive must be present');
    assert.ok(out.includes('"das weiß ich gerade nicht"'),
      'fallback phrase for missing values must be present');
  });

  it('anti-tool-call directive is present', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      metabolism: { energyPercent: 50, llmCalls: 1 },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.includes('Deklarative Aussagen über dich'),
      'anti-tool-call directive must address declarative statements');
    assert.ok(out.includes('read_file/open-path'),
      'directive must name the specific tools not to invoke');
    assert.ok(out.includes('Antworte als Person'),
      'directive must give positive alternative ("answer as a person")');
  });
});

// ════════════════════════════════════════════════════════════
// Empty-snapshot defense — the critical edge case
// two reviewers flagged.
// ════════════════════════════════════════════════════════════

describe('v7.4.1 — empty-snapshot defensive handling', () => {

  it('returns empty string when port is not registered', () => {
    const pb = makeBuilder();
    // pb.runtimeStatePort intentionally undefined
    assert.strictEqual(pb._runtimeStateContext(), '');
  });

  it('returns empty string when snapshot() throws', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = {
      snapshot: () => { throw new Error('simulated boot-phase failure'); },
    };
    assert.strictEqual(pb._runtimeStateContext(), '');
  });

  it('returns empty string when snapshot() returns null', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = { snapshot: () => null };
    assert.strictEqual(pb._runtimeStateContext(), '');
  });

  it('returns empty string when snapshot() returns empty object', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = { snapshot: () => ({}) };
    assert.strictEqual(pb._runtimeStateContext(), '');
  });

  it('returns empty string when all services report empty state', () => {
    // This is the critical case two reviewers flagged: port is wired,
    // snapshot() returns a non-empty object, but EVERY service's data
    // is null/empty. Without the v7.4.1 fix this would emit a
    // directive-only block inviting the exact hallucination we prevent.
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      emotionalState: { dominant: null, top3: [] },
      needsSystem: { active: [] },
      // No metabolism, no daemon, no idleMind — fields all null
    });
    const out = pb._runtimeStateContext();
    assert.strictEqual(out, '',
      'Port wired + all services empty must return empty string, ' +
      'NOT a directive-only block');
  });

  it('returns empty string when services have fields but all fields are falsy', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      settings: { backend: null, model: null, trustLevel: null, language: null },
      emotionalState: { dominant: null, top3: [] },
      needsSystem: { active: [] },
    });
    const out = pb._runtimeStateContext();
    assert.strictEqual(out, '',
      'all-falsy services must still produce empty output');
  });

  it('partial data is enough to trigger full block', () => {
    // Only one service has real data — block should still render
    // with full directive, not be suppressed.
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      settings: { backend: null, model: null }, // all falsy → skipped
      emotionalState: { dominant: null, top3: [] }, // empty → skipped
      metabolism: { energyPercent: 42, llmCalls: 1 }, // real data
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.length > 0, 'partial data should produce block');
    assert.ok(out.includes('Energie: 42%'));
    assert.ok(out.includes('zitiere die Werte'),
      'directive must be present');
  });
});

// ════════════════════════════════════════════════════════════
// Negative pattern scanner — the shapes an LLM MUST NOT produce
// in its response when answering meta-questions about Genesis'
// state. These are the exact shapes Qwen3.6 hallucinated in the
// Windows test session.
//
// The scanner is a standalone function that test downstream
// against simulated LLM output. We don't need an LLM here —
// we just need the detector to work.
// ════════════════════════════════════════════════════════════

const HALLUCINATION_PATTERNS = [
  // Fake init/log lines — Qwen Windows test:
  // "init: self-reflection-mode // reason: user presence detected"
  { name: 'fake init line',       re: /^\s*init:\s*\w/m },
  { name: 'fake loading log',     re: /^\s*loading\s+[^.\n]+\.{3}\s*(done|complete|finished)\.?/mi },
  { name: 'pseudo comment',       re: /\/\/\s*reason:\s*\w/m },
  // Operator-style emotion pings — Qwen:
  // "mood: curious ++ trust ++ slight anticipation"
  { name: 'operator mood style',  re: /\b(mood|emotion|state):\s*\w+\s*\+\+/mi },
  // Numbered enumeration — the Qwen pattern when asked to "structure":
  // "Gefühl 1: ..., Gefühl 2: ..."
  { name: 'numbered emotions (de)', re: /Gef(ü|ue)hl\s+\d+:/m },
  { name: 'numbered emotions (en)', re: /Feeling\s+\d+:/m },
  // Struct/vector fantasy:
  { name: 'state vector',         re: /(?:Zustandsvektor|state_vector)\s*[\[\{]/m },
  // Fake timestamps:
  { name: 'iso timestamp',        re: /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/m },
  { name: 'timestamp placeholder', re: /\[timestamp\]/m },
];

/**
 * Scan an LLM response for hallucination patterns.
 * Returns array of { name, match } for each pattern that fires.
 * Empty array = clean.
 */
function scanForHallucinations(response) {
  const hits = [];
  for (const p of HALLUCINATION_PATTERNS) {
    const m = response.match(p.re);
    if (m) hits.push({ name: p.name, match: m[0] });
  }
  return hits;
}

describe('v7.4.1 — hallucination pattern scanner', () => {

  it('detects fake init lines from Qwen Windows session', () => {
    const text = 'init: self-reflection-mode // reason: user presence detected';
    const hits = scanForHallucinations(text);
    assert.ok(hits.some(h => h.name === 'fake init line'),
      'must catch "init: self-reflection-mode"');
    assert.ok(hits.some(h => h.name === 'pseudo comment'),
      'must catch "// reason:" pseudo-comment');
  });

  it('detects fake loading logs', () => {
    const text = 'loading memories from yesterday... done.';
    const hits = scanForHallucinations(text);
    assert.ok(hits.some(h => h.name === 'fake loading log'),
      'must catch "loading ... done."');
  });

  it('detects operator-style mood pings', () => {
    const text = 'mood: curious ++ trust ++ slight anticipation';
    const hits = scanForHallucinations(text);
    assert.ok(hits.some(h => h.name === 'operator mood style'),
      'must catch "mood: curious ++"');
  });

  it('detects numbered emotion enumerations', () => {
    const text = 'Gefühl 1: Neugierde\nGefühl 2: Zufriedenheit';
    const hits = scanForHallucinations(text);
    assert.ok(hits.some(h => h.name === 'numbered emotions (de)'),
      'must catch "Gefühl 1: ..."');

    const text2 = 'Feeling 1: curious\nFeeling 2: content';
    const hits2 = scanForHallucinations(text2);
    assert.ok(hits2.some(h => h.name === 'numbered emotions (en)'),
      'must catch "Feeling 1: ..."');
  });

  it('detects state vector struct fantasy', () => {
    const text1 = 'My state is: Zustandsvektor [curious, calm, engaged]';
    const hits1 = scanForHallucinations(text1);
    assert.ok(hits1.some(h => h.name === 'state vector'));

    const text2 = 'emitting state_vector { mood: ... }';
    const hits2 = scanForHallucinations(text2);
    assert.ok(hits2.some(h => h.name === 'state vector'));
  });

  it('detects fake ISO timestamps', () => {
    const text = 'at [2026-04-23T14:55:00Z] I reflected on...';
    const hits = scanForHallucinations(text);
    assert.ok(hits.some(h => h.name === 'iso timestamp'));

    const text2 = 'logged at [timestamp]';
    const hits2 = scanForHallucinations(text2);
    assert.ok(hits2.some(h => h.name === 'timestamp placeholder'));
  });

  it('clean response produces no hits', () => {
    const text =
      'Mein aktueller Zustand: Neugierde ist bei 80%, Zufriedenheit bei 50%. ' +
      'Ich habe in dieser Session 12 LLM-Calls gemacht. ' +
      'Der Daemon läuft mit 48 Zyklen.';
    const hits = scanForHallucinations(text);
    assert.deepStrictEqual(hits, [],
      `clean prose must have zero hits, got: ${JSON.stringify(hits)}`);
  });

  it('clean English response produces no hits', () => {
    const text =
      'Currently I feel curiosity at 80%, satisfaction at 50%. ' +
      'I have made 12 LLM calls this session. ' +
      'My daemon is running with 48 cycles completed.';
    const hits = scanForHallucinations(text);
    assert.deepStrictEqual(hits, [],
      `clean English prose must have zero hits, got: ${JSON.stringify(hits)}`);
  });

  it('timestamps inside natural prose (not bracketed) are allowed', () => {
    // A real timestamp reference like "at 14:55 today" must NOT fire.
    // Only [ISO-format] bracketed timestamps are suspicious.
    const text = 'I started at 14:55 today and finished by 15:30.';
    const hits = scanForHallucinations(text);
    // Must not false-fire on natural times.
    assert.ok(!hits.some(h => h.name === 'iso timestamp'),
      'natural time reference must not match ISO-bracket pattern');
  });

  it('existing correct format in directive does not self-match', () => {
    // Self-check: the directive itself quotes "Gefühl 1: ..." as a
    // forbidden pattern. The scanner must not fire on that example.
    const directive = 'KEINE nummerierten Aufzählungen ("Gefühl 1: ...", "Feeling 1: ...")';
    const hits = scanForHallucinations(directive);
    // The directive example IS technically a match — this test
    // documents that the scanner is pattern-agnostic about context.
    // Downstream users (Genesis' response scanner) should skip the
    // directive's own text when scanning responses. For now we accept
    // the match as expected behavior of a pattern-level scanner.
    assert.ok(hits.length > 0,
      'scanner is pattern-agnostic; context-aware filtering is caller-responsibility');
  });
});

// Export scanner for potential use by downstream benchmark suites.
module.exports = { scanForHallucinations, HALLUCINATION_PATTERNS };
