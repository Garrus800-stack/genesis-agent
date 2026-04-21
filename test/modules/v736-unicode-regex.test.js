// ============================================================
// v7.3.6 #10 — Unicode-Regex für Umlaute und andere Latin-Script-Zeichen
//
// Bestehende \W und [^a-z0-9äöüß\s]-Patterns verstümmelten nicht-ASCII
// Eingaben: "Müller" wurde [M, ller], "Fähigkeit" [F, higkeit], und
// Texte mit é/à/ñ/ó verloren diese Buchstaben. Der Fix ersetzt die
// Patterns durch \p{L}\p{N} mit /u-Flag, sodass alle Unicode-Buchstaben
// und -Ziffern als Token-Inneres erkannt werden.
// ============================================================

const assert = require('assert');
const { describe, test, run } = require('../harness');

describe('Research._scoreResearchInsight — Unicode tokenization', () => {
  const { _scoreResearchInsight } = require('../../src/agent/autonomy/activities/Research');

  test('German umlauts: "Müller" is kept as one token', () => {
    // If tokenization splits, insight about Müller would not match topic Müller
    const topic = { label: 'Müller Forschung', query: 'Müller Modelle' };
    const insight = 'Müller hat systematisch Müller-Modelle untersucht und in Müller-Kontexten verwendet.';
    const r = _scoreResearchInsight(insight, topic);
    // With broken tokenization, 'Müller' would split into 'M' + 'ller', and
    // no overlap would exist. Score would be near 0. With the fix, overlap
    // is high → score > 0.4 at minimum.
    assert(r.score > 0.3, `expected score > 0.3 for matching German topic, got ${r.score}`);
  });

  test('"Fähigkeit" as one token (not F+higkeit)', () => {
    const topic = { label: 'Fähigkeit Entwicklung', query: 'Fähigkeit' };
    const insight = 'Die Fähigkeit zur Fähigkeit-Erweiterung entwickelt sich über Fähigkeit-Tests.';
    const r = _scoreResearchInsight(insight, topic);
    assert(r.score > 0.2, `Fähigkeit overlap expected, got ${r.score}`);
  });

  test('French accents: "café" intact', () => {
    const topic = { label: 'café research', query: 'café' };
    const insight = 'The café scene in café-oriented research covers café-goers extensively.';
    const r = _scoreResearchInsight(insight, topic);
    assert(r.score > 0.2, `café overlap expected, got ${r.score}`);
  });

  test('Spanish ñ: "señal" intact', () => {
    const topic = { label: 'señal processing', query: 'señal' };
    const insight = 'La señal processing uses señal-analysis and señal-filtering frequently.';
    const r = _scoreResearchInsight(insight, topic);
    assert(r.score > 0.2, `señal overlap expected, got ${r.score}`);
  });

  test('short insight still returns 0 (regression check)', () => {
    const r = _scoreResearchInsight('Müller', { label: 'x', query: 'y' });
    assert.strictEqual(r.score, 0);
    assert.strictEqual(r.reason, 'too short');
  });
});

describe('LocalClassifier._tokenize — Unicode tokens', () => {
  const { LocalClassifier } = require('../../src/agent/intelligence/LocalClassifier');
  // Minimal stubs — _tokenize doesn't touch bus/storage at all, just pure text.
  const classifier = new LocalClassifier({
    bus: { on: () => () => {}, fire: () => {}, emit: () => {} },
    storage: null,
    config: {},
  });

  test('tokenize keeps German umlauts', () => {
    // Access the private method via prototype
    const tokens = classifier._tokenize('Müller hat Fähigkeiten über Möglichkeiten');
    assert(tokens.includes('müller'), `tokens should include "müller", got: ${tokens.join(',')}`);
    assert(tokens.includes('fähigkeiten'), `tokens should include "fähigkeiten", got: ${tokens.join(',')}`);
    assert(tokens.includes('möglichkeiten'), `tokens should include "möglichkeiten"`);
  });

  test('tokenize keeps French accents', () => {
    const tokens = classifier._tokenize('café naïve résumé');
    assert(tokens.includes('café'), `expected "café", got: ${tokens.join(',')}`);
    assert(tokens.includes('naïve'), `expected "naïve", got: ${tokens.join(',')}`);
    assert(tokens.includes('résumé'), `expected "résumé", got: ${tokens.join(',')}`);
  });

  test('tokenize keeps Spanish ñ', () => {
    const tokens = classifier._tokenize('señal mañana niño');
    assert(tokens.includes('señal'));
    assert(tokens.includes('mañana'));
    assert(tokens.includes('niño'));
  });

  test('tokenize splits on punctuation (positive control)', () => {
    const tokens = classifier._tokenize('Hello, world! Testing; the splitter.');
    // Punctuation should split
    assert(tokens.includes('hello'));
    assert(tokens.includes('world'));
    assert(tokens.includes('testing'));
    // No punctuation leaks in
    for (const t of tokens) {
      assert(!/[.,;!?]/.test(t), `token "${t}" contains punctuation`);
    }
  });

  test('tokenize filters too-short and too-long tokens', () => {
    const tokens = classifier._tokenize('a ab abc ' + 'x'.repeat(40));
    assert(!tokens.includes('a'), 'single chars filtered');
    assert(tokens.includes('ab') || tokens.includes('abc'), 'short-but-valid kept');
    assert(!tokens.some(t => t.length >= 30), 'over-long tokens filtered');
  });
});

describe('AutonomousDaemon topic normalization', () => {
  test('regex keeps Umlauts in topic string', () => {
    const regex = /[^\p{L}\p{N}\s-]/gu;
    const cleaned = 'Möchte Genesis über Künstliche Intelligenz forschen?'.replace(regex, '').trim();
    assert(/Möchte/.test(cleaned), 'Möchte kept');
    assert(/über/.test(cleaned), 'über kept');
    assert(/Künstliche/.test(cleaned), 'Künstliche kept');
    assert(!/[?]/.test(cleaned), 'punctuation stripped');
  });

  test('regex keeps French/Spanish letters', () => {
    const regex = /[^\p{L}\p{N}\s-]/gu;
    const cleaned = 'café au naïve señal — mañana?'.replace(regex, '').trim();
    assert(/café/.test(cleaned));
    assert(/naïve/.test(cleaned));
    assert(/señal/.test(cleaned));
    assert(/mañana/.test(cleaned));
    assert(!/[?—]/.test(cleaned));
  });

  test('regex keeps hyphens and whitespace', () => {
    const regex = /[^\p{L}\p{N}\s-]/gu;
    const cleaned = 'eine well-known Müller-Studie'.replace(regex, '').trim();
    assert(/well-known/.test(cleaned), 'hyphens preserved');
    assert(/Müller-Studie/.test(cleaned));
  });
});

describe('#10 Design-check — narrow ASCII paths unchanged', () => {
  // CloneFactory and SnapshotManager intentionally stay ASCII
  // because their output feeds into filesystems and URLs.
  // Document the contract here so nobody "fixes" them accidentally.

  test('CloneFactory clone names remain ASCII-safe (not touched)', () => {
    // Simulate the regex in CloneFactory:46
    const cleaned = 'Müller-Genesis'.replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    // Müller gets stripped to '-ller' because ü is non-ASCII.
    // This is INTENTIONAL — clone names become filesystem paths.
    assert(!/ü/.test(cleaned), 'umlauts intentionally removed for filesystem safety');
  });

  test('SnapshotManager safe names remain ASCII-safe (not touched)', () => {
    const cleaned = 'Snapshot Müller'.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    assert(!/ü/.test(cleaned), 'umlauts replaced with _ for path safety');
  });
});

run();
