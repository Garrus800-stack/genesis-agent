// Test: v7.4.6.fix — completes the v7.4.5 fixes that were declared
// in CHANGELOG but never made it into the source code:
//   #28  step.target || step.command   (AgentLoopSteps._stepShell)
//   #29  find /V /C ":" quote-safe    (ShellAgent._adaptCommand)
//   #30  execAsync for shell-meta     (ShellAgent.run, behavior verified
//                                      via the real shell)
//
// Each test exercises the REAL code path via require(), not just regex
// patterns from a copy of the source.

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log(`    ✅ ${name}`); })
              .catch(err => { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

(async () => {

  // ── Fix #28: AgentLoopSteps._stepShell reads step.command if target absent ──

  await test('#28 AgentLoopSteps source reads step.target || step.command', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'src', 'agent', 'revolution', 'AgentLoopSteps.js'), 'utf-8');
    const stepShellStart = src.indexOf('async _stepShell(');
    assert(stepShellStart > 0, 'expected _stepShell function in source');
    const region = src.slice(stepShellStart, stepShellStart + 1500);
    assert(region.includes('step.command'),
      'expected step.command to be read in _stepShell — fix #28 not applied');
    assert(region.includes('step.target || step.command'),
      'expected the canonical "step.target || step.command" pattern in _stepShell');
  });

  await test('#28 _stepShell fallback prompt mentions OS + rootDir', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'src', 'agent', 'revolution', 'AgentLoopSteps.js'), 'utf-8');
    const stepShellStart = src.indexOf('async _stepShell(');
    const region = src.slice(stepShellStart, stepShellStart + 2500);
    assert(/Working directory:|rootDir/.test(region),
      'fallback prompt must include working-directory hint');
    assert(/process\.platform|isWindows|Windows/i.test(region),
      'fallback prompt must include OS detection');
  });

  await test('#28 _stepShell returns command in result for Verifier visibility', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'src', 'agent', 'revolution', 'AgentLoopSteps.js'), 'utf-8');
    const stepShellStart = src.indexOf('async _stepShell(');
    const stepSearchStart = src.indexOf('async _stepSearch', stepShellStart);
    const region = src.slice(stepShellStart, stepSearchStart > 0 ? stepSearchStart : stepShellStart + 3000);
    const returns = region.match(/return\s*\{[^}]*\}/g) || [];
    assert(returns.length >= 2, `expected ≥2 return statements in _stepShell, got ${returns.length}`);
    for (const ret of returns) {
      assert(/command/.test(ret), `return statement missing 'command' field: ${ret.slice(0, 80)}`);
    }
  });

  // ── Fix #29: ShellAgent._adaptCommand quote-safe counting ──

  await test('#29 _adaptCommand translates wc -l to find /V /C ":"', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const lang = { t: (k, v) => k };
    const bus = { emit() {}, on() {}, fire() {} };
    const agent = new ShellAgent({ lang, bus, model: null, memory: null, knowledgeGraph: null, eventStore: null, sandbox: null, guard: null, rootDir: '/tmp' });
    agent.isWindows = true;
    const adapted = agent._adaptCommand('ls | wc -l');
    assert(adapted.includes('find /V /C ":"'), `expected /V /C ":" in adapted command, got: ${adapted}`);
    assert(!adapted.includes('find /c /v ""'), `must not produce broken /C /V "" pattern, got: ${adapted}`);
  });

  await test('#29 _adaptCommand fixes broken find /C /V "" if LLM emits it', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const lang = { t: (k) => k };
    const bus = { emit() {}, on() {}, fire() {} };
    const agent = new ShellAgent({ lang, bus, model: null, memory: null, knowledgeGraph: null, eventStore: null, sandbox: null, guard: null, rootDir: '/tmp' });
    agent.isWindows = true;
    const adapted1 = agent._adaptCommand('dir /b *.js | find /C /V ""');
    assert(adapted1.includes('find /V /C ":"'), `case 1: expected fixed pattern, got: ${adapted1}`);
    const adapted2 = agent._adaptCommand('dir /b | find /V /C ""');
    assert(adapted2.includes('find /V /C ":"'), `case 2: expected fixed pattern, got: ${adapted2}`);
  });

  await test('#29 _adaptCommand non-Windows is pass-through', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const lang = { t: (k) => k };
    const bus = { emit() {}, on() {}, fire() {} };
    const agent = new ShellAgent({ lang, bus, model: null, memory: null, knowledgeGraph: null, eventStore: null, sandbox: null, guard: null, rootDir: '/tmp' });
    agent.isWindows = false;
    const adapted = agent._adaptCommand('ls | wc -l');
    assert(adapted === 'ls | wc -l', `non-Windows must be pass-through, got: ${adapted}`);
  });

  // ── Fix #30: ShellAgent uses execAsync (not execFileAsync-with-shell) for shell-meta ──

  await test('#30 ShellAgent imports both exec and execFile', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'src', 'agent', 'capabilities', 'ShellAgent.js'), 'utf-8');
    assert(/require\(['"]child_process['"]\)[^;]*\bexec\b/.test(src) || /\{\s*[^}]*\bexec\b[^}]*\}\s*=\s*require\(['"]child_process['"]\)/.test(src),
      'expected exec to be imported from child_process');
    assert(src.includes('execAsync'), 'expected promisified execAsync constant');
    assert(src.includes('execFileAsync'), 'expected execFileAsync (still used for non-shell path)');
  });

  await test('#30 ShellAgent.run uses execAsync (with shell option) for shellMeta/Windows path', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'src', 'agent', 'capabilities', 'ShellAgent.js'), 'utf-8');
    const runStart = src.indexOf('async run(');
    const runEnd = src.indexOf('runStreaming', runStart);
    assert(runStart > 0 && runEnd > runStart, `expected run/runStreaming markers, got ${runStart}/${runEnd}`);
    const region = src.slice(runStart, runEnd);
    assert(region.includes('execAsync'),
      'execAsync must be called inside run() — fix #30 not applied');
    assert(!/execFileAsync\(\s*this\.shell\s*,\s*\[\s*this\.shellFlag/.test(region),
      'old execFileAsync(this.shell, [this.shellFlag, cmd]) pattern still present in run() — fix #30 partial');
  });

  // ── Live: actually run a command on this machine via ShellAgent ──

  await test('LIVE ShellAgent.run executes and returns stdout', async () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const lang = { t: (k) => k };
    const bus = { emit() {}, on() {}, fire() {} };
    const agent = new ShellAgent({ lang, bus, model: null, memory: null, knowledgeGraph: null, eventStore: null, sandbox: null, guard: null, rootDir: process.cwd() });
    const result = await agent.run('ls', { tier: 'read', silent: true });
    assert(result.ok === true, `expected ok=true, got: ${JSON.stringify(result).slice(0,200)}`);
    assert(typeof result.stdout === 'string' && result.stdout.length > 0,
      `expected non-empty stdout, got: ${JSON.stringify(result.stdout).slice(0,80)}`);
    assert(result.adaptedCommand, 'result must include adaptedCommand');
    assert(result.originalCommand === 'ls', `originalCommand should be preserved, got: ${result.originalCommand}`);
  });

  await test('LIVE ShellAgent.run captures stderr on failed command', async () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const lang = { t: (k) => k };
    const bus = { emit() {}, on() {}, fire() {} };
    const agent = new ShellAgent({ lang, bus, model: null, memory: null, knowledgeGraph: null, eventStore: null, sandbox: null, guard: null, rootDir: process.cwd() });
    const result = await agent.run('this-binary-definitely-does-not-exist-xyz123', { tier: 'read', silent: true });
    assert(result.ok === false, `expected ok=false, got: ${JSON.stringify(result).slice(0,200)}`);
    assert(typeof result.stderr === 'string' && result.stderr.length > 0,
      `expected non-empty stderr, got: ${JSON.stringify(result).slice(0,200)}`);
  });

  // ── End-to-end: the missing-await + step.target fix together ──

  await test('LIVE _stepShell with step.command (no target) executes correctly', async () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const { AgentLoopStepsDelegate } = require('../../src/agent/revolution/AgentLoopSteps');
    const lang = { t: (k) => k };
    const bus = { emit() {}, on() {}, fire() {} };
    const shell = new ShellAgent({ lang, bus, model: null, memory: null, knowledgeGraph: null, eventStore: null, sandbox: null, guard: null, rootDir: process.cwd() });

    const fakeLoop = {
      shell,
      rootDir: process.cwd(),
      model: { chat: async () => 'echo fallback-was-called' },
      _requestApproval: async () => true,
    };

    const delegate = new AgentLoopStepsDelegate(fakeLoop);
    const step = { type: 'SHELL', target: null, command: 'echo hello-from-command-field', description: 'test' };
    const result = await delegate._stepShell(step, {}, () => {});
    assert(typeof result.output === 'string' && result.output.includes('hello-from-command-field'),
      `expected output to come from step.command (echo result), got: ${JSON.stringify(result).slice(0,200)}`);
    assert(result.command, `expected result.command to be populated, got: ${result.command}`);
  });

  // ── #31: rootDir sandbox ─────────────────────────────────
  await test('#31 _checkRootDirSandbox accepts relative paths', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const agent = Object.create(ShellAgent.prototype);
    agent.rootDir = process.cwd();
    agent.isWindows = process.platform === 'win32';
    const r = agent._checkRootDirSandbox('dir /b *.js');
    assert(r.ok, `expected ok, got: ${JSON.stringify(r)}`);
  });

  await test('#31 _checkRootDirSandbox accepts absolute paths inside rootDir', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const agent = Object.create(ShellAgent.prototype);
    agent.rootDir = process.cwd();
    agent.isWindows = process.platform === 'win32';
    const inside = require('path').join(process.cwd(), 'src');
    const r = agent._checkRootDirSandbox(`dir /b "${inside}"`);
    assert(r.ok, `expected ok for inside path, got: ${JSON.stringify(r)}`);
  });

  await test('#31 _checkRootDirSandbox rejects "dir /s C:\\"', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const agent = Object.create(ShellAgent.prototype);
    agent.rootDir = 'C:\\Users\\Genesis\\project';
    agent.isWindows = true;
    const r = agent._checkRootDirSandbox('dir /s C:\\');
    assert(!r.ok, 'expected reject "dir /s C:\\"');
    assert(/recursive|outside/i.test(r.reason || ''), `reason: ${r.reason}`);
  });

  await test('#31 _checkRootDirSandbox rejects "where /r C:\\"', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const agent = Object.create(ShellAgent.prototype);
    agent.rootDir = 'C:\\Users\\Genesis\\project';
    agent.isWindows = true;
    const r = agent._checkRootDirSandbox('where /r C:\\ node.exe');
    assert(!r.ok, 'expected reject "where /r C:\\"');
  });

  await test('#31 _checkRootDirSandbox rejects absolute path outside rootDir on Windows', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const agent = Object.create(ShellAgent.prototype);
    agent.rootDir = 'C:\\Users\\Genesis\\project';
    agent.isWindows = true;
    const r = agent._checkRootDirSandbox('type C:\\Windows\\System32\\drivers\\etc\\hosts');
    assert(!r.ok, 'expected reject system path');
    assert(/outside rootDir/i.test(r.reason || ''), `reason: ${r.reason}`);
  });

  await test('#31 ShellAgent.run() returns sandboxBlock:true when sandbox rejects', async () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const { NullBus } = require('../../src/agent/core/EventBus');
    const fakeLang = { t: (k, args) => `${k}: ${JSON.stringify(args || {})}` };
    const agent = new ShellAgent({
      lang: fakeLang,
      bus: NullBus,
      rootDir: 'C:\\Users\\Genesis\\project',
    });
    agent.isWindows = true;
    agent.permissionLevel = 'read';
    const r = await agent.run('dir /s C:\\', { silent: true });
    assert(r.ok === false, 'expected ok:false');
    assert(r.sandboxBlock === true, `expected sandboxBlock:true, got: ${JSON.stringify(r)}`);
    assert(/Sandbox/i.test(r.stderr), `stderr: ${r.stderr}`);
  });

  // ── shell.plan() salvage from non-array LLM responses ────────
  await test('shell.plan salvage: extracts commands from fenced code block', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const a = Object.create(ShellAgent.prototype);
    const out = a._salvageStepsFromText('Plan:\n```\ndir /b *.js\nfind /V /C ":"\n```');
    assert(out.length === 2, `expected 2 steps, got ${out.length}`);
    assert(out[0].cmd === 'dir /b *.js', `got: ${out[0].cmd}`);
  });

  await test('shell.plan salvage: extracts backticked commands', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const a = Object.create(ShellAgent.prototype);
    const out = a._salvageStepsFromText('Führe `dir /b *.js` aus.');
    assert(out.length === 1 && out[0].cmd === 'dir /b *.js', `got: ${JSON.stringify(out)}`);
  });

  await test('shell.plan salvage: extracts $-prompt lines', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const a = Object.create(ShellAgent.prototype);
    const out = a._salvageStepsFromText('Steps:\n$ dir /b *.js\n$ echo done');
    assert(out.length === 2, `got ${out.length}`);
    assert(out[0].cmd === 'dir /b *.js', `got: ${out[0].cmd}`);
  });

  await test('shell.plan salvage: extracts numbered list with known commands', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const a = Object.create(ShellAgent.prototype);
    const out = a._salvageStepsFromText('1. dir /b *.js\n2. find /V /C ":" results.txt');
    assert(out.length === 2, `got ${out.length}`);
  });

  await test('shell.plan salvage: returns empty for non-command text', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const a = Object.create(ShellAgent.prototype);
    const out = a._salvageStepsFromText('Das ist kein Befehl, bitte präzisieren.');
    assert(out.length === 0, `expected 0, got: ${JSON.stringify(out)}`);
  });

  // ── #29b: LLM hallucination patterns ────────────────────────
  await test('#29b _adaptCommand fixes find /c "*" hallucination', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const agent = Object.create(ShellAgent.prototype);
    agent.isWindows = true;
    const out = agent._adaptCommand('dir /b *.js | find /c "*"');
    assert(out.includes('find /V /C ":"'), `expected fix, got: ${out}`);
    assert(!out.includes('find /c "*"'), `broken pattern still present: ${out}`);
  });

  await test('#29b _adaptCommand fixes find /c "." hallucination', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const agent = Object.create(ShellAgent.prototype);
    agent.isWindows = true;
    const out = agent._adaptCommand('dir /b *.js | find /c "."');
    assert(out.includes('find /V /C ":"'), `expected fix, got: ${out}`);
  });

  await test('#29b _adaptCommand fixes find /count hallucination', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const agent = Object.create(ShellAgent.prototype);
    agent.isWindows = true;
    const out = agent._adaptCommand('dir /b *.js | find /count');
    assert(out.includes('find /V /C ":"'), `expected fix, got: ${out}`);
  });

  await test('#29b _adaptCommand fixes findstr /c:"*" hallucination', () => {
    const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
    const agent = Object.create(ShellAgent.prototype);
    agent.isWindows = true;
    const out = agent._adaptCommand('dir /b *.js | findstr /c:"*"');
    assert(out.includes('find /V /C ":"'), `expected fix, got: ${out}`);
  });

  // ── Summary ──

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
