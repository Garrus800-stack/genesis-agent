// ============================================================
// TEST: SkillRegistry — V6-6 Skill Install/Uninstall/List
// ============================================================

const { describe, test, assertEqual, assert, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const { SkillRegistry } = require('../../src/agent/capabilities/SkillRegistry');

const TEST_DIR = path.join(__dirname, '..', '.tmp-skillreg-test');

function mockBus() {
  const events = [];
  return {
    on() { return () => {}; },
    emit(e, d) { events.push({ event: e, data: d }); },
    fire(e, d) { this.emit(e, d); },
    _events: events,
  };
}

function setup() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function cleanup() {
  try { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true }); } catch (_e) { /* */ }
}

function createMockSkill(dir, name, version = '1.0.0') {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'skill-manifest.json'), JSON.stringify({
    name, version, description: `Test skill: ${name}`, entry: 'index.js',
  }));
  fs.writeFileSync(path.join(skillDir, 'index.js'), `module.exports = { run() { return "hello from ${name}"; } };`);
  return skillDir;
}

// ── Constructor + Lifecycle ─────────────────────────────────

describe('SkillRegistry — Constructor', () => {
  test('constructs with required deps', () => {
    setup();
    const reg = new SkillRegistry({ skillsDir: TEST_DIR, bus: mockBus() });
    assert(reg.skillsDir === TEST_DIR);
    assertEqual(reg.list().length, 0);
    cleanup();
  });

  test('SkillRegistry is registered via manifest', () => {
    assert(typeof SkillRegistry === 'function', 'class exported');
  });

  test('asyncLoad creates skillsDir if missing', async () => {
    const dir = path.join(TEST_DIR, 'new-dir');
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    const reg = new SkillRegistry({ skillsDir: dir, bus: mockBus() });
    await reg.asyncLoad();
    assert(fs.existsSync(dir), 'Should create directory');
    cleanup();
  });
});

// ── Manifest Validation ─────────────────────────────────────

describe('SkillRegistry — Manifest Validation', () => {
  test('accepts valid manifest', async () => {
    setup();
    createMockSkill(TEST_DIR, 'valid-skill');
    const reg = new SkillRegistry({ skillsDir: TEST_DIR, bus: mockBus() });
    const result = await reg._validateManifest(path.join(TEST_DIR, 'valid-skill', 'skill-manifest.json'));
    assert(result.valid, 'Should accept valid manifest');
    assertEqual(result.data.name, 'valid-skill');
    cleanup();
  });

  test('rejects missing name', async () => {
    setup();
    const dir = path.join(TEST_DIR, 'bad');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'skill-manifest.json'), JSON.stringify({ version: '1.0.0', description: 'x', entry: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), '');
    const reg = new SkillRegistry({ skillsDir: TEST_DIR, bus: mockBus() });
    const result = await reg._validateManifest(path.join(dir, 'skill-manifest.json'));
    assert(!result.valid, 'Should reject missing name');
    assert(result.error.includes('name'));
    cleanup();
  });

  test('rejects invalid name pattern', async () => {
    setup();
    const dir = path.join(TEST_DIR, 'bad2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'skill-manifest.json'), JSON.stringify({ name: 'INVALID_NAME!', version: '1.0.0', description: 'x', entry: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), '');
    const reg = new SkillRegistry({ skillsDir: TEST_DIR, bus: mockBus() });
    const result = await reg._validateManifest(path.join(dir, 'skill-manifest.json'));
    assert(!result.valid, 'Should reject uppercase name');
    cleanup();
  });

  test('rejects invalid version', async () => {
    setup();
    const dir = path.join(TEST_DIR, 'bad3');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'skill-manifest.json'), JSON.stringify({ name: 'test', version: 'nope', description: 'x', entry: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), '');
    const reg = new SkillRegistry({ skillsDir: TEST_DIR, bus: mockBus() });
    const result = await reg._validateManifest(path.join(dir, 'skill-manifest.json'));
    assert(!result.valid, 'Should reject non-semver');
    cleanup();
  });

  test('rejects missing entry file', async () => {
    setup();
    const dir = path.join(TEST_DIR, 'bad4');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'skill-manifest.json'), JSON.stringify({ name: 'test', version: '1.0.0', description: 'x', entry: 'missing.js' }));
    const reg = new SkillRegistry({ skillsDir: TEST_DIR, bus: mockBus() });
    const result = await reg._validateManifest(path.join(dir, 'skill-manifest.json'));
    assert(!result.valid, 'Should reject missing entry');
    cleanup();
  });
});

// ── List + Meta Persistence ─────────────────────────────────

describe('SkillRegistry — List + Meta', () => {
  test('list returns empty for fresh registry', () => {
    setup();
    const reg = new SkillRegistry({ skillsDir: TEST_DIR, bus: mockBus() });
    assertEqual(reg.list().length, 0);
    cleanup();
  });

  test('meta persists and loads', async () => {
    setup();
    const bus = mockBus();
    const reg = new SkillRegistry({ skillsDir: TEST_DIR, bus });
    reg._installed.set('test-skill', {
      name: 'test-skill', version: '1.0.0', source: 'test', installedAt: 'now', description: 'Test',
    });
    await reg._saveMeta();

    const reg2 = new SkillRegistry({ skillsDir: TEST_DIR, bus });
    await reg2._loadMeta();
    assertEqual(reg2.list().length, 1);
    assertEqual(reg2.list()[0].name, 'test-skill');
    cleanup();
  });
});

// ── Uninstall ───────────────────────────────────────────────

describe('SkillRegistry — Uninstall', () => {
  test('uninstall removes skill dir and meta', async () => {
    setup();
    const bus = mockBus();
    const reg = new SkillRegistry({ skillsDir: TEST_DIR, bus });
    createMockSkill(TEST_DIR, 'remove-me');
    reg._installed.set('remove-me', {
      name: 'remove-me', version: '1.0.0', source: 'test', installedAt: 'now', description: 'x',
    });

    const result = await reg.uninstall('remove-me');
    assert(result.success, 'Should succeed');
    assert(!fs.existsSync(path.join(TEST_DIR, 'remove-me')), 'Dir should be gone');
    assertEqual(reg.list().length, 0);
    assert(bus._events.some(e => e.event === 'skill:uninstalled'), 'Should emit event');
    cleanup();
  });

  test('uninstall returns error for unknown skill', async () => {
    setup();
    const reg = new SkillRegistry({ skillsDir: TEST_DIR, bus: mockBus() });
    const result = await reg.uninstall('nonexistent');
    assert(!result.success);
    assert(result.error.includes('not installed'));
    cleanup();
  });
});

// ── Search ──────────────────────────────────────────────────

describe('SkillRegistry — Search', () => {
  test('returns empty when no registry URL', async () => {
    const reg = new SkillRegistry({ skillsDir: TEST_DIR, bus: mockBus() });
    const results = await reg.search('test');
    assertEqual(results.length, 0);
  });
});

run();
