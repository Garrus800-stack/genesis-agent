#!/usr/bin/env node
// Test: shared shell read-vocabulary (ShellReadVocabulary) + plan-time guard.
//
//   isReadOnlyShellCommand(cmd) is fail-closed: true ONLY if cmd is provably a
//   read; false on any doubt — FormalPlanner._typifyStep then rewrites the
//   SHELL_EXEC step to ANALYZE on a read-only goal. Covers the field case
//   (mkdir + git init), the multiplexer sub-command split (npm install/run vs
//   npm test), redirection, command/process substitution, chained commands,
//   quoted '>', version probes, env-assignments, and find mutating flags.
//
//   Stage 2: the runtime gate (ShellSafety) and this guard share BASE_READ_VERBS
//   as one source of truth, so the common core cannot drift. The invariant block
//   pins that the plan-time set is a superset of the shared base.

const { describe, test, assert, run } = require('../harness');
const {
  isReadOnlyShellCommand,
  BASE_READ_VERBS,
  READ_VERBS,
} = require('../../src/agent/core/shell/ShellReadVocabulary');

const blocks = (cmd) => assert(isReadOnlyShellCommand(cmd) === false, `expected BLOCK: ${cmd}`);
const reads = (cmd) => assert(isReadOnlyShellCommand(cmd) === true, `expected READ: ${cmd}`);

describe('read-only SHELL guard — mutating commands are blocked', () => {
  test('field case: scaffolding + git init', () => {
    blocks('mkdir -p project/src project/tests project/docs && git init');
  });
  test('sed -i (in-place write)', () => blocks("sed -i 's/a/b/' file"));
  test('PowerShell write cmdlet', () => blocks('Set-Content file x'));
  test('interpreter write (python -c)', () => blocks('python -c "open(\'x\',\'w\').write(\'y\')"'));
  test('interpreter write (node -e)', () => blocks('node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"'));
  test('bare mutators', () => {
    blocks('rm -rf build');
    blocks('mv a b');
    blocks('touch x');
    blocks('git init');
  });
});

describe('read-only SHELL guard — read commands pass', () => {
  test('grep / ls / cat', () => {
    reads('grep -n foo src/agent/x.js');
    reads('ls -la src');
    reads('cat package.json');
  });
  test('git read sub-commands', () => {
    reads('git status');
    reads('git log --oneline -n 5');
    reads('git diff HEAD~1');
  });
  test('npm test (project test runner)', () => reads('npm test'));
  test('version probe', () => {
    reads('python --version');
    reads('node -v');
  });
  test('PowerShell reads', () => {
    reads('Get-ChildItem -Recurse');
    reads('Get-Content file');
  });
});

describe('read-only SHELL guard — bypass attempts fail closed', () => {
  test('chained mutator after a read', () => blocks('ls -la src && rm -rf build'));
  test('output redirection to a file', () => blocks('grep foo file > out.txt'));
  test('append redirection', () => blocks('echo x >> file'));
  test('command substitution $()', () => blocks('cat $(rm -rf x)'));
  test('command substitution backticks', () => blocks('cat `rm -rf x`'));
  test('process substitution <()', () => blocks('cat <(rm -rf x)'));
  test('npm run <script> / install are opaque writes', () => {
    blocks('npm install');
    blocks('npm run build');
    blocks('yarn add lodash');
  });
  test('find with mutating flags', () => {
    blocks('find . -delete');
    blocks('find . -exec rm {} ;');
  });
});

describe('read-only SHELL guard — quoting and edge cases', () => {
  test('quoted > is not a redirect', () => reads('grep "a>b" file'));
  test('quoted separator does not split', () => reads('grep "a;b" file'));
  test('leading env assignment is stripped', () => reads('FOO=bar grep x file'));
  test('env assignment before a mutator still blocks', () => blocks('FOO=bar rm -rf x'));
  test('empty / missing command fails closed', () => {
    blocks('');
    blocks('   ');
    assert(isReadOnlyShellCommand(null) === false, 'null fails closed');
    assert(isReadOnlyShellCommand(undefined) === false, 'undefined fails closed');
  });
  test('unknown tool fails closed', () => blocks('frobnicate --all'));
  test('unbalanced quotes fail closed', () => blocks('grep "unterminated file'));
  test('find with read flags passes', () => reads('find . -name "*.js"'));
});

describe('shared base vocabulary — Stage 2 invariant', () => {
  test('BASE_READ_VERBS is non-empty', () => assert(BASE_READ_VERBS.size > 0, 'base not empty'));
  test('plan-time READ_VERBS is a superset of the shared base', () => {
    for (const v of BASE_READ_VERBS) {
      assert(READ_VERBS.has(v), `READ_VERBS missing base verb: ${v}`);
    }
  });
  test('shared base contains the universally-read core', () => {
    for (const v of ['cat', 'ls', 'find', 'grep', 'head', 'tail', 'wc', 'stat', 'file', 'type', 'dir', 'findstr', 'tree']) {
      assert(BASE_READ_VERBS.has(v), `base missing: ${v}`);
    }
  });
});

run();
