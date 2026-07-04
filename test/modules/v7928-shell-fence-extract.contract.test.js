// ============================================================
// GENESIS — test/modules/v7928-shell-fence-extract.contract.test.js
//
// v7.9.28: some models write shell commands (cat/find/ls) inside a ```bash
// fenced block instead of emitting a tool call, so nothing ran and the model
// looped ("file not found" while it exists). The chat tool-loop recovers by
// running ONLY the READ-ONLY commands it finds. This pins that extraction:
// read commands are returned, anything that writes/deletes/installs/executes
// is left untouched.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { extractReadOnlyShellCommands } = require(path.join(ROOT, 'src/agent/core/shell/shell-fence-extract'));

// Build fences without a literal ``` sequence in awkward spots.
const fence = (lang, body) => '```' + (lang || '') + '\n' + body + '\n```';

describe('v7.9.28 read-only shell-fence extraction', () => {
  test('extracts cat from a ```bash block', () => {
    const r = extractReadOnlyShellCommands('I will check.\n' + fence('bash', 'cat README.md'));
    assertEqual(r.length, 1);
    assertEqual(r[0], 'cat README.md');
  });

  test('extracts find and ls', () => {
    assert(extractReadOnlyShellCommands(fence('bash', 'find . -name "X.md"')).length === 1, 'find extracted');
    assert(extractReadOnlyShellCommands(fence('', 'ls -la')).length === 1, 'ls extracted (no lang tag)');
  });

  test('rejects destructive commands', () => {
    assertEqual(extractReadOnlyShellCommands(fence('bash', 'rm -rf /')).length, 0);
    assertEqual(extractReadOnlyShellCommands(fence('bash', 'del important.txt')).length, 0);
    assertEqual(extractReadOnlyShellCommands(fence('bash', 'npm install express')).length, 0);
  });

  test('rejects redirection / write even with a read command', () => {
    assertEqual(extractReadOnlyShellCommands(fence('bash', 'echo hacked > /etc/passwd')).length, 0);
  });

  test('strips a leading shell prompt marker', () => {
    const r = extractReadOnlyShellCommands(fence('bash', '$ cat package.json'));
    assertEqual(r.length, 1);
    assertEqual(r[0], 'cat package.json');
  });

  test('keeps read-only, drops write in a mixed block', () => {
    const r = extractReadOnlyShellCommands(fence('bash', 'cat a.txt\nrm b.txt\ndir'));
    assert(r.includes('cat a.txt'), 'cat kept');
    assert(r.includes('dir'), 'dir kept');
    assert(!r.some((c) => /\brm\b/.test(c)), 'rm dropped');
  });

  test('no fenced block yields nothing (prose is not executed)', () => {
    assertEqual(extractReadOnlyShellCommands('Just talking about cat and ls in prose.').length, 0);
  });

  test('respects the max cap', () => {
    const body = Array.from({ length: 10 }, (_, i) => `cat file${i}.txt`).join('\n');
    const r = extractReadOnlyShellCommands(fence('bash', body), 3);
    assertEqual(r.length, 3);
  });
});

run();
