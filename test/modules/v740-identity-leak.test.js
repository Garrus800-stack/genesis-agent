// ============================================================
// v7.4.0 — Identity-Leak Regression Test
//
// Ensures the identity block does not prime strongly-branded
// models (Qwen-Coder, Llama, Claude, GPT) to self-identify as
// themselves instead of as Genesis.
//
// Originally discovered with qwen3-coder:480b-cloud: users
// reported Genesis responding "I am Qwen Coder, built by
// Alibaba Cloud" when asked "who are you". Root cause: the
// identity block in PromptBuilder named the underlying model
// explicitly ("Dein Sprachmodell ist X"), which gave the
// strongly-trained branded model a stronger self-reference
// than the Genesis framing around it.
//
// Fix: model name removed from identity block. It still appears
// in capabilities block (where it belongs as technical context).
// This test locks the fix in so no future change re-introduces
// the leak.
// ============================================================

const { describe, it } = require('node:test');
const assert = require('assert');
const { sections } = require('../../src/agent/intelligence/PromptBuilderSections');

describe('v7.4.0 — Identity-Leak Regression', () => {

  // All branded model names that have historically caused leaks.
  // If any of these appears in the identity block, the prompt
  // primes the model to self-identify as itself.
  const BRANDED_MODELS = [
    'qwen', 'qwen2.5', 'qwen3-coder', 'qwen-coder',
    'llama', 'llama2', 'llama3', 'llama-3',
    'claude', 'claude-sonnet', 'claude-opus',
    'gpt', 'gpt-4', 'gpt-4o', 'gpt-3.5',
    'mistral', 'mixtral',
    'gemma', 'gemma2',
    'phi', 'phi-3',
    'deepseek', 'deepseek-coder',
    'yi', 'yi-34b',
    'command-r',
  ];

  function makeCtx(modelName, withIdentity = false) {
    return {
      memory: null,
      selfModel: { manifest: { version: '7.4.0' } },
      model: { activeModel: modelName },
      _storage: {
        readJSON: (_n) => withIdentity
          ? { name: 'Genesis', text: 'I am an autonomous agent.' }
          : null,
      },
    };
  }

  for (const modelName of BRANDED_MODELS) {
    it(`fallback path does not leak "${modelName}"`, () => {
      const ctx = makeCtx(modelName, false);
      const out = sections._identity.call(ctx);
      // Use word-boundary regex, not .includes() — "yi" would
      // otherwise match inside "identity", "claude" inside
      // "claudeappreciates" etc. We only want standalone brand
      // hits.
      const escaped = modelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      assert.ok(
        !re.test(out),
        `identity block (fallback) leaked model name "${modelName}":\n${out}`
      );
    });

    it(`self-identity path does not leak "${modelName}"`, () => {
      const ctx = makeCtx(modelName, true);
      const out = sections._identity.call(ctx);
      const escaped = modelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      assert.ok(
        !re.test(out),
        `identity block (with self-identity) leaked "${modelName}":\n${out}`
      );
    });
  }

  it('identity block explicitly states Genesis is NOT the LLM', () => {
    const ctx = makeCtx('qwen3-coder', false);
    const out = sections._identity.call(ctx);
    // German anti-LLM-identity anchor must be present.
    assert.ok(
      /NICHT das zugrundeliegende Sprachmodell/i.test(out),
      'identity block must explicitly reject LLM self-identification'
    );
  });

  it('identity block leads with "Du bist Genesis" (strong anchor)', () => {
    const ctx = makeCtx('qwen3-coder', false);
    const out = sections._identity.call(ctx);
    // First non-empty line should start the Genesis framing.
    const firstLine = out.split('\n').find(l => l.trim().length > 0);
    assert.ok(
      /^Du bist Genesis\b/i.test(firstLine),
      `first line must anchor as Genesis, got: "${firstLine}"`
    );
  });

  it('identity block gives identity priority over version info', () => {
    const ctx = makeCtx('qwen3-coder', false);
    const out = sections._identity.call(ctx);
    const identityIdx = out.indexOf('Du bist Genesis');
    const versionIdx = out.indexOf('Version:');
    assert.ok(identityIdx >= 0, 'identity anchor must be present');
    assert.ok(versionIdx >= 0, 'version must be present');
    assert.ok(
      identityIdx < versionIdx,
      'identity anchor must come BEFORE version line'
    );
  });
});
