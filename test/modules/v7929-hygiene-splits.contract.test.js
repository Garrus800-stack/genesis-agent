// ============================================================
// GENESIS — test/modules/v7929-hygiene-splits.contract.test.js
//
// v7.9.29 (Teil A): the >700-LOC modules were split along natural
// seams into sibling files, each mixed back onto its class's
// prototype (the same Object.assign pattern already used by
// IdleMind, GoalStack, etc.) so no public method moved and no
// container resolution changed. These are pure relocations — the
// behaviour is exercised by each parent's own suite.
//
// This suite verifies, per split: the new file exports its piece,
// the extracted method is present on the parent prototype (so the
// mixin actually took), and the parent is under the 700-LOC guard.
// Referencing each new module's basename here also keeps it counted
// as covered by the architectural-fitness Test-Coverage check.
// ============================================================

const { describe, test, assert, run } = require('../harness');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const loc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').length;

describe('v7.9.29 hygiene #1 — AgentCoreBootWire', () => {
  const { agentCoreBootWireMixin } = require(path.join(ROOT, 'src/agent/AgentCoreBootWire'));
  const { AgentCoreBoot } = require(path.join(ROOT, 'src/agent/AgentCoreBoot'));

  test('AgentCoreBootWire exports the wire mixin with _wireAndStart', () => {
    assert(agentCoreBootWireMixin && typeof agentCoreBootWireMixin._wireAndStart === 'function',
      'mixin exports _wireAndStart');
  });

  test('_wireAndStart is mixed onto AgentCoreBoot.prototype', () => {
    assert(typeof AgentCoreBoot.prototype._wireAndStart === 'function',
      'method present on prototype (AgentCore.js call unchanged)');
  });

  test('AgentCoreBoot.js is under the 700-LOC guard', () => {
    const lines = loc('src/agent/AgentCoreBoot.js');
    assert(lines < 700, `AgentCoreBoot.js has ${lines} LOC`);
  });
});

describe('v7.9.29 hygiene #2 — ModelBridgeSemaphore', () => {
  const { _LLMSemaphore } = require(path.join(ROOT, 'src/agent/foundation/ModelBridgeSemaphore'));

  test('ModelBridgeSemaphore exports the _LLMSemaphore class', () => {
    assert(typeof _LLMSemaphore === 'function', 'exports the class');
    const s = new _LLMSemaphore(2);
    assert(typeof s.acquire === 'function' && typeof s.release === 'function', 'has acquire/release');
  });

  test('ModelBridge imports it and is under the 700-LOC guard', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf8');
    assert(/ModelBridgeSemaphore/.test(src), 'ModelBridge imports the semaphore');
    assert(!/class _LLMSemaphore/.test(src), 'class no longer defined inline');
    assert(loc('src/agent/foundation/ModelBridge.js') < 700, 'ModelBridge under 700 LOC');
  });
});

describe('v7.9.29 hygiene #5 — EmotionalStateHistory', () => {
  const { emotionalStateHistoryMixin } = require(path.join(ROOT, 'src/agent/organism/EmotionalStateHistory'));
  const { EmotionalState } = require(path.join(ROOT, 'src/agent/organism/EmotionalState'));

  test('EmotionalStateHistory exports the mood-history methods', () => {
    for (const m of ['exportMoodHistory', 'getPeaks', 'getSustained']) {
      assert(typeof emotionalStateHistoryMixin[m] === 'function', `mixin has ${m}`);
    }
  });

  test('methods are mixed onto EmotionalState.prototype; file under 700 LOC', () => {
    assert(typeof EmotionalState.prototype.getPeaks === 'function', 'getPeaks on prototype');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/organism/EmotionalState.js'), 'utf8');
    assert(!/^\s{2}exportMoodHistory\(/m.test(src), 'method no longer defined inline');
    assert(loc('src/agent/organism/EmotionalState.js') < 700, 'EmotionalState under 700 LOC');
  });
});

describe('v7.9.29 hygiene #6 — VerificationEngineVerifiers', () => {
  const V = require(path.join(ROOT, 'src/agent/intelligence/VerificationEngineVerifiers'));
  const VE = require(path.join(ROOT, 'src/agent/intelligence/VerificationEngine'));

  test('Verifiers file exports the 5 classes + getAcorn + status constants', () => {
    for (const c of ['CodeVerifier', 'TestVerifier', 'ShellVerifier', 'FileVerifier', 'PlanVerifier']) {
      assert(typeof V[c] === 'function', `exports ${c}`);
    }
    assert(typeof V.getAcorn === 'function' && V.PASS === 'pass', 'getAcorn + PASS present');
  });

  test('VerificationEngine re-exports them and is under 700 LOC', () => {
    assert(typeof VE.CodeVerifier === 'function', 'VE re-exports CodeVerifier');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/VerificationEngine.js'), 'utf8');
    assert(/VerificationEngineVerifiers/.test(src), 'VE imports the verifiers module');
    assert(!/^class CodeVerifier/m.test(src), 'classes no longer defined inline');
    assert(loc('src/agent/intelligence/VerificationEngine.js') < 700, 'VE under 700 LOC');
  });
});

describe('v7.9.29 hygiene #7 — AgentLoopObstacles', () => {
  const { agentLoopObstaclesMixin } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopObstacles'));
  const { AgentLoopRecoveryDelegate } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery'));

  test('AgentLoopObstacles exports the 7 recovery-tactic methods', () => {
    for (const m of ['_tryDecomposeOnRepeatedFailure', '_sweepRepeatedFailures', '_trySpawnObstacleSubgoal',
      '_isObstacleLoop', '_recordObstacleSpawn', '_recallObstacleLessons', '_fireLoopProtected']) {
      assert(typeof agentLoopObstaclesMixin[m] === 'function', `mixin has ${m}`);
    }
  });

  test('methods are mixed onto the delegate; file under 700 LOC', () => {
    assert(typeof AgentLoopRecoveryDelegate.prototype._trySpawnObstacleSubgoal === 'function', 'method on prototype');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery.js'), 'utf8');
    assert(/AgentLoopObstacles/.test(src), 'delegate imports the obstacles module');
    assert(loc('src/agent/revolution/AgentLoopRecovery.js') < 700, 'AgentLoopRecovery under 700 LOC');
  });
});

describe('v7.9.29 hygiene #8 — AutonomousDaemonActivities', () => {
  const { autonomousDaemonActivitiesMixin } = require(path.join(ROOT, 'src/agent/autonomy/AutonomousDaemonActivities'));
  const { AutonomousDaemon } = require(path.join(ROOT, 'src/agent/autonomy/AutonomousDaemon'));

  test('AutonomousDaemonActivities exports the 7 idle-cycle activities', () => {
    for (const m of ['_healthCheck', '_persistHealthIssues', '_trimJsonlFile', '_consolidateMemory',
      '_learnFromHistory', '_suggestOptimizations', '_persistSuggestions']) {
      assert(typeof autonomousDaemonActivitiesMixin[m] === 'function', `mixin has ${m}`);
    }
  });

  test('activities are mixed onto AutonomousDaemon.prototype; file under 700 LOC', () => {
    assert(typeof AutonomousDaemon.prototype._consolidateMemory === 'function', 'method on prototype');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/AutonomousDaemon.js'), 'utf8');
    assert(/AutonomousDaemonActivities/.test(src), 'daemon imports the activities module');
    assert(loc('src/agent/autonomy/AutonomousDaemon.js') < 700, 'AutonomousDaemon under 700 LOC');
  });
});

describe('v7.9.29 hygiene #10 — phase9-cognitive-b', () => {
  const { phase9b } = require(path.join(ROOT, 'src/agent/manifest/phase9-cognitive-b'));
  const { phase9 } = require(path.join(ROOT, 'src/agent/manifest/phase9-cognitive'));

  test('phase9b is a function returning the second-half registration list', () => {
    assert(typeof phase9b === 'function', 'phase9b is a function');
    const ctx = { bus: {}, intervals: {} };
    const R = () => ({});
    const arr = phase9b(ctx, R);
    assert(Array.isArray(arr) && arr.length > 0, 'phase9b returns a non-empty array');
  });

  test('phase9 concatenates both halves; file under 700 LOC', () => {
    const ctx = { bus: {}, intervals: {} };
    const R = () => ({});
    const full = phase9(ctx, R);
    const names = full.map((e) => e[0]);
    assert(names.includes('eventCounter') && names.includes('lessonsAutoCapture'),
      'phase9 includes entries from both halves');
    assert(loc('src/agent/manifest/phase9-cognitive.js') < 700, 'phase9-cognitive under 700 LOC');
  });
});

describe('v7.9.29 hygiene #9 — AgentLoopStepsCode', () => {
  const { agentLoopStepsCodeMixin } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopStepsCode'));
  const { AgentLoopStepsDelegate } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopSteps'));

  test('AgentLoopStepsCode exports the code + sandbox step handlers', () => {
    const keys = Object.keys(agentLoopStepsCodeMixin).sort();
    assert(keys.includes('_stepCode') && keys.includes('_stepSandbox'), 'mixin exports _stepCode and _stepSandbox');
  });

  test('handlers are mixed onto AgentLoopStepsDelegate.prototype; file under 700 LOC', () => {
    assert(typeof AgentLoopStepsDelegate.prototype._stepCode === 'function', '_stepCode on prototype');
    assert(typeof AgentLoopStepsDelegate.prototype._stepSandbox === 'function', '_stepSandbox on prototype');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopSteps.js'), 'utf8');
    assert(/AgentLoopStepsCode/.test(src), 'delegate imports the code module');
    assert(loc('src/agent/revolution/AgentLoopSteps.js') < 700, 'AgentLoopSteps under 700 LOC');
  });
});

describe('v7.9.29 hygiene #3 — ToolRegistryBuiltins (+ ShellOSAdapter moved to core/shell)', () => {
  const { toolRegistryBuiltinsMixin } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistryBuiltins'));
  const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry'));

  test('ToolRegistryBuiltins exports the two tool-definition registrars', () => {
    const keys = Object.keys(toolRegistryBuiltinsMixin).sort();
    assert(keys.includes('registerBuiltins') && keys.includes('registerSystemTools'), 'mixin exports both registrars');
  });

  test('registrars are mixed onto ToolRegistry.prototype; file under 700 LOC', () => {
    assert(typeof ToolRegistry.prototype.registerBuiltins === 'function', 'registerBuiltins on prototype');
    assert(typeof ToolRegistry.prototype.registerSystemTools === 'function', 'registerSystemTools on prototype');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'), 'utf8');
    assert(/ToolRegistryBuiltins/.test(src), 'ToolRegistry imports the builtins module');
    assert(loc('src/agent/intelligence/ToolRegistry.js') < 700, 'ToolRegistry under 700 LOC');
  });

  test('ShellOSAdapter now lives in core/shell (Phase 0), not capabilities', () => {
    assert(fs.existsSync(path.join(ROOT, 'src/agent/core/shell/ShellOSAdapter.js')), 'ShellOSAdapter in core/shell');
    assert(!fs.existsSync(path.join(ROOT, 'src/agent/capabilities/shell/ShellOSAdapter.js')), 'old capabilities path removed');
  });
});

describe('v7.9.29 hygiene #4 — SettingsPersistence', () => {
  const { settingsPersistenceMixin } = require(path.join(ROOT, 'src/agent/foundation/SettingsPersistence'));
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));

  test('SettingsPersistence exports load/save/merge/clamp methods', () => {
    const keys = Object.keys(settingsPersistenceMixin).sort();
    assert(keys.includes('_load') && keys.includes('_save') && keys.includes('_sanityClampOnLoad'), 'mixin exports the persistence methods');
  });

  test('methods are mixed onto Settings.prototype; file under 700 LOC', () => {
    assert(typeof Settings.prototype._load === 'function', '_load on prototype');
    assert(typeof Settings.prototype._sanityClampOnLoad === 'function', '_sanityClampOnLoad on prototype');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf8');
    assert(/SettingsPersistence/.test(src), 'Settings imports the persistence module');
    assert(loc('src/agent/foundation/Settings.js') < 700, 'Settings under 700 LOC');
  });
});

describe('v7.9.29 hygiene #11 — ChatOrchestratorLessons', () => {
  const { chatOrchestratorLessons } = require(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorLessons'));
  const { helpers } = require(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorHelpers'));

  test('ChatOrchestratorLessons exports the two lesson-capture helpers', () => {
    const keys = Object.keys(chatOrchestratorLessons).sort();
    assert(keys.includes('_captureNotFoundLesson') && keys.includes('_captureUnknownCmdLesson'), 'exports both lesson helpers');
  });

  test('helpers are merged onto the helpers object; file under 700 LOC', () => {
    assert(typeof helpers._captureNotFoundLesson === 'function', '_captureNotFoundLesson on helpers');
    assert(typeof helpers._captureUnknownCmdLesson === 'function', '_captureUnknownCmdLesson on helpers');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorHelpers.js'), 'utf8');
    assert(/ChatOrchestratorLessons/.test(src), 'helpers imports the lessons module');
    assert(loc('src/agent/hexagonal/ChatOrchestratorHelpers.js') < 700, 'ChatOrchestratorHelpers under 700 LOC');
  });
});

run();
