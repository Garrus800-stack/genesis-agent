// ============================================================
// GENESIS — test/modules/v7946-mcp-settings.contract.test.js
//
// v7.9.46 (MCP settings side-cut) contract: the MCP server password
// became a real setting — a write-only field in the MCP tab, encrypted
// in settings.json, and mandatory for every start path.
//
// This suite pins the CHANNELS through which that password could leak
// or be destroyed. Each test corresponds to a hole that was found by
// reading the code, not by a failing test:
//
//   1. Settings.getAll  — the renderer feed and the JSON editor both
//      read it; it must report state, never a value.
//   2. Chat GET branch  — `settings <path>` bypasses getAll entirely.
//   3. Chat SET branches — both of them echoed the value back into the
//      chat, and from there into chat-history.json.
//   4. The legacy "api key" regex swallowed `mcp.serve.apiKey` (it
//      matches "api"+"Key") and wrote the MCP password into
//      models.anthropicApiKey — password lost, model key destroyed.
//   5. JSON editor      — its own sensitive-path list drives both the
//      display mask and the write-back guard.
//   6. startServer      — refuses without a usable password, and tells
//      "not set" apart from "set but undecryptable".
//
// Deliberate beneficial side effect of 2–4: the model API keys stop
// leaking through the same chat command (pre-existing hole).
// ============================================================

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings.js'));
const { SENSITIVE_KEYS } = require(path.join(ROOT, 'src/agent/foundation/SettingsEncryption.js'));
const { McpClient } = require(path.join(ROOT, 'src/agent/capabilities/McpClient.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

function freshSettings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v7946-mcpset-'));
  return { dir, settings: new Settings(dir) };
}

function chatHandler(settings) {
  const mod = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersSystem.js'));
  const h = Object.assign({}, mod.commandHandlersSystem || mod);
  h.settings = settings;
  h.lang = { t: (k) => k };
  return h;
}

(async () => {
  // ── 0: the key is registered as sensitive at all ──
  t('the MCP password is in SENSITIVE_KEYS (encrypted on write)', () => {
    assert.ok(SENSITIVE_KEYS.has('mcp.serve.apiKey'));
  });

  // ── 1: getAll reports state, not value ──
  t('getAll masks the MCP password to (set) — no prefix, no length', () => {
    const { settings } = freshSettings();
    assert.strictEqual(settings.getAll().mcp.serve.apiKey, '', 'unset reads as empty');
    settings.set('mcp.serve.apiKey', 'a-long-secret-password');
    const all = settings.getAll();
    assert.strictEqual(all.mcp.serve.apiKey, '(set)');
    assert.ok(!JSON.stringify(all).includes('a-long-secret-password'), 'value must not appear anywhere in the feed');
    assert.strictEqual(all.mcp.serve.port, 3580, 'port stays readable — the settings dialog loads it');
    assert.strictEqual(all.mcp.serve.enabled, false, 'enabled stays readable');
  });

  // ── 2: chat GET branch redacts sensitive leaves ──
  t('chat `settings <path>` reports (set — hidden) for sensitive leaves', () => {
    const { settings } = freshSettings();
    const h = chatHandler(settings);
    settings.set('mcp.serve.apiKey', 'a-long-secret-password');
    settings.set('models.anthropicApiKey', 'sk-ant-supersecret-0001');
    const mcpOut = h.handleSettings('settings mcp.serve.apiKey');
    assert.ok(mcpOut.includes('(set — hidden)'), mcpOut);
    assert.ok(!mcpOut.includes('a-long-secret-password'));
    // beneficial side effect: same protection for the model keys
    const antOut = h.handleSettings('settings models.anthropicApiKey');
    assert.ok(antOut.includes('(set — hidden)'), antOut);
    assert.ok(!antOut.includes('sk-ant-supersecret-0001'));
    // a subtree query prints the STORED form — ciphertext, never plaintext
    const sub = h.handleSettings('settings mcp.serve');
    assert.ok(!sub.includes('a-long-secret-password'));
  });

  // ── 3 + 4: both setter branches redact, and the dotted path lands right ──
  t('chat `settings <path> = <pw>` stores the MCP password and echoes (set)', () => {
    const { settings } = freshSettings();
    const h = chatHandler(settings);
    const out = h.handleSettings('settings mcp.serve.apiKey = my-chat-password');
    assert.ok(out.includes('(set)'), out);
    assert.ok(!out.includes('my-chat-password'), 'the value must not be echoed into chat history');
    // Regression pin: the legacy "(?:anthropic|api).?key" branch used to
    // swallow this line (it matches "api"+"Key"), so the password went to
    // models.anthropicApiKey and the Anthropic key was destroyed.
    assert.strictEqual(settings.get('mcp.serve.apiKey'), 'my-chat-password', 'lands at the MCP path');
    assert.ok(!settings.get('models.anthropicApiKey'), 'must not touch the Anthropic key');
    assert.ok(String(settings.data.mcp.serve.apiKey).startsWith('enc'), 'stored encrypted');
  });
  t('chat whitespace setter redacts too, and natural phrasing still works', () => {
    const { settings } = freshSettings();
    const h = chatHandler(settings);
    const out = h.handleSettings('settings mcp.serve.apiKey whitespace-password');
    assert.ok(out.includes('(set)') && !out.includes('whitespace-password'), out);
    assert.strictEqual(settings.get('mcp.serve.apiKey'), 'whitespace-password');
    // the legacy convenience form is untouched
    h.handleSettings('anthropic key: sk-ant-legacy-form-123456');
    assert.strictEqual(settings.get('models.anthropicApiKey'), 'sk-ant-legacy-form-123456');
  });

  // ── 5: JSON editor masks AND refuses to write the mask back ──
  t('JSON editor treats the MCP password like the other secrets', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings-json-editor.js'), 'utf8');
    assert.ok(/SENSITIVE_PATHS[\s\S]{0,400}'mcp\.serve\.apiKey'/.test(src),
      'mcp.serve.apiKey must be in SENSITIVE_PATHS — it drives the display mask AND the write-back guard');
    // the guard that keeps a mask from becoming the stored value
    assert.ok(src.includes("startsWith('***MASKED***')"), 'write-back guard still present');
  });

  // ── 6: no password, no server — on every path, with two distinct reasons ──
  await ta('startServer refuses without a password and names the reason', async () => {
    const { dir, settings } = freshSettings();
    const mcp = new McpClient({ settings, toolRegistry: { listTools: () => [] }, storageDir: dir });
    let code = null;
    try { await mcp.startServer(); } catch (e) { code = e.code; }
    assert.strictEqual(code, 'MCP_NO_KEY');
    // "set but undecryptable" (enc3 is anchored to .genesis/.install-id, so a
    // copied folder yields an empty decrypt) must NOT read as "not set".
    // A well-formed iv:tag:payload triple that fails authentication is
    // exactly what a foreign installation produces.
    settings.data.mcp.serve.apiKey = 'enc3:'
      + '0'.repeat(24) + ':' + '1'.repeat(32) + ':' + 'abcdef';
    assert.strictEqual(settings.get('mcp.serve.apiKey'), '', 'failed decrypt yields an empty string');
    code = null;
    try { await mcp.startServer(); } catch (e) { code = e.code; }
    assert.strictEqual(code, 'MCP_KEY_UNREADABLE');
    // with a password it starts, on the configured port
    settings.set('mcp.serve.apiKey', 'a-long-secret-password');
    settings.set('mcp.serve.port', 3599);
    const port = await mcp.startServer();
    assert.strictEqual(port, 3599, 'inherits mcp.serve.port when no port is passed');
    await mcp._mcpServer.stop();
  });

  // ── 7: the wiring block must resolve its own `tools` ──
  t('every tool-registration block in BootWire resolves `tools` itself', () => {
    // Field bug: the vestibule block used a bare `tools` that was scoped
    // inside an earlier try, so it threw ReferenceError on EVERY boot and
    // the catch swallowed it — the vestibule was silently absent from the
    // running app while every test passed. The lab block carries a comment
    // about the exact same trap. This pin makes the class impossible.
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreBootWire.js'), 'utf8');
    const registrations = src.match(/=\s*register(?:V\d+)Tools\(tools,|\bregister(?:V\d+)Tools\(tools,/g) || [];
    const resolutions = src.match(/const tools = c\.tryResolve\('tools'\)/g) || [];
    assert.ok(registrations.length >= 3, `expected the three tool families, found ${registrations.length}`);
    assert.strictEqual(resolutions.length, registrations.length,
      `each registration block needs its own tools resolve — ${registrations.length} blocks, ${resolutions.length} resolves`);
    // and a failure there must be loud, not debug
    assert.ok(/\[v7946-vestibule\] wiring FAILED/.test(src),
      'a failed vestibule wiring must warn, not whisper at debug level');
  });

  // ── 8: the vestibule tools must survive a REAL ToolRegistry ──
  t('vestibule tools register against the real ToolRegistry API', () => {
    // Second half of the same field bug: because the wiring never ran, nobody
    // noticed the tools were registered with an object argument while
    // ToolRegistry.register is (name, schema, handler, source). listTools()
    // then threw on `schema.description`. Contract suite and matrix used a
    // hand-rolled double that accepted the object form — the double agreed
    // with the bug. Both now use the real class; this pin fixes it in place.
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const { registerV7946Tools } = require(path.join(ROOT, 'src/agent/cognitive/tools/v7946-vestibule-tools.js'));
    const { VestibuleGate } = require(path.join(ROOT, 'src/agent/capabilities/VestibuleGate.js'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v7946-reg-'));
    const reg = new ToolRegistry({});
    const names = registerV7946Tools(reg, {
      vestibuleGate: new VestibuleGate({ genesisDir: dir }),
      modelBridge: { _genesisDir: dir },
      bus: { fire() {} },
    });
    assert.deepStrictEqual(names, ['vestibule-status', 'vestibule-voice', 'vestibule-circle', 'vestibule-visits']);
    const listed = reg.listTools(); // this is what threw in the real boot
    assert.strictEqual(listed.length, 4);
    for (const t2 of listed) {
      assert.ok(t2.description && t2.description.length > 10, `${t2.name} has a description`);
      assert.ok(t2.input && typeof t2.input === 'object', `${t2.name} has an input schema`);
    }
  });

  // ── 10: the responder must call a method the real ModelBridge has ──
  t('the knock responder calls a real ModelBridge method with a real shape', () => {
    // Third bug of the same family: the responder called chatStructured(),
    // which forces JSON and returns the PARSED object, then read .content /
    // .text — a chat() shape. Every knock fell through to the absent line,
    // and the doubles in contract suite and matrix returned {content} for
    // chatStructured, a shape the real bridge never produces. The doubles
    // agreed with the bug, exactly like the ToolRegistry double did.
    const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'));
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/cognitive/tools/v7946-vestibule-tools.js'), 'utf8');
    const m = src.match(/modelBridge\.(\w+)\(/);
    assert.ok(m, 'the responder calls the model bridge');
    const method = m[1];
    assert.strictEqual(typeof ModelBridge.prototype[method], 'function',
      `ModelBridge has no ${method}()`);
    assert.strictEqual(method, 'chat',
      'chatStructured returns parsed JSON, not the .content/.text the responder reads');
    // and the doubles must not be more generous than the real thing
    for (const rel of ['test/modules/v7946-vorhalle.contract.test.js', 'scripts/revision-matrix.js']) {
      const d = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const stubs = d.match(/chatStructured\s*[:(]/g) || [];
      assert.strictEqual(stubs.length, 0, `${rel} still stubs a method the responder does not call`);
    }
  });

  // ── 11: the tool-call parser must understand pipe-delimited tokens ──
  t('parseToolCalls understands the pipe-delimited token family', () => {
    // Field bug: a local model asked for a tool as
    //   <|tool_call>call:vestibule-circle{...}<tool_call|>
    // Format 1 wants bare <tool_call> tags, so the request fell through and
    // the raw token was PRINTED INTO THE CHAT as if it were an answer. The
    // model had asked and nobody listened — which is why circle changes,
    // voice writes and "who knocked?" all quietly did nothing.
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const reg = new ToolRegistry({});
    for (const n of ['vestibule-circle', 'vestibule-visits', 'shell']) {
      reg.register(n, { description: 'd', input: {} }, async () => ({ ok: true }));
    }
    const cases = [
      ['<|tool_call>call:vestibule-circle{name:"Neo",targetCircle:"middle"}<tool_call|>', 'vestibule-circle'],
      ['<|tool_call|>{"name":"vestibule-visits","arguments":{}}<|/tool_call|>', 'vestibule-visits'],
      ['<|tool_call|>call:vestibule-visits{}</|tool_call|>', 'vestibule-visits'],
      ['<|tool_call>vestibule-visits{}<tool_call|>', 'vestibule-visits'],
      ['<tool_call>{"name":"vestibule-visits","input":{}}</tool_call>', 'vestibule-visits'],
    ];
    for (const [raw, want] of cases) {
      const out = reg.parseToolCalls(raw);
      assert.strictEqual(out.toolCalls.length, 1, raw);
      assert.strictEqual(out.toolCalls[0].name, want, raw);
      assert.ok(!/tool_call/.test(out.text), `token leaked into the chat text: ${out.text}`);
    }
    // plain prose must stay plain prose
    const prose = reg.parseToolCalls('Ich habe Neo angelegt und gehoben.');
    assert.strictEqual(prose.toolCalls.length, 0);
    assert.ok(prose.text.trim(), 'prose survives');

    // And the twin failure: a tool-call-shaped span that does NOT parse used
    // to be stripped anyway, leaving an empty reply — the user got the honest
    // "no answer emerged" line while the model had in fact said something.
    // A parser must not throw away what it could not read.
    for (const broken of [
      '<tool_call>{name: vestibule-circle, action raise}</tool_call>',
      '```tool_call\nkein json\n```',
      '<|tool_call>...<tool_call|>',
    ]) {
      const out = reg.parseToolCalls(broken);
      assert.strictEqual(out.toolCalls.length, 0, broken);
      assert.ok(out.text.trim(), `an unparsable call must not blank the reply: ${broken}`);
    }
    // a parsed call is still removed cleanly, with the surrounding prose kept
    const mixed = reg.parseToolCalls('Ich schaue nach.\n<|tool_call>call:vestibule-visits{}<tool_call|>');
    assert.strictEqual(mixed.toolCalls.length, 1);
    assert.strictEqual(mixed.text.trim(), 'Ich schaue nach.');
  });

  // ── 12: an act-planned round must not leave the uninformed answer standing ──
  await ta('a system-planned act replaces the pre-act answer, a model-planned call keeps its step', async () => {
    // Field: "Wer hat geklopft?" produced BOTH lines in one bubble —
    //   "Bisher hat niemand geklopft. Die Vorhalle ist still."
    //   "Es gab mehrere Besuche: Gast … sowie Neo-Probe …"
    // The model answers first, the system then plans the read-only act, and
    // the informed answer was APPENDED to the uninformed one. Either nobody
    // was there or somebody was — never both.
    const { helpers } = require(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorHelpers.js'));
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const mkOrch = (reg) => Object.assign(Object.create(helpers), {
      tools: reg, maxToolRounds: 3, history: [], lang: { t: (k) => k, current: 'de' },
      promptBuilder: { build: () => 'SYS' }, bus: { fire() {} }, _cleanForHistory: (t) => t,
      model: { chat: async () => 'Es gab mehrere Besuche: Gast und Neo-Probe.', activeModel: 'stub' },
    });

    // (a) the system plans the act — the pre-act answer must be gone
    const regA = new ToolRegistry({});
    regA.register('vestibule-visits', { description: 'book', input: {} }, async () => ({ count: 2, visits: [{ who: 'Gast' }, { who: 'Neo' }] }));
    const outA = await mkOrch(regA)._processToolLoop(
      'Bisher hat niemand geklopft. Die Vorhalle ist still.', () => {}, 'Wer hat geklopft?', 'general');
    assert.ok(/mehrere Besuche/.test(outA), 'the informed answer is delivered');
    assert.ok(!/niemand geklopft/.test(outA), 'the uninformed answer must not stand next to it');

    // (b) the model emitted the call itself — its own step is a real partial
    //     and stays, so multi-step work is not truncated
    const regB = new ToolRegistry({});
    regB.register('vestibule-visits', { description: 'book', input: {} }, async () => ({ count: 2, visits: [{ who: 'Gast' }] }));
    const outB = await mkOrch(regB)._processToolLoop(
      'Ich schaue in mein Besuchsbuch.\n<tool_call>{"name":"vestibule-visits","input":{}}</tool_call>',
      () => {}, 'Schau in dein Buch', 'general');
    assert.ok(/Besuchsbuch/.test(outB), 'a genuine partial step is kept');
    assert.ok(/mehrere Besuche/.test(outB), 'and the synthesis follows it');
  });

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
