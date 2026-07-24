// ============================================================
// GENESIS — src/agent/hexagonal/CommandHandlersVault.js
// v7.9.45 field: the spoken vault handshake. "Mein Vault liegt in
// D:\..." sets vault.path itself — no JSON editing, no restart (the
// knowledge block reads settings every turn). Honest when the folder does
// not exist; asks for the place when none is named.
// ============================================================
'use strict';

const commandHandlersVault = {
  async vaultSet(message) {
    const fs = require('fs');
    const path = require('path');
    const m = String(message || '');
    let p = null;
    const quoted = m.match(/["']([^"']+)["']/);
    if (quoted) p = quoted[1];
    if (!p) { const win = m.match(/([A-Za-z]:\\[^\r\n"']+)/); if (win) p = win[1]; }
    if (!p) { const c = m.indexOf(':'); if (c >= 0) { const r = m.slice(c + 1).trim(); if (/[\\\/]/.test(r)) p = r; } }
    if (!p) { const rest = m.match(/\b(?:in|unter|auf|bei|at|dans|sous|\u00e0|en)\s+(.+)$/i); if (rest && /[\\/:]/.test(rest[1])) p = rest[1]; }
    if (p) p = p.trim().replace(/[.,;!?]+$/, '').trim();
    if (!p) {
      return 'Gern \u2014 nenn mir den Ordner deines Vaults (z.B. D:\\Genesis Home\\MeinVault), dann merke ich ihn mir.';
    }
    if (!this.settings || typeof this.settings.set !== 'function') {
      return 'Ich kann den Ort gerade nicht speichern (Settings nicht erreichbar) \u2014 trag ihn bitte im JSON-Editor unter vault.path ein.';
    }
    let ok = false;
    try { ok = fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch (_e) { ok = false; }
    if (!ok) {
      return 'Unter \u201e' + p + '\u201c finde ich keinen Ordner \u2014 pr\u00fcf den Pfad bitte einmal (Tippfehler?), dann sag ihn mir erneut.';
    }
    const norm = path.resolve(p);
    try { this.settings.set('vault.path', norm); } catch (e) {
      return 'Speichern schlug fehl: ' + String((e && e.message) || e).slice(0, 120);
    }
    // v7.9.45 field: two-roots drift — if Obsidian's own .obsidian folder lives in a
    // CHILD of the given path (not the path itself), the graphs will never meet.
    // Say it right away instead of letting the partner hunt for the reason.
    let hinweis = '';
    try {
      if (!fs.existsSync(path.join(norm, '.obsidian'))) {
        const kids = fs.readdirSync(norm, { withFileTypes: true }).filter((e) => e.isDirectory());
        const hit = kids.find((e) => { try { return fs.existsSync(path.join(norm, e.name, '.obsidian')); } catch { return false; } });
        if (hit) hinweis = '\nHinweis: Obsidian nutzt offenbar ' + path.join(norm, hit.name) + ' als Vault (dort liegt .obsidian). Wenn du DEN meinst, sag: \u201emein vault liegt in ' + path.join(norm, hit.name) + '\u201c \u2014 oder \u00f6ffne in Obsidian stattdessen ' + norm + ' als Vault, dann sehen wir beide dasselbe.';
      }
    } catch { /* hint only */ }
    return 'Dein Vault ist verbunden: ' + norm + '\nIch lese \u00fcberall darin, wenn eine Aufgabe es braucht \u2014 und schreibe nur in meinen Genesis/-Ordner dort. Gilt ab sofort, kein Neustart n\u00f6tig.' + hinweis;
  },
};

module.exports = { commandHandlersVault };
