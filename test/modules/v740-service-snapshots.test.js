// ============================================================
// v7.4.0 Session 2 — Service getRuntimeSnapshot() whitelists
//
// One test per service, plus regression proofs that:
//   - The method exists and returns a plain object
//   - Whitelist is enforced: no leaks
//   - No disk I/O (measured by performance timing)
//
// Sensitive-regex scan is in a separate file:
// v740-sensitive-scan.test.js.
// ============================================================

const { describe, it } = require('node:test');
const assert = require('assert');

// ════════════════════════════════════════════════════════════
// Settings — must mask API keys, must use getAll not getRaw
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — Settings.getRuntimeSnapshot', () => {
  const { Settings } = require('../../src/agent/foundation/Settings');

  function makeSettings(overrides = {}) {
    const s = Object.create(Settings.prototype);
    s.data = {
      models: {
        defaultBackend: 'ollama',
        defaultModel: 'qwen2.5:7b',
        anthropicApiKey: 'sk-ant-SECRET-KEY-abcdef123456789',
        openaiApiKey: 'sk-SECRET-OPENAI-987654321abcdef',
        ...overrides.models,
      },
      trust: { level: 'ASSISTED', ...overrides.trust },
      ui: { language: 'de', ...overrides.ui },
    };
    return s;
  }

  it('exposes the whitelisted fields', () => {
    const s = makeSettings();
    const snap = s.getRuntimeSnapshot();
    assert.strictEqual(snap.backend, 'ollama');
    assert.strictEqual(snap.model, 'qwen2.5:7b');
    assert.strictEqual(snap.trustLevel, 'ASSISTED');
    assert.strictEqual(snap.language, 'de');
  });

  it('DOES NOT leak anthropic API key (critical — uses getAll not getRaw)', () => {
    const s = makeSettings();
    const snap = s.getRuntimeSnapshot();
    const serialized = JSON.stringify(snap);
    assert.ok(
      !serialized.includes('SECRET-KEY-abcdef123456789'),
      'anthropic key leaked into snapshot'
    );
  });

  it('DOES NOT leak openai API key', () => {
    const s = makeSettings();
    const snap = s.getRuntimeSnapshot();
    const serialized = JSON.stringify(snap);
    assert.ok(
      !serialized.includes('SECRET-OPENAI-987654321abcdef'),
      'openai key leaked into snapshot'
    );
  });

  it('DOES NOT include any unexpected fields', () => {
    const s = makeSettings();
    const snap = s.getRuntimeSnapshot();
    const allowed = new Set(['backend', 'model', 'trustLevel', 'language']);
    for (const key of Object.keys(snap)) {
      assert.ok(
        allowed.has(key),
        `unexpected field "${key}" in Settings snapshot — whitelist violated`
      );
    }
  });

  it('tolerates missing fields with nulls, not throws', () => {
    const s = Object.create(Settings.prototype);
    s.data = { models: {}, trust: {}, ui: {} };
    const snap = s.getRuntimeSnapshot();
    // No throws, all fields null
    assert.strictEqual(snap.backend, null);
    assert.strictEqual(snap.model, null);
  });
});

// ════════════════════════════════════════════════════════════
// EmotionalState
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — EmotionalState.getRuntimeSnapshot', () => {
  const { EmotionalState } = require('../../src/agent/organism/EmotionalState');

  function makeState() {
    return new EmotionalState({
      bus: null, storage: null, intervals: null, config: {},
    });
  }

  it('returns dominant, intensity, mood, trend, top3', () => {
    const s = makeState();
    const snap = s.getRuntimeSnapshot();
    assert.strictEqual(typeof snap.dominant, 'string');
    assert.strictEqual(typeof snap.intensity, 'number');
    assert.strictEqual(typeof snap.mood, 'string');
    assert.strictEqual(typeof snap.trend, 'string');
    assert.ok(Array.isArray(snap.top3));
    assert.strictEqual(snap.top3.length, 3);
  });

  it('top3 entries are ordered by value descending', () => {
    const s = makeState();
    const snap = s.getRuntimeSnapshot();
    assert.ok(snap.top3[0].value >= snap.top3[1].value);
    assert.ok(snap.top3[1].value >= snap.top3[2].value);
  });

  it('values are integer percentages (0-100)', () => {
    const s = makeState();
    const snap = s.getRuntimeSnapshot();
    for (const entry of snap.top3) {
      assert.ok(Number.isInteger(entry.value));
      assert.ok(entry.value >= 0 && entry.value <= 100);
    }
    assert.ok(Number.isInteger(snap.intensity));
  });
});

// ════════════════════════════════════════════════════════════
// NeedsSystem
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — NeedsSystem.getRuntimeSnapshot', () => {
  const { NeedsSystem } = require('../../src/agent/organism/NeedsSystem');

  function makeNeeds() {
    return new NeedsSystem({
      bus: null, storage: null, intervals: null, config: {},
    });
  }

  it('returns object with active array', () => {
    const n = makeNeeds();
    const snap = n.getRuntimeSnapshot();
    assert.ok(Array.isArray(snap.active));
  });

  it('only includes needs with drive > 0.3 (as integer percent)', () => {
    const n = makeNeeds();
    // Force a known state
    n.needs.knowledge.value = 0.5;  // included
    n.needs.social.value = 0.1;     // excluded (< 0.3)
    n.needs.rest.value = 0.4;       // included
    const snap = n.getRuntimeSnapshot();
    const names = snap.active.map(a => a.name);
    assert.ok(names.includes('knowledge'));
    assert.ok(names.includes('rest'));
    assert.ok(!names.includes('social'), 'social below 0.3 must be excluded');
  });

  it('sorts by drive descending', () => {
    const n = makeNeeds();
    n.needs.knowledge.value = 0.5;
    n.needs.rest.value = 0.9;
    n.needs.maintenance.value = 0.7;
    const snap = n.getRuntimeSnapshot();
    for (let i = 0; i < snap.active.length - 1; i++) {
      assert.ok(snap.active[i].drive >= snap.active[i + 1].drive);
    }
  });
});

// ════════════════════════════════════════════════════════════
// Metabolism
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — Metabolism.getRuntimeSnapshot', () => {
  const { Metabolism } = require('../../src/agent/organism/Metabolism');

  function makeMetabolism() {
    return new Metabolism({
      bus: null, storage: null, intervals: null, config: {},
    });
  }

  it('exposes energyPercent and llmCalls only', () => {
    const m = makeMetabolism();
    const snap = m.getRuntimeSnapshot();
    assert.strictEqual(typeof snap.energyPercent, 'number');
    assert.strictEqual(typeof snap.llmCalls, 'number');
  });

  it('does NOT include cost details', () => {
    const m = makeMetabolism();
    const snap = m.getRuntimeSnapshot();
    assert.ok(!('cost' in snap));
    assert.ok(!('costDetails' in snap));
    assert.ok(!('totalEnergySpent' in snap));
    assert.ok(!('recentCosts' in snap));
  });

  it('energyPercent is 0-100 integer', () => {
    const m = makeMetabolism();
    const snap = m.getRuntimeSnapshot();
    assert.ok(Number.isInteger(snap.energyPercent));
    assert.ok(snap.energyPercent >= 0 && snap.energyPercent <= 100);
  });
});

// ════════════════════════════════════════════════════════════
// AutonomousDaemon
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — AutonomousDaemon.getRuntimeSnapshot', () => {
  const { AutonomousDaemon } = require('../../src/agent/autonomy/AutonomousDaemon');

  function makeDaemon() {
    return new AutonomousDaemon({ bus: null });
  }

  it('exposes running, cycles, checksRun, gapCount', () => {
    const d = makeDaemon();
    const snap = d.getRuntimeSnapshot();
    assert.strictEqual(typeof snap.running, 'boolean');
    assert.strictEqual(typeof snap.cycles, 'number');
    assert.ok(Array.isArray(snap.checksRun));
    assert.strictEqual(typeof snap.gapCount, 'number');
  });

  it('does NOT expose full config or lastResults payload', () => {
    const d = makeDaemon();
    d.lastResults = { health: { score: 42, details: { very: 'noisy' } } };
    const snap = d.getRuntimeSnapshot();
    // checksRun gives names only, not the noisy details
    assert.ok(snap.checksRun.includes('health'));
    assert.ok(!('lastResults' in snap));
    assert.ok(!('config' in snap));
  });
});

// ════════════════════════════════════════════════════════════
// IdleMind — critically: NO disk I/O
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — IdleMind.getRuntimeSnapshot', () => {
  const { IdleMind } = require('../../src/agent/autonomy/IdleMind');

  // Use prototype-based mock. The real constructor does
  // path.join(storageDir, 'journal.jsonl') which requires
  // a string — but getRuntimeSnapshot() doesn't need any
  // of the constructor-set fields except a few. We give it
  // just those, bypassing the constructor entirely.
  function makeIdleMind() {
    const i = Object.create(IdleMind.prototype);
    i.running = false;
    i.thoughtCount = 0;
    i.activityLog = [];
    return i;
  }

  it('exposes running, thoughtCount, currentActivity, lastActivityAgoSeconds', () => {
    const i = makeIdleMind();
    i.running = true;
    i.thoughtCount = 5;
    i.lastUserActivity = Date.now();
    i.idleThreshold = 5 * 60 * 1000;
    i.activityLog = [{ activity: 'reflect', timestamp: Date.now() - 10000 }];
    const snap = i.getRuntimeSnapshot();
    assert.strictEqual(snap.running, true);
    assert.strictEqual(snap.thoughtCount, 5);
    assert.strictEqual(snap.currentActivity, 'reflect');
    assert.ok(snap.lastActivityAgoSeconds >= 10,
      `expected >=10 seconds, got ${snap.lastActivityAgoSeconds}`);
  });

  it('handles empty activity log', () => {
    const i = makeIdleMind();
    i.lastUserActivity = Date.now();
    i.idleThreshold = 5 * 60 * 1000;
    i.activityLog = [];
    const snap = i.getRuntimeSnapshot();
    assert.strictEqual(snap.currentActivity, null);
    assert.strictEqual(snap.lastActivityAgoSeconds, null);
  });

  it('CRITICAL: does NOT read from disk', () => {
    // The whole point of this method: unlike getStatus() which
    // does fs.readFileSync('journal.jsonl'), getRuntimeSnapshot
    // must be pure in-memory. We prove that by breaking all
    // disk-read paths and checking the call still succeeds.
    const i = makeIdleMind();
    i.lastUserActivity = Date.now();
    i.idleThreshold = 5 * 60 * 1000;
    i.storage = {
      readText: () => { throw new Error('DISK I/O DETECTED'); },
    };
    const originalReadFileSync = require('fs').readFileSync;
    require('fs').readFileSync = () => { throw new Error('DISK I/O DETECTED'); };
    try {
      assert.doesNotThrow(() => i.getRuntimeSnapshot());
    } finally {
      require('fs').readFileSync = originalReadFileSync;
    }
  });
});

// ════════════════════════════════════════════════════════════
// GoalStack
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — GoalStack.getRuntimeSnapshot', () => {
  const { GoalStack } = require('../../src/agent/planning/GoalStack');

  function makeGoalStack() {
    return new GoalStack({});
  }

  it('exposes open, paused, blocked, topTitle', () => {
    const g = makeGoalStack();
    g.goals = [
      { id: '1', status: 'active',    priority: 5, description: 'Ship v7.4.0' },
      { id: '2', status: 'active',    priority: 3, description: 'Write docs' },
      { id: '3', status: 'paused',    priority: 1, description: 'Later thing' },
      { id: '4', status: 'blocked',   priority: 1, description: 'Waiting on input' },
      { id: '5', status: 'completed', priority: 1, description: 'Done' },  // not counted
    ];
    const snap = g.getRuntimeSnapshot();
    assert.strictEqual(snap.open, 2);
    assert.strictEqual(snap.paused, 1);
    assert.strictEqual(snap.blocked, 1);
    assert.strictEqual(snap.topTitle, 'Ship v7.4.0');
  });

  it('truncates long goal descriptions to 80 chars', () => {
    const longText = 'A'.repeat(200);  // 200 chars — way over the 80 limit
    const g = makeGoalStack();
    g.goals = [{ id: '1', status: 'active', priority: 1, description: longText }];
    const snap = g.getRuntimeSnapshot();
    // topTitle must be present but truncated with "..." marker.
    assert.ok(snap.topTitle, 'topTitle should be present');
    assert.ok(snap.topTitle.length <= 80,
      `topTitle must be <= 80 chars, got ${snap.topTitle.length}`);
    assert.ok(snap.topTitle.endsWith('...'),
      `long titles must end with "..." marker, got: "${snap.topTitle}"`);
    // The full 200-char text must NOT leak into the snapshot.
    const serialized = JSON.stringify(snap);
    assert.ok(!serialized.includes(longText),
      'full-length description must not leak into snapshot');
  });

  it('handles no goals gracefully', () => {
    const g = makeGoalStack();
    g.goals = [];
    const snap = g.getRuntimeSnapshot();
    assert.strictEqual(snap.open, 0);
    assert.strictEqual(snap.paused, 0);
    assert.strictEqual(snap.blocked, 0);
    assert.strictEqual(snap.topTitle, null);
  });
});

// ════════════════════════════════════════════════════════════
// PeerNetwork — must NOT leak token or IPs
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — PeerNetwork.getRuntimeSnapshot', () => {
  const { PeerNetwork } = require('../../src/agent/hexagonal/PeerNetwork');

  function makePN() {
    const p = Object.create(PeerNetwork.prototype);
    p.peers = new Map();
    p.port = 0;
    p._token = 'secret-token-DO-NOT-LEAK-12345678';
    return p;
  }

  it('exposes peerCount and ownPort only', () => {
    const p = makePN();
    p.peers.set('peer1', { ip: '192.168.1.100' });
    p.peers.set('peer2', { ip: '10.0.0.5' });
    p.port = 43210;
    const snap = p.getRuntimeSnapshot();
    assert.strictEqual(snap.peerCount, 2);
    assert.strictEqual(snap.ownPort, 43210);
  });

  it('CRITICAL: does NOT leak token', () => {
    const p = makePN();
    const snap = p.getRuntimeSnapshot();
    assert.ok(!('token' in snap));
    const serialized = JSON.stringify(snap);
    assert.ok(
      !serialized.includes('secret-token-DO-NOT-LEAK-12345678'),
      'PeerNetwork token leaked into snapshot'
    );
  });

  it('CRITICAL: does NOT leak peer IPs', () => {
    const p = makePN();
    p.peers.set('peer1', { ip: '192.168.1.100', port: 9999 });
    p.peers.set('peer2', { ip: '10.0.0.5', port: 9998 });
    const snap = p.getRuntimeSnapshot();
    const serialized = JSON.stringify(snap);
    assert.ok(!serialized.includes('192.168.1.100'));
    assert.ok(!serialized.includes('10.0.0.5'));
  });

  it('defends against non-Map peers field', () => {
    const p = Object.create(PeerNetwork.prototype);
    p.peers = null;
    p.port = 0;
    const snap = p.getRuntimeSnapshot();
    assert.strictEqual(snap.peerCount, 0);
  });
});
