#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/build-bundle.js
//
// Production bundler using esbuild. Creates optimized bundles
// for faster startup and cleaner distribution.
//
// Bundles:
//   1. preload.js → dist/preload.js (single file, no require())
//   2. src/agent/** → dist/agent.js (tree-shaken agent bundle)
//
// Usage:
//   node scripts/build-bundle.js          # Production build
//   node scripts/build-bundle.js --watch  # Dev watch mode
//
// Note: main.js (kernel) is NOT bundled — it stays separate
// as the immutable entry point. The bundled agent is loaded
// via require('./dist/agent') when dist/ exists.
// ============================================================

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Ensure esbuild is available
try {
  require.resolve('esbuild');
} catch {
  console.log('[BUILD] Installing esbuild...');
  execSync('npm install --save-dev esbuild', { cwd: ROOT, stdio: 'inherit' });
}

const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');
const isCI = process.argv.includes('--ci');

// v5.1.0: CI mode collects warnings and exits non-zero if any found.
// This catches duplicate object keys, dead code, and other semantic issues
// that node -c (syntax-only) misses.
const ciWarnings = [];

async function build() {
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

  // CI mode: capture warnings via esbuild plugin
  const ciPlugin = isCI ? [{
    name: 'ci-warning-gate',
    setup(build) {
      build.onEnd(result => {
        for (const w of result.warnings) {
          ciWarnings.push({
            text: w.text,
            location: w.location ? `${w.location.file}:${w.location.line}` : 'unknown',
          });
        }
      });
    },
  }] : [];

  const commonOptions = {
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    bundle: true,
    minify: !isWatch,
    sourcemap: isWatch ? 'inline' : false,
    logLevel: 'info',
    // Electron + native modules stay external
    external: [
      'electron',
      'chokidar',
      'tree-kill',
      // Node built-ins
      'fs', 'path', 'crypto', 'http', 'https', 'dgram', 'child_process',
      'os', 'util', 'url', 'vm', 'net', 'dns', 'stream', 'events',
      'worker_threads', 'perf_hooks',
    ],
  };

  // 1. Bundle preload.js → dist/preload.js
  const preloadResult = await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(ROOT, 'preload.js')],
    outfile: path.join(DIST, 'preload.js'),
    plugins: ciPlugin,
  });

  // (Removed) Agent bundle → dist/agent.js. main.js loads the agent from
  // source (require('./src/agent/AgentCore')), so dist/agent.js was never
  // loaded — a dead artifact. Worse, bundling the full agent (entry
  // AgentCore.js, ~385 modules + acorn inline) was the heaviest, most
  // failure-prone step, and it ran BETWEEN preload and renderer. If it threw,
  // the renderer bundle below — the actual UI — never built, leaving a blank
  // window with no model list. Removing it makes the UI build independent of
  // a step the runtime doesn't use.

  // 2. Bundle renderer → dist/renderer.bundle.js (v3.8.0)
  // Browser target — entry is renderer-main.js + 6 modules.
  // The legacy monolithic src/ui/renderer.js was retired in v7.6.0
  // and deleted in v7.7.0. v7.7.5: Monaco moved from CDN to local ESM
  // bundle (see step 4 below); renderer-main.js still accesses Monaco
  // as window.monaco (provided by step-4 bundle's globalName).
  const rendererResult = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'ui', 'renderer-main.js')],
    outfile: path.join(DIST, 'renderer.bundle.js'),
    platform: 'browser',
    target: 'chrome120', // Electron 28 uses Chrome ~120
    format: 'iife',
    bundle: true,
    minify: !isWatch,
    sourcemap: isWatch ? 'inline' : false,
    logLevel: 'info',
    define: {
      'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
    },
    metafile: true,
    plugins: ciPlugin,
  });

  if (rendererResult.metafile) {
    const outputs = rendererResult.metafile.outputs;
    for (const [file, info] of Object.entries(outputs)) {
      const sizeKB = Math.round(info.bytes / 1024);
      console.log(`  ${file}: ${sizeKB}KB (${Object.keys(info.inputs).length} modules)`);
    }
  }

  // Mermaid: copy local mermaid.min.js to dist/ for the chat renderer.
  // v7.8.4: resilient against the v10 (UMD) → v11 (IIFE) layout shift.
  // Both versions publish `dist/mermaid.min.js` at the same path, but
  // we probe a few fallback paths so a future filename rename does not
  // silently break diagram rendering. The first existing path wins.
  try {
    const mermaidDist = path.join(ROOT, 'node_modules', 'mermaid', 'dist');
    const candidates = [
      'mermaid.min.js',          // v10 UMD, v11 IIFE — primary
      'mermaid.js',              // unminified fallback
      'mermaid.esm.min.mjs',     // ESM-only fallback (would need <script type=module>)
    ];
    let chosen = null;
    for (const name of candidates) {
      const p = path.join(mermaidDist, name);
      if (fs.existsSync(p)) { chosen = { name, path: p }; break; }
    }
    if (chosen) {
      const mermaidDest = path.join(DIST, 'mermaid.min.js');
      fs.copyFileSync(chosen.path, mermaidDest);
      const sizeKB = Math.round(fs.statSync(mermaidDest).size / 1024);
      console.log(`  dist/mermaid.min.js: ${sizeKB}KB (source: ${chosen.name})`);
    } else {
      console.log('[BUILD] mermaid not in node_modules — diagram rendering will fail until installed');
    }
  } catch (err) {
    console.warn('[BUILD] mermaid copy failed:', err.message);
  }

  // 4. Bundle Monaco editor (v7.7.5: AMD → ESM migration)
  // Monaco was previously loaded via CDN <script> tag using its AMD loader.
  // Now bundled locally as ESM. cdnjs dependency is removed entirely
  // (script-src/style-src/font-src/connect-src in CSP are now stricter).
  // Output layout in dist/monaco/:
  //   monaco.bundle.js      — main API, exposes window.monaco (globalName)
  //   monaco.bundle.css     — styles, asset-paths point to codicon-*.ttf
  //   codicon-*.ttf         — icon font (esbuild file-loader, hashed name)
  //   editor.worker.js      — base editor worker
  //   ts.worker.js          — TypeScript/JavaScript language service
  //   json.worker.js        — JSON validation
  //   html.worker.js        — HTML language service
  //   css.worker.js         — CSS language service
  // The amd-bypass-pre/post.js scripts (used pre-v7.7.5 to hide Monaco's
  // AMD `define` from mermaid's UMD wrapper) are no longer generated —
  // without Monaco's AMD loader, `define` is never set globally.
  const MONACO_DIST = path.join(DIST, 'monaco');
  const monacoEsmRoot = path.join(ROOT, 'node_modules', 'monaco-editor', 'esm', 'vs');
  if (!fs.existsSync(monacoEsmRoot)) {
    console.log('[BUILD] monaco-editor not in node_modules — skipping Monaco bundle (run npm install)');
  } else {
    if (!fs.existsSync(MONACO_DIST)) fs.mkdirSync(MONACO_DIST, { recursive: true });

    const monacoCommon = {
      platform: 'browser',
      target: 'chrome120',
      bundle: true,
      minify: !isWatch,
      sourcemap: isWatch ? 'inline' : false,
      logLevel: 'info',
    };

    // Main Monaco bundle — exposes window.monaco for editor.js + renderer-main.js
    const monacoMain = await esbuild.build({
      ...monacoCommon,
      entryPoints: [path.join(monacoEsmRoot, 'editor', 'editor.main.js')],
      outdir: MONACO_DIST,
      entryNames: 'monaco.bundle',
      assetNames: '[name]-[hash]',
      format: 'iife',
      globalName: 'monaco',
      loader: { '.css': 'css', '.ttf': 'file', '.svg': 'file' },
      metafile: true,
      plugins: ciPlugin,
    });

    if (monacoMain.metafile) {
      for (const [file, info] of Object.entries(monacoMain.metafile.outputs)) {
        const sizeKB = Math.round(info.bytes / 1024);
        console.log(`  ${file}: ${sizeKB}KB`);
      }
    }

    // Worker bundles — each language has its own worker, lazy-loaded
    // by Monaco's MonacoEnvironment.getWorker (set up in editor.js).
    // CSS/TTF imports inside workers are dropped (no DOM in worker context).
    const workers = [
      { entry: 'editor/editor.worker.js', out: 'editor.worker.js' },
      { entry: 'language/typescript/ts.worker.js', out: 'ts.worker.js' },
      { entry: 'language/json/json.worker.js', out: 'json.worker.js' },
      { entry: 'language/html/html.worker.js', out: 'html.worker.js' },
      { entry: 'language/css/css.worker.js', out: 'css.worker.js' },
    ];
    for (const w of workers) {
      await esbuild.build({
        ...monacoCommon,
        entryPoints: [path.join(monacoEsmRoot, w.entry)],
        outfile: path.join(MONACO_DIST, w.out),
        format: 'iife',
        loader: { '.css': 'empty', '.ttf': 'empty', '.svg': 'empty' },
        plugins: ciPlugin,
      });
      const sizeKB = Math.round(fs.statSync(path.join(MONACO_DIST, w.out)).size / 1024);
      console.log(`  dist/monaco/${w.out}: ${sizeKB}KB`);
    }
  }

  if (isWatch) {
    console.log('[BUILD] Watching for changes...');
    // esbuild watch mode with rebuild
    const ctx = await esbuild.context({
      ...commonOptions,
      entryPoints: [path.join(ROOT, 'src', 'agent', 'AgentCore.js')],
      outfile: path.join(DIST, 'agent.js'),
    });
    await ctx.watch();
  }

  console.log(`[BUILD] Done. Output: ${DIST}`);

  // v5.1.0: CI mode — fail on warnings (duplicate keys, dead code, etc.)
  if (isCI && ciWarnings.length > 0) {
    console.error(`\n[BUILD:CI] ❌ ${ciWarnings.length} warning(s) — build FAILED`);
    for (const w of ciWarnings) {
      console.error(`  ${w.location}: ${w.text}`);
    }
    process.exit(1);
  } else if (isCI) {
    console.log('[BUILD:CI] ✅ 0 warnings — build passed');
  }
}

build().catch(err => {
  console.error('[BUILD] Failed:', err);
  process.exit(1);
});
