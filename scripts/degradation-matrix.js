#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/degradation-matrix.js (v4.0.0)
//
// Generates a Graceful Degradation Matrix from ContainerManifest.
// Answers: "If service X is missing, what breaks?"
//
// Scans all phase manifests and builds a report of:
//   1. Which services are optional (via lateBindings)
//   2. Who consumes each optional service
//   3. What functionality is lost when it's missing
//   4. Which services have no consumers (dead code candidates)
//
// Usage:
//   node scripts/degradation-matrix.js              → console output
//   node scripts/degradation-matrix.js --json       → JSON output
//   node scripts/degradation-matrix.js --md         → Markdown table
// ============================================================

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// ── Build manifest without booting ────────────────────────
// We need the manifest entries but not actual instances.
// Create minimal stubs for the context.

function loadManifest() {
  const { IntervalManager } = require(path.join(ROOT, 'src/agent/core/IntervalManager'));
  const genesisDir = path.join(ROOT, '.genesis');

  // Minimal stubs
  const bus = { on: () => () => {}, emit: () => {}, fire: () => {} };
  const guard = {
    lockKernel() {}, lockCritical() { return { locked: 0, missing: [] }; },
    isProtected() { return false; }, validateWrite() { return true; },
    verifyIntegrity() { return { ok: true, issues: [] }; },
    getProtectedFiles() { return []; },
  };

  const { buildManifest } = require(path.join(ROOT, 'src/agent/ContainerManifest'));
  return buildManifest({
    rootDir: ROOT,
    genesisDir,
    guard,
    bus,
    intervals: new IntervalManager(),
  });
}

function analyze(manifest) {
  const services = new Map(); // name → { phase, deps, tags, lateBindings }
  const consumers = new Map(); // serviceName → [{ consumer, prop, optional }]

  // Parse manifest
  for (const [name, config] of manifest) {
    services.set(name, {
      phase: config.phase || 0,
      deps: config.deps || [],
      tags: config.tags || [],
      lateBindings: config.lateBindings || [],
    });
  }

  // Build consumer map (who consumes whom)
  for (const [name, config] of services) {
    // Direct deps
    for (const dep of config.deps) {
      if (!consumers.has(dep)) consumers.set(dep, []);
      consumers.get(dep).push({ consumer: name, prop: null, optional: false, type: 'dep' });
    }
    // Late-bindings
    for (const binding of config.lateBindings) {
      const target = binding.service;
      if (!consumers.has(target)) consumers.set(target, []);
      consumers.get(target).push({
        consumer: name,
        prop: binding.prop,
        optional: binding.optional || false,
        type: 'lateBinding',
      });
    }
  }

  // Build degradation matrix
  const matrix = [];

  for (const [name, config] of services) {
    const dependents = consumers.get(name) || [];
    const isRequired = dependents.some(d => !d.optional && d.type === 'dep');
    const optionalConsumers = dependents.filter(d => d.optional);
    const requiredConsumers = dependents.filter(d => !d.optional);

    // Determine impact
    let impact;
    if (requiredConsumers.length === 0 && optionalConsumers.length === 0) {
      impact = 'No dependents — leaf service or entry point';
    } else if (requiredConsumers.length > 0) {
      impact = `CRITICAL: ${requiredConsumers.length} service(s) fail without this: ${requiredConsumers.map(d => d.consumer).join(', ')}`;
    } else {
      const features = optionalConsumers.map(d => `${d.consumer}.${d.prop || '?'}`);
      impact = `Graceful: ${features.join(', ')} lose this integration but continue working`;
    }

    matrix.push({
      service: name,
      phase: config.phase,
      tags: config.tags,
      requiredBy: requiredConsumers.length,
      optionalFor: optionalConsumers.length,
      totalConsumers: dependents.length,
      requiredConsumers: requiredConsumers.map(d => d.consumer),
      optionalConsumers: optionalConsumers.map(d => ({ consumer: d.consumer, prop: d.prop })),
      impact,
      isLeaf: dependents.length === 0,
    });
  }

  // Sort: required services first, then by phase
  matrix.sort((a, b) => {
    if (a.requiredBy !== b.requiredBy) return b.requiredBy - a.requiredBy;
    return a.phase - b.phase;
  });

  return { matrix, services: services.size, totalBindings: [...consumers.values()].reduce((s, v) => s + v.length, 0) };
}

function formatConsole(result) {
  const { matrix, services, totalBindings } = result;

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║          GENESIS — Graceful Degradation Matrix                  ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`\n  ${services} services, ${totalBindings} dependency bindings\n`);

  // Critical services (required by others)
  const critical = matrix.filter(m => m.requiredBy > 0);
  const optional = matrix.filter(m => m.requiredBy === 0 && m.optionalFor > 0);
  const leaves = matrix.filter(m => m.totalConsumers === 0);

  console.log(`━━━ CRITICAL (${critical.length}) — removal breaks dependents ━━━`);
  for (const entry of critical) {
    console.log(`  P${entry.phase} ${entry.service} — required by ${entry.requiredBy}: [${entry.requiredConsumers.join(', ')}]`);
  }

  console.log(`\n━━━ OPTIONAL (${optional.length}) — graceful degradation ━━━`);
  for (const entry of optional) {
    const consumers = entry.optionalConsumers.map(c => `${c.consumer}.${c.prop}`).join(', ');
    console.log(`  P${entry.phase} ${entry.service} → ${consumers}`);
  }

  console.log(`\n━━━ LEAF SERVICES (${leaves.length}) — no dependents ━━━`);
  for (const entry of leaves) {
    console.log(`  P${entry.phase} ${entry.service} [${entry.tags.join(', ')}]`);
  }
}

function formatMarkdown(result) {
  const { matrix, services, totalBindings } = result;
  const lines = [
    '# Genesis — Graceful Degradation Matrix',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Services: ${services} | Bindings: ${totalBindings}`,
    '',
    '## Critical Services (removal breaks dependents)',
    '',
    '| Service | Phase | Required By | Dependents |',
    '|---------|-------|-------------|------------|',
  ];

  for (const e of matrix.filter(m => m.requiredBy > 0)) {
    lines.push(`| ${e.service} | P${e.phase} | ${e.requiredBy} | ${e.requiredConsumers.join(', ')} |`);
  }

  lines.push('', '## Optional Services (graceful degradation)', '',
    '| Service | Phase | Consumers | Lost Features |',
    '|---------|-------|-----------|---------------|');

  for (const e of matrix.filter(m => m.requiredBy === 0 && m.optionalFor > 0)) {
    const features = e.optionalConsumers.map(c => `${c.consumer}.${c.prop}`).join(', ');
    lines.push(`| ${e.service} | P${e.phase} | ${e.optionalFor} | ${features} |`);
  }

  lines.push('', '## Leaf Services (no dependents)', '',
    '| Service | Phase | Tags |',
    '|---------|-------|------|');

  for (const e of matrix.filter(m => m.totalConsumers === 0)) {
    lines.push(`| ${e.service} | P${e.phase} | ${e.tags.join(', ')} |`);
  }

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────

try {
  const manifest = loadManifest();
  const result = analyze(manifest);

  const args = process.argv.slice(2);
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else if (args.includes('--md')) {
    const md = formatMarkdown(result);
    if (args.includes('--out')) {
      const outPath = path.join(ROOT, 'docs', 'DEGRADATION-MATRIX.md');
      fs.writeFileSync(outPath, md, 'utf-8');
      console.log(`Written to ${outPath}`);
    } else {
      console.log(md);
    }
  } else {
    formatConsole(result);
  }
} catch (err) {
  console.error('Failed to generate degradation matrix:', err.message);
  process.exit(1);
}
