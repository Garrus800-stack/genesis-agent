// @ts-checked-v5.7
// ============================================================
// GENESIS — GitHubEffector.js (Phase 11 — Plugin Effector)
//
// Effector plugin for GitHub API integration.
// Registers with EffectorRegistry for:
//   - Creating issues
//   - Creating pull requests
//   - Adding comments to issues/PRs
//   - Listing repo issues
//
// Requires: GITHUB_TOKEN environment variable or settings.
// Uses GitHub REST API v3 (no external dependencies).
// ============================================================

const https = require('https');

const GITHUB_API = 'api.github.com';

class GitHubEffector {
  constructor({ bus, storage, config }) {
    this.bus = bus;
    this.storage = storage;
    // FIX v4.10.0 (M-3): Only accept token from config (Settings, encrypted at rest).
    // Previously fell back to process.env.GITHUB_TOKEN, which leaks the token
    // into in-memory state and can be exfiltrated if agent state is serialized
    // or read via self-modification. Config tokens come from Settings which
    // encrypts sensitive values with AES-256-GCM.
    this.token = config?.token || null;
    this.defaultOwner = config?.owner || null;
    this.defaultRepo = config?.repo || null;
  }

  /**
   * Register all GitHub effectors with an EffectorRegistry.
   * @param {object} registry
   */
  registerWith(registry) {
    registry.register({
      name: 'github:create-issue',
      description: 'Create a GitHub issue',
      risk: 'medium',
      schema: {
        inputs: { title: 'string', body: 'string', labels: 'string[]?', owner: 'string?', repo: 'string?' },
        outputs: { number: 'number', url: 'string' },
      },
      preconditions: [{ description: 'GitHub token configured', check: () => !!this.token }],
      execute: async (params) => this._createIssue(params),
    });

    registry.register({
      name: 'github:create-pr',
      description: 'Create a GitHub pull request',
      risk: 'high',
      schema: {
        inputs: { title: 'string', body: 'string', head: 'string', base: 'string?', owner: 'string?', repo: 'string?' },
        outputs: { number: 'number', url: 'string' },
      },
      preconditions: [{ description: 'GitHub token configured', check: () => !!this.token }],
      execute: async (params) => this._createPR(params),
    });

    registry.register({
      name: 'github:comment',
      description: 'Add a comment to a GitHub issue or PR',
      risk: 'medium',
      schema: {
        inputs: { issueNumber: 'number', body: 'string', owner: 'string?', repo: 'string?' },
        outputs: { id: 'number', url: 'string' },
      },
      preconditions: [{ description: 'GitHub token configured', check: () => !!this.token }],
      execute: async (params) => this._addComment(params),
    });

    registry.register({
      name: 'github:list-issues',
      description: 'List open issues for a repository',
      risk: 'safe',
      schema: {
        inputs: { state: 'string?', labels: 'string?', owner: 'string?', repo: 'string?' },
        outputs: { issues: 'object[]', count: 'number' },
      },
      preconditions: [{ description: 'GitHub token configured', check: () => !!this.token }],
      execute: async (params) => this._listIssues(params),
    });
  }

  // ════════════════════════════════════════════════════════
  // GITHUB API
  // ════════════════════════════════════════════════════════

  async _createIssue({ title, body, labels, owner, repo }) {
    const o = owner || this.defaultOwner;
    const r = repo || this.defaultRepo;
    if (!o || !r) throw new Error('owner and repo required');

    const data = await this._apiRequest('POST', `/repos/${o}/${r}/issues`, {
      title, body, labels: labels || [],
    });

    return { number: data.number, url: data.html_url };
  }

  async _createPR({ title, body, head, base, owner, repo }) {
    const o = owner || this.defaultOwner;
    const r = repo || this.defaultRepo;
    if (!o || !r) throw new Error('owner and repo required');

    const data = await this._apiRequest('POST', `/repos/${o}/${r}/pulls`, {
      title, body, head, base: base || 'main',
    });

    return { number: data.number, url: data.html_url };
  }

  async _addComment({ issueNumber, body, owner, repo }) {
    const o = owner || this.defaultOwner;
    const r = repo || this.defaultRepo;
    if (!o || !r) throw new Error('owner and repo required');

    const data = await this._apiRequest('POST', `/repos/${o}/${r}/issues/${issueNumber}/comments`, { body });

    return { id: data.id, url: data.html_url };
  }

  async _listIssues({ state, labels, owner, repo }) {
    const o = owner || this.defaultOwner;
    const r = repo || this.defaultRepo;
    if (!o || !r) throw new Error('owner and repo required');

    const params = new URLSearchParams();
    params.set('state', state || 'open');
    if (labels) params.set('labels', labels);
    params.set('per_page', '30');

    const data = await this._apiRequest('GET', `/repos/${o}/${r}/issues?${params.toString()}`);

    return {
      issues: data.map(i => ({
        number: i.number,
        title: i.title,
        state: i.state,
        labels: i.labels?.map(l => l.name) || [],
        url: i.html_url,
        created: i.created_at,
      })),
      count: data.length,
    };
  }

  _apiRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: GITHUB_API,
        path,
        method,
        headers: {
          'User-Agent': 'Genesis-Agent/4.1',
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `token ${this.token}`,
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 400) {
              reject(new Error(`GitHub API ${res.statusCode}: ${parsed.message || raw.slice(0, 200)}`));
            } else {
              resolve(parsed);
            }
          } catch (_e) {
            reject(new Error(`GitHub API parse error: ${raw.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(TIMEOUTS.GITHUB_API, () => { req.destroy(); reject(new Error('GitHub API timeout')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
}

module.exports = { GitHubEffector };
