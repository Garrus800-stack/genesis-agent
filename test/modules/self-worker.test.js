// ============================================================
// TEST — _self-worker.js (v7.0.5)
// Smoke test for SelfSpawner child process worker.
// ============================================================

const { describe, test, run } = require('../harness');
const path = require('path');
const fs = require('fs');

describe('_self-worker', () => {
  const workerPath = path.join(__dirname, '../../src/agent/capabilities/_self-worker.js');

  test('module file exists and is loadable source', () => {
    const content = fs.readFileSync(workerPath, 'utf-8');
    if (!content.includes('executeTask')) throw new Error('Missing executeTask function');
    if (!content.includes('process.on')) throw new Error('Missing IPC listener');
    if (content.length < 100) throw new Error('File too short — likely empty stub');
  });

  test('exports are not required at module level (IPC worker)', () => {
    // _self-worker.js is designed to run as a child process via process.send/on.
    // It attaches a process.on('message') handler at the module level.
    // We verify the file parses without errors by checking syntax with acorn.
    const acorn = require('../../src/kernel/vendor/acorn');
    const content = fs.readFileSync(workerPath, 'utf-8');
    // Should parse without throwing
    acorn.parse(content, { ecmaVersion: 2022, sourceType: 'script' });
  });
});

if (require.main === module) run();
