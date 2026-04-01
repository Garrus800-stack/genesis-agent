// @ts-checked-v5.6
// ============================================================
// GENESIS — GenericWorker.js
// Runs in a worker thread. Handles: syntax checks, code
// analysis, file processing. No access to main thread state.
// ============================================================

const { parentPort } = require('worker_threads');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

if (!parentPort) throw new Error('GenericWorker must run in a worker thread');
const port = parentPort;

port.on('message', async (msg) => {
  const { taskId, taskType, data } = msg;

  try {
    let result;
    switch (taskType) {
      case 'syntax-check':
        result = syntaxCheck(data.code);
        break;
      case 'analyze-code':
        result = analyzeCode(data.code, data.language);
        break;
      case 'process-file':
        result = processFile(data.filePath, data.action);
        break;
      case 'execute':
        result = executeCode(data.code, data.timeout || 10000);
        break;
      default:
        result = { error: `Unknown task type: ${taskType}` };
    }
    port.postMessage({ taskId, result });
  } catch (err) {
    port.postMessage({ taskId, error: err.message });
  }
});

// ── Task Implementations ───────────────────────────────────

function syntaxCheck(code) {
  try {
    new vm.Script(code, { filename: 'check.js' });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message, line: err.lineNumber || null };
  }
}

function analyzeCode(code, language) {
  const lines = code.split('\n');
  const analysis = {
    language,
    lines: lines.length,
    chars: code.length,
    /** @type {string[]} */ functions: [],
    /** @type {string[]} */ classes: [],
    /** @type {string[]} */ imports: [],
    complexity: 'low',
    /** @type {Array<{type: string, detail: any}>} */ issues: [],
  };

  if (language === 'javascript' || language === 'js') {
    // Extract functions
    const fnMatches = code.matchAll(/(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*(?:=|:)\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>))/g);
    for (const m of fnMatches) analysis.functions.push(m[1] || m[2]);

    // Extract classes
    const classMatches = code.matchAll(/class\s+(\w+)/g);
    for (const m of classMatches) analysis.classes.push(m[1]);

    // Extract requires/imports
    const reqMatches = code.matchAll(/(?:require\(['"]([^'"]+)['"]\)|import\s+.*from\s+['"]([^'"]+)['"])/g);
    for (const m of reqMatches) analysis.imports.push(m[1] || m[2]);

    // Syntax check
    const syntax = syntaxCheck(code);
    if (!syntax.valid) analysis.issues.push({ type: 'syntax', detail: syntax.error });

    // Complexity heuristic
    const nestingDepth = maxNesting(code);
    if (nestingDepth > 5) analysis.complexity = 'high';
    else if (nestingDepth > 3 || lines.length > 200) analysis.complexity = 'medium';
  }

  if (language === 'python' || language === 'py') {
    const defMatches = code.matchAll(/def\s+(\w+)/g);
    for (const m of defMatches) analysis.functions.push(m[1]);
    const classMatches = code.matchAll(/class\s+(\w+)/g);
    for (const m of classMatches) analysis.classes.push(m[1]);
    const impMatches = code.matchAll(/(?:import\s+(\w+)|from\s+(\w+)\s+import)/g);
    for (const m of impMatches) analysis.imports.push(m[1] || m[2]);
  }

  if (language === 'bat' || language === 'batch') {
    const labelMatches = code.matchAll(/^:(\w+)/gm);
    for (const m of labelMatches) analysis.functions.push(m[1]);
  }

  return analysis;
}

function processFile(filePath, action) {
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const info = {
    path: filePath,
    name: path.basename(filePath),
    extension: ext,
    size: stat.size,
    sizeHuman: formatBytes(stat.size),
    modified: stat.mtime.toISOString(),
    isText: isTextFile(ext),
  };

  if (action === 'info') return info;

  if (action === 'analyze' && info.isText && stat.size < 5 * 1024 * 1024) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lang = extToLanguage(ext);
    info.analysis = analyzeCode(content, lang);
    info.preview = content.slice(0, 500);
  }

  return info;
}

function executeCode(code, timeout) {
  try {
    const script = new vm.Script(code, { filename: 'sandbox.js' });
    /** @type {any} */
    const ctx = vm.createContext({
      console: { log: (...a) => { ctx._output.push(a.join(' ')); } },
      _output: [],
      setTimeout, setInterval, clearTimeout, clearInterval,
      Math, JSON, Date, Array, Object, String, Number, Boolean,
      parseInt, parseFloat, isNaN, isFinite,
    });
    script.runInContext(ctx, { timeout });
    return { output: ctx._output.join('\n'), error: null };
  } catch (err) {
    return { output: '', error: err.message };
  }
}

// ── Helpers ────────────────────────────────────────────────

function maxNesting(code) {
  let max = 0, current = 0;
  for (const ch of code) {
    if (ch === '{') { current++; if (current > max) max = current; }
    if (ch === '}') current--;
  }
  return max;
}

function isTextFile(ext) {
  return ['.js', '.ts', '.jsx', '.tsx', '.py', '.bat', '.cmd', '.ps1',
    '.sh', '.bash', '.php', '.rb', '.java', '.c', '.cpp', '.h',
    '.cs', '.go', '.rs', '.swift', '.kt', '.lua', '.r', '.sql',
    '.html', '.htm', '.css', '.scss', '.less', '.xml', '.json',
    '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
    '.md', '.txt', '.log', '.csv', '.tsv', '.gitignore',
    '.dockerfile', '.makefile',
  ].includes(ext);
}

function extToLanguage(ext) {
  const map = {
    '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python', '.bat': 'bat', '.cmd': 'bat', '.ps1': 'powershell',
    '.sh': 'shell', '.bash': 'shell', '.php': 'php', '.rb': 'ruby',
    '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.cs': 'csharp',
    '.go': 'go', '.rs': 'rust', '.swift': 'swift', '.kt': 'kotlin',
    '.lua': 'lua', '.r': 'r', '.sql': 'sql',
    '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss',
    '.xml': 'xml', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
    '.toml': 'toml', '.ini': 'ini', '.md': 'markdown', '.txt': 'plaintext',
  };
  return map[ext] || 'plaintext';
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
