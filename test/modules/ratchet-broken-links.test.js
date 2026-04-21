// ============================================================
// Tests for scripts/check-ratchet.js broken-links check (v7.3.6 #12)
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { describe, test, run } = require('../harness');

const ratchet = require('../../scripts/check-ratchet');

describe('check-ratchet.js brokenLinks', () => {

  test('extractLinks finds standard markdown links', () => {
    const md = 'See [docs](./README.md) and [api](api.md).';
    const links = ratchet.extractLinks(md);
    assert.strictEqual(links.length, 2);
    assert.strictEqual(links[0].target, './README.md');
    assert.strictEqual(links[1].target, 'api.md');
  });

  test('extractLinks ignores image links', () => {
    const md = '![logo](logo.png) and [doc](real.md) and ![pic](pic.jpg)';
    const links = ratchet.extractLinks(md);
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].target, 'real.md');
  });

  test('isExternalOrAnchor: http/https/mailto are external', () => {
    assert(ratchet.isExternalOrAnchor('http://x.com'));
    assert(ratchet.isExternalOrAnchor('https://x.com'));
    assert(ratchet.isExternalOrAnchor('mailto:a@b.c'));
  });

  test('isExternalOrAnchor: hash fragments are anchors', () => {
    assert(ratchet.isExternalOrAnchor('#heading'));
    assert(ratchet.isExternalOrAnchor('#'));
  });

  test('isExternalOrAnchor: relative paths are internal', () => {
    assert(!ratchet.isExternalOrAnchor('./file.md'));
    assert(!ratchet.isExternalOrAnchor('../docs/api.md'));
    assert(!ratchet.isExternalOrAnchor('subdir/file.md'));
  });

  test('isExternalOrAnchor: empty or whitespace is treated as ignorable', () => {
    assert(ratchet.isExternalOrAnchor(''));
    assert(ratchet.isExternalOrAnchor('   '));
    assert(ratchet.isExternalOrAnchor(null));
    assert(ratchet.isExternalOrAnchor(undefined));
  });

  test('findMarkdownFiles returns files under root and docs', () => {
    const files = ratchet.findMarkdownFiles();
    // On this repo, at minimum README.md should be found
    const hasReadme = files.some(f => f.endsWith('README.md'));
    assert(hasReadme, 'README.md should be in the markdown file list');
    // All returned entries must be .md
    for (const f of files) {
      assert(f.endsWith('.md'), `non-md entry: ${f}`);
    }
  });

  test('checkBrokenLinks reports 0 on the actual repo', () => {
    const r = ratchet.checkBrokenLinks(0);
    // Current v7.3.5 state should be clean
    assert.strictEqual(r.current, 0,
      `expected 0 broken links, got ${r.current}. ` +
      `Broken: ${r._broken.map(b => `${b.file}→${b.target}`).join(', ')}`);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reason, null);
  });

  test('checkBrokenLinks detects an intentional broken link', () => {
    // Create a fixture in docs/ with one broken link, clean it up after
    const fixturePath = path.join(
      path.resolve(__dirname, '../../'),
      'docs', '__broken_link_fixture__.md'
    );
    fs.writeFileSync(fixturePath,
      '# Fixture\n\n' +
      'This [link points](./does-not-exist-xyz-123.md) to nothing.\n'
    );
    try {
      const r = ratchet.checkBrokenLinks(0);
      assert(r.current >= 1, 'should detect at least the fixture broken link');
      assert(!r.ok, 'should fail when broken links exceed max');
      const hasFixture = r._broken.some(b =>
        b.file.includes('__broken_link_fixture__.md') &&
        b.target.includes('does-not-exist-xyz-123.md')
      );
      assert(hasFixture, 'fixture broken link should appear in results');
    } finally {
      fs.unlinkSync(fixturePath);
    }
  });

});

run();
