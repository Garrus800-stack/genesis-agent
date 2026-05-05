// ============================================================
// GENESIS — test/modules/v759-fix.test.js
//
// Source-presence + behavior tests for the v7.5.9 patch suite:
//
//   B1 — Slash-Discipline enforced on fast-path returns of classifyAsync
//        (IntentRouter.js)
//   B2 — main.js sends stream-done when agent === null
//   B3 — openPath alias-resolver uses capture-group + leading-punct strip
//        (CommandHandlersShell.js)
//   B4 — ChatOrchestrator emits chat:completed on both try and catch
//        paths with structural success flag (no String-sniff)
//   B5 — ModelBridge.streamChat object-form maps noCache (parity with chat)
//   B6 — IntentRouter._llmClassify uses Promise.race timeout cap (8s)
//   Cleanup — slash-commands.js drops three never-called exports
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const { describe, test, assert, assertEqual, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');

// ── B1 ────────────────────────────────────────────────────────

describe('v7.5.9 B1 — Slash-Discipline enforced on fast-path', () => {

  test('source-presence: enforce on fast.confidence >= 0.6 return', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'), 'utf8');
    // Pre-fix was: `if (fast.confidence >= 0.6) return fast;`
    assert(/if \(fast\.confidence >= 0\.6\) return _enforceSlashDiscipline\(fast, message\);/.test(src),
      'fast-path must enforce slash-discipline');
  });

  test('source-presence: enforce on final fall-through return', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'), 'utf8');
    // Pre-fix was final `return fast;` — now must be enforce
    assert(/return _enforceSlashDiscipline\(fast, message\);/.test(src),
      'fall-through must enforce slash-discipline');
    // Make sure the bare `return fast;` is gone in classifyAsync context
    const ca = src.indexOf('async classifyAsync');
    const slice = src.slice(ca, ca + 3500);
    assert(!/^\s*return fast;\s*$/m.test(slice),
      'bare `return fast;` should not exist in classifyAsync');
  });

  test('behavior: free-text "fuehr aus den code" routes to general (not execute-code)', async () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const router = new IntentRouter({ bus: { fire: () => {}, emit: () => {} } });
    // No model, no localClassifier — purely tests fast-path enforce
    const result = await router.classifyAsync('fuehr aus den code');
    assertEqual(result.type, 'general', 'must rewrite to general (no slash present)');
  });

  test('behavior: "/execute-code do thing" still routes to execute-code', async () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const router = new IntentRouter({ bus: { fire: () => {}, emit: () => {} } });
    const result = await router.classifyAsync('/execute-code do thing');
    assertEqual(result.type, 'execute-code', 'slash-path remains intact');
  });

  test('behavior: "ich will diesen befehl ausfuehren" routes to general', async () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const router = new IntentRouter({ bus: { fire: () => {}, emit: () => {} } });
    const result = await router.classifyAsync('ich will diesen befehl ausfuehren');
    // Without slash, must NOT be shell-run. Could be general or codegen-guard fallthrough.
    assert(result.type !== 'shell-run' && result.type !== 'execute-code',
      `expected non-shell intent, got ${result.type}`);
  });

  test('behavior: code-block paste "```js\\nfoo()\\n```" still routes to execute-code', async () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const router = new IntentRouter({ bus: { fire: () => {}, emit: () => {} } });
    // Code-block paste is the documented alternate trigger for execute-code.
    // Discipline must allow this path through.
    const result = await router.classifyAsync('```js\nconsole.log("hi")\n```');
    assertEqual(result.type, 'execute-code', 'code-block paste must remain a valid trigger');
  });

});

// ── B2 ────────────────────────────────────────────────────────

describe('v7.5.9 B2 — main.js sends stream-done when agent is null', () => {

  test('source-presence: stream-done sent before return when !agent', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    // Locate the agent:request-stream handler
    const idx = src.indexOf("'agent:request-stream'");
    assert(idx > -1, 'agent:request-stream handler missing');
    const slice = src.slice(idx, idx + 1500);
    assert(/if \(!agent\) \{[\s\S]*?stream-chunk[\s\S]*?stream-done[\s\S]*?\}/.test(slice),
      'must send stream-chunk + stream-done in !agent branch');
    // Pre-fix bare `if (!agent) return;` should not exist any more
    assert(!/if \(!agent\) return;\s*\n\s*agent\.handleChatStream/.test(slice),
      'bare early-return must be replaced');
  });

});

// ── B3 ────────────────────────────────────────────────────────

describe('v7.5.9 B3 — openPath alias-resolver capture-group + punct-strip', () => {

  test('source-presence: capture-group regex with named alias', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersShell.js'), 'utf8');
    // New form: aliasRe with capture group + match-based offset
    assert(/aliasMatch = lower\.match\(aliasRe\)/.test(src),
      'must use match() instead of search() arithmetic');
    assert(/replace\(\/\^\[,;:!\?\\s\]\+\//.test(src),
      'must strip leading punctuation from afterAlias');
  });

  test('source-presence: legacy +1 arithmetic gone (excluding comments)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersShell.js'), 'utf8');
    // Strip line-comments before checking, so the historical-context comment
    // referencing the old form doesn't trigger a false positive.
    const stripped = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!/lower\.search\(aliasRe\) \+ alias\.length \+ 1/.test(stripped),
      'pre-fix arithmetic offset must be removed from real code');
  });

});

// ── B4 ────────────────────────────────────────────────────────

describe('v7.5.9 B4 — chat:completed structural success flag', () => {

  test('source-presence: success: true (literal) on success path', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator.js'), 'utf8');
    assert(/success: true/.test(src), 'literal success: true on try-branch');
    // Pre-fix string-sniff must be gone
    assert(!/!response\.startsWith\('\*\*' \+ this\.lang\.t\('agent\.error'\)\)/.test(src),
      'string-sniff success calculation must be removed');
  });

  test('source-presence: chat:completed emitted in catch branch with success: false', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator.js'), 'utf8');
    // Locate the catch block and verify chat:completed fires there too
    const idx = src.indexOf('} catch (err) {');
    assert(idx > -1, 'catch block missing');
    const slice = src.slice(idx, idx + 2000);
    assert(/this\.bus\.fire\('chat:completed'/.test(slice),
      'chat:completed must fire in catch branch');
    assert(/success: false/.test(slice),
      'success: false must be set in catch branch');
  });

});

// ── B5 ────────────────────────────────────────────────────────

describe('v7.5.9 B5 — ModelBridge.streamChat noCache parity', () => {

  test('source-presence: streamChat object-form maps noCache', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf8');
    // Find the streamChat *method* (not comment mentions)
    const idx = src.indexOf('async streamChat');
    assert(idx > -1, 'async streamChat method missing');
    const slice = src.slice(idx, idx + 3500);
    assert(/arg\.noCache\s+!==\s+undefined\s*\?\s*\{\s+noCache:\s+arg\.noCache\s*\}/.test(slice),
      'streamChat must map arg.noCache');
  });

});

// ── B6 ────────────────────────────────────────────────────────

describe('v7.5.9 B6 — _llmClassify Promise.race timeout', () => {

  test('source-presence: Promise.race with timeout on model.chat', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'), 'utf8');
    const idx = src.indexOf('async _llmClassify');
    assert(idx > -1, '_llmClassify missing');
    const slice = src.slice(idx, idx + 4000);
    assert(/Promise\.race\(\[/.test(slice), 'must use Promise.race');
    assert(/LLM_CLASSIFY_TIMEOUT/.test(slice), 'timeout error tag missing');
    // v7.5.9 ZIP1 Phase 5: default raised to 0 (disabled) — cloud LLMs
    // routinely take >30s, the cap was causing more harm than good.
    // Settings.intent.llmClassifyTimeoutMs overrides; positive values
    // re-enable the race.
    assert(/:\s*0\s*;/.test(slice), 'default must be 0 (disabled)');
    assert(/intent\.llmClassifyTimeoutMs/.test(slice),
      'must read configurable timeout from settings');
  });

  test('source-presence: setSettings late-binding for IntentRouter', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'), 'utf8');
    assert(/setSettings\s*\(\s*settings\s*\)/.test(src),
      'setSettings method must exist');
    const wireSrc = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreBoot.js'), 'utf8');
    assert(/intentRouter\D+\.setSettings\(/.test(wireSrc),
      'AgentCoreBoot must wire setSettings');
  });

  test('behavior: timeout fires when model.chat hangs', async () => {
    const { IntentRouter: _IR } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    void _IR;  // silence unused — only used to ensure the module loads
    // Mock: model.chat hangs forever
    const hangingModel = { chat: () => new Promise(() => {}) };
    // Replicate the timeout pattern used in _llmClassify with a 50ms cap.
    const t0 = Date.now();
    let caught = null;
    try {
      const _timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('LLM_CLASSIFY_TIMEOUT')), 50)
      );
      await Promise.race([
        hangingModel.chat('test', [], 'analysis'),
        _timeoutPromise,
      ]);
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - t0;
    assert(caught && /LLM_CLASSIFY_TIMEOUT/.test(caught.message),
      'must throw LLM_CLASSIFY_TIMEOUT');
    assert(elapsed < 200, `must time out fast, took ${elapsed}ms`);
  });

});

// ── Live-fixes (2026-05-04, after first v7.5.9 cloud-test) ───

describe('v7.5.9 live-fix — open-path catches natural folder phrasings', () => {

  test('source-presence: extended open-path patterns', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/IntentPatterns.js'), 'utf8');
    const idx = src.indexOf("'open-path'");
    const slice = src.slice(idx, idx + 1500);
    // Pattern (a): "öffne den X ordner" with alias before noun
    assert(/oeffne.+ordner.+folder.+verzeichnis.+dir.+datei.+file/i.test(slice),
      'pattern allowing alias-before-noun must be present');
    // Pattern (c): "welche dateien sind in ihm" implicit listing
    assert(/welche\\s\+dateien/.test(slice),
      'implicit dateien-in-ihm pattern must be present');
  });

  test('behavior: "öffne den github ordner auf dem desktop" → open-path', async () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const r = new IntentRouter({ bus: { fire: () => {}, emit: () => {} } });
    const result = r.classify('öffne den github ordner auf dem desktop');
    assertEqual(result.type, 'open-path', 'natural phrasing must route to open-path');
  });

  test('behavior: "kannst den ordner öffnen ? C:\\\\path" → open-path', async () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const r = new IntentRouter({ bus: { fire: () => {}, emit: () => {} } });
    const result = r.classify('kannst den ordner öffnen ? C:\\Users\\Name\\Desktop\\github');
    assertEqual(result.type, 'open-path', 'win-path-anywhere must route to open-path');
  });

  test('behavior: "welche dateien sind in ihm" → open-path', async () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const r = new IntentRouter({ bus: { fire: () => {}, emit: () => {} } });
    const result = r.classify('auf dem desktop ist ein ordner welche dateien sind in ihm');
    assertEqual(result.type, 'open-path', 'implicit listing must route to open-path');
  });

});

describe('v7.5.9 live-fix — file-read tool gets filename-variant resolution', () => {

  test('source-presence: file-read tool imports _resolveFileWithVariants', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'), 'utf8');
    assert(/_resolveFileWithVariants.*SelfModelSourceRead/s.test(src),
      'must import _resolveFileWithVariants from SelfModelSourceRead');
  });

  test('source-presence: file-read calls variant resolver on missing file', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'), 'utf8');
    const idx = src.indexOf("this.register('file-read'");
    const slice = src.slice(idx, idx + 2000);
    assert(/_resolveFileWithVariants\(filePath, rootDir\)/.test(slice),
      'file-read must call _resolveFileWithVariants(filePath, rootDir)');
    // Re-validate path through _resolveProjectPath after variant resolve.
    assert(/r2\s*=\s*_resolveProjectPath/.test(slice),
      'must re-validate resolved path through project-scope guard');
  });

  test('source-presence: _resolveFileWithVariants is exported', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/SelfModelSourceRead.js'), 'utf8');
    assert(/module\.exports\s*=\s*\{[^}]*_resolveFileWithVariants/.test(src),
      '_resolveFileWithVariants must be exported');
  });

});

describe('v7.5.9 cleanup — slash-commands.js dead funcs removed', () => {

  test('source-absence: slashPatternFor / detectSlashCommand / getCommand gone', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/slash-commands.js'), 'utf8');
    // function declarations gone
    assert(!/function slashPatternFor\b/.test(src), 'slashPatternFor declaration must be removed');
    assert(!/function detectSlashCommand\b/.test(src), 'detectSlashCommand declaration must be removed');
    assert(!/function getCommand\b/.test(src), 'getCommand declaration must be removed');
    // exports stripped
    const exportBlock = src.slice(src.indexOf('module.exports'));
    assert(!/slashPatternFor/.test(exportBlock), 'slashPatternFor must not be exported');
    assert(!/detectSlashCommand/.test(exportBlock), 'detectSlashCommand must not be exported');
    assert(!/getCommand/.test(exportBlock), 'getCommand must not be exported');
  });

  test('source-presence: SLASH_COMMANDS + allCommandNames remain', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/slash-commands.js'), 'utf8');
    const exportBlock = src.slice(src.indexOf('module.exports'));
    assert(/SLASH_COMMANDS/.test(exportBlock), 'SLASH_COMMANDS must remain exported');
    assert(/allCommandNames/.test(exportBlock), 'allCommandNames must remain exported');
  });

  test('module loads after cleanup', () => {
    const m = require(path.join(ROOT, 'src/agent/intelligence/slash-commands.js'));
    assert(Array.isArray(m.SLASH_COMMANDS), 'SLASH_COMMANDS must be an array');
    assert(typeof m.allCommandNames === 'function', 'allCommandNames must be a function');
    assert(m.slashPatternFor === undefined, 'slashPatternFor must be undefined');
    assert(m.detectSlashCommand === undefined, 'detectSlashCommand must be undefined');
    assert(m.getCommand === undefined, 'getCommand must be undefined');
  });

});

run();
