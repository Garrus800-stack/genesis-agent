// @ts-checked-v5.7
// ============================================================
// GENESIS — bootstrap.js (KERNEL)
// First-time setup: validates environment, creates directories,
// initializes git, installs dependencies.
//
// FIX v4.10.0 (Audit P1-04): Migrated all execSync → execFileSync
// with array args. No shell is spawned — eliminates injection risk
// from directory paths containing special characters.
// ============================================================

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// @ts-ignore
const EXEC_OPTS = { cwd: ROOT, stdio: 'pipe', windowsHide: true, encoding: 'utf-8' };

console.log('+=======================================+');
console.log('|         GENESIS — Bootstrap           |');
console.log('+=======================================+\n');

// Step 1: Check Node.js version
const nodeVersion = process.versions.node.split('.').map(Number);
if (nodeVersion[0] < 18) {
  console.error('[ERROR] Node.js 18+ required. Current:', process.version);
  process.exit(1);
}
console.log('[OK] Node.js', process.version);

// Step 2: Check git
try {
  execFileSync('git', ['--version'], EXEC_OPTS);
  console.log('[OK] Git available');
} catch (err) {
  console.error('[ERROR] Git not found. Please install Git.');
  process.exit(1);
}

// Step 3: Check Ollama (via node http — no curl dependency)
try {
  execFileSync('node', ['-e', [
    "const http = require('http');",
    "const req = http.get('http://127.0.0.1:11434/api/tags', { timeout: 3000 }, (res) => {",
    "  res.resume();",
    "  process.exit(res.statusCode < 400 ? 0 : 1);",
    "});",
    "req.on('error', () => process.exit(1));",
    "req.on('timeout', () => { req.destroy(); process.exit(1); });",
  ].join('\n')], { ...EXEC_OPTS, timeout: 5000 });
  console.log('[OK] Ollama running');
} catch (err) {
  console.warn('[WARN] Ollama not reachable. Start Ollama before Genesis.');
}

// Step 4: Create directories
const dirs = ['sandbox', '.genesis', 'src/skills', 'test', 'uploads'];
for (const dir of dirs) {
  const fullDir = path.join(ROOT, dir);
  if (!fs.existsSync(fullDir)) {
    fs.mkdirSync(fullDir, { recursive: true });
    console.log('[DIR] Created: ' + dir + '/');
  }
}

// Step 5: Initialize git if needed
if (!fs.existsSync(path.join(ROOT, '.git'))) {
  execFileSync('git', ['init'], EXEC_OPTS);

  fs.writeFileSync(
    path.join(ROOT, '.gitignore'),
    'node_modules/\nsandbox/\n.genesis/\ndist/\nuploads/\n*.log\n*.tmp\n.DS_Store\nThumbs.db\n',
    'utf-8'
  );

  // Ensure git user is configured
  try {
    execFileSync('git', ['config', 'user.name'], EXEC_OPTS);
  } catch (err) {
    execFileSync('git', ['config', 'user.name', 'Genesis'], EXEC_OPTS);
    execFileSync('git', ['config', 'user.email', 'genesis@local'], EXEC_OPTS);
  }

  execFileSync('git', ['add', '-A'], EXEC_OPTS);
  execFileSync('git', ['commit', '-m', 'genesis: initial', '--allow-empty'], EXEC_OPTS);
  console.log('[OK] Git repository initialized');
}

// Step 6: npm install
console.log('\n[INSTALL] Dependencies...');
try {
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmBin, ['install'], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  console.log('[OK] Dependencies installed');
} catch (err) {
  console.error('[ERROR] npm install failed');
  process.exit(1);
}

console.log('\n=======================================');
console.log('  Genesis is ready!');
console.log('  Start with: npm start');
console.log('=======================================\n');
