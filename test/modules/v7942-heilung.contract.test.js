#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7942-heilung.contract.test.js
// v7.9.42 Teil A: the run healings. Guards A1 (space-safe read
// grant boundary), A2 (no syntax-parse death for textual CODE
// output), A3 (partial travels on the error, never as success),
// A4 (model selection memory restores before the background scan).
// ============================================================
'use strict';
const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');

describe('v7942 A1 — read grant is space-safe and boundary-exact', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Sandbox.js'), 'utf8');
  test('grant resolves and compares on a separator boundary', () => {
    assert(/rootResolved \+ _path\.sep/.test(src), 'separator-bounded prefix check');
    assert(/_path\.resolve\(allowRoot\)/.test(src), 'grant is resolved before compare');
  });
  test('behavior: child of a space-root passes, sibling-prefix is blocked', () => {
    const root = createTestRoot('a1 space root');
    const inner = path.join(root, 'src'); fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, 'x.js'), '1');
    const resolvedRoot = path.resolve(root);
    const sib = resolvedRoot + '2';
    const child = path.join(resolvedRoot, 'src', 'x.js');
    // replicate the guard's exact comparison shape
    const inRoot = (p) => { const r = path.resolve(p); return r === resolvedRoot || r.startsWith(resolvedRoot + path.sep); };
    assert(inRoot(child), 'space-root child admitted');
    assert(!inRoot(path.join(sib, 'y.js')), 'sibling prefix rejected');
  });
});

describe('v7942 A2 — textual CODE output is not parsed to death', () => {
  const enginePath = path.join(ROOT, 'src/agent/intelligence/VerificationEngine.js');
  const src = fs.readFileSync(enginePath, 'utf8');
  test('guard sits before code.verify and only when no code payload', () => {
    const i = src.indexOf('v7.9.42 A2');
    assert(i > -1 && i < src.indexOf('this._verifiers.code.verify(_codePayload'), 'guard precedes the parse');
    assert(/if \(!result\.code && _codePayload &&/.test(src), 'only fires without a code field');
  });
  test('field sentence "Allowed ..." is accepted, real code still parses', () => {
    const looksCode = (t) => /[;{}]|=>|\bfunction\b|\bconst\b|\brequire\s*\(/.test(t);
    assert(!looksCode('Allowed files and modules under the Genesis package root: src, docs'), 'field text passes the guard');
    assert(looksCode('const x = 1;'), 'real code keeps going into the parser');
    assert(looksCode('module.exports = { a }'), 'object-ish code keeps parsing');
  });
});

describe('v7942 A3 — the partial travels on the error', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridgeContinuation.js'), 'utf8');
  test('pinned message prefix intact, partial fields attached', () => {
    assert(/discarded, not usable as code; preserved for diagnosis/.test(src), 'message keeps the pinned prefix and gains the honest suffix');
    assert(/_pErr\.partialText = result\.content/.test(src), 'partial text on the error');
    assert(/_pErr\.partialChars/.test(src) && /_pErr\.continuationReason/.test(src), 'chars and reason on the error');
  });
  test('failure block throws the enriched error and never returns', () => {
    const k = src.indexOf('const _pErr');
    const t = src.indexOf('throw _pErr', k);
    assert(k > -1 && t > k, 'enriched error is thrown');
    assert(!/\breturn\b/.test(src.slice(k, t)), 'no return inside the failure block');
  });
});

describe('v7942 A4 — model selection memory', () => {
  const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'));
  test('save→load roundtrip via the soul file', () => {
    const dir = createTestRoot('a4-sel');
    const a = Object.create(ModelBridge.prototype);
    a._selectionPath = path.join(dir, 'model-selection.json');
    a.activeModel = 'probe-model';
    a._saveSelection();
    const b = Object.create(ModelBridge.prototype);
    b._selectionPath = a._selectionPath;
    const got = b._loadSelection();
    assertEqual(got && got.model, 'probe-model', 'selection survives');
  });
  test('boot restores synchronously BEFORE the background scan (race pin)', () => {
    const mix = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridgeAvailability.js'), 'utf8');
    const i = mix.indexOf('this.activeModel = _cachedSel.model;');
    const j = mix.indexOf('this.detectAvailable().then(() => this._saveSelection())');
    assert(i > -1 && j > -1 && i < j, 'restore happens before the then-scan');
    assert(/} else {\s*\n\s*await this\.detectAvailable\(\);\s*\n\s*this\._saveSelection\(\);/.test(mix), 'without cache: awaited exactly as before, then remembered');
    assert(/_log\.info\(`\[MODEL\] Restored last selection/.test(mix), 'restore line uses the live mixin logger (v7.9.42 field: dead require silenced it)');
    const bridge = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf8');
    assert(/await this\._bootModelSelection\(\);/.test(bridge), 'boot path routes through the mixin');
  });
  test('missing or corrupt cache degrades to null, never throws', () => {
    const b = Object.create(ModelBridge.prototype);
    b._selectionPath = path.join(createTestRoot('a4-corrupt'), 'model-selection.json');
    fs.writeFileSync(b._selectionPath, '{not json');
    assertEqual(b._loadSelection(), null, 'corrupt cache is null');
    b._selectionPath = null;
    assertEqual(b._loadSelection(), null, 'no path is null');
  });
});

run();
