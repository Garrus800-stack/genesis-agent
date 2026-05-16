// ============================================================
// GENESIS — test/modules/v789-llm-capability-detection.contract.test.js
// Contract test for v7.8.9 LLMCapabilityDetector:
//   • Template classification: modern/legacy/unknown
//   • Special-renderer detection
//   • Verification call success/failure
//   • Cache hit on matching digest
//   • Cache invalidation on digest change
//   • Persistent file write/read
//   • Lazy detection (no auto-detection of unrelated models)
//   • Verification-failed status is retried on next call
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const { LLMCapabilityDetector } = require(path.join(ROOT, 'src/agent/foundation/backends/LLMCapabilityDetector'));

// ── Helper: temp genesis dir ──────────────────────────────

function makeTempGenesisDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-cap-test-'));
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

// ── Mock fetch implementation ────────────────────────────

function makeFetchImpl({ template = '', digest = 'sha256:abc', hasRenderer = false, verifyAnswer = '' } = {}) {
  return async (req) => {
    // Verification call branch
    if (req.verifyMessages) {
      return verifyAnswer; // returned content
    }
    // Info call branch
    return { template, digest, hasRenderer };
  };
}

// Adapter: the real detector takes a single fetchImpl that handles both cases;
// we split it into two calls inside the detector. Mock returns appropriate result.

function makeDetector(opts = {}) {
  const dir = opts.genesisDir || makeTempGenesisDir();
  const detector = new LLMCapabilityDetector({
    baseUrl: 'http://test',
    genesisDir: dir,
    fetchImpl: opts.fetchImpl || (async (req) => {
      if (req.verifyMessages) {
        // Default verify answer: matches expected (continues from prefill)
        return opts.verifyTrue !== false; // boolean for verifyPrefill
      }
      return {
        template: opts.template ?? '',
        digest: opts.digest ?? 'sha256:default',
        hasRenderer: opts.hasRenderer ?? false,
      };
    }),
  });
  return { detector, dir };
}

// ── Template classification ──────────────────────────────

describe('llm-resilience-v789 contract: template classification', () => {

  test('llm-resilience-v789 contract: simple range over .Messages → messages-loop', () => {
    const { detector } = makeDetector();
    assertEqual(detector.classifyTemplate('{{- range .Messages }}{{end}}'), 'messages-loop', 'simple range');
  });

  test('llm-resilience-v789 contract: indexed range over .Messages → messages-loop', () => {
    const { detector } = makeDetector();
    const t = '{{- range $i, $_ := .Messages }}{{ end }}';
    assertEqual(detector.classifyTemplate(t), 'messages-loop', 'indexed range');
  });

  test('llm-resilience-v789 contract: real-world llama3.1 template → messages-loop', () => {
    const { detector } = makeDetector();
    const t = '{{- range $i, $_ := .Messages }}\n{{- $last := eq (len (slice $.Messages $i)) 1 }}\n{{- if eq .Role "user" }}<|user|>{{ .Content }}{{ end }}';
    assertEqual(detector.classifyTemplate(t), 'messages-loop', 'real llama3.1 pattern');
  });

  test('llm-resilience-v789 contract: legacy .Prompt/.Response template → prompt-response', () => {
    const { detector } = makeDetector();
    const t = '{{ if .Prompt }}<|user|>{{ .Prompt }}<|end|>{{ end }}{{ .Response }}';
    assertEqual(detector.classifyTemplate(t), 'prompt-response', 'legacy template');
  });

  test('llm-resilience-v789 contract: empty template → unknown', () => {
    const { detector } = makeDetector();
    assertEqual(detector.classifyTemplate(''), 'unknown', 'empty');
    assertEqual(detector.classifyTemplate(null), 'unknown', 'null');
  });

  test('llm-resilience-v789 contract: prefers messages-loop over .Prompt when both present', () => {
    const { detector } = makeDetector();
    const t = '{{- if .Prompt }}old-style{{ end }}{{- range .Messages }}new-style{{ end }}';
    assertEqual(detector.classifyTemplate(t), 'messages-loop', 'modern wins');
  });

});

// ── Detection flow ────────────────────────────────────────

describe('llm-resilience-v789 contract: detection flow per template kind', () => {

  test('llm-resilience-v789 contract: special-renderer model gets special-renderer status', async () => {
    const { detector, dir } = makeDetector({
      template: 'some template',
      digest: 'sha256:mllama',
      hasRenderer: true,
    });
    try {
      const result = await detector.detectCapability('mllama:11b');
      assertEqual(result.status, 'special-renderer', 'renderer detected');
      assertEqual(result.template, 'special-renderer', 'template kind');
    } finally {
      cleanup(dir);
    }
  });

  test('llm-resilience-v789 contract: legacy template → unverified-no-prefill (skips verification)', async () => {
    let verifyCalled = false;
    const { detector, dir } = makeDetector({
      template: '{{ if .Prompt }}{{ .Prompt }}{{ end }}{{ .Response }}',
      digest: 'sha256:legacy',
      fetchImpl: async (req) => {
        if (req.verifyMessages) { verifyCalled = true; return true; }
        return { template: '{{ .Prompt }} {{ .Response }}', digest: 'sha256:legacy', hasRenderer: false };
      },
    });
    try {
      const result = await detector.detectCapability('tinyllama:1.1b');
      assertEqual(result.status, 'unverified-no-prefill', 'legacy → no prefill status');
      assertEqual(verifyCalled, false, 'verification skipped for legacy');
    } finally {
      cleanup(dir);
    }
  });

  test('llm-resilience-v789 contract: modern template + successful verify → verified-prefill', async () => {
    const { detector, dir } = makeDetector({
      template: '{{- range .Messages }}{{ end }}',
      digest: 'sha256:qwen',
      verifyTrue: true,
    });
    try {
      const result = await detector.detectCapability('qwen3-coder:32b');
      assertEqual(result.status, 'verified-prefill', 'modern + verify ok');
    } finally {
      cleanup(dir);
    }
  });

  test('llm-resilience-v789 contract: modern template + failed verify → verification-failed', async () => {
    const { detector, dir } = makeDetector({
      template: '{{- range .Messages }}{{ end }}',
      digest: 'sha256:mystery',
      verifyTrue: false,
    });
    try {
      const result = await detector.detectCapability('weird-model:7b');
      assertEqual(result.status, 'verification-failed', 'verify said no');
    } finally {
      cleanup(dir);
    }
  });

  test('llm-resilience-v789 contract: invalid model name returns verification-failed without crash', async () => {
    const { detector, dir } = makeDetector();
    try {
      const r1 = await detector.detectCapability('');
      assertEqual(r1.status, 'verification-failed', 'empty model name');
      const r2 = await detector.detectCapability(null);
      assertEqual(r2.status, 'verification-failed', 'null model name');
    } finally {
      cleanup(dir);
    }
  });

});

// ── Cache behavior ───────────────────────────────────────

describe('llm-resilience-v789 contract: capability caching', () => {

  test('llm-resilience-v789 contract: second detection of same model hits cache', async () => {
    let infoCalls = 0;
    let verifyCalls = 0;
    const dir = makeTempGenesisDir();
    try {
      const detector = new LLMCapabilityDetector({
        baseUrl: 'http://test',
        genesisDir: dir,
        fetchImpl: async (req) => {
          if (req.verifyMessages) { verifyCalls++; return true; }
          infoCalls++;
          return { template: '{{- range .Messages }}', digest: 'sha256:stable', hasRenderer: false };
        },
      });
      await detector.detectCapability('qwen:32b');
      await detector.detectCapability('qwen:32b'); // cache hit
      assertEqual(infoCalls, 2, 'info still fetched both times (digest check)');
      assertEqual(verifyCalls, 1, 'verify only called once');
    } finally {
      cleanup(dir);
    }
  });

  test('llm-resilience-v789 contract: digest change invalidates cache and triggers re-verify', async () => {
    let verifyCalls = 0;
    let digestState = 'sha256:v1';
    const dir = makeTempGenesisDir();
    try {
      const detector = new LLMCapabilityDetector({
        baseUrl: 'http://test',
        genesisDir: dir,
        fetchImpl: async (req) => {
          if (req.verifyMessages) { verifyCalls++; return true; }
          return { template: '{{- range .Messages }}', digest: digestState, hasRenderer: false };
        },
      });
      await detector.detectCapability('qwen:32b');
      assertEqual(verifyCalls, 1, 'initial verify');
      digestState = 'sha256:v2';
      await detector.detectCapability('qwen:32b');
      assertEqual(verifyCalls, 2, 'digest change → re-verify');
    } finally {
      cleanup(dir);
    }
  });

  test('llm-resilience-v789 contract: verification-failed is retried on next call', async () => {
    let verifyCalls = 0;
    let verifyResult = false; // initially fails
    const dir = makeTempGenesisDir();
    try {
      const detector = new LLMCapabilityDetector({
        baseUrl: 'http://test',
        genesisDir: dir,
        fetchImpl: async (req) => {
          if (req.verifyMessages) { verifyCalls++; return verifyResult; }
          return { template: '{{- range .Messages }}', digest: 'sha256:flaky', hasRenderer: false };
        },
      });
      const r1 = await detector.detectCapability('flaky:7b');
      assertEqual(r1.status, 'verification-failed', 'initial fail');
      // Server gets better, but cache says verification-failed.
      // Next call should retry verification.
      verifyResult = true;
      const r2 = await detector.detectCapability('flaky:7b');
      assertEqual(r2.status, 'verified-prefill', 'recovered');
      assertEqual(verifyCalls, 2, 'verification retried');
    } finally {
      cleanup(dir);
    }
  });

});

// ── Persistence ─────────────────────────────────────────

describe('llm-resilience-v789 contract: persistent capability file', () => {

  test('llm-resilience-v789 contract: writes capability file after detection', async () => {
    const dir = makeTempGenesisDir();
    try {
      const detector = new LLMCapabilityDetector({
        baseUrl: 'http://test',
        genesisDir: dir,
        fetchImpl: async (req) => {
          if (req.verifyMessages) return true;
          return { template: '{{- range .Messages }}', digest: 'sha256:persist', hasRenderer: false };
        },
      });
      await detector.detectCapability('llama3:70b');
      const fp = path.join(dir, 'llm-capabilities.json');
      assert(fs.existsSync(fp), 'capability file created');
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      assert(data['llama3:70b'], 'model entry present');
      assertEqual(data['llama3:70b'].status, 'verified-prefill', 'status persisted');
      assertEqual(data['llama3:70b'].digest, 'sha256:persist', 'digest persisted');
    } finally {
      cleanup(dir);
    }
  });

  test('llm-resilience-v789 contract: loads existing capability file on first call', async () => {
    const dir = makeTempGenesisDir();
    try {
      // Pre-seed the file
      const fp = path.join(dir, 'llm-capabilities.json');
      const seed = {
        'qwen:32b': {
          status: 'verified-prefill',
          template: 'messages-loop',
          digest: 'sha256:seeded',
          verifiedAt: Date.now() - 1000,
        },
      };
      fs.writeFileSync(fp, JSON.stringify(seed));

      let verifyCalls = 0;
      const detector = new LLMCapabilityDetector({
        baseUrl: 'http://test',
        genesisDir: dir,
        fetchImpl: async (req) => {
          if (req.verifyMessages) { verifyCalls++; return true; }
          return { template: '{{- range .Messages }}', digest: 'sha256:seeded', hasRenderer: false };
        },
      });
      const result = await detector.detectCapability('qwen:32b');
      assertEqual(result.status, 'verified-prefill', 'cached status used');
      assertEqual(verifyCalls, 0, 'no verify call when digest matches seed');
    } finally {
      cleanup(dir);
    }
  });

  test('llm-resilience-v789 contract: tolerates missing genesisDir', async () => {
    const detector = new LLMCapabilityDetector({
      baseUrl: 'http://test',
      genesisDir: null,
      fetchImpl: async (req) => {
        if (req.verifyMessages) return true;
        return { template: '{{- range .Messages }}', digest: 'sha256:nopersist', hasRenderer: false };
      },
    });
    // Should not throw even though it can't persist
    const result = await detector.detectCapability('qwen:7b');
    assertEqual(result.status, 'verified-prefill', 'detection still works');
  });

});

if (require.main === module) run();
