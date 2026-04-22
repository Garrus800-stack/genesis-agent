// ============================================================
// v7.3.8 #B — Synchroner Source-Read im Chat
//
// Verified:
//   _maybeReadSourceSync:
//     - "was hat sich geändert" → CHANGELOG.md geladen
//     - "was ist neu" → CHANGELOG.md geladen
//     - "welche version" → package.json version extrahiert
//     - Unrelated query → nichts geladen
//     - Non-general intent → nichts geladen
//     - Non-string message → safe no-op
//     - Setzt _lastSourceReadAttempted korrekt
//
//   _readSourceCached:
//     - Cache-Miss beim ersten Aufruf
//     - Cache-Hit bei zweitem Aufruf (mtime unverändert)
//     - Cache-Miss nach mtime-Änderung
//     - Fehler → null, kein Throw
//
//   CHANGELOG-Extraction:
//     - Zwei Header → vom ersten bis zum zweiten (exklusiv)
//     - Nur ein Header → bis Ende der Datei
//     - Keine Header → null
//     - >6000 Zeichen → gekürzt mit Hinweis am Ende
//
//   package.json-Extraction:
//     - Korrektes version-Feld extrahiert
//     - JSON-Fehler → null, graceful
//
//   PromptBuilder-Integration:
//     - attachSourceContent stores
//     - clearSourceContent clears
//     - _getSourceContentBlock baut korrekten Text mit Autoritäts-Hinweis
// ============================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatOrchestrator } = require('../../src/agent/hexagonal/ChatOrchestrator');
const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');

function makeMockBus() {
  const events = [];
  return {
    emit: (n, p) => events.push({ name: n, payload: p }),
    fire: (n, p) => events.push({ name: n, payload: p }),
    on: () => {},
    events,
  };
}

// Test harness that exposes just what _maybeReadSourceSync needs
class ChatHarness {
  constructor() {
    this.hints = [];
    this.contents = [];
    this.contentsCleared = 0;
    this._lastSourceReadAttempted = false;
    this.promptBuilder = {
      attachSourceHint: () => {},
      clearSourceHint: () => {},
      attachSourceContent: (s) => { this.contents.push(s); },
      clearSourceContent: () => { this.contentsCleared++; },
    };
    this.storage = null;  // defaults to cwd
  }
}

// Patch the harness with the target methods from ChatOrchestrator.prototype
function harnessWithMethods(tempDir) {
  const h = new ChatHarness();
  // storage.baseDir points to a .genesis-style dir — _rootDir takes path.dirname()
  h.storage = { baseDir: path.join(tempDir, '.genesis') };
  const methods = [
    '_maybeReadSourceSync',
    '_readSourceCached',
    '_readChangelogLatestSection',
    '_readPackageVersion',
    '_rootDir',
  ];
  for (const name of methods) {
    h[name] = ChatOrchestrator.prototype[name].bind(h);
  }
  return h;
}

// ════════════════════════════════════════════════════════════
// PromptBuilder additions
// ════════════════════════════════════════════════════════════

describe('v7.3.8 #B — PromptBuilder source-content', () => {

  it('attachSourceContent stores and _getSourceContentBlock renders', () => {
    const pb = new PromptBuilder({});
    pb.attachSourceContent({ content: '## [7.3.8]\nNew features.', label: 'CHANGELOG.md' });
    const block = pb._getSourceContentBlock();
    assert.ok(block.includes('CHANGELOG.md'));
    assert.ok(block.includes('## [7.3.8]'));
    assert.ok(block.includes('Grundlage deiner Antwort'));
  });

  it('clearSourceContent removes the content', () => {
    const pb = new PromptBuilder({});
    pb.attachSourceContent({ content: 'x', label: 'y' });
    pb.clearSourceContent();
    assert.strictEqual(pb._getSourceContentBlock(), '');
  });

  it('attachSourceContent with null clears', () => {
    const pb = new PromptBuilder({});
    pb.attachSourceContent({ content: 'x', label: 'y' });
    pb.attachSourceContent(null);
    assert.strictEqual(pb._getSourceContentBlock(), '');
  });

  it('attachSourceContent with empty content clears', () => {
    const pb = new PromptBuilder({});
    pb.attachSourceContent({ content: 'x', label: 'y' });
    pb.attachSourceContent({ content: '', label: 'y' });
    assert.strictEqual(pb._getSourceContentBlock(), '');
  });

  it('no content attached → empty block', () => {
    const pb = new PromptBuilder({});
    assert.strictEqual(pb._getSourceContentBlock(), '');
  });
});

// ════════════════════════════════════════════════════════════
// _readSourceCached
// ════════════════════════════════════════════════════════════

describe('v7.3.8 #B — _readSourceCached', () => {
  let tempDir, filePath, h;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-src-cache-'));
    filePath = path.join(tempDir, 'test.md');
    fs.writeFileSync(filePath, 'original content');
    h = harnessWithMethods(tempDir);
  });
  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('first read populates cache', () => {
    const c = h._readSourceCached(filePath);
    assert.strictEqual(c, 'original content');
    assert.strictEqual(h._sourceReadCache.size, 1);
  });

  it('second read hits cache (mtime unchanged)', () => {
    const first = h._readSourceCached(filePath);
    // Spy on fs.readFileSync — second call should NOT invoke it
    const origReadFile = fs.readFileSync;
    let readCallCount = 0;
    fs.readFileSync = function(...args) {
      readCallCount++;
      return origReadFile.apply(fs, args);
    };
    try {
      const second = h._readSourceCached(filePath);
      assert.strictEqual(second, first);       // same content
      assert.strictEqual(readCallCount, 0);    // fs.readFileSync not invoked
    } finally {
      fs.readFileSync = origReadFile;
    }
  });

  it('cache-miss after mtime change', () => {
    h._readSourceCached(filePath);
    // Wait to ensure mtime advances, then update
    const newTime = new Date(Date.now() + 2000);
    fs.writeFileSync(filePath, 'new content');
    fs.utimesSync(filePath, newTime, newTime);
    const second = h._readSourceCached(filePath);
    assert.strictEqual(second, 'new content');
  });

  it('missing file → null, no throw', () => {
    const result = h._readSourceCached(path.join(tempDir, 'does-not-exist.md'));
    assert.strictEqual(result, null);
  });
});

// ════════════════════════════════════════════════════════════
// _readChangelogLatestSection
// ════════════════════════════════════════════════════════════

describe('v7.3.8 #B — _readChangelogLatestSection', () => {
  let tempDir, changelogPath, h;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-changelog-'));
    changelogPath = path.join(tempDir, 'CHANGELOG.md');
    h = harnessWithMethods(tempDir);
  });
  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('extracts section from first to second header (exclusive)', () => {
    fs.writeFileSync(changelogPath, `# Changelog

## [7.3.8] — "Ehrliches Nichtwissen"

New stuff here.

## [7.3.7] — "Zuhause einrichten"

Old stuff.
`);
    const section = h._readChangelogLatestSection(changelogPath);
    assert.ok(section.includes('7.3.8'));
    assert.ok(section.includes('New stuff'));
    assert.ok(!section.includes('7.3.7'));
    assert.ok(!section.includes('Old stuff'));
  });

  it('extracts to EOF when only one header exists', () => {
    fs.writeFileSync(changelogPath, `# Changelog

## [7.3.8] — "First release"

All the content.
More content.
Even more.
`);
    const section = h._readChangelogLatestSection(changelogPath);
    assert.ok(section.includes('7.3.8'));
    assert.ok(section.includes('All the content'));
    assert.ok(section.includes('Even more'));
  });

  it('returns null when no version headers exist', () => {
    fs.writeFileSync(changelogPath, `# Changelog

No version headers yet.
`);
    const section = h._readChangelogLatestSection(changelogPath);
    assert.strictEqual(section, null);
  });

  it('truncates at 6000 chars with hint', () => {
    const hugeContent = '## [7.3.8]\n\n' + 'A'.repeat(7000) + '\n\n## [7.3.7]\nOld.';
    fs.writeFileSync(changelogPath, hugeContent);
    const section = h._readChangelogLatestSection(changelogPath);
    assert.ok(section.length < hugeContent.length);
    assert.ok(section.length <= 6200);  // 6000 + hint overhead
    assert.ok(section.includes('Gekürzt'));
    assert.ok(section.includes('CHANGELOG.md'));
  });

  it('does not truncate when under 6000 chars', () => {
    const small = '## [7.3.8]\n\nShort section.\n\n## [7.3.7]\nOld.';
    fs.writeFileSync(changelogPath, small);
    const section = h._readChangelogLatestSection(changelogPath);
    assert.ok(!section.includes('Gekürzt'));
  });

  it('returns null when file does not exist', () => {
    const section = h._readChangelogLatestSection(path.join(tempDir, 'missing.md'));
    assert.strictEqual(section, null);
  });
});

// ════════════════════════════════════════════════════════════
// _readPackageVersion
// ════════════════════════════════════════════════════════════

describe('v7.3.8 #B — _readPackageVersion', () => {
  let tempDir, pkgPath, h;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-pkg-'));
    pkgPath = path.join(tempDir, 'package.json');
    h = harnessWithMethods(tempDir);
  });
  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('extracts version field', () => {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'test', version: '7.3.8' }));
    assert.strictEqual(h._readPackageVersion(pkgPath), '7.3.8');
  });

  it('returns null on invalid JSON', () => {
    fs.writeFileSync(pkgPath, 'not valid json {{{');
    assert.strictEqual(h._readPackageVersion(pkgPath), null);
  });

  it('returns null when version field missing', () => {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'test' }));
    assert.strictEqual(h._readPackageVersion(pkgPath), null);
  });

  it('returns null when version is not a string', () => {
    fs.writeFileSync(pkgPath, JSON.stringify({ version: 123 }));
    assert.strictEqual(h._readPackageVersion(pkgPath), null);
  });
});

// ════════════════════════════════════════════════════════════
// _maybeReadSourceSync — integration
// ════════════════════════════════════════════════════════════

describe('v7.3.8 #B — _maybeReadSourceSync', () => {
  let tempDir, h;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-sync-'));
    fs.writeFileSync(path.join(tempDir, 'CHANGELOG.md'),
      '# Changelog\n\n## [7.3.8]\n\nHonesty features.\n\n## [7.3.7]\nOld.\n');
    fs.writeFileSync(path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'genesis', version: '7.3.8' }));
    h = harnessWithMethods(tempDir);
  });
  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('"was hat sich geändert" loads CHANGELOG content', () => {
    h._maybeReadSourceSync('was hat sich in v7.3.8 geändert', { type: 'general' });
    assert.strictEqual(h.contents.length, 1);
    assert.ok(h.contents[0].content.includes('7.3.8'));
    assert.ok(h.contents[0].content.includes('Honesty features'));
    assert.strictEqual(h._lastSourceReadAttempted, true);
  });

  it('"was ist neu" loads CHANGELOG content', () => {
    h._maybeReadSourceSync('was ist neu', { type: 'general' });
    assert.strictEqual(h.contents.length, 1);
    assert.strictEqual(h._lastSourceReadAttempted, true);
  });

  it('"welche version" loads package.json version', () => {
    h._maybeReadSourceSync('welche version läuft gerade', { type: 'general' });
    assert.strictEqual(h.contents.length, 1);
    assert.ok(h.contents[0].content.includes('7.3.8'));
    assert.ok(h.contents[0].label.includes('package.json'));
    assert.strictEqual(h._lastSourceReadAttempted, true);
  });

  it('unrelated query → nothing loaded, flag false', () => {
    h._maybeReadSourceSync('wie geht es dir heute', { type: 'general' });
    assert.strictEqual(h.contents.length, 0);
    assert.strictEqual(h._lastSourceReadAttempted, false);
  });

  it('non-general intent → nothing loaded', () => {
    h._maybeReadSourceSync('was hat sich geändert', { type: 'goals' });
    assert.strictEqual(h.contents.length, 0);
    assert.strictEqual(h._lastSourceReadAttempted, false);
  });

  it('non-string message → safe no-op', () => {
    assert.doesNotThrow(() => {
      h._maybeReadSourceSync(null, { type: 'general' });
      h._maybeReadSourceSync(42, { type: 'general' });
    });
    assert.strictEqual(h.contents.length, 0);
  });

  it('always clears previous content at turn start', () => {
    h._maybeReadSourceSync('was hat sich geändert', { type: 'general' });
    const clearedBefore = h.contentsCleared;
    h._maybeReadSourceSync('unrelated', { type: 'general' });
    // clearSourceContent should have been called again at turn 2
    assert.ok(h.contentsCleared > clearedBefore);
  });

  it('missing CHANGELOG file → graceful, flag false, no content', () => {
    fs.rmSync(path.join(tempDir, 'CHANGELOG.md'));
    h._maybeReadSourceSync('was hat sich geändert', { type: 'general' });
    assert.strictEqual(h.contents.length, 0);
    assert.strictEqual(h._lastSourceReadAttempted, false);
  });

  it('corrupt package.json → graceful, flag false', () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), 'not json');
    h._maybeReadSourceSync('welche version', { type: 'general' });
    assert.strictEqual(h.contents.length, 0);
    assert.strictEqual(h._lastSourceReadAttempted, false);
  });

  it('missing promptBuilder.attachSourceContent → safe no-op', () => {
    const h2 = new ChatHarness();
    h2.promptBuilder = {};
    for (const m of ['_maybeReadSourceSync', '_readSourceCached',
                      '_readChangelogLatestSection', '_readPackageVersion', '_rootDir']) {
      h2[m] = ChatOrchestrator.prototype[m].bind(h2);
    }
    h2.storage = { baseDir: path.join(tempDir, '.genesis') };
    assert.doesNotThrow(() => {
      h2._maybeReadSourceSync('was hat sich geändert', { type: 'general' });
    });
  });
});
