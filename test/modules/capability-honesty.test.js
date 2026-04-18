// ============================================================
// Test: v7.3.0 — Capability Honesty
// ------------------------------------------------------------
// Verifies that _detectCapabilities() derives capabilities from
// four signals (path, class, header, manifest tags) and that
// the backward-compatible getCapabilities() still returns
// string[] for all existing consumers.
// ============================================================

'use strict';

const path = require('path');
const { describe, test, assert, assertEqual, assertIncludes, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');

const { SelfModel } = require('../../src/agent/foundation/SelfModel');
const { SafeGuard } = require('../../src/kernel/SafeGuard');

// Helper: build SelfModel and scan against the real codebase
async function buildScannedModel(manifestMeta) {
  const guard = new SafeGuard([path.join(ROOT, 'src', 'kernel')], ROOT);
  const sm = new SelfModel(ROOT, guard);
  if (manifestMeta) sm.setManifestMeta(manifestMeta);
  await sm.scan();
  return sm;
}

describe('v7.3.0 — Capability Honesty: Class Presence', () => {
  // Hardcoded test-gate: these classes are part of Genesis's ontology.
  // If any of them lose their Capability entry, a refactor silently broke
  // self-recognition. The test must be explicit about which classes must
  // surface — no generic "at least N capabilities" assertion.
  const REQUIRED_CLASSES = [
    { className: 'Homeostasis',       expectedId: 'homeostasis' },
    { className: 'Metabolism',        expectedId: 'metabolism' },
    { className: 'EmotionalFrontier', expectedId: 'emotional-frontier' },
    { className: 'NeedsSystem',       expectedId: 'needs-system' },
    { className: 'Genome',            expectedId: 'genome' },
    { className: 'ImmuneSystem',      expectedId: 'immune-system' },
    { className: 'BodySchema',        expectedId: 'body-schema' },
    { className: 'EmbodiedPerception', expectedId: 'embodied-perception' },
    { className: 'DreamCycle',        expectedId: 'dream-cycle' },
    { className: 'IdleMind',          expectedId: 'idle-mind' },
  ];

  let caps, detailed;

  test('scan produces capabilities', async () => {
    const sm = await buildScannedModel();
    caps = sm.getCapabilities();
    detailed = sm.getCapabilitiesDetailed();
    assert(caps.length >= 20, `Expected >=20 capabilities, got ${caps.length}`);
    assert(detailed.length === caps.length, 'Detailed and flat lists must be in sync');
  });

  for (const { className, expectedId } of REQUIRED_CLASSES) {
    test(`${className} is detected as capability "${expectedId}"`, () => {
      assertIncludes(caps, expectedId, `${className} should be detected as ${expectedId}`);
      const entry = detailed.find(c => c.id === expectedId);
      assert(entry, `Detailed entry for ${expectedId} must exist`);
      assertEqual(entry.class, className, `Detailed entry's class must be ${className}`);
    });
  }
});

describe('v7.3.0 — Manifest Tag Pipeline', () => {
  // Second test gate: when manifest meta is injected, the tags must flow
  // through to the capability entry. Without this test, a refactor of
  // the injection pipeline (e.g. setManifestMeta dropping the tags field)
  // would silently produce tag-less capabilities.
  test('homeostasis inherits all injected manifest tags', async () => {
    const sm = await buildScannedModel({
      homeostasis: { tags: ['organism', 'homeostasis', 'effectors'], phase: 7, deps: [] },
    });
    const entry = sm.getCapabilitiesDetailed().find(c => c.id === 'homeostasis');
    assert(entry, 'homeostasis capability must exist');
    assert(Array.isArray(entry.tags), 'tags must be an array');
    assertIncludes(entry.tags, 'organism', 'tag "organism" must be preserved');
    assertIncludes(entry.tags, 'homeostasis', 'tag "homeostasis" must be preserved');
    assertIncludes(entry.tags, 'effectors', 'tag "effectors" must be preserved');
  });

  test('keywords include manifest tag values', async () => {
    const sm = await buildScannedModel({
      metabolism: { tags: ['organism', 'metabolism', 'energy'], phase: 7, deps: [] },
    });
    const entry = sm.getCapabilitiesDetailed().find(c => c.id === 'metabolism');
    assert(entry, 'metabolism capability must exist');
    assertIncludes(entry.keywords, 'energy',
      `"energy" (from manifest tags) must flow into keywords; got: ${entry.keywords.join(',')}`);
    assertIncludes(entry.keywords, 'organism', '"organism" (category+tag) must be a keyword');
  });

  test('module with no manifest meta still gets detected from other signals', async () => {
    // No meta injected at all — class/path/header still produce capability
    const sm = await buildScannedModel();
    const entry = sm.getCapabilitiesDetailed().find(c => c.id === 'homeostasis');
    assert(entry, 'homeostasis must be detected without meta');
    assertEqual(entry.tags.length, 0, 'without meta, tags should be empty');
    assert(entry.keywords.length > 0, 'keywords should still be populated from class/path/header');
  });
});

describe('v7.3.0 — Backward Compatibility', () => {
  // Third test gate: getCapabilities() must behave exactly like before.
  // Ten consumers call .join(), .includes(), .slice() — breaking any of
  // those breaks PeerNetwork's wire protocol, ReasoningEngine prompts,
  // SelfModificationPipeline inspect output, and more.
  let sm, caps;

  test('getCapabilities returns a string array', async () => {
    sm = await buildScannedModel();
    caps = sm.getCapabilities();
    assert(Array.isArray(caps), 'must be an array');
    assert(caps.every(c => typeof c === 'string'),
      `all entries must be strings; got: ${caps.slice(0, 3).map(c => typeof c).join(',')}`);
  });

  test('caps.join(", ") produces a readable string', () => {
    const joined = caps.join(', ');
    assert(typeof joined === 'string' && joined.includes(','), 'join produces readable output');
    assert(!joined.includes('[object Object]'),
      'join must NOT produce "[object Object]" — indicates non-string entries leaked');
  });

  test('caps.includes("chat") works for seed capabilities', () => {
    assert(caps.includes('chat'), 'chat seed must be present');
    assert(caps.includes('self-awareness'), 'self-awareness seed must be present');
  });

  test('caps.slice(0, 8) works for UI truncation', () => {
    const top8 = caps.slice(0, 8);
    assertEqual(top8.length, Math.min(8, caps.length), 'slice returns right length');
  });

  test('PeerNetwork-style JSON serialization stays compact', () => {
    // PeerNetwork wire protocol: JSON.stringify({capabilities: getCapabilities()})
    // Must serialize as ["chat","self-awareness",...] not nested objects.
    const wire = JSON.stringify({ capabilities: caps });
    assert(wire.startsWith('{"capabilities":["'), 'wire format must be string array');
    assert(!wire.includes('"id":'), 'wire format must NOT leak the detailed object schema');
  });
});

describe('v7.3.0 — No Regressions in Existing Behavior', () => {
  test('chat and self-awareness are always present (seed capabilities)', async () => {
    const sm = await buildScannedModel();
    assertIncludes(sm.getCapabilities(), 'chat');
    assertIncludes(sm.getCapabilities(), 'self-awareness');
  });

  test('no duplicate capability IDs', async () => {
    const sm = await buildScannedModel();
    const caps = sm.getCapabilities();
    const unique = new Set(caps);
    assertEqual(unique.size, caps.length, 'all capability IDs must be unique');
  });

  test('manifest.version still set from package.json', async () => {
    const sm = await buildScannedModel();
    assert(sm.getFullModel().version, 'version must be set');
  });
});

run();
