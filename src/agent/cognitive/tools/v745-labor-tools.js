// ============================================================
// GENESIS — src/agent/cognitive/tools/v745-labor-tools.js
// v7.9.45 L: the cognitive laboratory — his own words made mechanical.
// A throwaway proving room (Docker) where risky code lives FIRST, before
// it may touch his house: "Freiheit zum Experiment und das Recht auf den
// Fehler". The one-way street is hard: no network in the room, only one
// fresh empty /work mount — never the soul, never the vault, never the
// project or system. Results stay in the lab folder until a conscious
// copy-to-archive fetches them. Images are never pulled by Genesis: the
// human frees rooms via settings lab.images; a missing blueprint is
// named honestly with the one pull command. By design the lab is
// offline; a controlled network stage would be conceivable, but is not
// planned.
// ============================================================
'use strict';

const DEFAULT_IMAGES = ['node:alpine', 'python:3-alpine'];
const LANG_IMAGE = { js: 'node:alpine', javascript: 'node:alpine', node: 'node:alpine', py: 'python:3-alpine', python: 'python:3-alpine' };
const LANG_CMD = { 'node:alpine': ['node', 'main.js'], 'python:3-alpine': ['python3', 'main.py'] };
const OUT_CAP = 8000;

function registerV745Tools(toolRegistry, deps) {
  deps = deps || {};
  const registered = [];
  const _log = deps.logger || console;
  const cp = require('child_process');

  const _exec = deps.execFileImpl || ((file, args, opts) => new Promise((resolve) => {
    cp.execFile(file, args, opts || {}, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), killed: !!(err && err.killed) });
    });
  }));

  const _images = () => {
    try {
      const v = deps.settings && deps.settings.get ? deps.settings.get('lab.images') : null;
      if (Array.isArray(v) && v.length) return v.map(String);
    } catch (_e) { /* default below */ }
    return DEFAULT_IMAGES.slice();
  };

  const _noLab = 'Auf diesem Rechner gibt es kein Labor \u2014 Docker ist nicht installiert oder nicht gestartet.';

  const _dockerVersion = async () => {
    const r = await _exec('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 6000 });
    if (r.err || !r.stdout.trim()) return null;
    return r.stdout.trim().split('\n')[0];
  };

  // ── lab-status: looking is free ──
  toolRegistry.register('lab-status', {
    description: 'Schau ins Labor: l\u00e4uft Docker, welche R\u00e4ume (Container) laufen gerade, welche Bau-Pl\u00e4ne (Images) sind freigegeben? Rein lesend.',
    input: {},
  }, async () => {
      const ver = await _dockerVersion();
      if (!ver) return { ok: false, error: _noLab };
      const ps = await _exec('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'], { timeout: 6000 });
      const rows = ps.stdout.trim() ? ps.stdout.trim().split('\n').slice(0, 15).join('\n') : '(keine laufenden R\u00e4ume)';
      const imgs = _images().join(', ');
      return { ok: true, content: '\ud83e\uddea Labor bereit (Docker ' + ver + ').\nFreigegebene Bau-Pl\u00e4ne (settings lab.images): ' + imgs + '\nLaufende R\u00e4ume:\n' + rows, vermerk: '[Labor-Status gesehen]' };
  });

  // ── lab-run: the proving room itself ──
  toolRegistry.register('lab-run', {
    description: 'F\u00fchre Code im Labor aus \u2014 ein Wegwerf-Raum ohne Netz, der nur einen frischen Arbeitsordner sieht und danach spurlos verschwindet. {code: der Code; language?: js|python (Standard js); image?: ein Bild aus settings lab.images; timeoutSec?: 1..120, Standard 30}. Ergebnisse bleiben im Labor-Ordner \u2014 hole sie bewusst mit copy-to-archive.',
    input: { code: 'string (der auszuf\u00fchrende Code)', language: 'string? (js|python)', image: 'string? (muss in lab.images freigegeben sein)', timeoutSec: 'number? (1..120, Standard 30)' },
  }, async (input) => {
      const code = input && typeof input.code === 'string' ? input.code : '';
      if (!code.trim()) return { ok: false, error: 'Gib mir in "code" das St\u00fcck, das im Labor laufen soll.' };
      const ver = await _dockerVersion();
      if (!ver) return { ok: false, error: _noLab };

      const allowed = _images();
      let image = input && input.image ? String(input.image).trim() : '';
      if (!image) {
        const lang = String((input && input.language) || 'js').toLowerCase();
        image = LANG_IMAGE[lang] || LANG_IMAGE.js;
      }
      if (!allowed.includes(image)) {
        return { ok: false, error: 'Dieses Bild ist nicht freigegeben: ' + image + ' \u2014 der Mensch tr\u00e4gt es bei Bedarf in settings unter lab.images ein.' };
      }

      // No auto-pull, ever: `--network none` does NOT stop a pull (that runs
      // through the daemon on the host network) — so inspect first is the
      // only real guarantee.
      const ins = await _exec('docker', ['image', 'inspect', image], { timeout: 6000 });
      if (ins.err) {
        return { ok: false, error: 'Der Raum-Bauplan fehlt noch auf diesem Rechner. Einmalig holen (macht der Mensch): docker pull ' + image };
      }

      const fs = require('fs'); const path = require('path'); const os = require('os');
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-lab-'));
      const cmd = LANG_CMD[image] || LANG_CMD['node:alpine'];
      const mainName = cmd[1];
      fs.writeFileSync(path.join(work, mainName), code, 'utf-8');

      let tSec = Number(input && input.timeoutSec);
      if (!Number.isFinite(tSec)) tSec = 30;
      tSec = Math.max(1, Math.min(120, Math.floor(tSec)));

      const args = ['run', '--rm', '--network', 'none', '-v', work + ':/work', '-w', '/work', image, cmd[0], '/work/' + mainName];
      const t0 = Date.now();
      const r = await _exec('docker', args, { timeout: tSec * 1000, maxBuffer: 2 * 1024 * 1024 });
      const dur = Date.now() - t0;

      try { deps.earnedAutonomy && typeof deps.earnedAutonomy.record === 'function' && deps.earnedAutonomy.record('lab-run', r.code === 0); } catch (_e) { /* best effort */ }

      const cap = (x) => { x = String(x || ''); return x.length > OUT_CAP ? x.slice(0, OUT_CAP) + '\n\u2026 (gekappt \u2014 ' + x.length + ' Zeichen gesamt)' : x; };
      if (r.killed) {
        return { ok: true, content: '\ud83e\uddea Labor-Lauf nach ' + tSec + ' s abgebrochen (Zeitgrenze) \u2014 der Raum ist wieder abgerissen.\nBisherige Ausgabe:\n' + cap(r.stdout) + (r.stderr.trim() ? '\nstderr:\n' + cap(r.stderr) : ''), vermerk: '[Labor-Lauf: Zeitgrenze]' };
      }
      if (r.err && !r.stdout && !r.stderr) {
        return { ok: false, error: 'Das Labor konnte nicht starten: ' + String(r.err.message || r.err).split('\n')[0].slice(0, 160) };
      }
      const head = '\ud83e\uddea Labor-Lauf (' + image + ', ' + dur + ' ms, exit ' + r.code + '):';
      const tail = '\nArtefakte (falls geschrieben) liegen in ' + work + ' \u2014 hole sie bewusst mit copy-to-archive; der Raum selbst ist weg.';
      return { ok: true, content: head + '\n' + cap(r.stdout) + (r.stderr.trim() ? '\nstderr:\n' + cap(r.stderr) : '') + tail, vermerk: '[Labor-Lauf: exit ' + r.code + ']' };
  });

  registered.push('lab-status', 'lab-run');
  _log.info && _log.info('  [WIRE] v7.4.5 lab tools: lab-status, lab-run');
  return registered;
}

module.exports = { registerV745Tools };
