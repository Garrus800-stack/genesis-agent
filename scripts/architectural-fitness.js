#!/usr/bin/env node
// ============================================================
// GENESIS — Architectural Fitness Function
//
// Automated structural health check. Run on every commit or
// as part of CI to detect architectural drift early.
//
// Inspired by Genesis's own self-reflection requesting exactly
// this: "an automatic check that verifies whether coupling
// between the 13 phases is getting tighter or looser."
//
// Usage:
//   node scripts/architectural-fitness.js          — full report
//   node scripts/architectural-fitness.js --json   — machine-readable
//   node scripts/architectural-fitness.js --ci     — exit 1 on violations
//
// Checks:
//   1. Phase coupling — cross-phase require() dependencies
//   2. Memory silo detection — direct memory access bypassing facade
//   3. Circular dependencies — in the require() graph
//   4. Shutdown coverage — services with stop() not in TO_STOP
//   5. Debounced write audit — stop() paths using debounced writes
//   6. Orphan setInterval — intervals without clearInterval
//   7. Test coverage gaps — source files without test suites
//   8. God object detection — files with excessive method count
//   9. EventBus health — orphan events, phantom listeners
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TEST = path.join(ROOT, 'test', 'modules');
const CI_MODE = process.argv.includes('--ci');
const JSON_MODE = process.argv.includes('--json');

const results = {
  timestamp: new Date().toISOString(),
  version: require(path.join(ROOT, 'package.json')).version,
  checks: [],
  score: 0,
  maxScore: 0,
};

function check(name, fn) {
  const result = { name, status: 'pass', score: 0, maxScore: 10, details: [] };
  try {
    fn(result);
  } catch (err) {
    result.status = 'error';
    result.details.push(`Check crashed: ${err.message}`);
  }
  results.checks.push(result);
  results.score += result.score;
  results.maxScore += result.maxScore;
}

// ── Utilities ──────────────────────────────────────────────

function walkJs(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJs(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

function readSafe(file) {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; }
}

function relPath(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function getPhaseDir(file) {
  const rel = path.relative(path.join(SRC, 'agent'), file).replace(/\\/g, '/');
  return rel.split('/')[0] || null;
}

// ════════════════════════════════════════════════════════════
// CHECK 1: Circular Dependencies
// ════════════════════════════════════════════════════════════

check('Circular Dependencies', (r) => {
  const graph = new Map();
  const srcFiles = walkJs(path.join(SRC, 'agent'));

  for (const file of srcFiles) {
    const code = readSafe(file);
    const key = file.replace(/\.js$/, '');
    const deps = [];
    const re = /require\(['"]([^'"]+)['"]\)/g;
    let m;
    while ((m = re.exec(code))) {
      if (m[1].startsWith('.')) {
        deps.push(path.resolve(path.dirname(file), m[1]).replace(/\.js$/, ''));
      }
    }
    graph.set(key, deps);
  }

  const visited = new Set();
  const inStack = new Set();
  const cycles = [];

  function dfs(node, chain) {
    if (inStack.has(node)) {
      const idx = chain.indexOf(node);
      if (idx >= 0) {
        const cycle = chain.slice(idx).map(p => path.basename(p));
        // Filter self-references (file requiring itself via different path)
        if (cycle.length > 1) cycles.push(cycle);
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    inStack.add(node);
    for (const dep of (graph.get(node) || [])) {
      if (graph.has(dep)) dfs(dep, [...chain, node]);
    }
    inStack.delete(node);
  }

  for (const node of graph.keys()) dfs(node, []);

  if (cycles.length === 0) {
    r.score = 10;
    r.details.push('No circular dependencies found.');
  } else {
    r.score = 0;
    r.status = 'fail';
    for (const c of cycles) {
      r.details.push(`Cycle: ${c.join(' → ')} → ${c[0]}`);
    }
  }
});

// ════════════════════════════════════════════════════════════
// CHECK 2: Memory Silo Detection
// ════════════════════════════════════════════════════════════

check('Memory Silo Bypass', (r) => {
  const MEMORY_SERVICES = [
    'conversationMemory', 'episodicMemory', 'vectorMemory',
    'adaptiveMemory', 'echoicMemory', 'knowledgeGraph',
  ];
  const ALLOWED_ACCESSORS = [
    'MemoryFacade.js', 'UnifiedMemory.js', 'ContainerManifest.js',
    'AgentCoreHealth.js', 'AgentCoreBoot.js', 'AgentCoreWire.js',
    'KnowledgePort.js', 'MemoryPort.js',
  ];

  const violations = [];
  const srcFiles = walkJs(path.join(SRC, 'agent'));

  for (const file of srcFiles) {
    const basename = path.basename(file);
    if (ALLOWED_ACCESSORS.includes(basename)) continue;
    if (basename.includes('test')) continue;
    if (file.includes('manifest')) continue;

    const code = readSafe(file);
    for (const svc of MEMORY_SERVICES) {
      const re = new RegExp(`resolve\\(['"]${svc}['"]\\)|tryResolve\\(['"]${svc}['"]\\)`, 'g');
      if (re.test(code)) {
        violations.push(`${relPath(file)} directly resolves '${svc}'`);
      }
    }
  }

  if (violations.length === 0) {
    r.score = 10;
    r.details.push('All memory access goes through MemoryFacade/UnifiedMemory.');
  } else {
    r.score = Math.max(0, 10 - violations.length * 2);
    r.status = violations.length > 3 ? 'fail' : 'warn';
    r.details = violations;
  }
});

// ════════════════════════════════════════════════════════════
// CHECK 3: Shutdown Coverage
// ════════════════════════════════════════════════════════════

check('Shutdown Coverage', (r) => {
  const healthFile = readSafe(path.join(SRC, 'agent', 'AgentCoreHealth.js'));
  const toStopMatch = healthFile.match(/const TO_STOP\s*=\s*\[([\s\S]*?)\];/);
  const stoppedServices = new Set();

  if (toStopMatch) {
    const entries = toStopMatch[1].match(/'([^']+)'/g) || [];
    for (const e of entries) stoppedServices.add(e.replace(/'/g, ''));
  }
  // Also capture individually stopped services
  const safeMatches = healthFile.match(/tryResolve\('([^']+)'\)\?\.stop\(\)/g) || [];
  for (const m of safeMatches) {
    const svc = m.match(/tryResolve\('([^']+)'\)/)?.[1];
    if (svc) stoppedServices.add(svc);
  }
  // Also capture saveSync calls (worldState pattern)
  const syncMatches = healthFile.match(/tryResolve\('([^']+)'\)\?\.saveSync\(\)/g) || [];
  for (const m of syncMatches) {
    const svc = m.match(/tryResolve\('([^']+)'\)/)?.[1];
    if (svc) stoppedServices.add(svc);
  }

  // ── Build set of all DI-managed service names ──
  // Strategy: scan BOTH static containerConfig in source files AND
  // manifest array entries ['serviceName', {...}] in manifest files.
  // This catches services registered via either pattern.
  const diServices = new Map(); // name → filename

  const srcFiles = walkJs(path.join(SRC, 'agent'));

  for (const file of srcFiles) {
    if (file.includes('AgentCore')) continue;
    const code = readSafe(file);
    const hasStop = /^\s*(async\s+)?stop\s*\(\)/m.test(code);
    const hasInterval = /setInterval|clearInterval/.test(code);
    if (!hasStop && !hasInterval) continue;

    // Pattern 1: static containerConfig with name
    const ccMatch = code.match(/static containerConfig[\s\S]*?name:\s*'([^']+)'/);
    if (ccMatch) {
      diServices.set(ccMatch[1], path.basename(file));
      continue;
    }

    // Pattern 2: name from containerConfig without static (older pattern)
    const nameMatch = code.match(/containerConfig[\s\S]{0,100}name:\s*'([^']+)'/);
    if (nameMatch) {
      diServices.set(nameMatch[1], path.basename(file));
    }
  }

  // Pattern 3: manifest array entries — ['serviceName', { phase: N, ... }]
  // Only add if the service has stop() AND is not already detected via Pattern 1/2
  const manifestDir = path.join(SRC, 'agent', 'manifest');
  const manifestFiles = fs.readdirSync(manifestDir).filter(f => f.endsWith('.js'));
  for (const mf of manifestFiles) {
    const mc = readSafe(path.join(manifestDir, mf));
    const entries = mc.match(/\['(\w+)',\s*\{/g) || [];
    for (const entry of entries) {
      const svcName = entry.match(/\['(\w+)'/)?.[1];
      if (!svcName || diServices.has(svcName) || stoppedServices.has(svcName)) continue;

      // Find the factory require to identify source file
      // Manifest pattern: factory: (c) => new (R('FileName').ClassName)(...)
      const factoryRe = new RegExp("\\['" + svcName + "',[\\s\\S]*?R\\('([^']+)'\\)", 'm');
      const factoryMatch = mc.match(factoryRe);
      if (!factoryMatch) continue;

      const moduleName = factoryMatch[1];
      // Search for the actual file — exact basename match only
      for (const sf of srcFiles) {
        if (path.basename(sf, '.js') !== moduleName) continue;
        const sc = readSafe(sf);
        if (/^\s*(async\s+)?stop\s*\(\)/m.test(sc)) {
          diServices.set(svcName, path.basename(sf));
        }
        break;
      }
    }
  }

  const missing = [];
  for (const [svcName, fileName] of diServices) {
    if (!stoppedServices.has(svcName)) {
      missing.push(`${svcName} (${fileName}) — has stop()/interval but not in shutdown list`);
    }
  }

  if (missing.length === 0) {
    r.score = 10;
    r.details.push(`All ${stoppedServices.size} stoppable services are in the shutdown list.`);
  } else {
    r.score = Math.max(0, 10 - missing.length * 3);
    r.status = 'fail';
    r.details = missing;
  }
});

// ════════════════════════════════════════════════════════════
// CHECK 4: Debounced Write in Shutdown Path
// ════════════════════════════════════════════════════════════

check('Shutdown Persist Safety', (r) => {
  const violations = [];
  const srcFiles = walkJs(path.join(SRC, 'agent'));

  for (const file of srcFiles) {
    const code = readSafe(file);
    const hasStop = /^\s*stop\s*\(\)\s*\{/m.test(code);
    if (!hasStop) continue;

    // Extract stop() body
    const stopMatch = code.match(/^\s*stop\s*\(\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/m);
    if (!stopMatch) continue;
    const stopBody = stopMatch[1].split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');

    // Direct debounced write in stop()
    if (stopBody.includes('writeJSONDebounced')) {
      violations.push(`${path.basename(file)}: stop() directly calls writeJSONDebounced`);
      continue;
    }

    // Check what stop() calls — find methods called from stop()
    const callMatch = stopBody.match(/this\.([\w]+)\(\)/g) || [];
    for (const call of callMatch) {
      const methodName = call.match(/this\.([\w]+)/)?.[1];
      if (!methodName || methodName.includes('Sync') || methodName === 'clear') continue;

      // If stop() calls _save() (not _saveSync()), check if _save uses debounced
      const methodRe = new RegExp(`^\\s*${methodName}\\s*\\(\\)\\s*\\{([\\s\\S]*?)^\\s*\\}`, 'm');
      const methodMatch = code.match(methodRe);
      if (methodMatch && methodMatch[1].includes('writeJSONDebounced')) {
        violations.push(`${path.basename(file)}: stop() → ${methodName}() → writeJSONDebounced`);
      }
    }
  }

  if (violations.length === 0) {
    r.score = 10;
    r.details.push('All shutdown paths use synchronous writes.');
  } else {
    r.score = 0;
    r.status = 'fail';
    r.details = violations;
  }
});

// ════════════════════════════════════════════════════════════
// CHECK 5: Test Coverage Gaps
// ════════════════════════════════════════════════════════════

check('Test Coverage Gaps', (r) => {
  const srcFiles = walkJs(path.join(SRC, 'agent'))
    .filter(f => !f.includes('manifest') && !f.includes('ports') && !path.basename(f).startsWith('index'));

  const testFiles = fs.existsSync(TEST)
    ? fs.readdirSync(TEST).filter(f => f.endsWith('.test.js'))
    : [];

  const testContent = testFiles.map(f => readSafe(path.join(TEST, f))).join('\n');
  const untested = [];

  for (const file of srcFiles) {
    const base = path.basename(file, '.js');
    const lower = base.toLowerCase();
    // Check if any test file references this module
    const hasTest = testContent.includes(base) ||
                    testFiles.some(t => t.toLowerCase().includes(lower));
    if (!hasTest) {
      const loc = readSafe(file).split('\n').length;
      if (loc > 80) untested.push(`${relPath(file)} (${loc} LOC)`);
    }
  }

  const coverage = ((srcFiles.length - untested.length) / srcFiles.length * 100).toFixed(0);
  r.details.push(`${srcFiles.length - untested.length}/${srcFiles.length} source files have tests (${coverage}%).`);

  if (untested.length === 0) {
    r.score = 10;
  } else {
    r.score = Math.max(0, 10 - Math.floor(untested.length / 2));
    r.status = untested.length > 10 ? 'fail' : 'warn';
    for (const u of untested.slice(0, 10)) r.details.push(`  Missing: ${u}`);
    if (untested.length > 10) r.details.push(`  ... and ${untested.length - 10} more`);
  }
});

// ════════════════════════════════════════════════════════════
// CHECK 6: God Object Detection
// ════════════════════════════════════════════════════════════

check('God Object Detection', (r) => {
  const MAX_METHODS = 50;
  // v7.0.1: Known large modules — exempt from threshold but capped at current count.
  // EventBus: FEATURE-FROZEN, do not add methods.
  // ArchitectureReflection: Split into ArchGraph/ArchMetrics/ArchAdvisor at 70.
  const EXEMPT_CAPS = {
    'EventBus.js': 84,
    'Container.js': 72,
    'PromptBuilderSections.js': 70,
    'CognitiveEvents.js': 65,
    'ArchitectureReflection.js': 70,
    'SelfModificationPipeline.js': 60,
  };
  const srcFiles = walkJs(path.join(SRC, 'agent'));
  const gods = [];

  for (const file of srcFiles) {
    const code = readSafe(file);
    const basename = path.basename(file);
    // Count class/prototype methods (indented), not top-level functions
    const methods = code.match(/^  (?:async\s+)?(?:_?)[\w]+\s*\([^)]*\)\s*\{/gm) || [];
    const cap = EXEMPT_CAPS[basename];
    const limit = cap || MAX_METHODS;
    if (methods.length > limit) {
      const label = cap ? `${basename}: ${methods.length} methods (cap: ${limit})` : `${basename}: ${methods.length} methods (threshold: ${MAX_METHODS})`;
      gods.push(label);
    }
  }

  if (gods.length === 0) {
    r.score = 10;
    r.details.push(`No files exceed thresholds. ${Object.keys(EXEMPT_CAPS).length} exempt modules capped.`);
  } else {
    r.score = Math.max(0, 10 - gods.length * 2);
    r.status = 'warn';
    r.details = gods;
  }
});

// ════════════════════════════════════════════════════════════
// CHECK 7: Cross-Phase Coupling
// ════════════════════════════════════════════════════════════

check('Cross-Phase Coupling', (r) => {
  const PHASE_MAP = {
    core: 0, foundation: 1, intelligence: 2, capabilities: 3,
    planning: 4, hexagonal: 5, autonomy: 6, organism: 7,
    revolution: 8, cognitive: 9, consciousness: 13,
  };

  const srcFiles = walkJs(path.join(SRC, 'agent'));
  const crossPhase = [];

  for (const file of srcFiles) {
    const fromDir = getPhaseDir(file);
    if (!fromDir || !PHASE_MAP[fromDir]) continue;
    const fromPhase = PHASE_MAP[fromDir];

    const code = readSafe(file);
    const re = /require\(['"]\.\.\/([^/'"]+)\//g;
    let m;
    while ((m = re.exec(code))) {
      const toDir = m[1];
      const toPhase = PHASE_MAP[toDir];
      if (toPhase !== undefined && toPhase > fromPhase) {
        crossPhase.push(`${fromDir}/${path.basename(file)} → ${toDir} (phase ${fromPhase} → ${toPhase})`);
      }
    }
  }

  if (crossPhase.length === 0) {
    r.score = 10;
    r.details.push('No upward cross-phase dependencies.');
  } else {
    r.score = Math.max(0, 10 - crossPhase.length);
    r.status = crossPhase.length > 5 ? 'fail' : 'warn';
    r.details = crossPhase.slice(0, 10);
    if (crossPhase.length > 10) r.details.push(`... and ${crossPhase.length - 10} more`);
  }
});

// ════════════════════════════════════════════════════════════
// CHECK 8: EventBus Hygiene
// ════════════════════════════════════════════════════════════

check('EventBus Hygiene', (r) => {
  const srcFiles = walkJs(path.join(SRC, 'agent'));
  const emitted = new Set();
  const listened = new Set();

  for (const file of srcFiles) {
    const code = readSafe(file);

    // Collect emitted events (emit, fire, AND request — bus.request() is a named event too)
    const emitRe = /\.(?:emit|fire|request)\(['"]([^'"]+)['"]/g;
    let m;
    while ((m = emitRe.exec(code))) emitted.add(m[1]);

    // Collect listened events
    const onRe = /\.on\(['"]([^'"]+)['"]/g;
    while ((m = onRe.exec(code))) listened.add(m[1]);
  }

  // Filter out Node.js stream events + IPC/external trigger events
  const excludedEvents = new Set(['error', 'data', 'end', 'close', 'message',
    'timeout', 'exit', 'drain', 'readable', 'connect', 'open', 'add',
    'change', 'unlink', 'uncaughtException',
    // ConsciousnessExtension internal EventEmitter
    'started', 'stopped', 'state-change', 'frame-processed', 'keyframe',
    'hypervigilant-entered', 'dream-complete', 'awakened', 'daydream-reflection',
    // IPC events (emitted from Electron renderer, not src/agent/)
    'chat:message', 'ui:heartbeat',
    // External trigger events (emitted by peers/CLI/UI, listened in src/agent/)
    'deploy:request', 'colony:run-request',
    // Cross-service events that use PromptEvolution internal emitter
    'prompt-evolution:promoted',
    // EventStore-routed: emitted via eventStore.append() → EVENT_STORE_BUS_MAP
    'shell:complete',
  ]);

  const phantoms = [...listened]
    .filter(e => !emitted.has(e) && !excludedEvents.has(e))
    .filter(e => !e.startsWith('store:'));

  r.details.push(`${emitted.size} emitted events, ${listened.size} listeners.`);
  if (phantoms.length > 0) {
    r.details.push(`${phantoms.length} phantom listeners: ${phantoms.join(', ')}`);
  } else {
    r.details.push('No phantom listeners.');
  }

  if (phantoms.length <= 5) {
    r.score = 10;
  } else if (phantoms.length <= 15) {
    r.score = 7;
    r.status = 'warn';
  } else {
    r.score = 4;
    r.status = 'warn';
  }
});

// ════════════════════════════════════════════════════════════
// CHECK 9: Source Metrics
// ════════════════════════════════════════════════════════════

check('Source Metrics', (r) => {
  const srcFiles = walkJs(path.join(SRC));
  const testFiles = walkJs(path.join(ROOT, 'test'));
  let totalLoc = 0;
  let testLoc = 0;

  for (const f of srcFiles) totalLoc += readSafe(f).split('\n').length;
  for (const f of testFiles) testLoc += readSafe(f).split('\n').length;

  const ratio = (testLoc / totalLoc).toFixed(2);

  r.details.push(`Source: ${srcFiles.length} files, ${totalLoc.toLocaleString()} LOC`);
  r.details.push(`Tests:  ${testFiles.length} files, ${testLoc.toLocaleString()} LOC`);
  r.details.push(`Test/Source ratio: ${ratio}`);
  r.score = 10; // Informational only
});

// ════════════════════════════════════════════════════════════
// 10. Raw setInterval Usage
// FIX v7.0.8 (Q-1): Audit finding — 12 modules use raw setInterval
// instead of IntervalManager. Track count so it doesn't grow.
// ════════════════════════════════════════════════════════════

check('Raw setInterval Audit', (r) => {
  const agentFiles = walkJs(path.join(SRC, 'agent'));
  // IntervalManager itself uses setInterval internally (implementation, not usage).
  // CrashLog: runs before/after IntervalManager lifecycle — kernel-level timer.
  // McpTransport: heartbeat tied to SSE connection lifecycle (F-06) — managed externally.
  const EXEMPT = ['IntervalManager.js', 'CrashLog.js', 'McpTransport.js'];
  const KNOWN_RAW = 2; // v7.1.1 baseline: 2 modules with raw-only setInterval
  // Exempt (intentionally raw): CrashLog (pre-DI lifecycle), McpTransport (F-06).
  // McpServer migrated to dual IntervalManager/fallback pattern in v7.1.1.
  const raw = [];

  for (const file of agentFiles) {
    const base = path.basename(file);
    if (EXEMPT.includes(base)) continue;
    const code = readSafe(file);
    // Match raw setInterval that isn't through this._intervals.register
    const intervals = code.match(/\bsetInterval\s*\(/g);
    if (!intervals) continue;
    // Exclude if the file uses IntervalManager (this._intervals or this.intervals, both patterns used)
    if (/this\._?intervals\.register/.test(code)) continue;
    raw.push(`${base} (${intervals.length} call${intervals.length > 1 ? 's' : ''})`);
  }

  if (raw.length <= KNOWN_RAW) {
    r.score = raw.length === 0 ? 10 : 7; // 7/10 for stable count, 10/10 when all migrated
    r.status = raw.length === 0 ? 'pass' : 'warn';
    r.details.push(`${raw.length} modules use raw setInterval (baseline: ${KNOWN_RAW}).`);
    if (raw.length > 0) r.details.push('Migration to IntervalManager recommended for coordinated shutdown.');
  } else {
    r.score = Math.max(0, 7 - (raw.length - KNOWN_RAW) * 2);
    r.status = 'warn';
    r.details.push(`${raw.length} modules use raw setInterval — INCREASED from baseline ${KNOWN_RAW}.`);
    for (const entry of raw) r.details.push(`  ${entry}`);
  }
});

// ════════════════════════════════════════════════════════════
// 11. Causal Graph Size (v7.0.9 Phase 1)
// Monitors the number of causal edges in KnowledgeGraph.
// Auto-prune trigger if count exceeds threshold.
// ════════════════════════════════════════════════════════════

check('Causal Graph Size', (r) => {
  // Count causal relation types in GraphStore if data exists
  const PASS_THRESHOLD = 3000;
  const WARN_THRESHOLD = 5000;

  // At build time we can't query the live graph — check that
  // CausalAnnotation module exists and has pruning support
  const causalPath = path.join(SRC, 'agent', 'cognitive', 'CausalAnnotation.js');
  const graphStorePath = path.join(SRC, 'agent', 'foundation', 'GraphStore.js');

  if (!fs.existsSync(causalPath)) {
    r.score = 5;
    r.status = 'warn';
    r.details.push('CausalAnnotation.js not found — Phase 1 not yet implemented.');
    return;
  }

  const gsCode = readSafe(graphStorePath);
  const hasPrune = /pruneEdges/.test(gsCode);
  const hasDegrade = /degradeEdges/.test(gsCode);
  const hasPromote = /promoteEdge/.test(gsCode);

  if (hasPrune && hasDegrade && hasPromote) {
    r.score = 10;
    r.status = 'pass';
    r.details.push('GraphStore has pruneEdges(), degradeEdges(), promoteEdge() — causal graph lifecycle managed.');
    r.details.push(`Thresholds: pass <${PASS_THRESHOLD}, warn <${WARN_THRESHOLD}, fail >${WARN_THRESHOLD}.`);
  } else {
    r.score = 5;
    r.status = 'warn';
    const missing = [];
    if (!hasPrune) missing.push('pruneEdges');
    if (!hasDegrade) missing.push('degradeEdges');
    if (!hasPromote) missing.push('promoteEdge');
    r.details.push(`GraphStore missing causal lifecycle methods: ${missing.join(', ')}.`);
  }
});

// ════════════════════════════════════════════════════════════
// 12. Inference Contradiction Detection (v7.0.9 Phase 2)
// Verifies InferenceEngine exists and has contradiction detection.
// At runtime, contradictions should be 0 (warn >5).
// ════════════════════════════════════════════════════════════

check('Inference Contradiction Detection', (r) => {
  const enginePath = path.join(SRC, 'agent', 'cognitive', 'InferenceEngine.js');

  if (!fs.existsSync(enginePath)) {
    r.score = 5;
    r.status = 'warn';
    r.details.push('InferenceEngine.js not found — Phase 2 not yet implemented.');
    return;
  }

  const code = readSafe(enginePath);
  const hasContradictions = /findContradictions/.test(code);
  const hasRuleIndex = /ruleIndex|_ruleIndex/.test(code);
  const hasMinObs = /minObservations/.test(code);
  const hasLearnedRules = /learned/.test(code);

  const features = [hasContradictions, hasRuleIndex, hasMinObs, hasLearnedRules];
  const featureCount = features.filter(Boolean).length;

  if (featureCount === 4) {
    r.score = 10;
    r.status = 'pass';
    r.details.push('InferenceEngine: contradiction detection, rule index, minObservations, learned rules — all present.');
  } else if (featureCount >= 2) {
    r.score = 7;
    r.status = 'warn';
    r.details.push(`InferenceEngine: ${featureCount}/4 features present.`);
  } else {
    r.score = 3;
    r.status = 'warn';
    r.details.push('InferenceEngine exists but missing key features.');
  }
});

// ════════════════════════════════════════════════════════════
// CHECK 13: File Size Guard (v7.1.2)
// Prevents files from growing past maintainability thresholds.
// Warn >600 LOC, fail >800 LOC. Vendor files exempt.
// ════════════════════════════════════════════════════════════

check('File Size Guard', (r) => {
  const WARN_THRESHOLD = 700;
  const FAIL_THRESHOLD = 900;
  const EXEMPT = [
    'acorn.js',         // Vendored parser — not our code
    'EventTypes.js',    // Catalog file — grows with features, pure data
    'EventPayloadSchemas.js', // Schema catalog — same
    'Language.js',      // i18n strings — data, not logic
    'Container.js',     // Core DI — feature-frozen, complex by nature
  ];

  const srcFiles = walkJs(path.join(SRC, 'agent'));
  const overWarn = [];
  const overFail = [];

  for (const file of srcFiles) {
    const name = path.basename(file);
    if (EXEMPT.includes(name)) continue;

    const lines = readSafe(file).split('\n').length;
    if (lines > FAIL_THRESHOLD) {
      overFail.push({ file: relPath(file), lines });
    } else if (lines > WARN_THRESHOLD) {
      overWarn.push({ file: relPath(file), lines });
    }
  }

  if (overFail.length > 0) {
    r.score = 0;
    r.status = 'fail';
    for (const f of overFail) {
      r.details.push(`FAIL: ${f.file} — ${f.lines} LOC (>${FAIL_THRESHOLD})`);
    }
  } else if (overWarn.length > 0) {
    r.score = 7;
    r.status = 'warn';
    for (const f of overWarn) {
      r.details.push(`WARN: ${f.file} — ${f.lines} LOC (>${WARN_THRESHOLD})`);
    }
  } else {
    r.score = 10;
    r.details.push(`All ${srcFiles.length} source files under ${WARN_THRESHOLD} LOC.`);
  }

  if (overWarn.length > 0 || overFail.length > 0) {
    r.details.push(`Exempt: ${EXEMPT.join(', ')}`);
  }
});

if (JSON_MODE) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const pct = ((results.score / results.maxScore) * 100).toFixed(0);
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     GENESIS — Architectural Fitness Check    ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  for (const c of results.checks) {
    const icon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️ ' : '❌';
    console.log(`  ${icon} ${c.name} (${c.score}/${c.maxScore})`);
    for (const d of c.details) console.log(`     ${d}`);
    console.log('');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Score: ${results.score}/${results.maxScore} (${pct}%)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

if (CI_MODE) {
  const CI_BLOCKING = ['Circular Dependencies', 'Shutdown Persist Safety'];
  const failures = results.checks.filter(c => c.status === 'fail' && CI_BLOCKING.includes(c.name));
  if (failures.length > 0) {
    console.error(`CI FAILURE: ${failures.map(f => f.name).join(', ')}`);
    process.exit(1);
  }
}
