// ============================================================
// GENESIS — DeploymentManager.js (v5.9.2 — V6-3 Foundation)
//
// Manages deployment of code changes into running systems.
// Strategy pattern: Direct, Canary, Rolling, Blue-Green.
//
// Foundation layer — wires into existing infrastructure:
//   - ShellAgent (execute deploy commands)
//   - HealthMonitor (verify target health)
//   - HotReloader (self-deploy)
//   - EffectorRegistry (system actions)
//
// Phase: 6 (autonomy) — deployment is an autonomous action
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('DeploymentManager');

/**
 * @typedef {'direct'|'canary'|'rolling'|'blue-green'} DeployStrategy
 * @typedef {'pending'|'deploying'|'verifying'|'done'|'rolled-back'|'failed'} DeployStatus
 * @typedef {{ id: string, target: string, strategy: DeployStrategy, status: DeployStatus, steps: DeployStep[], startedAt: number, completedAt: number|null, error: string|null }} Deployment
 * @typedef {{ name: string, status: 'pending'|'running'|'passed'|'failed', detail: string|null }} DeployStep
 */

const STRATEGY_CONFIGS = {
  'direct':     { healthChecks: 1, rollbackOnFail: true,  parallel: false },
  'canary':     { healthChecks: 3, rollbackOnFail: true,  parallel: false, canaryPercent: 10 },
  'rolling':    { healthChecks: 2, rollbackOnFail: true,  parallel: false },
  'blue-green': { healthChecks: 2, rollbackOnFail: true,  parallel: true },
};

class DeploymentManager {
  /**
   * @param {{ bus: *, shell?: *, healthMonitor?: *, hotReloader?: *, config?: { defaultStrategy?: DeployStrategy, healthTimeoutMs?: number, maxRetries?: number } }} deps
   */
  constructor({ bus, shell, healthMonitor, hotReloader, config }) {
    /** @type {*} */ this.bus = bus;
    /** @type {*} */ this.shell = shell;
    /** @type {*} */ this.healthMonitor = healthMonitor;
    /** @type {*} */ this.hotReloader = hotReloader;

    /** @type {{ defaultStrategy: DeployStrategy, healthTimeoutMs: number, maxRetries: number }} */
    this.config = {
      defaultStrategy: config?.defaultStrategy || 'direct',
      healthTimeoutMs: config?.healthTimeoutMs || 30_000,
      maxRetries: config?.maxRetries || 2,
    };

    /** @type {Map<string, Deployment>} */
    this._deployments = new Map();

    /** @type {Map<string, { backup: *, timestamp: number }>} */
    this._rollbackSnapshots = new Map();

    this.META = {
      id: 'deploymentManager',
      name: 'DeploymentManager',
      version: '5.9.2',
      phase: 6,
      tags: ['autonomy', 'deployment', 'devops'],
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async boot() {
    this.bus.on('deploy:request', (data) => this._handleDeployRequest(data));
    _log.info('[DEPLOY] DeploymentManager ready (foundation mode)');
  }

  async stop() {
    // No persistent timers to clean up in foundation mode
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Deploy changes to a target.
   * @param {string} target — Target identifier (e.g. service name, path, or 'self')
   * @param {{ strategy?: DeployStrategy, files?: string[], commands?: string[], env?: string }} [options]
   * @returns {Promise<Deployment>}
   */
  async deploy(target, options = {}) {
    const strategy = options.strategy || this.config.defaultStrategy;
    const id = this._uid();

    /** @type {Deployment} */
    const deployment = {
      id,
      target,
      strategy,
      status: /** @type {const} */ ('pending'),
      steps: [],
      startedAt: Date.now(),
      completedAt: null,
      error: null,
    };
    this._deployments.set(id, deployment);

    _log.info(`[DEPLOY] Starting ${strategy} deployment ${id.slice(0, 8)} → ${target}`);
    this.bus.fire('deploy:started', { id, target, strategy }, { source: 'DeploymentManager' });

    try {
      // 1. Pre-flight checks
      deployment.status = 'deploying';
      await this._step(deployment, 'pre-flight', () => this._preFlight(target, options));

      // 2. Create rollback snapshot
      await this._step(deployment, 'snapshot', () => this._createSnapshot(id, target));

      // 3. Execute deployment strategy
      await this._step(deployment, `deploy-${strategy}`, () => this._executeStrategy(strategy, target, options));

      // 4. Health verification
      deployment.status = 'verifying';
      const stratConfig = STRATEGY_CONFIGS[strategy] || STRATEGY_CONFIGS.direct;
      await this._step(deployment, 'health-check', () => this._healthCheck(target, stratConfig.healthChecks));

      // 5. Done
      deployment.status = 'done';
      deployment.completedAt = Date.now();
      this.bus.fire('deploy:completed', {
        id, target, strategy,
        duration: deployment.completedAt - deployment.startedAt,
      }, { source: 'DeploymentManager' });
      _log.info(`[DEPLOY] ${id.slice(0, 8)} completed in ${deployment.completedAt - deployment.startedAt}ms`);

    } catch (err) {
      deployment.error = err.message;
      _log.error(`[DEPLOY] ${id.slice(0, 8)} failed: ${err.message}`);

      // Auto-rollback if configured
      const stratConfig = STRATEGY_CONFIGS[strategy] || STRATEGY_CONFIGS.direct;
      if (stratConfig.rollbackOnFail) {
        try {
          await this.rollback(id);
        } catch (rbErr) {
          _log.error(`[DEPLOY] Rollback also failed: ${rbErr.message}`);
          deployment.status = 'failed';
        }
      } else {
        deployment.status = 'failed';
      }

      deployment.completedAt = Date.now();
      this.bus.fire('deploy:failed', { id, target, error: err.message }, { source: 'DeploymentManager' });
    }

    return deployment;
  }

  /**
   * Rollback a deployment using saved snapshot.
   * @param {string} deploymentId
   */
  async rollback(deploymentId) {
    const deployment = this._deployments.get(deploymentId);
    if (!deployment) throw new Error(`Unknown deployment: ${deploymentId}`);

    const snapshot = this._rollbackSnapshots.get(deploymentId);
    if (!snapshot) {
      _log.warn(`[DEPLOY] No rollback snapshot for ${deploymentId.slice(0, 8)}`);
      deployment.status = 'failed';
      return;
    }

    _log.info(`[DEPLOY] Rolling back ${deploymentId.slice(0, 8)}`);
    await this._step(deployment, 'rollback', async () => {
      // In full implementation: restore files, restart services
      // Foundation: emit event for external handling
      this.bus.fire('deploy:rollback', {
        id: deploymentId,
        target: deployment.target,
        snapshot: snapshot.timestamp,
      }, { source: 'DeploymentManager' });
    });

    deployment.status = 'rolled-back';
    this._rollbackSnapshots.delete(deploymentId);
  }

  /**
   * Get deployment status.
   * @param {string} id
   * @returns {Deployment|null}
   */
  getDeployment(id) {
    return this._deployments.get(id) || null;
  }

  /**
   * List recent deployments.
   * @param {number} [limit=20]
   * @returns {Deployment[]}
   */
  listDeployments(limit = 20) {
    return [...this._deployments.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  /**
   * Health snapshot.
   */
  getHealth() {
    const all = [...this._deployments.values()];
    return {
      total: all.length,
      active: all.filter(d => d.status === 'deploying' || d.status === 'verifying').length,
      succeeded: all.filter(d => d.status === 'done').length,
      failed: all.filter(d => d.status === 'failed').length,
      rolledBack: all.filter(d => d.status === 'rolled-back').length,
    };
  }

  // ── Strategy Execution ────────────────────────────────────

  /**
   * @param {DeployStrategy} strategy
   * @param {string} target
   * @param {*} options
   */
  async _executeStrategy(strategy, target, options) {
    switch (strategy) {
      case 'direct':
        return this._deployDirect(target, options);
      case 'canary':
        return this._deployCanary(target, options);
      case 'rolling':
        return this._deployRolling(target, options);
      case 'blue-green':
        return this._deployBlueGreen(target, options);
      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }
  }

  async _deployDirect(target, options) {
    if (target === 'self' && this.hotReloader) {
      // Self-deploy using HotReloader
      for (const file of (options.files || [])) {
        await this.hotReloader.reload(file);
      }
      return;
    }

    // External deploy via shell commands
    if (options.commands?.length && this.shell) {
      for (const cmd of options.commands) {
        await this.shell.run(cmd);
      }
    }
  }

  async _deployCanary(target, options) {
    // Foundation: same as direct but with smaller scope
    _log.info(`[DEPLOY] Canary deploy to ${target} (10% traffic)`);
    await this._deployDirect(target, options);
  }

  async _deployRolling(target, options) {
    // Foundation: sequential deploy with health checks between steps
    const commands = options.commands || [];
    for (let i = 0; i < commands.length; i++) {
      _log.info(`[DEPLOY] Rolling step ${i + 1}/${commands.length}`);
      if (this.shell) await this.shell.run(commands[i]);
      if (i < commands.length - 1) {
        await this._healthCheck(target, 1);
      }
    }
  }

  async _deployBlueGreen(target, options) {
    // Foundation: deploy to "green", verify, then swap
    _log.info(`[DEPLOY] Blue-Green deploy to ${target}`);
    await this._deployDirect(target, options);
    // In full implementation: swap load balancer / symlink
  }

  // ── Health Checks ─────────────────────────────────────────

  /**
   * @param {string} target
   * @param {number} checks — Number of consecutive passing checks required
   */
  async _healthCheck(target, checks = 1) {
    for (let i = 0; i < checks; i++) {
      if (target === 'self' && this.healthMonitor) {
        const health = this.healthMonitor.getHealth?.();
        if (!health || health.status === 'critical') {
          throw new Error(`Health check ${i + 1}/${checks} failed for ${target}`);
        }
      }
      // External health check would use shell/http here
      if (i < checks - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // ── Step Tracking ─────────────────────────────────────────

  /**
   * @param {Deployment} deployment
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  async _step(deployment, name, fn) {
    /** @type {DeployStep} */
    const step = { name, status: 'running', detail: null };
    deployment.steps.push(step);

    try {
      await fn();
      step.status = 'passed';
    } catch (err) {
      step.status = 'failed';
      step.detail = err.message;
      throw err;
    }
  }

  // ── Snapshot ──────────────────────────────────────────────

  async _createSnapshot(deploymentId, target) {
    this._rollbackSnapshots.set(deploymentId, {
      backup: { target, createdAt: Date.now() },
      timestamp: Date.now(),
    });
    // In full implementation: copy files, save state
  }

  // ── Pre-flight ────────────────────────────────────────────

  async _preFlight(target, options) {
    // Basic validation
    if (!target) throw new Error('Deploy target is required');
    if (options.env && !['dev', 'staging', 'prod'].includes(options.env)) {
      throw new Error(`Unknown environment: ${options.env}`);
    }
    // In full implementation: check disk space, permissions, service availability
  }

  // ── Helpers ───────────────────────────────────────────────

  _uid() {
    return 'dpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  _handleDeployRequest(data) {
    if (!data?.target) return;
    this.deploy(data.target, data.options || {}).catch(err => {
      _log.error('[DEPLOY] Requested deploy failed:', err.message);
    });
  }
}

module.exports = { DeploymentManager };
