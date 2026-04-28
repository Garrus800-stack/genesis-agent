// ============================================================
// v7.4.2 "Kassensturz" Baustein D — Structure tests
//
// Locks invariants of the CommandHandlers 7-file split. Analog to
// v739-structure.test.js for the DreamCycle / ChatOrchestrator splits.
//
// If any of these tests fail, the domain split is broken in a way
// that won't be caught by functional tests (e.g. a method silently
// moved to wrong mixin, Object.assign order forgot one, a file grew
// past the soft guard).
// ============================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { CommandHandlers } = require('../../src/agent/hexagonal/CommandHandlers');

const HEXAGONAL_DIR = path.resolve(__dirname, '../../src/agent/hexagonal');

// All 22 methods that must be reachable on CommandHandlers instances
// (23 including constructor; constructor is class-level, not prototype)
const ALL_METHOD_NAMES = [
  // Core
  'registerHandlers', 'undo',
  // Code/Skill
  'executeCode', 'executeFile', 'analyzeCode', 'runSkill',
  // Shell & File
  'shellTask', 'shellRun', 'projectScan', 'openPath',
  // Goals/Plans
  'plans', 'goals', 'journal',
  // CoreMemories
  'memoryMark', 'memoryList', 'memoryVeto',
  // System
  'handleSettings', 'daemonControl', 'trustControl',
  // Network
  'peer', 'mcpControl', 'webLookup',
];

// Map of method → expected mixin file (for traceability / move-detection)
const METHOD_HOME = {
  'registerHandlers':  'CommandHandlers.js',      // core
  'undo':              'CommandHandlers.js',      // core
  'executeCode':       'CommandHandlersCode.js',
  'executeFile':       'CommandHandlersCode.js',
  'analyzeCode':       'CommandHandlersCode.js',
  'runSkill':          'CommandHandlersCode.js',
  'shellTask':         'CommandHandlersShell.js',
  'shellRun':          'CommandHandlersShell.js',
  'projectScan':       'CommandHandlersShell.js',
  'openPath':          'CommandHandlersShell.js',
  'plans':             'CommandHandlersGoals.js',
  'goals':             'CommandHandlersGoals.js',
  'journal':           'CommandHandlersGoals.js',
  'memoryMark':        'CommandHandlersMemory.js',
  'memoryList':        'CommandHandlersMemory.js',
  'memoryVeto':        'CommandHandlersMemory.js',
  'handleSettings':    'CommandHandlersSystem.js',
  'daemonControl':     'CommandHandlersSystem.js',
  'trustControl':      'CommandHandlersSystem.js',
  'peer':              'CommandHandlersNetwork.js',
  'mcpControl':        'CommandHandlersNetwork.js',
  'webLookup':         'CommandHandlersNetwork.js',
};

// Minimal mock deps for constructing an instance
function makeHandler() {
  return new CommandHandlers({
    bus: null, lang: null, sandbox: null, fileProcessor: null,
    network: null, daemon: null, idleMind: null, analyzer: null,
    goalStack: null, settings: null, webFetcher: null,
    shellAgent: null, mcpClient: null, coreMemories: null,
  });
}

describe('v7.4.2 Baustein D — CommandHandlers split structure', () => {

  it('all 22 method names are reachable on an instance', () => {
    const ch = makeHandler();
    for (const name of ALL_METHOD_NAMES) {
      assert.strictEqual(
        typeof ch[name], 'function',
        `Method ${name} is missing from CommandHandlers instance`
      );
    }
  });

  it('no renamed methods — exact names preserved from v7.4.1', () => {
    const ch = makeHandler();
    // Just verify via count + names — any rename would either miss the
    // ALL_METHOD_NAMES check above or add new names we'd spot here.
    const allFunctions = Object.getOwnPropertyNames(CommandHandlers.prototype)
      .filter(n => typeof ch[n] === 'function' && n !== 'constructor');
    for (const name of ALL_METHOD_NAMES) {
      assert.ok(
        allFunctions.includes(name),
        `Method ${name} not found on prototype`
      );
    }
  });

  it('CommandHandlers.js core is under 700 LOC', () => {
    const file = path.join(HEXAGONAL_DIR, 'CommandHandlers.js');
    const lines = fs.readFileSync(file, 'utf8').split('\n').length;
    assert.ok(
      lines < 700,
      `CommandHandlers.js has ${lines} lines, must be under 700 (warn threshold)`
    );
  });

  it('each mixin file is under 300 LOC (soft guard)', () => {
    const mixins = [
      'CommandHandlersCode.js',
      'CommandHandlersShell.js',
      'CommandHandlersGoals.js',
      'CommandHandlersMemory.js',
      'CommandHandlersSystem.js',
      'CommandHandlersNetwork.js',
    ];
    for (const name of mixins) {
      const file = path.join(HEXAGONAL_DIR, name);
      const lines = fs.readFileSync(file, 'utf8').split('\n').length;
      assert.ok(
        lines < 300,
        `${name} has ${lines} lines, should stay under 300 (soft guard)`
      );
    }
  });

  it('all six mixin files exist and export the expected name', () => {
    const expected = {
      'CommandHandlersCode.js':    'commandHandlersCode',
      'CommandHandlersShell.js':   'commandHandlersShell',
      'CommandHandlersGoals.js':   'commandHandlersGoals',
      'CommandHandlersMemory.js':  'commandHandlersMemory',
      'CommandHandlersSystem.js':  'commandHandlersSystem',
      'CommandHandlersNetwork.js': 'commandHandlersNetwork',
    };
    for (const [fname, exportName] of Object.entries(expected)) {
      const file = path.join(HEXAGONAL_DIR, fname);
      assert.ok(fs.existsSync(file), `${fname} missing`);
      const mod = require(file);
      assert.ok(mod[exportName], `${fname} does not export ${exportName}`);
      assert.strictEqual(typeof mod[exportName], 'object', `${exportName} is not an object`);
    }
  });

  it('prototype chain composition: each method exists on prototype (not just instance)', () => {
    for (const name of ALL_METHOD_NAMES) {
      assert.ok(
        typeof CommandHandlers.prototype[name] === 'function',
        `Method ${name} is not on CommandHandlers.prototype — Object.assign order broken?`
      );
    }
  });

  it('constructor initializes all expected instance fields', () => {
    const ch = makeHandler();
    // v7.4.2 split preserves the constructor contract
    const fields = ['bus', 'lang', 'sandbox', 'fp', 'network', 'daemon',
                    'idleMind', 'analyzer', 'goalStack', 'settings',
                    'web', 'shell', 'mcp', 'coreMemories', 'skillManager'];
    for (const f of fields) {
      assert.ok(f in ch, `Instance field '${f}' not initialized`);
    }
  });

  it('no mixin method collides with another mixin method', () => {
    // Ensure each method's home is unique — no duplicates across mixins
    const seen = new Map();
    const { commandHandlersCode }    = require('../../src/agent/hexagonal/CommandHandlersCode');
    const { commandHandlersShell }   = require('../../src/agent/hexagonal/CommandHandlersShell');
    const { commandHandlersGoals }   = require('../../src/agent/hexagonal/CommandHandlersGoals');
    const { commandHandlersMemory }  = require('../../src/agent/hexagonal/CommandHandlersMemory');
    const { commandHandlersSystem }  = require('../../src/agent/hexagonal/CommandHandlersSystem');
    const { commandHandlersNetwork } = require('../../src/agent/hexagonal/CommandHandlersNetwork');
    const mixins = {
      code: commandHandlersCode,
      shell: commandHandlersShell,
      goals: commandHandlersGoals,
      memory: commandHandlersMemory,
      system: commandHandlersSystem,
      network: commandHandlersNetwork,
    };
    for (const [mixinName, mixin] of Object.entries(mixins)) {
      for (const methodName of Object.keys(mixin)) {
        assert.ok(
          !seen.has(methodName),
          `Method ${methodName} collision: ${seen.get(methodName)} and ${mixinName}`
        );
        seen.set(methodName, mixinName);
      }
    }
  });

  it('expected method count per mixin (domain integrity)', () => {
    const { commandHandlersCode }    = require('../../src/agent/hexagonal/CommandHandlersCode');
    const { commandHandlersShell }   = require('../../src/agent/hexagonal/CommandHandlersShell');
    const { commandHandlersGoals }   = require('../../src/agent/hexagonal/CommandHandlersGoals');
    const { commandHandlersMemory }  = require('../../src/agent/hexagonal/CommandHandlersMemory');
    const { commandHandlersSystem }  = require('../../src/agent/hexagonal/CommandHandlersSystem');
    const { commandHandlersNetwork } = require('../../src/agent/hexagonal/CommandHandlersNetwork');

    assert.strictEqual(Object.keys(commandHandlersCode).length, 4, 'Code mixin: 4 methods expected');
    assert.strictEqual(Object.keys(commandHandlersShell).length, 4, 'Shell mixin: 4 methods expected');
    // v7.5.0: Goals mixin grew from 3 → 10 methods. The 3 public handlers
    // (journal, plans, goals) are unchanged. Added 7 private helpers
    // for the slash-subcommand parser + negotiate-before-add flow:
    //   _addGoalCommand, _cancelGoalCommand, _cancelAllCommand,
    //   _confirmPendingCommand, _revisePendingCommand,
    //   _dismissPendingCommand, _renderGoalsList.
    // Domain-integrity is preserved — all helpers are goal-domain only.
    assert.strictEqual(Object.keys(commandHandlersGoals).length, 10, 'Goals mixin: 10 methods expected (3 public + 7 v7.5.0 helpers)');
    assert.strictEqual(Object.keys(commandHandlersMemory).length, 3, 'Memory mixin: 3 methods expected');
    assert.strictEqual(Object.keys(commandHandlersSystem).length, 3, 'System mixin: 3 methods expected');
    assert.strictEqual(Object.keys(commandHandlersNetwork).length, 3, 'Network mixin: 3 methods expected');
    // Total: 4+4+10+3+3+3 = 27 in mixins + registerHandlers + undo = 29
  });
});
