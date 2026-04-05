// ============================================================
// GENESIS — test/modules/skills-builtin.test.js (v5.9.3)
//
// Tests built-in skills: git-status, file-search, code-stats.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// ── git-status ──────────────────────────────────────────────

describe('Skill: git-status', () => {
  const { GitStatusSkill } = require(path.join(ROOT, 'src/skills/git-status/index'));

  test('constructs with name', () => {
    const skill = new GitStatusSkill();
    assertEqual(skill.name, 'git-status');
  });

  test('execute() returns branch and commit info', async () => {
    const skill = new GitStatusSkill();
    const r = await skill.execute({ cwd: ROOT });
    assert(typeof r.branch === 'string', 'branch is string');
    assert(typeof r.commitHash === 'string', 'commitHash is string');
    assert(typeof r.dirty === 'boolean' || r.dirty === null, 'dirty is boolean or null');
    assert(typeof r.totalChanges === 'number', 'totalChanges is number');
    assert(Array.isArray(r.recentCommits), 'recentCommits is array');
    assert(typeof r.latestTag === 'string', 'latestTag is string');
  });

  test('recentCommits have hash and message', async () => {
    const skill = new GitStatusSkill();
    const r = await skill.execute({ cwd: ROOT });
    if (r.recentCommits.length > 0) {
      const c = r.recentCommits[0];
      assert(typeof c.hash === 'string' && c.hash.length > 0, 'commit has hash');
      assert(typeof c.message === 'string', 'commit has message');
    }
  });

  test('test() self-check passes', async () => {
    const skill = new GitStatusSkill();
    const r = await skill.test();
    assert(r.passed, `self-test passed: ${r.detail}`);
  });

  test('handles non-git directory gracefully', async () => {
    const skill = new GitStatusSkill();
    const os = require('os');
    const r = await skill.execute({ cwd: os.tmpdir() });
    // Should not throw, just return defaults
    assert(r.branch === 'unknown' || typeof r.branch === 'string', 'branch has value');
  });
});

// ── file-search ─────────────────────────────────────────────

describe('Skill: file-search', () => {
  const { FileSearchSkill } = require(path.join(ROOT, 'src/skills/file-search/index'));

  test('constructs with name', () => {
    const skill = new FileSearchSkill();
    assertEqual(skill.name, 'file-search');
  });

  test('search by extension', async () => {
    const skill = new FileSearchSkill();
    const r = await skill.execute({ cwd: ROOT, ext: '.json', maxResults: 5 });
    assert(r.resultCount > 0, 'found .json files');
    assert(r.results.every(f => f.file.endsWith('.json')), 'all results are .json');
  });

  test('search by name pattern', async () => {
    const skill = new FileSearchSkill();
    const r = await skill.execute({ cwd: ROOT, pattern: 'package', maxResults: 5 });
    assert(r.resultCount > 0, 'found files matching pattern');
    assert(r.results.some(f => f.file.includes('package')), 'match includes package');
  });

  test('content grep returns line hits', async () => {
    const skill = new FileSearchSkill();
    const r = await skill.execute({ cwd: ROOT, content: 'GENESIS', ext: '.js', maxResults: 3 });
    assert(r.resultCount > 0, 'found files with GENESIS content');
    const first = r.results[0];
    assert(Array.isArray(first.hits), 'result has hits array');
    assert(first.hits.length > 0, 'hits are non-empty');
    assert(typeof first.hits[0].line === 'number', 'hit has line number');
    assert(typeof first.hits[0].text === 'string', 'hit has text');
  });

  test('maxResults limits output', async () => {
    const skill = new FileSearchSkill();
    const r = await skill.execute({ cwd: ROOT, ext: '.js', maxResults: 3 });
    assert(r.resultCount <= 3, 'respects maxResults');
  });

  test('test() self-check passes', async () => {
    const skill = new FileSearchSkill();
    const r = await skill.test();
    assert(r.passed, `self-test passed: ${r.detail}`);
  });
});

// ── code-stats ──────────────────────────────────────────────

describe('Skill: code-stats', () => {
  const { CodeStatsSkill } = require(path.join(ROOT, 'src/skills/code-stats/index'));

  test('constructs with name', () => {
    const skill = new CodeStatsSkill();
    assertEqual(skill.name, 'code-stats');
  });

  test('execute() returns project metrics', async () => {
    const skill = new CodeStatsSkill();
    const r = await skill.execute({ cwd: ROOT });
    assert(r.totalFiles > 100, `totalFiles > 100 (got ${r.totalFiles})`);
    assert(r.totalLOC > 10000, `totalLOC > 10000 (got ${r.totalLOC})`);
    assert(r.codeLOC > 0, 'codeLOC > 0');
    assert(r.directories > 10, `directories > 10 (got ${r.directories})`);
    assert(typeof r.blankLines === 'number', 'blankLines is number');
    assert(typeof r.commentLines === 'number', 'commentLines is number');
  });

  test('byExtension has .js entries', async () => {
    const skill = new CodeStatsSkill();
    const r = await skill.execute({ cwd: ROOT });
    assert(r.byExtension['.js'], 'has .js extension');
    assert(r.byExtension['.js'].files > 50, 'many .js files');
    assert(r.byExtension['.js'].loc > 10000, 'significant .js LOC');
  });

  test('largestFiles are sorted by LOC', async () => {
    const skill = new CodeStatsSkill();
    const r = await skill.execute({ cwd: ROOT });
    assert(r.largestFiles.length > 0, 'has largest files');
    for (let i = 1; i < r.largestFiles.length; i++) {
      assert(r.largestFiles[i - 1].loc >= r.largestFiles[i].loc, 'sorted descending');
    }
  });

  test('detects package.json dependencies', async () => {
    const skill = new CodeStatsSkill();
    const r = await skill.execute({ cwd: ROOT });
    assert(typeof r.dependencies === 'number', 'has dependencies count');
    assert(r.dependencies > 0, 'has dependencies');
  });

  test('test() self-check passes', async () => {
    const skill = new CodeStatsSkill();
    const r = await skill.test();
    assert(r.passed, `self-test passed: ${r.detail}`);
  });
});

run();
