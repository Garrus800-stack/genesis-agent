#!/usr/bin/env node
// GENESIS — v7.9.45 L: the cognitive laboratory. The one-way street is pinned
// at the ARGUMENT level: --rm, --network none, exactly one fresh /work mount,
// no auto-pull (inspect first), honest no-lab and timeout sentences. The
// runner is injectable — the workbench has no Docker, the field does.
'use strict';
const { describe, test, assert, run } = require('../harness');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { registerV745Tools } = require(path.join(ROOT, 'src/agent/cognitive/tools/v745-labor-tools.js'));

const mk = (behave, settings) => {
  const calls = [];
  const reg = { _t: {}, register(n, s, h) { this._t[n] = { handler: h }; } };
  registerV745Tools(reg, {
    execFileImpl: async (file, args, opts) => { calls.push({ file, args, opts }); return behave(file, args, opts); },
    settings: settings || { get: () => undefined },
    logger: { info() {} },
  });
  return { T: reg._t, calls };
};
const dockerUp = (onRun) => async (file, args) => {
  if (args[0] === 'version') return { err: null, stdout: '27.0', stderr: '', code: 0 };
  if (args[0] === 'image') return { err: null, stdout: '[]', stderr: '', code: 0 };
  if (args[0] === 'ps') return { err: null, stdout: '', stderr: '', code: 0 };
  return onRun ? onRun(file, args) : { err: null, stdout: 'ok', stderr: '', code: 0 };
};

describe('v7945 L — the cognitive laboratory', () => {
  test('the lab is OPT-IN by word: explicit sentences route deterministically, everyday code does not', () => {
    const defs = require(path.join(ROOT, 'src/agent/intelligence/IntentPatterns.js')).INTENT_DEFINITIONS;
    const hit = (t) => { for (const d of defs) { if (d[1].some((r) => r.test(t))) return d[0]; } return null; };
    assert(hit('F\u00fchre im Labor diesen Code aus: console.log(1)') === 'lab-run', 'lab sentence routes to lab-run');
    assert(hit('F\u00fchre im Labor diesen Python-Code aus: print(1)') === 'lab-run', 'python variant too');
    assert(hit('f\u00fchre diesen code aus: x=1') !== 'lab-run', 'everyday code stays on the old road');
  });

  test('the handler extracts code, language and seconds — and speaks through the REAL registry', async () => {
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const { CommandHandlers } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlers.js'));
    const reg = new ToolRegistry({ bus: { fire() {} }, lang: { t: (k) => k } });
    const seen = [];
    reg.register('lab-run', { description: 's', input: {} }, async (input) => { seen.push(input); return { ok: true, content: '\ud83e\uddea ok' }; });
    const h = new CommandHandlers({ lang: { t: (k) => k, detect() {}, current: 'de' } });
    const r = await h.labRun('F\u00fchre im Labor mit 3 Sekunden Limit diesen Python-Code aus: print(2)', { tools: reg });
    assert(seen[0].code === 'print(2)' && seen[0].language === 'python' && seen[0].timeoutSec === 3 && /\ud83e\uddea ok/.test(r), 'args reach the tool intact');
    const empty = new ToolRegistry({ bus: { fire() {} }, lang: { t: (k) => k } });
    const miss = await h.labRun('f\u00fchre im labor aus: x', { tools: empty });
    assert(/nicht angeschlossen/.test(miss), 'honest when the room is absent');
  });

  test('the boot wiring uses tryResolve only — the field regression that silently skipped the lab', () => {
    const fs2 = require('fs');
    const wire = fs2.readFileSync(path.join(ROOT, 'src/agent/AgentCoreBootWire.js'), 'utf-8');
    const block = wire.split('registerV745Tools(tools')[1] || '';
    assert(/settings:\s*c\.tryResolve\('settings'\)/.test(block.slice(0, 400)), 'v745 deps resolve settings via tryResolve');
    assert(!/c\.resolve\(/.test(block.slice(0, 400)), 'no bare c.resolve in the lab wiring');
    assert(/const tools = c\.tryResolve\('tools'\)/.test(wire.split('v7.9.45 L: the cognitive laboratory')[1].slice(0, 500)), 'the lab block resolves tools in its OWN scope (the second silent root)');
  });

  test('a status question without code shows the room instead of begging for code', async () => {
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const { CommandHandlers } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlers.js'));
    const reg = new ToolRegistry({ bus: { fire() {} }, lang: { t: (k) => k } });
    reg.register('lab-status', { description: 's', input: {} }, async () => ({ ok: true, content: 'STATUS-ROOM' }));
    reg.register('lab-run', { description: 's', input: {} }, async () => ({ ok: true, content: 'RUN' }));
    const h = new CommandHandlers({ lang: { t: (k) => k, detect() {}, current: 'de' } });
    assert(/STATUS-ROOM/.test(await h.labRun('Schau ins Labor.', { tools: reg })), 'DE status question → lab-status');
    assert(/STATUS-ROOM/.test(await h.labRun('look into the lab', { tools: reg })), 'EN too');
    assert(/Gib mir den Code/.test(await h.labRun('im labor bitte', { tools: reg })), 'no status word → code ask stays');
  });

  test('no Docker answers with his no-lab sentence, honestly', async () => {
    const { T } = mk(async () => ({ err: new Error('nope'), stdout: '', stderr: '', code: 1 }));
    const st = await T['lab-status'].handler({});
    assert(!st.ok && /kein Labor/.test(st.error), 'status speaks plainly');
    const rn = await T['lab-run'].handler({ code: 'x' });
    assert(!rn.ok && /kein Labor/.test(rn.error), 'run speaks the same sentence');
  });

  test('only images the human freed may build a room', async () => {
    const { T } = mk(dockerUp(), { get: (k) => (k === 'lab.images' ? ['node:alpine'] : undefined) });
    const r = await T['lab-run'].handler({ code: 'x', image: 'evil:latest' });
    assert(!r.ok && /nicht freigegeben/.test(r.error) && /lab\.images/.test(r.error), 'foreign image refused, the settings road named');
  });

  test('a missing blueprint names the one pull command and never runs', async () => {
    const { T, calls } = mk(async (file, args) => {
      if (args[0] === 'version') return { err: null, stdout: '27.0', stderr: '', code: 0 };
      if (args[0] === 'image') return { err: new Error('no such image'), stdout: '', stderr: '', code: 1 };
      return { err: null, stdout: 'RAN', stderr: '', code: 0 };
    });
    const r = await T['lab-run'].handler({ code: 'x', language: 'python' });
    assert(!r.ok && /docker pull python:3-alpine/.test(r.error), 'the exact pull command is spoken');
    assert(!calls.some((c) => c.args[0] === 'run'), 'no run ever fired — inspect is the only no-auto-pull guarantee');
  });

  test('the one-way arguments are pinned: --rm, --network none, exactly one fresh mount, timeout honoured', async () => {
    const { T, calls } = mk(dockerUp(() => ({ err: null, stdout: 'hallo aus dem labor', stderr: '', code: 0 })));
    const r = await T['lab-run'].handler({ code: 'console.log(1)', timeoutSec: 7 });
    const runCall = calls.find((c) => c.args[0] === 'run');
    const a = runCall.args;
    assert(a.includes('--rm'), 'the room is one-way (removed after)');
    assert(a[a.indexOf('--network') + 1] === 'none', 'no network in the room');
    assert(a.filter((x) => x === '-v').length === 1, 'exactly one mount');
    const mount = a[a.indexOf('-v') + 1] || '';
    assert(/genesis-lab-/.test(mount) && mount.endsWith(':/work'), 'the mount is the fresh throwaway folder');
    assert(!/\.genesis/.test(mount), 'never the soul');
    assert(runCall.opts.timeout === 7000, 'the time limit rides into the runner');
    assert(r.ok && /hallo aus dem labor/.test(r.content) && /copy-to-archive/.test(r.content), 'output returns, the conscious fetch road is named');
  });

  test('the time limit ends a run honestly — a result, not a failure', async () => {
    const { T } = mk(dockerUp(() => ({ err: Object.assign(new Error('killed'), { killed: true }), stdout: 'teil', stderr: '', code: null, killed: true })));
    const r = await T['lab-run'].handler({ code: 'while(1);', timeoutSec: 2 });
    assert(r.ok && /Zeitgrenze|abgebrochen/.test(r.content) && /teil/.test(r.content), 'partial output and the honest sentence');
  });
});
run();
