// @ts-checked-v5.7
// ============================================================
// GENESIS — PeerTransport.js (v3.7.0 — extracted from PeerNetwork)
//
// HTTP transport layer for peer-to-peer communication.
// Handles: HTTP server setup, request routing, HTTP client,
// multicast/broadcast discovery, announcement, gossip.
// ============================================================

const http = require('http');
const { TIMEOUTS } = require('../core/Constants');
// @ts-ignore — genuine TS error, fix requires type widening
const dgram = require('dgram');
const crypto = require('crypto');
const { NullBus } = require('../core/EventBus');
const { verifyAuth } = require('./PeerCrypto');
const { PeerRateLimiter } = require('./PeerCrypto');
// FIX v4.10.0 (L-3): Use safeJsonParse for network-sourced JSON
const { safeJsonParse } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('PeerTransport');

class PeerTransport {
  /** @param {{ bus?: object, config?: object }} [opts] */
  constructor({ bus, config } = {}) {
    this.bus = bus || NullBus;
    this.server = null;
    this.udpSocket = null;
    this.port = 0;
    this._useBroadcast = false;
    this._rateLimiter = new PeerRateLimiter(config?.rateLimitPerMin || 30);

    this.config = {
      multicastGroup: '239.42.42.42',
      multicastPort: 19420,
      announceInterval: 30000,
      gossipInterval: 60000,
      healthCheckInterval: 45000,
      peerTTL: 300000,
      rateLimitCleanupInterval: 120000,
      ...config,
    };
  }

  // ── HTTP Server ───────────────────────────────────────

  async startServer(port, token, requestHandler) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const ip = req.socket.remoteAddress;

        const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
        if (!isLocal) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'Non-local connections rejected' }));
          this.bus.fire('peer:rejected', { ip, reason: 'non-local' }, { source: 'PeerTransport' });
          return;
        }

        if (!this._rateLimiter.check(ip)) {
          res.statusCode = 429;
          res.end(JSON.stringify({ error: 'Rate limited' }));
          return;
        }

        const url = new URL(/** @type {string} */ (req.url), `http://127.0.0.1:${this.port}`);
        const publicEndpoints = new Set(['/health', '/discover', '/handshake']);

        if (!publicEndpoints.has(url.pathname)) {
          if (!verifyAuth(req, token)) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }
        }

        requestHandler(req, res, url);
      });

      this.server.listen(port, '127.0.0.1', () => {
        // @ts-ignore — genuine TS error, fix requires type widening
        this.port = this.server.address().port;
        resolve(this.port);
      });

      this.server.on('error', reject);
    });
  }

  // ── Multicast Discovery ───────────────────────────────

  startDiscovery(ownPort, onAnnounce, token = null) {
    // FIX v4.10.0 (M-2): Store discovery token for HMAC-signed announcements.
    // Without signing, any device on the LAN can inject fake genesis-announce
    // packets, fingerprint Genesis instances, or flood the discovery mechanism.
    // FIX v4.12.3 (S-04): Require a discovery token. Without one, multicast
    // discovery is disabled entirely — the UDP socket binds to 0.0.0.0 by
    // necessity for multicast, so unsigned packets must always be rejected.
    this._discoveryToken = token;
    if (!token) {
      _log.warn('[PEER:TRANSPORT] No discovery token — multicast discovery disabled for security. Set peer.discoveryToken in settings to enable.');
      return;
    }
    try {
      this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.udpSocket.on('message', (msg, rinfo) => {
        try {
          const data = safeJsonParse(msg.toString(), null, 'PeerTransport:discovery');
          if (!data) return; // malformed — silent drop
          if (data.type === 'genesis-announce' && data.port !== ownPort) {
            // FIX v4.10.0 (M-2): Verify HMAC on incoming announcements.
            // If we have a token configured, reject unsigned/invalid packets.
            // Peers sharing the same token form a trusted discovery group.
            if (this._discoveryToken) {
              if (!data.sig || !data.nonce) return; // silent drop — unsigned
              const expected = crypto.createHmac('sha256', this._discoveryToken)
                .update(`${data.port}:${data.protocol || 0}:${data.nonce}`)
                .digest('hex');
              if (data.sig !== expected) return; // silent drop — bad signature
            }
            onAnnounce(rinfo.address, data.port);
          }
        } catch (_e) { _log.debug('[catch] ignore malformed:', _e.message); }
      });

      this.udpSocket.on('error', (err) => {
        _log.warn('[PEER:TRANSPORT] UDP error:', err.message);
        this.udpSocket?.close();
        this.udpSocket = null;
      });

      const sock = /** @type {NonNullable<typeof this.udpSocket>} */ (this.udpSocket);
      sock.bind(this.config.multicastPort, () => {
        try {
          sock.addMembership(this.config.multicastGroup);
          sock.setMulticastTTL(2);
        } catch (err) {
          _log.warn('[PEER:TRANSPORT] Multicast failed, fallback to broadcast:', err.message);
          try { sock.setBroadcast(true); } catch (_e) { _log.debug('[catch] UDP setBroadcast:', _e.message); }
          this._useBroadcast = true;
        }
      });
    } catch (err) {
      _log.warn('[PEER:TRANSPORT] Discovery init failed:', err.message);
    }
  }

  announce(ownPort, protocolVersion) {
    if (!this.udpSocket || !ownPort) return;
    const payload = {
      type: 'genesis-announce',
      port: ownPort,
      protocol: protocolVersion,
    };
    // FIX v4.10.0 (M-2): HMAC-sign outgoing announcements.
    if (this._discoveryToken) {
      payload.nonce = crypto.randomBytes(8).toString('hex');
      payload.sig = crypto.createHmac('sha256', this._discoveryToken)
        .update(`${ownPort}:${protocolVersion || 0}:${payload.nonce}`)
        .digest('hex');
    }
    const msg = JSON.stringify(payload);
    try {
      const target = this._useBroadcast ? '255.255.255.255' : this.config.multicastGroup;
      this.udpSocket.send(msg, this.config.multicastPort, target);
    } catch (err) { _log.debug('[PEER:TRANSPORT] Announce failed:', err.message); }
  }

  // ── HTTP Client ───────────────────────────────────────

  httpGet(urlStr, token = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const headers = {};

      if (token) {
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['x-genesis-nonce'] = nonce;
        headers['x-genesis-challenge-response'] = crypto
          .createHmac('sha256', token).update(nonce).digest('hex');
      }

      http.get({
        hostname: url.hostname, port: url.port,
        path: url.pathname + url.search,
        timeout: TIMEOUTS.QUICK_CHECK, headers,
      }, (res) => {
        if (res.statusCode === 401) { reject(new Error('Unauthorized')); return; }
        if (res.statusCode === 429) { reject(new Error('Rate limited')); return; }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (_e) { _log.debug('[catch] JSON parse:', _e.message); reject(new Error('Invalid JSON')); }
        });
      })
      .on('error', reject)
      .on('timeout', function () { this.destroy(); reject(new Error('Timeout')); });
    });
  }

  cleanupRateLimiter() { this._rateLimiter.cleanup(); }

  // ── Shutdown ──────────────────────────────────────────

  async shutdown() {
    if (this.udpSocket) {
      try {
        if (!this._useBroadcast) this.udpSocket.dropMembership(this.config.multicastGroup);
        this.udpSocket.close();
      } catch (_e) { _log.debug('[catch] UDP socket close:', _e.message); }
    }
    // @ts-ignore — genuine TS error, fix requires type widening
    if (this.server) return new Promise(resolve => this.server.close(resolve));
  }
}

module.exports = { PeerTransport };
