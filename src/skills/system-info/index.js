// ============================================================
// SKILL: system-info (v5.9.1 — Sandbox-Safe)
// Collects system information for self-awareness and diagnostics.
//
// v5.9.1: Removed child_process dependency (blocked by sandbox).
// ============================================================

const os = require('os');

class SystemInfoSkill {
  constructor() {
    this.name = 'system-info';
  }

  async execute(_input) {
    return {
      os: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
        uptime: Math.round(os.uptime() / 60) + ' minutes',
      },
      cpu: {
        model: os.cpus()[0]?.model || 'unknown',
        cores: os.cpus().length,
        speed: (os.cpus()[0]?.speed || 0) + ' MHz',
      },
      memory: {
        total: this._fmt(os.totalmem()),
        free: this._fmt(os.freemem()),
        used: this._fmt(os.totalmem() - os.freemem()),
        usagePercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100) + '%',
      },
      node: process.version,
    };
  }

  _fmt(bytes) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  async test() {
    const r = await this.execute({});
    const ok = r.os?.platform && r.cpu?.cores > 0 && r.memory?.total;
    return { passed: !!ok, detail: ok ? `${r.os.platform}, ${r.cpu.cores} cores, ${r.memory.total} RAM` : 'missing fields' };
  }
}

module.exports = { SystemInfoSkill };
