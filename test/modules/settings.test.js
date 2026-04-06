#!/usr/bin/env node
// Test: Settings — dot-path config with encryption
const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDir = path.join(os.tmpdir(), `genesis-settings-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

const { Settings } = require('../../src/agent/foundation/Settings');

function create() { return new Settings(tmpDir, null); }

describe('Settings', () => {

  test('constructor initializes with defaults', () => {
    const s = create();
    assertEqual(s.get('ui.language'), 'de');
    assertEqual(s.get('daemon.enabled'), true);
    assertEqual(s.get('security.allowSelfModify'), true);
  });

  test('set and get simple value', () => {
    const s = create();
    s.set('ui.language', 'en');
    assertEqual(s.get('ui.language'), 'en');
  });

  test('set creates nested paths', () => {
    const s = create();
    s.set('custom.deep.nested.key', 42);
    assertEqual(s.get('custom.deep.nested.key'), 42);
  });

  test('get returns undefined for missing path', () => {
    const s = create();
    assertEqual(s.get('nonexistent.path'), undefined);
  });

  test('get returns undefined for null in chain', () => {
    const s = create();
    assertEqual(s.get('ui.language.deeper'), undefined);
  });

  test('set encrypts sensitive keys', () => {
    const s = create();
    s.set('models.anthropicApiKey', 'sk-ant-test-12345');
    // Raw value should be encrypted
    const raw = s.data.models.anthropicApiKey;
    assert(typeof raw === 'string', 'should store as string');
    assert(raw.startsWith('ENC:') || raw.startsWith('ENCv2:') || raw.startsWith('enc2:'), 'should be encrypted');
    // get() should decrypt transparently
    assertEqual(s.get('models.anthropicApiKey'), 'sk-ant-test-12345');
  });

  test('getAll returns decrypted copy', () => {
    const s = create();
    s.set('models.anthropicApiKey', 'sk-test');
    const all = s.getAll();
    // API key should be masked in getAll
    assert(typeof all.models.anthropicApiKey === 'string');
  });

  test('getRaw returns data reference', () => {
    const s = create();
    assertEqual(s.getRaw(), s.data);
  });

  test('hasAnthropic returns false without key', () => {
    const s = create();
    assertEqual(s.hasAnthropic(), false);
  });

  test('hasAnthropic returns true with key', () => {
    const s = create();
    s.set('models.anthropicApiKey', 'sk-ant-api03-longenoughtopass');
    assertEqual(s.hasAnthropic(), true);
  });

  test('hasOpenAI checks both url and key', () => {
    const s = create();
    assertEqual(s.hasOpenAI(), false);
    s.set('models.openaiBaseUrl', 'http://localhost:11434');
    assertEqual(s.hasOpenAI(), false); // still no key
    s.set('models.openaiApiKey', 'test-key');
    assertEqual(s.hasOpenAI(), true);
  });

  test('asyncLoad does not crash', async () => {
    const s = create();
    await s.asyncLoad();
  });

  test('cognitive defaults are present', () => {
    const s = create();
    assertEqual(s.get('cognitive.phase9Enabled'), true);
    assertEqual(s.get('cognitive.simulation.maxBranches'), 3);
    assertEqual(s.get('cognitive.surprise.noveltyThreshold'), 1.5);
  });

  test('organism defaults are present', () => {
    const s = create();
    assertEqual(s.get('organism.homeostasis.tickIntervalMs'), 30000);
    assertEqual(s.get('organism.emotions.baselines.curiosity'), 0.6);
  });
});

run();
try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* */ }
