// ============================================================
// SKILL: git-status (v5.9.3)
// Reports git repository status: branch, changes, recent commits.
// Sandbox-safe: uses child_process.execFileSync (no shell).
// ============================================================

const { execFileSync } = require('child_process');
const path = require('path');

class GitStatusSkill {
  constructor() {
    this.name = 'git-status';
  }

  async execute(input) {
    const cwd = input?.cwd || process.cwd();
    const opts = { cwd, encoding: 'utf-8', timeout: 10_000, windowsHide: true };

    const result = { cwd };

    try {
      result.branch = this._exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim();
    } catch { result.branch = 'unknown'; }

    try {
      result.commitHash = this._exec('git', ['rev-parse', '--short', 'HEAD'], opts).trim();
    } catch { result.commitHash = 'unknown'; }

    try {
      const status = this._exec('git', ['status', '--porcelain'], opts).trim();
      const lines = status ? status.split('\n') : [];
      result.dirty = lines.length > 0;
      result.staged = lines.filter(l => l[0] !== ' ' && l[0] !== '?').length;
      result.modified = lines.filter(l => l[1] === 'M').length;
      result.untracked = lines.filter(l => l.startsWith('??')).length;
      result.totalChanges = lines.length;
    } catch {
      result.dirty = null;
      result.totalChanges = 0;
    }

    try {
      const log = this._exec('git', ['log', '--oneline', '-5', '--no-decorate'], opts).trim();
      result.recentCommits = log ? log.split('\n').map(l => {
        const [hash, ...msg] = l.split(' ');
        return { hash, message: msg.join(' ') };
      }) : [];
    } catch { result.recentCommits = []; }

    try {
      const tags = this._exec('git', ['tag', '--sort=-version:refname'], opts).trim();
      result.latestTag = tags ? tags.split('\n')[0] : 'none';
    } catch { result.latestTag = 'none'; }

    try {
      result.remoteUrl = this._exec('git', ['config', '--get', 'remote.origin.url'], opts).trim();
    } catch { result.remoteUrl = 'none'; }

    return result;
  }

  _exec(cmd, args, opts) {
    return execFileSync(cmd, args, { ...opts, stdio: 'pipe' });
  }

  async test() {
    try {
      const r = await this.execute({});
      const ok = r.branch && r.commitHash;
      return { passed: !!ok, detail: ok ? `${r.branch}@${r.commitHash}, ${r.totalChanges} changes` : 'not a git repo' };
    } catch (err) {
      return { passed: false, detail: err.message };
    }
  }
}

module.exports = { GitStatusSkill };
