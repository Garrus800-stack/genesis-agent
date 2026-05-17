// ============================================================
// GENESIS — test/modules/v790-followup-fixes.contract.test.js
// Contract tests for the v7.9.0 follow-up fixes that surfaced
// from Garrus's first real-world run (12:21–12:45 log):
//   A) /settings <path>           — GET form (path-only)
//   A) /settings <path> <value>   — whitespace SET form
//   B) /affect-trail               — explains when boundaries appear
//   D) LLMCapabilityDetector       — widened Go range window (300)
//   D) LLMCapabilityDetector       — Jinja for-in pattern
//   D) LLMCapabilityDetector       — unknown templates still classify
// All test names carry `koennen-crystallizer-v790 contract:` prefix
// so they count toward the v7.9.0 contract floor.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { commandHandlersSystem } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersSystem'));
const { commandHandlersGoals }  = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersGoals'));
const { commandHandlersCode }   = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersCode'));
const { LLMCapabilityDetector } = require(path.join(ROOT, 'src/agent/foundation/backends/LLMCapabilityDetector'));

// ── Helpers ──────────────────────────────────────────────

function makeSettingsStub(store = {}) {
  const flatten = (obj, prefix = '') => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        Object.assign(out, flatten(v, full));
      } else {
        out[full] = v;
      }
    }
    return out;
  };
  let flat = flatten(store);
  return {
    get(p) {
      if (flat[p] !== undefined) return flat[p];
      // subtree fallback: rebuild object from prefix
      const prefix = p + '.';
      const sub = {};
      let any = false;
      for (const k of Object.keys(flat)) {
        if (k.startsWith(prefix)) {
          any = true;
          const rest = k.slice(prefix.length);
          const segs = rest.split('.');
          let cur = sub;
          for (let i = 0; i < segs.length - 1; i++) {
            cur[segs[i]] = cur[segs[i]] || {};
            cur = cur[segs[i]];
          }
          cur[segs[segs.length - 1]] = flat[k];
        }
      }
      return any ? sub : undefined;
    },
    set(p, v) { flat[p] = v; },
    getAll() {
      return {
        models: { anthropicApiKey: '', openaiBaseUrl: '', preferred: 'auto' },
        daemon: { enabled: true, cycleMinutes: 5 },
        idleMind: { enabled: true, idleMinutes: 2 },
        security: { allowSelfModify: true },
      };
    },
  };
}

function newSystemHandler(settings) {
  const inst = Object.create(commandHandlersSystem);
  inst.settings = settings;
  inst.lang = { t: (k, p) => p ? `${k}:${JSON.stringify(p)}` : k };
  inst.daemon = { getStatus: () => ({ running: true, cycleCount: 0, knownGaps: [] }) };
  return inst;
}

function newGoalsHandler(candidateLog) {
  const inst = Object.create(commandHandlersGoals);
  inst.koennenCandidateLog = candidateLog;
  inst.lang = { t: (k) => k };
  return inst;
}

// ── Tests ────────────────────────────────────────────────

describe('koennen-crystallizer-v790 contract: /settings handler v7.9.0 follow-up', () => {
  test('koennen-crystallizer-v790 contract: GET form returns leaf value', () => {
    const settings = makeSettingsStub({
      cognitive: { koennen: { crystallization: { enabled: true } } },
    });
    const h = newSystemHandler(settings);
    const out = h.handleSettings('/settings cognitive.koennen.crystallization.enabled');
    assert(/= true/.test(out), `expected leaf value, got: ${out}`);
  });

  test('koennen-crystallizer-v790 contract: GET form returns subtree JSON', () => {
    const settings = makeSettingsStub({
      cognitive: { koennen: { enabled: true, crystallization: { enabled: true, minCandidatesPerPattern: 3 } } },
    });
    const h = newSystemHandler(settings);
    const out = h.handleSettings('/settings cognitive.koennen');
    assert(out.includes('cognitive.koennen ='),
      `expected subtree header: ${out}`);
    assert(out.includes('minCandidatesPerPattern'),
      `expected nested key in JSON: ${out}`);
  });

  test('koennen-crystallizer-v790 contract: GET form on missing path returns clear error', () => {
    const settings = makeSettingsStub({});
    const h = newSystemHandler(settings);
    const out = h.handleSettings('/settings cognitive.koennen.unknown.path');
    assert(/is not set/.test(out), `expected not-set message: ${out}`);
  });

  test('koennen-crystallizer-v790 contract: whitespace SET form (path value) works', () => {
    const settings = makeSettingsStub({
      cognitive: { koennen: { crystallization: { enabled: true } } },
    });
    const h = newSystemHandler(settings);
    const out = h.handleSettings('/settings cognitive.koennen.crystallization.enabled false');
    assert(/✓/.test(out), `expected check mark: ${out}`);
    assertEqual(settings.get('cognitive.koennen.crystallization.enabled'), false);
  });

  test('koennen-crystallizer-v790 contract: whitespace SET coerces int and float and bool', () => {
    const settings = makeSettingsStub({ cognitive: { koennen: { x: 0, y: 0, z: false } } });
    const h = newSystemHandler(settings);
    h.handleSettings('/settings cognitive.koennen.x 42');
    h.handleSettings('/settings cognitive.koennen.y 0.5');
    h.handleSettings('/settings cognitive.koennen.z true');
    assertEqual(settings.get('cognitive.koennen.x'), 42);
    assertEqual(settings.get('cognitive.koennen.y'), 0.5);
    assertEqual(settings.get('cognitive.koennen.z'), true);
  });

  test('koennen-crystallizer-v790 contract: equals SET form still works (backward compat)', () => {
    const settings = makeSettingsStub({ cognitive: { koennen: { enabled: true } } });
    const h = newSystemHandler(settings);
    const out = h.handleSettings('/settings cognitive.koennen.enabled = false');
    assert(/✓/.test(out));
    assertEqual(settings.get('cognitive.koennen.enabled'), false);
  });

  test('koennen-crystallizer-v790 contract: bare /settings still shows overview', () => {
    const settings = makeSettingsStub({});
    const h = newSystemHandler(settings);
    const out = h.handleSettings('/settings');
    assert(/Genesis/.test(out));
    assert(/Daemon/.test(out));
  });
});

describe('koennen-crystallizer-v790 contract: /affect-trail empty-state clarity', () => {
  test('koennen-crystallizer-v790 contract: empty boundaries message explains the AgentLoop link', async () => {
    const log = {
      getRecentBoundaries: () => [],
      getStats: () => ({ totalEvaluated: 0, gatePassRate: 0, currentTheta: 0.6, missedStarts: 0 }),
    };
    const h = newGoalsHandler(log);
    const out = await h.affectTrail('/affect-trail');
    assert(/AgentLoop/.test(out), `must mention AgentLoop: ${out}`);
    assert(/Goal/.test(out), `must mention Goals: ${out}`);
    assert(/chat|create-skill|settings/i.test(out),
      `must explain that plain chat does NOT trigger it: ${out}`);
  });
});

describe('koennen-crystallizer-v790 contract: LLMCapabilityDetector v7.9.0 follow-up', () => {
  test('koennen-crystallizer-v790 contract: Go range with wide gap (>100 chars) is now detected', () => {
    const detector = new LLMCapabilityDetector({});
    // 200-char gap between `range` and `.Messages`
    const filler = '{{- if .Tools }}{{ /* nested control flow with text and {{ braces }} */ }}{{- end }}';
    const template = `{{- range $i, $msg := ${filler}${filler} .Messages }}<|im_start|>{{ .Role }}<|im_end|>{{- end }}`;
    assertEqual(detector.classifyTemplate(template), 'messages-loop');
  });

  test('koennen-crystallizer-v790 contract: Jinja {% for ... in messages %} → messages-loop', () => {
    const detector = new LLMCapabilityDetector({});
    const template = '{% for message in messages %}<|im_start|>{{ message.role }}\n{{ message.content }}<|im_end|>\n{% endfor %}';
    assertEqual(detector.classifyTemplate(template), 'messages-loop');
  });

  test('koennen-crystallizer-v790 contract: legacy .Prompt/.Response still detected', () => {
    const detector = new LLMCapabilityDetector({});
    assertEqual(detector.classifyTemplate('{{ .Prompt }}\n{{ .Response }}'), 'prompt-response');
  });

  test('koennen-crystallizer-v790 contract: genuinely opaque template still unknown', () => {
    const detector = new LLMCapabilityDetector({});
    assertEqual(detector.classifyTemplate('<some>opaque</some> template with no markers'), 'unknown');
  });

  test('koennen-crystallizer-v790 contract: empty template is unknown', () => {
    const detector = new LLMCapabilityDetector({});
    assertEqual(detector.classifyTemplate(''), 'unknown');
    assertEqual(detector.classifyTemplate(null), 'unknown');
  });

  // ─────────────────────────────────────────────────────────
  // E) Settings toggle events are catalogued and have schemas
  //    Live-run on 17:46 emitted `settings:koennen-crystallization-toggled`
  //    and the EventBus dev-mode logged "Unknown event ... Not in
  //    EventTypes catalog" because catalog + schema entries were
  //    missing for the two new boolean toggles.
  // ─────────────────────────────────────────────────────────
  test('koennen-crystallizer-v790 contract: koennen toggles in EventTypes + schemas', () => {
    const fs = require('fs');
    const ET = fs.readFileSync(path.join(ROOT, 'src/agent/core/EventTypes.js'), 'utf8');
    const EP = fs.readFileSync(path.join(ROOT, 'src/agent/core/EventPayloadSchemas.js'), 'utf8');
    for (const evt of ['settings:koennen-toggled', 'settings:koennen-crystallization-toggled']) {
      assert(ET.includes(`'${evt}'`), `EventTypes.js missing catalog entry for ${evt}`);
      assert(EP.includes(`'${evt}'`), `EventPayloadSchemas.js missing schema for ${evt}`);
    }
  });

  // ─────────────────────────────────────────────────────────
  // F) LLMCapabilityDetector: cloud is FIXED unverified-no-prefill
  //    Cloud's small prefill probe passes (HTTP 200) but large
  //    skill-gen prefill requests fail HTTP 500. ContinuationLoop
  //    must use pseudo-mode, which requires status != verified-prefill.
  // ─────────────────────────────────────────────────────────
  test('koennen-crystallizer-v790 contract: cloud is fixed no-prefill, no probe', async () => {
    let probeCount = 0;
    const detector = new LLMCapabilityDetector({});
    detector._verifyPrefill = async () => { probeCount++; return true; };
    detector._persist = async () => {};
    detector._ensureLoaded = async () => {};
    detector._fetchModelInfo = async () => ({ template: '', modelfile: '', hasRenderer: false, digest: 'abc' });
    const entry = await detector.detectCapability('qwen3-vl:235b-cloud');
    assertEqual(probeCount, 0, 'cloud must NOT probe (probe is misleading)');
    assertEqual(entry.status, 'unverified-no-prefill');
    assertEqual(entry.template, 'cloud');
  });

  test('koennen-crystallizer-v790 contract: gpt-oss:cloud also fixed no-prefill', async () => {
    const detector = new LLMCapabilityDetector({});
    detector._verifyPrefill = async () => true;
    detector._persist = async () => {};
    detector._ensureLoaded = async () => {};
    detector._fetchModelInfo = async () => ({ template: '', modelfile: '', hasRenderer: false, digest: 'def' });
    const entry = await detector.detectCapability('gpt-oss:120b-cloud');
    assertEqual(entry.status, 'unverified-no-prefill');
    assertEqual(entry.template, 'cloud');
  });

  test('koennen-crystallizer-v790 contract: stale cloud verified-prefill in cache is evicted', async () => {
    const detector = new LLMCapabilityDetector({});
    detector._verifyPrefill = async () => true;
    detector._persist = async () => {};
    detector._ensureLoaded = async () => {};
    detector._fetchModelInfo = async () => ({ template: '', modelfile: '', hasRenderer: false, digest: 'xyz' });
    // Inject stale cache entry (from buggy probe-once-cache version)
    detector._memCache.set('qwen3-vl:235b-cloud', {
      status: 'verified-prefill', template: 'cloud', digest: 'xyz', verifiedAt: Date.now()
    });
    const entry = await detector.detectCapability('qwen3-vl:235b-cloud');
    assertEqual(entry.status, 'unverified-no-prefill', 'stale verified-prefill must be evicted');
    assertEqual(entry.template, 'cloud');
  });

  // ─────────────────────────────────────────────────────────
  // H) SkillManager createSkill parser is robust to:
  //    - truncated code blocks (no closing fence)
  //    - bare code without any fences
  //    - bare manifest JSON without fences
  //    Cloud LLMs sometimes return responses that previously got
  //    rejected with "model returned incomplete result" even when
  //    the code is actually present.
  // ─────────────────────────────────────────────────────────
  test('koennen-crystallizer-v790 contract: createSkill regex matches truncated code block', () => {
    // Real cloud-truncation case: closed json fence, OPEN js fence, no closing
    const response = '```json\n{"name":"uuid","entry":"index.js"}\n```\n\n```javascript\nfunction uuidv4() {\n  return crypto.randomUUID();\n}\nmodule.exports = { uuidv4 };';
    // Step (a): closed js fence — must MISS
    const closedJs = response.match(/```(?:javascript|js)\n([\s\S]+?)```/);
    assert(!closedJs, 'closed-js regex must not match truncated tail');
    // Step (b): truncated js fence — must HIT and capture function code
    const truncJs = response.match(/```(?:javascript|js)\n([\s\S]+)$/);
    assert(truncJs, 'truncated js fence must match');
    assert(truncJs[1].includes('uuidv4'), 'must capture the function');
    assert(!truncJs[1].trim().startsWith('{'), 'must NOT capture JSON manifest');
  });

  test('koennen-crystallizer-v790 contract: generic fence fallback rejects JSON-content captures', () => {
    // Bug: closed `json` fence existed, unclosed js fence followed.
    // Generic `\w*` fallback used to grab the JSON manifest as "code".
    const response = '```json\n{"name":"uuid","entry":"index.js"}\n```\n\n```js\nfunction u(){return 1}';
    // Negative-lookahead: `(?!json\b)` keeps json fences from being caught
    const generic = response.match(/```(?!json\b)\w*\n([\s\S]+?)```/);
    // Either no match, OR if matched, must not start with `{`
    if (generic) assert(!generic[1].trim().startsWith('{'), 'rejected JSON content');
    // The actual JS truncated path picks up the function:
    const truncJs = response.match(/```(?:javascript|js)\n([\s\S]+)$/);
    assert(truncJs);
    assert(truncJs[1].includes('function u'));
  });

  test('koennen-crystallizer-v790 contract: createSkill regex matches bare code with no fences', () => {
    const response = 'function uuidv4() {\n  return crypto.randomUUID();\n}\nmodule.exports = { uuidv4 };';
    const looksLikeCode = /(?:^|\n)\s*(?:async\s+)?function\s+\w+\s*\(|=>\s*[\{(]|module\.exports\s*=|exports\.\w+\s*=/.test(response);
    assert(looksLikeCode, 'fence-less code must be detectable');
    assert(!response.includes('```'), 'sanity: no fences in this case');
  });

  test('koennen-crystallizer-v790 contract: createSkill regex finds bare manifest JSON', () => {
    const response = 'Here is the skill:\n{"name":"uuid","version":"1.0.0","entry":"index.js"}\n\nAnd the code:\nfunction uuidv4() { return "x"; }';
    const bareManifest = response.match(/(\{[\s\S]*?"name"\s*:[\s\S]*?\})/);
    assert(bareManifest);
    assert(bareManifest[1].includes('"name"'));
  });

  // ─────────────────────────────────────────────────────────
  // I) runSkill slash-aware parsing
  //    `/run-skill random-hex-color` was getting parsed as
  //    skillName="run-skill" by the legacy `[\w-]+-skill` regex.
  //    Then executeSkill("run-skill", {}) → not found → catch
  //    fell through to shellRun(message), which executed the
  //    chat input in PowerShell → "command not found" surfaced
  //    in the chat UI as if /run-skill didn't exist.
  // ─────────────────────────────────────────────────────────
  test('koennen-crystallizer-v790 contract: /run-skill <name> picks the argument, not "run-skill"', async () => {
    const calls = [];
    const handler = Object.create(commandHandlersCode);
    handler.skillManager = {
      listSkills: () => [{ name: 'random-hex-color', description: 'gen hex' }],
      executeSkill: async (name, args) => { calls.push({ name, args }); return { result: '#abc123' }; }
    };
    handler.shell = { run: () => { throw new Error('should NEVER be called'); } };
    handler.shellRun = () => { throw new Error('shellRun should NEVER be called for slash form'); };
    const result = await handler.runSkill('/run-skill random-hex-color');
    assertEqual(calls.length, 1);
    assertEqual(calls[0].name, 'random-hex-color', 'must use the argument, not "run-skill"');
    assert(result.includes('random-hex-color'));
  });

  test('koennen-crystallizer-v790 contract: /run-skill alone lists skills (no shell fallback)', async () => {
    const handler = Object.create(commandHandlersCode);
    handler.skillManager = {
      listSkills: () => [{ name: 'random-hex-color', description: 'gen hex' }],
      executeSkill: async () => { throw new Error('should not be called'); }
    };
    handler.shellRun = () => { throw new Error('shellRun must not be called'); };
    const result = await handler.runSkill('/run-skill');
    assert(result.includes('Available skills'));
    assert(result.includes('random-hex-color'));
  });

  test('koennen-crystallizer-v790 contract: /run-skill <missing> returns clean error, not shell-fallback', async () => {
    let shellCalled = false;
    const handler = Object.create(commandHandlersCode);
    handler.skillManager = {
      listSkills: () => [],
      executeSkill: async () => { throw new Error('skill not found'); }
    };
    handler.shell = { run: () => { shellCalled = true; return 'shell ran'; } };
    handler.shellRun = () => { shellCalled = true; return 'shell ran'; };
    const result = await handler.runSkill('/run-skill nonexistent');
    assertEqual(shellCalled, false, 'shell fallback must be disabled for slash commands');
    assert(result.includes('nonexistent'));
    assert(result.includes('failed') || result.includes('❌'));
  });

  test('koennen-crystallizer-v790 contract: free-text "run my-tool" still has shell fallback', async () => {
    let shellCalled = false;
    const handler = Object.create(commandHandlersCode);
    handler.skillManager = {
      listSkills: () => [],
      executeSkill: async () => { throw new Error('skill not found'); }
    };
    handler.shell = { run: () => { shellCalled = true; return 'shell ran'; } };
    handler.shellRun = (msg) => { shellCalled = true; return `shell: ${msg}`; };
    await handler.runSkill('run my-tool');
    assertEqual(shellCalled, true, 'free-text path keeps legacy shell fallback');
  });
});

run();
