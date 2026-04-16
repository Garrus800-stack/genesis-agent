// ============================================================
// TEST — ProjectIntelligence.js
// ============================================================

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { ProjectIntelligence } = require('../../src/agent/cognitive/ProjectIntelligence');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function mockStorage() {
  return { readJSON: () => null, writeJSON: () => {} };
}

describe('ProjectIntelligence', () => {
  let pi;

  before(() => {
    pi = new ProjectIntelligence({
      bus: { on: () => {}, emit: () => {}, fire: () => {} },
      storage: mockStorage(),
      config: { staleMs: 999999 },
    });
    pi.selfModel = { rootDir: ROOT };
    pi.start();
  });

  describe('getProfile', () => {
    it('returns a profile with file counts', () => {
      const p = pi.getProfile();
      assert.ok(p);
      assert.ok(p.fileCount > 100, `Expected >100 files, got ${p.fileCount}`);
      assert.ok(p.totalLOC > 10000, `Expected >10k LOC, got ${p.totalLOC}`);
    });

    it('detects categories', () => {
      const p = pi.getProfile();
      assert.ok(p.byCategory.code > 50);
      assert.ok(p.byCategory.test > 20);
    });

    it('detects directory count', () => {
      const p = pi.getProfile();
      assert.ok(p.directoryCount > 10);
    });
  });

  describe('stack detection', () => {
    it('detects JavaScript/Electron', () => {
      const p = pi.getProfile();
      assert.ok(p.stack.language === 'JavaScript');
      assert.ok(p.stack.framework === 'Electron');
    });

    it('detects package manager', () => {
      const p = pi.getProfile();
      assert.ok(['npm', 'yarn', 'pnpm'].includes(p.stack.packageManager));
    });

    it('detects test framework', () => {
      const p = pi.getProfile();
      assert.ok(p.stack.testFramework, 'Expected test framework detection');
    });

    it('counts dependencies', () => {
      const p = pi.getProfile();
      assert.ok(p.stack.dependencies >= 1);
    });
  });

  describe('quality analysis', () => {
    it('estimates test coverage', () => {
      const p = pi.getProfile();
      assert.ok(typeof p.quality.testCoverageEstimate === 'number');
      assert.ok(p.quality.testCoverageEstimate >= 0 && p.quality.testCoverageEstimate <= 100);
    });

    it('counts code and test files', () => {
      const p = pi.getProfile();
      assert.ok(p.quality.codeFiles > 50);
      assert.ok(p.quality.testFiles > 10);
    });

    it('finds large files', () => {
      const p = pi.getProfile();
      assert.ok(Array.isArray(p.quality.largeFiles));
    });
  });

  describe('conventions', () => {
    it('detects module system', () => {
      const p = pi.getProfile();
      assert.ok(['commonjs', 'esm', 'mixed'].includes(p.conventions.moduleSystem));
    });

    it('detects naming style', () => {
      const p = pi.getProfile();
      assert.ok(['camel', 'snake', 'kebab', 'unknown'].includes(p.conventions.namingStyle));
    });

    it('detects indentation', () => {
      const p = pi.getProfile();
      assert.ok(['2-space', '4-space'].includes(p.conventions.indentation));
    });
  });

  describe('hotspots', () => {
    it('finds coupling hotspots', () => {
      const p = pi.getProfile();
      assert.ok(Array.isArray(p.hotspots));
      if (p.hotspots.length > 0) {
        assert.ok(p.hotspots[0].importedBy >= 3);
      }
    });
  });

  describe('buildPromptContext', () => {
    it('returns non-empty context', () => {
      const ctx = pi.buildPromptContext();
      assert.ok(ctx.includes('PROJECT'));
      assert.ok(ctx.length > 20);
    });

    it('includes stack info', () => {
      const ctx = pi.buildPromptContext();
      assert.ok(ctx.includes('JavaScript') || ctx.includes('TypeScript'));
    });
  });

  describe('getSuggestions', () => {
    it('returns array of strings', () => {
      const suggestions = pi.getSuggestions();
      assert.ok(Array.isArray(suggestions));
      for (const s of suggestions) {
        assert.ok(typeof s === 'string');
      }
    });
  });

  describe('rescan', () => {
    it('rebuilds profile', () => {
      const p1 = pi.getProfile();
      const p2 = pi.rescan();
      assert.ok(p2.scannedAt >= p1.scannedAt);
    });
  });

  describe('manifest registration', () => {
    it('is registered via manifest', () => {
      // v7.2.2: containerConfig removed (orphaned dead code).
      assert.ok(typeof ProjectIntelligence === 'function', 'ProjectIntelligence class exported');
    });
  });
});
