#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/build-bundle.js (v3.7.0)
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
      'monaco-editor',
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

  // 2. Bundle agent entry → dist/agent.js
  const agentResult = await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(ROOT, 'src', 'agent', 'AgentCore.js')],
    outfile: path.join(DIST, 'agent.js'),
    external: commonOptions.external.filter(e => e !== 'acorn'),
    metafile: true,
    plugins: ciPlugin,
  });

  // Report bundle sizes
  if (agentResult.metafile) {
    const outputs = agentResult.metafile.outputs;
    for (const [file, info] of Object.entries(outputs)) {
      const sizeKB = Math.round(info.bytes / 1024);
      console.log(`  ${file}: ${sizeKB}KB (${Object.keys(info.inputs).length} modules)`);
    }
  }

  // 3. Bundle renderer → dist/renderer.bundle.js (v3.8.0)
  // Browser target — replaces the monolithic renderer.js with 6 modules.
  // Monaco is loaded externally via CDN, not bundled.
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
    // Monaco is loaded via CDN script tag, not bundled
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
