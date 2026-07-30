#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-free-identifiers.js
//
// Every identifier a module uses must resolve: to a declaration in the file,
// to a require, to a parameter, or to a JavaScript builtin. Nothing else.
//
// Why this exists. In v7.9.48 the streaming chat path was split into its own
// file. The split checked which module-scope names travelled with it by
// searching for FIVE NAMES that seemed relevant — dedupeSeams, two stream
// filters, buildSelfMessageEntry, path. It missed `_log`, which handleStream
// passes to ensureNonEmptyReply. Every streamed answer then ended with
// "Fehler: _log is not defined", caught by the chat error handler and printed
// under the reply. Syntax was valid, the module loaded, every gate was green,
// 9534 tests passed — and the field caught it in the first conversation.
//
// That is the release's own mistake in miniature: a check built around a
// handful of expected forms instead of resolving the whole set. A name-based
// search cannot find the name nobody thought of. Resolution can.
//
// Exit codes: 0 clean, 1 unresolved identifiers with --strict.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('../src/kernel/vendor/acorn.js');

const ROOT = path.resolve(__dirname, '..');
const STRICT = process.argv.includes('--strict');

const red = (s) => `\u001b[31m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;

/** Globals a CommonJS module may use without declaring them. */
const BUILTINS = new Set([
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'console', 'Buffer',
  'globalThis', 'global', 'structuredClone', 'queueMicrotask',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Function',
  'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Proxy', 'Reflect',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'undefined', 'NaN', 'Infinity', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent', 'escape', 'unescape',
  'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams',
  'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File',
  'Intl', 'WebAssembly', 'performance', 'crypto', 'localStorage', 'sessionStorage',
  // browser side (src/ui runs in the renderer)
  'window', 'document', 'navigator', 'location', 'history', 'alert', 'confirm', 'prompt',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia',
  'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver',
  'IntersectionObserver', 'ResizeObserver', 'XMLHttpRequest', 'WebSocket', 'Image', 'Worker',
  'DOMParser', 'MessageChannel', 'BroadcastChannel', 'CSS', 'ClipboardItem',
  'marked', 'DOMPurify', 'hljs', 'mermaid', 'Chart', 'monaco', // vendored UI globals
  'FileReader', 'self', // browser globals used by the renderer
]);

/** Collect every name a scope-free walk can see as "declared". */
function declaredNames(ast) {
  const names = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'VariableDeclarator': collectPattern(node.id, names); break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) names.add(node.id.name);
        for (const p of node.params || []) collectPattern(p, names);
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) names.add(node.id.name);
        break;
      case 'CatchClause':
        if (node.param) collectPattern(node.param, names);
        break;
      case 'ImportDefaultSpecifier':
      case 'ImportSpecifier':
      case 'ImportNamespaceSpecifier':
        if (node.local) names.add(node.local.name);
        break;
      case 'LabeledStatement':
        if (node.label) names.add(node.label.name);
        break;
      default: break;
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === 'object' && child.type) walk(child);
    }
  })(ast);
  return names;
}

function collectPattern(pat, out) {
  if (!pat) return;
  switch (pat.type) {
    case 'Identifier': out.add(pat.name); break;
    case 'ObjectPattern':
      for (const p of pat.properties) collectPattern(p.value || p.argument, out);
      break;
    case 'ArrayPattern': for (const el of pat.elements) collectPattern(el, out); break;
    case 'AssignmentPattern': collectPattern(pat.left, out); break;
    case 'RestElement': collectPattern(pat.argument, out); break;
    default: break;
  }
}

/** Every identifier read as a value — not property names, not keys, not labels. */
function usedNames(ast) {
  const names = new Set();
  (function walk(node, parent, key) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Identifier' && parent) {
      const isProperty = parent.type === 'MemberExpression' && parent.property === node && !parent.computed;
      const isKey = (parent.type === 'Property' || parent.type === 'PropertyDefinition'
                     || parent.type === 'MethodDefinition') && parent.key === node && !parent.computed;
      const isLabel = parent.type === 'LabeledStatement' || parent.type === 'BreakStatement'
                     || parent.type === 'ContinueStatement';
      const isDecl = key === 'id' || (parent.type === 'ClassDeclaration' && parent.id === node);
      if (!isProperty && !isKey && !isLabel && !isDecl) names.add(node.name);
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'range') continue;
      const child = node[k];
      if (Array.isArray(child)) child.forEach((c) => walk(c, node, k));
      else if (child && typeof child === 'object' && child.type) walk(child, node, k);
    }
  })(ast, null, null);
  return names;
}

function walkJs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walkJs(p, acc); }
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const files = [
  ...walkJs(path.join(ROOT, 'src')),
  path.join(ROOT, 'main.js'),
  path.join(ROOT, 'preload.js'),
  path.join(ROOT, 'cli.js'),
].filter((f) => fs.existsSync(f));

// The renderer loads its files as <script> tags, so a top-level function in one
// UI file is global to the others. Collect those names once and treat them as
// available inside src/ui — without weakening the check for src/agent, where
// every module is a CommonJS island and must import what it uses.
const uiGlobals = new Set();
for (const f of files.filter((x) => x.includes(`${path.sep}ui${path.sep}`) || x.endsWith(`${path.sep}ui`))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)) uiGlobals.add(m[1]);
  for (const m of src.matchAll(/^(?:const|let|var)\s+(\w+)\s*=/gm)) uiGlobals.add(m[1]);
}

const violations = [];
let scanned = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = acorn.parse(src, {
      ecmaVersion: 2022, sourceType: 'script',
      allowReturnOutsideFunction: true, allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true, allowHashBang: true,
    });
  } catch (_e) {
    try {
      ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', allowHashBang: true });
    } catch (err) { continue; } // unparseable — that is another gate's job
  }
  scanned++;
  const declared = declaredNames(ast);
  const istUi = file.includes(`${path.sep}ui${path.sep}`);
  const unresolved = [...usedNames(ast)].filter((n) => !declared.has(n) && !BUILTINS.has(n)
    && !(istUi && uiGlobals.has(n)));
  if (unresolved.length) {
    violations.push({ file: path.relative(ROOT, file).split(path.sep).join('/'), names: unresolved });
  }
}

console.log('\n  Genesis — free identifier resolution');
console.log(dim('  ────────────────────────────────────'));
console.log(`  Files scanned: ${scanned}`);

if (violations.length) {
  console.log(red(`\n  ✗ ${violations.length} file(s) use a name they never declare:\n`));
  for (const v of violations) console.log(`    ${v.file}\n      ${v.names.join(', ')}`);
  console.log(dim('\n  Usually a split: a method moved to a new file and a module-scope'));
  console.log(dim('  name it used stayed behind. Syntax stays valid and every other'));
  console.log(dim('  gate stays green — the error only appears when the line runs.'));
  if (STRICT) process.exit(1);
} else {
  console.log(green('\n  ✅ Every identifier resolves.'));
}
process.exit(0);
