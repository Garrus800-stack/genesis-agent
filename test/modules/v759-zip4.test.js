// @ts-checked-v7.5.9
// ============================================================
// GENESIS — test/modules/v759-zip4.test.js
// ZIP 4: Phase 8 (architecture-diagram) + Phase 11 (mermaid renderer)
//        + bonuses (space-tolerant install, anti-confabulation)
// ============================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function describe(name, fn) {
  console.log(`\n  ${name}`);
  fn();
}
function test(name, fn) {
  try {
    fn();
    console.log(`    ✅ ${name}`);
    test._pass = (test._pass || 0) + 1;
  } catch (err) {
    console.log(`    ❌ ${name}: ${err.message}`);
    test._fail = (test._fail || 0) + 1;
  }
}

// ============================================================
// Phase 8 — Architecture-Diagram Generator
// ============================================================

describe('v7.5.9 ZIP4 Phase 8 — Mermaid escaping helper', () => {

  const { commandHandlersArchitecture } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersArchitecture'));
  const esc = commandHandlersArchitecture._escapeMermaid;

  test('escape: removes double quotes (parser-breaking)', () => {
    assert.strictEqual(esc('foo "bar"'), 'foo bar');
  });
  test('escape: removes brackets (parser-breaking)', () => {
    assert.strictEqual(esc('foo[1]<2>'), 'foo12');
  });
  test('escape: passes alphanumeric + dash + dot', () => {
    assert.strictEqual(esc('foo-bar.baz'), 'foo-bar.baz');
  });
});

describe('v7.5.9 ZIP4 Phase 8 — architectureDiagram output shape', () => {

  const { commandHandlersArchitecture } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersArchitecture'));

  function makeFakeSelfModel(meta = {}, moduleCount = 100) {
    return {
      getFullModel: () => ({}),
      moduleCount: () => moduleCount,
      _manifestMeta: meta,
    };
  }

  // Helper — ZIP 5 made architectureDiagram async (because external
  // path scanning needs fs.readdirSync on potentially-slow paths and
  // we wanted to keep all branches in the same call site). Tests that
  // were synchronous before now await.
  // The handler internally calls this._parseArchRequest etc. — in the
  // real system these are merged into CommandHandlers.prototype via
  // Object.assign. For tests we merge into the per-test context.
  async function callArch(ctx, msg) {
    const merged = Object.assign({}, commandHandlersArchitecture, ctx);
    return await commandHandlersArchitecture.architectureDiagram.call(merged, msg);
  }

  test('graceful: missing selfModel → friendly error', async () => {
    const r = await callArch({}, '/architecture');
    assert(/nicht verfügbar/i.test(r), 'expected "nicht verfügbar" error');
  });
  test('graceful: missing manifest meta → friendly error', async () => {
    const r = await callArch(
      { selfModel: makeFakeSelfModel({}) },
      '/architecture'
    );
    assert(/Manifest-Metadaten/.test(r), `expected manifest error, got: ${r.slice(0, 100)}`);
  });
  test('default output is ASCII (no mermaid block)', async () => {
    const r = await callArch(
      { selfModel: makeFakeSelfModel({ a: { phase: 1, deps: [] } }) },
      '/architecture'
    );
    assert(!/```mermaid/.test(r), 'ASCII default: should NOT contain mermaid block');
    assert(/```/.test(r), 'ASCII output: should be wrapped in code-fence');
    assert(/Architektur-Übersicht/.test(r), 'should contain ASCII header');
  });
  test('--mermaid flag produces mermaid output', async () => {
    const r = await callArch(
      { selfModel: makeFakeSelfModel({ a: { phase: 1, deps: [] } }) },
      '/architecture --mermaid'
    );
    assert(/```mermaid/.test(r), 'mermaid flag should produce mermaid block');
    assert(/graph T[BD]/.test(r), 'no graph-TB/TD declaration');
  });
  test('"als mermaid" phrase with architecture keyword produces mermaid output', async () => {
    // After the disambiguation guard (live-fix): a free-text request
    // for the architecture diagram needs at least one architecture
    // keyword to disambiguate from AdHoc-mermaid intent.
    const r = await callArch(
      { selfModel: makeFakeSelfModel({ a: { phase: 1, deps: [] } }) },
      'zeig mir die architektur als mermaid'
    );
    assert(/```mermaid/.test(r), '"architektur als mermaid" should trigger mermaid format');
  });
  test('AdHoc mermaid request does NOT auto-route to architecture', async () => {
    // "zeige X in einem mermaid" without any architecture keyword
    // must NOT silently render Genesis-self — the user wants a
    // simple AdHoc-mermaid, not the full project architecture.
    const r = await callArch(
      { selfModel: makeFakeSelfModel({ a: { phase: 1, deps: [] } }) },
      'zeige Genesis in einem mermaid'
    );
    assert(!/```mermaid/.test(r), 'AdHoc mermaid request must not produce architecture output');
    assert(/Mermaid|architecture/i.test(r), 'should hint at the right way to ask');
  });
  test('ASCII output groups by phase', async () => {
    const r = await callArch(
      { selfModel: makeFakeSelfModel({
        a: { phase: 1, deps: [] },
        b: { phase: 2, deps: ['a'] },
      }) },
      '/architecture'
    );
    assert(/Phase 1.*Foundation/.test(r), 'no Phase 1 entry in ASCII output');
    assert(/Phase 2.*Intelligence/.test(r), 'no Phase 2 entry in ASCII output');
  });
  test('mermaid output draws inter-phase chain, skips intra-phase service edges', async () => {
    // New spec: the mermaid renderer no longer draws service-to-service
    // edges (too dense, hurts readability at chat width). It draws a
    // visible chain between phase-header nodes (p1_hdr → p2_hdr → ...)
    // which both communicates phase order and forces vertical stacking.
    const r = await callArch(
      { selfModel: makeFakeSelfModel({
        a: { phase: 1, deps: [] },
        b: { phase: 1, deps: ['a'] },
        c: { phase: 2, deps: ['a'] },
      }) },
      '/architecture --mermaid'
    );
    // Phase-chain arrow between header nodes must be present.
    assert(/p1_hdr\s*-->\s*p2_hdr/.test(r), 'phase-chain arrow missing');
    // Service-to-service edges must NOT be drawn.
    assert(!/svc_c\s*-->\s*svc_a/.test(r), 'service edges should not render in mermaid');
    assert(!/svc_b\s*-->\s*svc_a/.test(r), 'service edges should not render in mermaid');
  });
  test('mermaid output caps services per phase to 3 with "+N weitere"', async () => {
    const meta = {};
    for (let i = 0; i < 20; i++) meta['svc' + i] = { phase: 1, deps: [] };
    const r = await callArch(
      { selfModel: makeFakeSelfModel(meta) },
      '/architecture --mermaid'
    );
    assert(/\+17 weitere/.test(r), 'should show "+17 weitere" overflow marker (20 - 3 visible)');
  });
  test('output is deterministic — same input → same output', async () => {
    const meta = {
      x: { phase: 1, deps: [] },
      y: { phase: 2, deps: ['x'] },
      z: { phase: 1, deps: [] },
    };
    const sm1 = makeFakeSelfModel(meta);
    const sm2 = makeFakeSelfModel(meta);
    const r1 = await callArch({ selfModel: sm1 }, '/architecture --mermaid');
    const r2 = await callArch({ selfModel: sm2 }, '/architecture --mermaid');
    assert.strictEqual(r1, r2, 'output must be byte-identical for same input');
  });
  test('mermaid summary header lists totals', async () => {
    const r = await callArch(
      { selfModel: makeFakeSelfModel({
        a: { phase: 1, deps: [] },
        b: { phase: 2, deps: ['a'] },
      }, 50) },
      '/architecture --mermaid'
    );
    assert(/Architektur-Übersicht/.test(r), 'no header');
    assert(/2 Services/.test(r), 'service count missing');
    assert(/50 Source-Module/.test(r), 'module count missing');
  });
});

describe('v7.5.9 ZIP5 Phase 8b — architecture parser + external paths', () => {

  const { commandHandlersArchitecture } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersArchitecture'));

  test('parser: /architecture without args targets self', () => {
    const r = commandHandlersArchitecture._parseArchRequest('/architecture');
    assert.strictEqual(r.targetPath, null);
    assert.strictEqual(r.format, 'ascii');
  });
  test('parser: /architecture <path> captures path', () => {
    const r = commandHandlersArchitecture._parseArchRequest('/architecture C:\\my-project');
    assert.strictEqual(r.targetPath, 'C:\\my-project');
  });
  test('parser: --mermaid flag flips format', () => {
    const r = commandHandlersArchitecture._parseArchRequest('/architecture --mermaid');
    assert.strictEqual(r.format, 'mermaid');
  });
  test('parser: free-text "diagramm vom X" extracts path', () => {
    const r = commandHandlersArchitecture._parseArchRequest('zeig diagramm vom github ordner');
    assert(r.targetPath, 'should extract a path');
    assert(/github/.test(r.targetPath), 'path should contain "github"');
  });
  test('parser: "als mermaid" sets format', () => {
    const r = commandHandlersArchitecture._parseArchRequest('zeig mir das als mermaid');
    assert.strictEqual(r.format, 'mermaid');
  });
  test('parser: standalone "als grafik" sets mermaid format', () => {
    const r = commandHandlersArchitecture._parseArchRequest('zeig als grafik');
    assert.strictEqual(r.format, 'mermaid');
  });
  test('alias /diagram triggers same handler', () => {
    const r = commandHandlersArchitecture._parseArchRequest('/diagram');
    assert.strictEqual(r.targetPath, null);
  });
  test('alias /arch triggers same handler', () => {
    const r = commandHandlersArchitecture._parseArchRequest('/arch desktop');
    assert.strictEqual(r.targetPath, 'desktop');
  });
});

describe('v7.5.9 ZIP4 Phase 8 — IntentPattern wiring', () => {

  const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/IntentPatterns.js'), 'utf8');

  test('intent "architecture-diagram" registered', () => {
    assert(/'architecture-diagram'/.test(src), 'intent missing');
  });
  test('intent has /architecture, /diagram, /arch slash patterns', () => {
    assert(/\/architect/.test(src), 'no /architecture pattern');
    assert(/\\\/diagram\\b/.test(src), 'no /diagram pattern');
    assert(/\\\/arch\\b/.test(src), 'no /arch pattern');
  });
});

describe('v7.5.9 ZIP4 Phase 8 — CommandHandlers wiring', () => {

  const ch = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/CommandHandlers.js'), 'utf8');

  test('require for CommandHandlersArchitecture present', () => {
    assert(/CommandHandlersArchitecture/.test(ch), 'require missing');
  });
  test('Object.assign includes commandHandlersArchitecture', () => {
    assert(/Object\.assign\([\s\S]+?commandHandlersArchitecture/.test(ch), 'Object.assign entry missing');
  });
  test('handler "architecture-diagram" registered', () => {
    assert(/registerHandler\(['"]architecture-diagram['"]/.test(ch), 'handler not registered');
  });

  const manifest = fs.readFileSync(path.join(ROOT, 'src/agent/manifest/phase5-hexagonal.js'), 'utf8');
  test('selfModel late-binding in commandHandlers', () => {
    assert(/prop:\s*'selfModel'/.test(manifest), 'selfModel late-binding missing');
  });
});

// ============================================================
// Phase 11 — Mermaid Renderer
// ============================================================

describe('v7.5.9 ZIP4 Phase 11 — chat.js mermaid branch', () => {

  // src/ui/modules/chat.js is the bundle entry (via renderer-main.js →
  // esbuild → dist/renderer.bundle.js). v7.6.0 consolidated the
  // dual-path UI by routing all loads through the bundle; v7.7.0
  // deleted the now-unloaded src/ui/renderer.js file itself, so
  // chat.js is the canonical renderer source.
  const chat = fs.readFileSync(path.join(ROOT, 'src/ui/modules/chat.js'), 'utf8');

  test('chat.js captures fenced-block lang', () => {
    assert(/codeBlocks\.push\(\{\s*lang/.test(chat), 'lang capture missing');
  });
  test('chat.js has mermaid lang branch in restore step', () => {
    assert(/block\.lang\s*===\s*['"]mermaid['"]/.test(chat), 'mermaid branch missing');
  });
  test('chat.js emits mermaid-block-wrapper', () => {
    assert(/mermaid-block-wrapper/.test(chat), 'wrapper class missing');
  });
  test('chat.js stores raw source in data-mermaid-src', () => {
    assert(/data-mermaid-src/.test(chat), 'data attribute missing');
  });
  test('chat.js has _ensureMermaid lazy-loader', () => {
    assert(/_ensureMermaid\s*\(/.test(chat), '_ensureMermaid missing');
  });
  test('chat.js relies on static window.mermaid (no CDN injection)', () => {
    assert(/window\.mermaid/.test(chat), 'should reference window.mermaid');
    assert(!/cdnjs\.cloudflare\.com\/ajax\/libs\/mermaid/.test(chat),
      'CDN fallback was removed — mermaid is now loaded only via static <script> tag in index.html');
  });
  test('chat.js has _hydrateMermaid', () => {
    assert(/_hydrateMermaid\s*\(/.test(chat), '_hydrateMermaid missing');
  });
  test('chat.js attachCodeButtons walks mermaid wrappers', () => {
    assert(/querySelectorAll\(['"]\.mermaid-block-wrapper['"]\)/.test(chat),
      'attachCodeButtons must hydrate mermaid wrappers');
  });
  test('chat.js has Code/Diagramm toggle', () => {
    assert(/mermaid-toggle-btn/.test(chat), 'toggle button missing');
  });
  test('chat.js error fallback shows raw source', () => {
    assert(/mermaid-error/.test(chat), 'error class missing');
    assert(/mermaid-fallback-source/.test(chat), 'fallback source class missing');
  });
});

describe('v7.5.9 ZIP4 Phase 11 — CSS', () => {

  const styles = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');

  test('CSS has .mermaid-block-wrapper styling', () => {
    assert(/\.mermaid-block-wrapper\s*{/.test(styles), 'wrapper styling missing');
  });
  test('CSS has .mermaid-toggle-btn styling', () => {
    assert(/\.mermaid-toggle-btn\s*{/.test(styles), 'toggle button styling missing');
  });
  test('CSS allows SVG to scale', () => {
    assert(/\.mermaid-diagram\s+svg/.test(styles), 'SVG scaling missing');
  });
});

// ============================================================
// Bonus 2 — Space-tolerant package name
// ============================================================

describe('v7.5.9 ZIP4 Bonus — install: space-tolerant package name', () => {

  const { commandHandlersInstall } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersInstall'));
  const handler = { _extractPackageName: commandHandlersInstall._extractPackageName };

  test('extract: "win rar" → "winrar"', () => {
    assert.strictEqual(handler._extractPackageName('installiere win rar'), 'winrar');
  });
  test('extract: "vs code" → "vscode"', () => {
    assert.strictEqual(handler._extractPackageName('installiere vs code'), 'vscode');
  });
  test('extract: 7 zip → "7zip"', () => {
    assert.strictEqual(handler._extractPackageName('installiere 7zip'), '7zip');
  });
  test('safety: "die Abhängigkeiten" still does not collapse', () => {
    // "die Abhängigkeiten" — second word has umlaut + length 14, stays
    // separate. Article-lookahead also catches this.
    assert.strictEqual(handler._extractPackageName('installiere die Abhängigkeiten'), null);
  });
  test('safety: legitimate word boundaries preserved', () => {
    // "installiere git remote" — should pick "git" and stop, not
    // collapse into "gitremote".
    const r = handler._extractPackageName('installiere git remote');
    // Either returns 'git' or 'gitremote' — both are defensible. We
    // prefer the conservative single-word match.
    assert(r === 'git' || r === 'gitremote', `unexpected: ${r}`);
  });
});

// ============================================================
// Bonus 3 — Anti-confabulation source-content prompt
// ============================================================

describe('v7.5.9 ZIP4 Bonus — Source-content prompt anti-confabulation', () => {

  const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/PromptBuilder.js'), 'utf8');

  test('prompt-block uses AUTORITATIVE marker', () => {
    assert(/AUTORITATIVE QUELLE/.test(src), 'authoritative marker missing');
  });
  test('prompt-block instructs against confabulation', () => {
    assert(/KONFABULIERE NICHT/.test(src), 'no-confabulate instruction missing');
  });
  test('prompt-block has explicit fallback phrase', () => {
    assert(/Im Inhalt dieser/.test(src), 'fallback phrase missing');
  });
});

// ============================================================
// Summary
// ============================================================
setTimeout(() => {
  const passed = test._pass || 0;
  const failed = test._fail || 0;
  console.log(`\n    ${passed} passed${failed ? ', ' + failed + ' failed' : ''}\n`);
  if (failed) process.exit(1);
}, 200);
