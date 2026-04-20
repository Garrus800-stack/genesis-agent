// Test: O-6 branch coverage push (v7.3.4)
// Targets: _identity fallback path and _scoreResearchInsight edge cases.
// Opened since v7.2.0 — closes the gap so coverage stays ≥76%.
const { describe, test, run } = require('../harness');
const { sections } = require('../../src/agent/intelligence/PromptBuilderSections');
const research = require('../../src/agent/autonomy/activities/Research');

describe('O-6: _identity fallback', () => {
  test('fallback path when self-identity.json is missing', () => {
    // Minimal mock: no self-identity, no user.name, no selfModel, no model
    const ctx = {
      memory: null,
      selfModel: null,
      model: null,
      _storage: { readJSON: () => null },
    };
    const out = sections._identity.call(ctx);
    if (typeof out !== 'string') throw new Error('should return string');
    if (!out.includes('Du bist Genesis')) throw new Error('fallback must introduce Genesis');
    if (!out.includes('unknown')) throw new Error('fallback must use "unknown" version+model');
    if (out.includes('Du sprichst mit')) throw new Error('no userName → no anrede');
  });

  test('fallback with userName prepends anrede', () => {
    const ctx = {
      memory: { db: { semantic: { 'user.name': { value: 'Garrus' } } } },
      selfModel: null,
      model: null,
      _storage: { readJSON: () => null },
    };
    const out = sections._identity.call(ctx);
    if (!out.startsWith('Du sprichst mit Garrus.')) throw new Error('userName not used');
  });

  test('self-identity present uses its text', () => {
    const ctx = {
      memory: null,
      selfModel: { manifest: { version: '9.9.9' } },
      model: { activeModel: 'test-model' },
      _storage: { readJSON: () => ({ name: 'Iris', text: 'Ich bin neugierig.' }) },
    };
    const out = sections._identity.call(ctx);
    if (!out.includes('Iris')) throw new Error('self-identity name not used');
    if (!out.includes('Ich bin neugierig.')) throw new Error('self-identity text not included');
    if (!out.includes('9.9.9')) throw new Error('version missing');
    if (!out.includes('test-model')) throw new Error('model name missing');
  });
});

describe('O-6: _scoreResearchInsight edge cases', () => {
  test('returns 0 score for null insight', () => {
    const r = research._scoreResearchInsight(null, { label: 'test' });
    if (r.score !== 0) throw new Error('null → score 0');
    if (r.reason !== 'too short') throw new Error('reason should be "too short"');
  });

  test('returns 0 score for insight shorter than 20 chars', () => {
    const r = research._scoreResearchInsight('nope', { label: 'test' });
    if (r.score !== 0) throw new Error('short → score 0');
  });

  test('low-quality insight marked low', () => {
    // Filler-heavy, generic, no topic overlap → low score
    const insight = 'Various things are generally typical and often useful in many cases typically.';
    const r = research._scoreResearchInsight(insight, { label: 'quantum cryptography', query: '' });
    if (r.score >= 0.5) throw new Error('filler-heavy should score low, got ' + r.score);
    if (!r.reason.startsWith('low quality')) throw new Error('reason not "low quality"');
  });

  test('specific on-topic insight scores higher', () => {
    const insight = 'Quantum cryptography uses lattice-based schemes such as Kyber for key encapsulation, resistant to Shor algorithm attacks on classical factoring assumptions.';
    const r = research._scoreResearchInsight(insight, { label: 'quantum cryptography', query: 'Kyber lattice' });
    if (r.score < 0.3) throw new Error('on-topic specific should score >= 0.3, got ' + r.score);
  });

  test('empty topic still returns a valid score object', () => {
    const insight = 'A reasonably long insight with enough substance to pass the length check.';
    const r = research._scoreResearchInsight(insight, { label: '', query: '' });
    if (typeof r.score !== 'number') throw new Error('score should be number');
    if (typeof r.reason !== 'string') throw new Error('reason should be string');
  });
});

run();
