// Test: CI-Ratchet baseline + checker (v7.3.5 commit 8)
// The ratchet locks the v7.3.5 release state as a regression floor.
// Later releases may only raise it, never lower it.
const { describe, test, run } = require('../harness');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RATCHET_PATH = path.join(ROOT, 'scripts', 'ratchet.json');
const CHECKER_PATH = path.join(ROOT, 'scripts', 'check-ratchet.js');

describe('ratchet baseline file', () => {
  test('ratchet.json exists', () => {
    if (!fs.existsSync(RATCHET_PATH)) throw new Error('ratchet.json missing');
  });

  test('ratchet.json parses as valid JSON', () => {
    JSON.parse(fs.readFileSync(RATCHET_PATH, 'utf8'));
  });

  test('has all required floor entries', () => {
    const r = JSON.parse(fs.readFileSync(RATCHET_PATH, 'utf8'));
    const required = ['testCount', 'fitnessScore', 'schemaMismatches', 'schemaMissing', 'schemaOrphan', 'brokenLinks'];
    for (const key of required) {
      if (!r[key]) throw new Error('missing ratchet key: ' + key);
    }
  });

  test('testCount floor is numeric and sane', () => {
    const r = JSON.parse(fs.readFileSync(RATCHET_PATH, 'utf8'));
    if (typeof r.testCount.floor !== 'number') throw new Error('testCount.floor must be number');
    if (r.testCount.floor < 1000) throw new Error('testCount.floor suspiciously low: ' + r.testCount.floor);
  });

  test('fitnessScore floor is between 0 and max', () => {
    const r = JSON.parse(fs.readFileSync(RATCHET_PATH, 'utf8'));
    if (typeof r.fitnessScore.floor !== 'number') throw new Error('fitnessScore.floor must be number');
    if (r.fitnessScore.floor < 0 || r.fitnessScore.floor > r.fitnessScore.max) {
      throw new Error('fitnessScore.floor out of range');
    }
  });

  test('drift thresholds are zero', () => {
    const r = JSON.parse(fs.readFileSync(RATCHET_PATH, 'utf8'));
    if (r.schemaMismatches.max !== 0) throw new Error('schema mismatches must be locked at 0');
    if (r.schemaMissing.max !== 0) throw new Error('schema missing must be locked at 0');
    if (r.schemaOrphan.max !== 0) throw new Error('schema orphan must be locked at 0');
  });
});

describe('ratchet checker script', () => {
  test('check-ratchet.js exists', () => {
    if (!fs.existsSync(CHECKER_PATH)) throw new Error('check-ratchet.js missing');
  });

  test('check-ratchet.js is syntactically valid', () => {
    const { execFileSync } = require('child_process');
    // Use node's -c (syntax check) mode — handles shebangs and cjs module globals
    execFileSync(process.execPath, ['-c', CHECKER_PATH], { stdio: 'pipe' });
  });

  test('check-ratchet.js supports --skip-tests flag', () => {
    const src = fs.readFileSync(CHECKER_PATH, 'utf8');
    if (!src.includes('--skip-tests')) throw new Error('should support --skip-tests');
  });
});

run();
