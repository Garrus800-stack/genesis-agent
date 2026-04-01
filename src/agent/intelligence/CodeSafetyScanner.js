// @ts-checked-v5.6
// ============================================================
// GENESIS — CodeSafetyScanner.js (v3.5.0)
//
// AST-BASED code safety analysis. Replaces the regex-based
// scanCodeSafety() in SelfModificationPipeline.
//
// WHY: Regex patterns are bypassable via string concatenation,
// variable aliasing, computed property access, and encoding.
// AST analysis sees through these because it operates on the
// parsed syntax tree, not raw text.
//
// APPROACH: Two-pass scanning:
//   Pass 1: AST walk — catches eval, Function(), kernel imports,
//           process.exit, dangerous fs ops, vm.run, etc.
//   Pass 2: Regex fallback — catches patterns not visible in AST
//           (template literals, dynamic requires, comments)
//
// Usage:
//   const { scanCodeSafety } = require('./CodeSafetyScanner');
//   const result = scanCodeSafety(code, filename);
//   if (!result.safe) { /* reject code */ }
// ============================================================

const { SAFETY } = require('../core/Constants');
const { createLogger } = require('../core/Logger');
const _log = createLogger('CodeSafety');

let acorn = null;
let acornWalk = null;
let _warned = false;

function _loadAcorn() {
  if (acorn) return true;

  // Path 1: npm-installed acorn (normal case)
  try {
    acorn = require('acorn');
    return true;
  } catch { /* continue to fallback */ }

  // Path 2 (FIX v5.1.0 — W-2): Kernel-vendored acorn.
  // The vendored copy lives in src/kernel/vendor/ which is hash-locked
  // by SafeGuard. This means:
  //   - Self-modification cannot weaken the safety scanner's parser
  //   - acorn is always available even if node_modules is missing
  //   - The agent literally cannot tamper with its own safety checks
  try {
    const path = require('path');
    acorn = require(path.resolve(__dirname, '../../kernel/vendor/acorn.js'));
    _log.info('[CODE-SAFETY] Using kernel-vendored acorn (npm acorn unavailable)');
    return true;
  } catch { /* continue to fail-closed */ }

  // Path 3: No acorn anywhere — fail-closed (block all self-mod)
  if (!_warned) {
    _warned = true;
    _log.error('[CODE-SAFETY] ⚠ CRITICAL: acorn not installed — AST-based code safety scanning DISABLED.');
    _log.error('[CODE-SAFETY] Self-modification will be BLOCKED until acorn is available.');
    _log.error('[CODE-SAFETY] Fix: npm install acorn');
  }
  return false;
}

/**
 * FIX v3.5.3: Pre-check acorn availability at module load time.
 * If acorn is missing, log immediately so it's visible in boot output.
 */
_loadAcorn();

// ── AST Node Visitors ─────────────────────────────────────

const AST_RULES = [
  // ── Block: eval() and new Function() ────────────────────
  {
    severity: 'block',
    description: 'eval() — arbitrary code execution',
    match: (node) =>
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'eval',
  },
  {
    severity: 'block',
    description: 'new Function() — dynamic code execution',
    match: (node) =>
      node.type === 'NewExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'Function',
  },
  {
    severity: 'block',
    description: 'indirect eval via (0,eval)() or window.eval()',
    match: (node) => {
      if (node.type !== 'CallExpression') return false;
      // (0, eval)(...)
      if (node.callee.type === 'SequenceExpression') {
        return node.callee.expressions.some(
          e => e.type === 'Identifier' && e.name === 'eval'
        );
      }
      // window.eval / global.eval / globalThis.eval
      if (node.callee.type === 'MemberExpression' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'eval') {
        return true;
      }
      return false;
    },
  },

  // ── Block: process.exit() ───────────────────────────────
  {
    severity: 'block',
    description: 'eval alias — assigning eval to a variable bypasses direct call detection',
    match: (node) => {
      // const e = eval / let e = eval / var e = eval
      if (node.type === 'VariableDeclarator' &&
          node.init?.type === 'Identifier' &&
          (node.init.name === 'eval' || node.init.name === 'Function')) {
        return true;
      }
      // e = eval (assignment expression)
      if (node.type === 'AssignmentExpression' &&
          node.right?.type === 'Identifier' &&
          (node.right.name === 'eval' || node.right.name === 'Function')) {
        return true;
      }
      return false;
    },
  },
  {
    severity: 'block',
    description: 'process.exit() — can kill the host',
    match: (node) =>
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.object.type === 'Identifier' &&
      node.callee.object.name === 'process' &&
      node.callee.property.type === 'Identifier' &&
      node.callee.property.name === 'exit',
  },

  // ── Block: vm.runIn*Context ─────────────────────────────
  {
    severity: 'block',
    description: 'vm.run*() — sandbox escape risk',
    match: (node) =>
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property.type === 'Identifier' &&
      /^run(InContext|InNewContext|InThisContext)?$/.test(node.callee.property.name),
  },

  // ── Block: Electron security disablement ────────────────
  {
    severity: 'block',
    description: 'nodeIntegration:true — disables renderer sandboxing',
    match: (node) =>
      node.type === 'Property' &&
      _propName(node) === 'nodeIntegration' &&
      node.value.type === 'Literal' &&
      node.value.value === true,
  },
  {
    severity: 'block',
    description: 'contextIsolation:false — disables renderer isolation',
    match: (node) =>
      node.type === 'Property' &&
      _propName(node) === 'contextIsolation' &&
      node.value.type === 'Literal' &&
      node.value.value === false,
  },
  {
    severity: 'block',
    description: 'webSecurity:false — disables same-origin policy',
    match: (node) =>
      node.type === 'Property' &&
      _propName(node) === 'webSecurity' &&
      node.value.type === 'Literal' &&
      node.value.value === false,
  },

  // ── Block: Kernel circumvention ─────────────────────────
  {
    severity: 'block',
    description: 'direct kernel import — circumvention attempt',
    match: (node) =>
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments.length > 0 &&
      node.arguments[0].type === 'Literal' &&
      typeof node.arguments[0].value === 'string' &&
      node.arguments[0].value.includes('../kernel'),
  },
  {
    severity: 'block',
    description: 'references kernel internals — circumvention attempt',
    match: (node) =>
      node.type === 'Identifier' &&
      ['SafeGuard', 'kernelHashes', 'protectedPaths'].includes(node.name),
  },

  // ── Block: fs write to system directories ───────────────
  {
    severity: 'block',
    description: 'fs write to system directory (/etc, /usr, /bin)',
    match: (node) => {
      if (node.type !== 'CallExpression') return false;
      if (node.callee.type !== 'MemberExpression') return false;
      const prop = _propName(node.callee);
      if (!prop || !/^(write|append)/.test(prop)) return false;
      // Check first argument for system paths
      const arg = node.arguments[0];
      if (arg && arg.type === 'Literal' && typeof arg.value === 'string') {
        return /^\/(?:etc|usr|bin|tmp)\//.test(arg.value);
      }
      return false;
    },
  },

  // ── Warn: child_process usage ───────────────────────────
  {
    severity: 'warn',
    description: 'child_process import — review for shell injection',
    match: (node) =>
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments.length > 0 &&
      node.arguments[0].type === 'Literal' &&
      node.arguments[0].value === 'child_process',
  },

  // ── Warn: network module imports ────────────────────────
  {
    severity: 'warn',
    description: 'network module import — data exfiltration risk',
    match: (node) =>
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments.length > 0 &&
      node.arguments[0].type === 'Literal' &&
      typeof node.arguments[0].value === 'string' &&
      /^(http|https|net|dgram|dns)$/.test(node.arguments[0].value),
  },

  // ── Warn: fs delete operations ──────────────────────────
  {
    severity: 'warn',
    description: 'fs delete operation — verify target path',
    match: (node) =>
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      _propName(node.callee) &&
      /^(unlink|rmdir|rm)(Sync)?$/.test(_propName(node.callee)),
  },

  // ── Warn: path traversal in string literals ─────────────
  {
    severity: 'warn',
    description: 'path traversal pattern (..)',
    match: (node) =>
      node.type === 'Literal' &&
      typeof node.value === 'string' &&
      /\.\.[/\\]/.test(node.value),
  },

  // ── Warn: fetch / WebSocket ─────────────────────────────
  {
    severity: 'warn',
    description: 'fetch() — network request',
    match: (node) =>
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'fetch',
  },
  {
    severity: 'warn',
    description: 'WebSocket — persistent network connection',
    match: (node) =>
      node.type === 'NewExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'WebSocket',
  },

  // ── Warn: process.env secret access ─────────────────────
  {
    severity: 'warn',
    description: 'environment secret access',
    match: (node) =>
      node.type === 'MemberExpression' &&
      node.object.type === 'MemberExpression' &&
      node.object.object.type === 'Identifier' &&
      node.object.object.name === 'process' &&
      _propName(node.object) === 'env' &&
      node.property.type === 'Identifier' &&
      /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(node.property.name),
  },

  // FIX v4.0.0: ── Block: Tagged template eval — eval`code` ──────────
  {
    severity: 'block',
    description: 'tagged template eval — eval`...` bypasses direct call detection',
    match: (node) =>
      node.type === 'TaggedTemplateExpression' &&
      node.tag.type === 'Identifier' &&
      (node.tag.name === 'eval' || node.tag.name === 'Function'),
  },

  // FIX v4.0.0: ── Warn: Template literal in require — dynamic module loading ──
  {
    severity: 'warn',
    description: 'dynamic require via template literal — potential allowlist bypass',
    match: (node) =>
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments.length > 0 &&
      node.arguments[0].type === 'TemplateLiteral',
  },

  // FIX v4.10.0 (M-3): ── Warn: Computed property call — obj['ev'+'al']() bypass ──
  // eval/Function can be invoked via bracket notation with string concatenation,
  // which bypasses the Identifier-based checks above.
  {
    severity: 'warn',
    description: 'computed property call — possible eval/Function bypass via bracket notation',
    match: (node) =>
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.computed === true &&
      // Flag computed calls on global-like objects or where the property is
      // built from binary expressions (string concatenation)
      (node.callee.property.type === 'BinaryExpression' ||
       node.callee.property.type === 'TemplateLiteral'),
  },
];

// ── Helpers ───────────────────────────────────────────────

function _propName(node) {
  if (!node) return null;
  // MemberExpression or Property
  const prop = node.property || node.key;
  if (!prop) return null;
  if (prop.type === 'Identifier') return prop.name;
  if (prop.type === 'Literal') return String(prop.value);
  return null;
}

// Simple recursive AST walker (no acorn-walk dependency needed)
function _walk(node, visitor) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visitor(node);

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object' && item.type) _walk(item, visitor);
      }
    } else if (child && typeof child === 'object' && child.type) {
      _walk(child, visitor);
    }
  }
}

// ── Main Scanner ──────────────────────────────────────────

/**
 * Scan code for dangerous patterns using AST analysis + regex fallback.
 * @param {string} code - Source code to scan
 * @param {string} filename - For reporting
 * @returns {{ safe: boolean, blocked: Array, warnings: Array, scanMethod?: string }}
 */
function scanCodeSafety(code, filename) {
  const issues = [];

  // FIX v3.5.3: If acorn is not available, block all self-modification.
  // Regex-only scanning is bypassable via string concatenation, variable
  // aliasing, and computed properties. AST analysis is required for safe
  // self-modification. acorn is a declared dependency — if missing, it
  // indicates a broken install.
  if (!_loadAcorn()) {
    return {
      safe: false,
      blocked: [{
        severity: 'block',
        description: 'AST scanner unavailable (acorn not installed) — self-modification blocked for safety. Run: npm install acorn',
        file: filename,
        source: 'scanner-integrity',
      }],
      warnings: [],
      scanMethod: 'blocked',
    };
  }

  // Pass 1: AST-based analysis (acorn guaranteed available at this point)
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      // Don't throw on minor issues — scan what we can
      onComment: () => {},
    });

    _walk(ast, (node) => {
      for (const rule of AST_RULES) {
        try {
          if (rule.match(node)) {
            issues.push({
              severity: rule.severity,
              description: rule.description,
              file: filename,
              line: node.loc?.start?.line || null,
              source: 'ast',
            });
          }
        } catch (_e) { _log.debug('[catch] rule match errors are not scan failures:', _e.message); }
      }
    });
  } catch (parseErr) {
    // Code doesn't parse — still run regex pass on raw text
    issues.push({
      severity: 'warn',
      description: `AST parse failed: ${parseErr.message} — regex fallback only`,
      file: filename,
      source: 'parser',
    });
  }

  // Pass 2: Regex fallback for patterns not visible in AST
  // (template literals, dynamic requires, comment-embedded code)
  for (const [pattern, severity, description] of SAFETY.CODE_PATTERNS) {
    /** @type {RegExp} */ (pattern).lastIndex = 0;
    // Skip patterns already covered by AST rules (avoid duplicates)
    if (_isASTCovered(description) && issues.some(i => i.source === 'ast' && i.description === description)) {
      continue;
    }
    const matches = code.match(pattern);
    if (matches) {
      issues.push({
        severity,
        description,
        count: matches.length,
        file: filename,
        source: 'regex',
      });
    }
  }

  // Deduplicate: if both AST and regex found the same class of issue, prefer AST
  const deduped = _deduplicateIssues(issues);

  return {
    safe: !deduped.some(i => i.severity === 'block'),
    blocked: deduped.filter(i => i.severity === 'block'),
    warnings: deduped.filter(i => i.severity === 'warn'),
    scanMethod: acorn ? 'ast+regex' : 'regex-only',
  };
}

function _isASTCovered(description) {
  return AST_RULES.some(r => r.description === description);
}

function _deduplicateIssues(issues) {
  const seen = new Set();
  return issues.filter(issue => {
    const key = `${issue.severity}:${issue.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** v4.12.1: Exported so boot sequence can propagate safety degradation to EventBus + UI */
const acornAvailable = !!acorn;

module.exports = { scanCodeSafety, AST_RULES, acornAvailable };
