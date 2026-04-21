// ============================================================
// v7.3.6 #8 — TF-IDF Library & CapabilityMatcher cosine-similarity
// ============================================================

const assert = require('assert');
const { describe, test, run } = require('../harness');

const tfidf = require('../../src/agent/core/tfidf');
const CapabilityMatcher = require('../../src/agent/planning/CapabilityMatcher');

describe('#8 tfidf — tokenize', () => {
  test('basic tokenization', () => {
    const t = tfidf.tokenize('Hello world from Genesis');
    assert(t.includes('hello'));
    assert(t.includes('world'));
    assert(t.includes('genesis'));
  });

  test('filters stop-words', () => {
    const t = tfidf.tokenize('the quick and brown fox');
    // "the", "and" are English stop-words in the library
    assert(!t.includes('the'));
    assert(!t.includes('and'));
    assert(t.includes('quick'));
  });

  test('filters German stop-words', () => {
    const t = tfidf.tokenize('der schnelle braune Fuchs und die faule Katze');
    assert(!t.includes('der'));
    assert(!t.includes('die'));
    assert(!t.includes('und'));
    assert(t.includes('schnelle'));
  });

  test('Unicode-aware: keeps Umlauts intact', () => {
    const t = tfidf.tokenize('Müller Fähigkeit café señal');
    assert(t.includes('müller'), `expected "müller" in ${JSON.stringify(t)}`);
    assert(t.includes('fähigkeit'));
    assert(t.includes('café'));
  });

  test('filters length < 3', () => {
    const t = tfidf.tokenize('a bb ccc dddd');
    assert(!t.includes('a'));
    assert(!t.includes('bb'));
    assert(t.includes('ccc'));
    assert(t.includes('dddd'));
  });

  test('empty / null input returns []', () => {
    assert.deepStrictEqual(tfidf.tokenize(''), []);
    assert.deepStrictEqual(tfidf.tokenize(null), []);
    assert.deepStrictEqual(tfidf.tokenize(undefined), []);
  });
});

describe('#8 tfidf — buildVocabulary', () => {
  test('builds vocab over corpus', () => {
    const v = tfidf.buildVocabulary([
      'homeostasis regulates state',
      'dream cycle consolidates memory',
    ]);
    assert(v.vocab.length > 0);
    assert(typeof v.vocabIndex === 'object');
    assert(typeof v.idf === 'object');
    assert.strictEqual(v.docCount, 2);
  });

  test('IDF: rare words weigh more than common ones', () => {
    const v = tfidf.buildVocabulary([
      'common word here',
      'common word there',
      'common word everywhere',
      'homeostasis is rare',
    ]);
    // Find the stem for "homeostasis" in the vocab (depends on stemmer)
    const rareKey = v.vocab.find(w => w.startsWith('homeosta'));
    assert(rareKey, `expected a homeost* stem in vocab: ${JSON.stringify(v.vocab)}`);
    const idfCommon = v.idf['common'];
    const idfRare = v.idf[rareKey];
    assert(idfRare > idfCommon, `rare IDF ${idfRare} should be > common IDF ${idfCommon}`);
  });

  test('empty corpus returns empty vocab', () => {
    const v = tfidf.buildVocabulary([]);
    assert.strictEqual(v.vocab.length, 0);
    assert.strictEqual(v.docCount, 0);
  });

  test('minDocFreq drops rare terms', () => {
    const v = tfidf.buildVocabulary(
      ['alpha beta', 'alpha gamma', 'alpha delta'],
      { minDocFreq: 2 }
    );
    assert(v.vocab.includes('alpha'));  // in 3 docs
    // Note: after stemming "beta"→"beta" stays; but in just 1 doc
    assert(!v.vocab.includes('beta'));
  });
});

describe('#8 tfidf — textToVector & cosineSimilarity', () => {
  test('vector has correct length', () => {
    const v = tfidf.buildVocabulary(['alpha beta gamma']);
    const vec = tfidf.textToVector('alpha', v);
    assert.strictEqual(vec.length, v.vocab.length);
  });

  test('unknown word → zero vector', () => {
    const v = tfidf.buildVocabulary(['alpha beta']);
    const vec = tfidf.textToVector('zzzunknownword', v);
    assert.strictEqual(vec.length, v.vocab.length);
    const allZero = Array.from(vec).every(x => x === 0);
    assert(allZero, 'unknown-only text should produce zero vector');
  });

  test('cosine similarity 1.0 for identical text', () => {
    const v = tfidf.buildVocabulary(['homeostasis feedback loop', 'dream cycle memory']);
    const a = tfidf.textToVector('homeostasis feedback loop', v);
    const b = tfidf.textToVector('homeostasis feedback loop', v);
    const sim = tfidf.cosineSimilarity(a, b);
    assert(Math.abs(sim - 1.0) < 0.001, `expected ~1.0, got ${sim}`);
  });

  test('cosine similarity 0 for orthogonal (no shared words)', () => {
    const v = tfidf.buildVocabulary(['apple orange banana', 'keyboard monitor mouse']);
    const a = tfidf.textToVector('apple orange banana', v);
    const b = tfidf.textToVector('keyboard monitor mouse', v);
    const sim = tfidf.cosineSimilarity(a, b);
    assert.strictEqual(sim, 0);
  });

  test('cosine 0 for zero vectors (safe, not NaN)', () => {
    const a = new Float64Array(5);
    const b = new Float64Array(5);
    assert.strictEqual(tfidf.cosineSimilarity(a, b), 0);
  });

  test('mismatched lengths → 0', () => {
    const a = new Float64Array(3);
    const b = new Float64Array(5);
    assert.strictEqual(tfidf.cosineSimilarity(a, b), 0);
  });

  test('rare-word match scores higher than common-word match', () => {
    // Corpus where "system" is common and "homeostasis" is rare
    const corpus = [
      'system runs system starts system stops',
      'another system config',
      'system again',
      'homeostasis regulation',
    ];
    const v = tfidf.buildVocabulary(corpus);
    const goalA = tfidf.textToVector('system things', v);
    const goalB = tfidf.textToVector('homeostasis thing', v);
    const target = tfidf.textToVector('system and homeostasis together', v);

    const simA = tfidf.cosineSimilarity(goalA, target);
    const simB = tfidf.cosineSimilarity(goalB, target);
    // "homeostasis" being rare should dominate
    assert(simB > simA, `rare match (${simB}) should beat common match (${simA})`);
  });
});

describe('#8 CapabilityMatcher — TF-IDF integration', () => {
  const MOCK_CAPS = [
    {
      id: 'homeostasis',
      name: 'Homeostasis',
      description: 'Organism regulates its own state via feedback loops',
      keywords: ['homeostasis', 'homeostatic', 'regulate', 'state', 'feedback', 'throttle', 'stabilize', 'effector'],
    },
    {
      id: 'dream-cycle',
      name: 'Dream Cycle',
      description: 'Memory consolidation during idle time',
      keywords: ['dream', 'cycle', 'memory', 'consolidation', 'idle', 'sleep'],
    },
  ];

  test('returns new shape {score, matched, decision}', () => {
    const r = CapabilityMatcher.match('regulate state via feedback', MOCK_CAPS);
    assert(typeof r.score === 'number');
    assert(r.matched !== undefined);
    assert(['pass', 'grey', 'block'].includes(r.decision));
  });

  test('long duplicate goal — clear match to homeostasis', () => {
    const r = CapabilityMatcher.match(
      'Implement homeostatic throttling to regulate state via feedback for stabilize effectors organism',
      MOCK_CAPS,
    );
    assert.strictEqual(r.matched.id, 'homeostasis');
    assert(r.score >= 0.4, `expected ≥0.4, got ${r.score}`);
  });

  test('truly novel goal → pass', () => {
    const r = CapabilityMatcher.match('Learn to cook Italian pasta', MOCK_CAPS);
    assert.strictEqual(r.decision, 'pass');
  });

  test('short goal with stem-divergent forms → rescued by prefix-fallback', () => {
    // "Homeostatic" stems to "homeostat", keyword "homeostasis" stems
    // to "homeostas" — TF-IDF alone treats them as different. The
    // prefix-rescue (cosine<PASS and short goal) catches the match.
    const r = CapabilityMatcher.match('Implement Homeostatic Throttling', MOCK_CAPS);
    assert(r.matched, `expected match via prefix-rescue, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.matched.id, 'homeostasis');
  });

  test('empty capabilities → pass', () => {
    const r = CapabilityMatcher.match('anything', []);
    assert.strictEqual(r.decision, 'pass');
    assert.strictEqual(r.matched, null);
  });

  test('null/undefined inputs → graceful pass', () => {
    assert.strictEqual(CapabilityMatcher.match(null, MOCK_CAPS).decision, 'pass');
    assert.strictEqual(CapabilityMatcher.match('', MOCK_CAPS).decision, 'pass');
    assert.strictEqual(CapabilityMatcher.match('goal', null).decision, 'pass');
  });

  test('BLOCK threshold is 0.75 (cosine-calibrated, lowered from 0.8 Jaccard)', () => {
    assert.strictEqual(CapabilityMatcher.THRESHOLDS.BLOCK, 0.75);
    assert.strictEqual(CapabilityMatcher.THRESHOLDS.PASS, 0.4);
  });
});

run();
