// ============================================================
// GENESIS — test/modules/v784-mermaid-safety.test.js (v7.8.4)
//
// mermaid-safety contract: SVG returned by mermaid.render() must
// pass through DOMPurify.sanitize() before reaching innerHTML.
// Without this, a crafted diagram source could embed
// <script> / onclick / javascript: URIs that execute in the
// Renderer context.
//
// Also verifies the mermaid v10 → v11 migration:
//   - package.json pin
//   - build-bundle.js resilient against IIFE/UMD layout shift
// ============================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

// ── mermaid-safety contract: chat.js sanitises before innerHTML ──

const chatSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src/ui/modules/chat.js'),
  'utf-8'
);

test('mermaid-safety contract: chat.js imports DOMPurify', () => {
  assert.match(
    chatSrc,
    /require\(['"]dompurify['"]\)/,
    'chat.js must require("dompurify") so esbuild bundles it into renderer.bundle.js'
  );
});

test('mermaid-safety contract: mermaid SVG goes through DOMPurify.sanitize before innerHTML', () => {
  // Find the mermaid-render path. The SVG is assigned to diagramEl.innerHTML;
  // it must be wrapped in DOMPurify.sanitize() — no raw innerHTML = svg.
  const sanitizedBlock = chatSrc.match(
    /diagramEl\.innerHTML\s*=\s*DOMPurify\.sanitize\(\s*svg[\s\S]{0,400}?\)/
  );
  assert.ok(
    sanitizedBlock,
    'diagramEl.innerHTML for mermaid SVG must call DOMPurify.sanitize(svg, ...)'
  );
  // The legacy raw-assignment must not remain.
  assert.ok(
    !/diagramEl\.innerHTML\s*=\s*svg\s*;/.test(chatSrc),
    'no remaining "diagramEl.innerHTML = svg;" raw assignment may exist'
  );
});

test('mermaid-safety contract: sanitize call enables SVG profile + foreignObject', () => {
  const sanitizedBlock = chatSrc.match(
    /DOMPurify\.sanitize\(\s*svg[\s\S]{0,400}?\)/
  );
  assert.ok(sanitizedBlock, 'sanitize call must exist');
  // SVG profile is required — without it DOMPurify strips the whole <svg>.
  assert.match(sanitizedBlock[0], /USE_PROFILES[\s\S]*svg:\s*true/);
  // Mermaid uses <foreignObject> for HTML-in-SVG labels; default svg profile
  // strips it, so we must add it back explicitly.
  assert.match(sanitizedBlock[0], /ADD_TAGS[\s\S]*['"]foreignObject['"]/);
});

// ── mermaid-version contract: v11 bump ───────────────────

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')
);

test('mermaid-version contract: package.json pins mermaid to ^11.x', () => {
  // mermaid sits in devDependencies because dist/mermaid.min.js is copied
  // to dist/ at build time and shipped as a static asset, not bundled.
  const mermaidPin =
    (pkg.dependencies && pkg.dependencies.mermaid) ||
    (pkg.devDependencies && pkg.devDependencies.mermaid);
  assert.ok(mermaidPin, 'mermaid must be pinned somewhere in package.json');
  assert.match(
    mermaidPin,
    /^\^11\./,
    `mermaid pin must start with ^11. — got ${mermaidPin}`
  );
});

test('mermaid-version contract: dompurify is a runtime dependency', () => {
  assert.ok(
    pkg.dependencies && pkg.dependencies.dompurify,
    'dompurify must be in "dependencies" (it ships inside renderer.bundle.js)'
  );
  assert.match(pkg.dependencies.dompurify, /^\^3\./);
});

test('mermaid-version contract: jsdom is a dev dependency for tests', () => {
  assert.ok(
    pkg.devDependencies && pkg.devDependencies.jsdom,
    'jsdom must be in "devDependencies" so live-sanitize tests have a DOM'
  );
});

// ── mermaid-version contract: build-bundle.js is layout-resilient ──

const buildBundleSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'scripts/build-bundle.js'),
  'utf-8'
);

test('mermaid-version contract: build-bundle probes multiple mermaid layouts', () => {
  // After v10→v11 the filename could shift; the probe-list must cover
  // mermaid.min.js (primary) and at least one ESM fallback so a future
  // package layout change does not silently break diagram rendering.
  const mermaidBlock = buildBundleSrc.match(
    /\/\/ Mermaid:[\s\S]+?\/\/ 4\. Bundle Monaco/
  );
  assert.ok(mermaidBlock, 'mermaid copy block must precede Monaco bundle');
  // The candidates array must exist with at least the IIFE entry.
  assert.match(
    mermaidBlock[0],
    /candidates\s*=\s*\[[\s\S]+?mermaid\.min\.js[\s\S]+?\]/,
    'candidates array must include mermaid.min.js as primary'
  );
  // ESM fallback so a future package layout change is logged not silent.
  assert.match(
    mermaidBlock[0],
    /mermaid\.esm\.min\.mjs/,
    'candidates must include mermaid.esm.min.mjs as fallback'
  );
});

// ── summary ───────────────────────────────────────────────

(async () => {
  await new Promise((r) => setTimeout(r, 50));
  if (failed > 0) {
    console.log(`\n  ${failed} failure(s):`);
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  console.log(`    ${passed} passed`);
})();
