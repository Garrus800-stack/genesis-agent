// @ts-checked-v5.7
// ============================================================
// GENESIS — HealthServer.js (v4.12.2)
//
// Optional HTTP health endpoint for external monitoring.
// Disabled by default. Enable via:
//   settings.set('health.httpEnabled', true);
//   settings.set('health.httpPort', 9477);
//
// Endpoints:
//   GET /health     → { status, uptime, model, services }
//   GET /health/full → full diagnostic (boot time, memory, errors)
//
// Binds to 127.0.0.1 only — never exposed externally.
// ============================================================

const http = require('http');
const { createLogger } = require('../core/Logger');
const _log = createLogger('HealthServer');

const DEFAULT_PORT = 9477;

class HealthServer {
  constructor({ port, container, bus }) {
    this.port = port || DEFAULT_PORT;
    this.container = container;
    this.bus = bus;
    this._server = null;
  }

  start() {
    this._server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');

      try {
        if (req.url === '/health') {
          res.writeHead(200);
          res.end(JSON.stringify(this._basicHealth()));
        } else if (req.url === '/health/full') {
          res.writeHead(200);
          res.end(JSON.stringify(this._fullHealth()));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found. Use /health or /health/full' }));
        }
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    this._server.listen(this.port, '127.0.0.1', () => {
      _log.info(`[HealthServer] Listening on http://127.0.0.1:${this.port}/health`);
    });

    this._server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        _log.warn(`[HealthServer] Port ${this.port} in use — health endpoint disabled`);
      } else {
        _log.warn(`[HealthServer] Error:`, err.message);
      }
    });
  }

  stop() {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }

  _basicHealth() {
    const c = this.container;
    const model = c.has('model') ? c.resolve('model') : null;
    return {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      model: model?.activeModel || 'none',
      backend: model?.activeBackend || 'none',
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      timestamp: new Date().toISOString(),
    };
  }

  _fullHealth() {
    const c = this.container;
    const basic = this._basicHealth();

    // Service status
    const graph = c.getDependencyGraph();
    const serviceCount = Object.keys(graph).length;
    const resolvedCount = Object.values(graph).filter(s => s.resolved).length;

    // Error aggregator
    let errorReport = null;
    if (c.has('errorAggregator')) {
      try { errorReport = c.resolve('errorAggregator').getReport().summary; } catch (_e) { /* optional service */ }
    }

    // Circuit breaker
    let circuit = null;
    if (c.has('circuitBreaker')) {
      try { circuit = c.resolve('circuitBreaker').getStatus(); } catch (_e) { /* optional service */ }
    }

    // Telemetry
    let telemetry = null;
    if (c.has('telemetry')) {
      try { telemetry = c.resolve('telemetry').getReport(); } catch (_e) { /* optional service */ }
    }

    // Goals
    let activeGoals = 0;
    if (c.has('goalStack')) {
      try { activeGoals = c.resolve('goalStack').getActiveGoals().length; } catch (_e) { /* optional service */ }
    }

    // Kernel integrity
    let integrity = null;
    if (c.has('guard')) {
      try { integrity = c.resolve('guard').verifyIntegrity(); } catch (_e) { /* optional service */ }
    }

    return {
      ...basic,
      services: { total: serviceCount, resolved: resolvedCount },
      errors: errorReport,
      circuit,
      telemetry,
      activeGoals,
      kernelIntegrity: integrity ? (integrity.ok ? 'ok' : 'COMPROMISED') : 'unknown',
      node: process.version,
      platform: process.platform,
    };
  }
}

module.exports = { HealthServer };
