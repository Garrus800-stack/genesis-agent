// ============================================================
// GENESIS — src/agent/hexagonal/CommandHandlersLab.js
// v7.9.45 field: "Führe im Labor … aus: CODE" — the deterministic road into
// the real Docker room. Everyday code execution stays untouched (sandbox,
// slash discipline unchanged); this handler fires ONLY when the lab is
// named, and speaks through the real lab-run tool (one room, one truth).
// ============================================================
'use strict';

const commandHandlersLab = {
  async labRun(message, orch) {
    const reg = orch && orch.tools;
    if (!reg || typeof reg.hasTool !== 'function' || !reg.hasTool('lab-run') || typeof reg.executeSingleTool !== 'function') {
      return 'Das Labor ist auf diesem Rechner nicht angeschlossen.';
    }
    const m = String(message || '');
    let code = null;
    const fence = m.match(/```(?:[a-zA-Z]+\n)?([\s\S]*?)```/);
    if (fence && fence[1] && fence[1].trim()) code = fence[1].trim();
    let colonIdx = -1;
    if (!code) { colonIdx = m.indexOf(':'); if (colonIdx >= 0 && m.slice(colonIdx + 1).trim()) code = m.slice(colonIdx + 1).trim(); }
    if (!code) {
      // v7.9.45 field: "Schau ins Labor" (fuzzy-learned routes land here too) is
      // a STATUS question, not a run — show the room instead of begging for code.
      if (/\b(schau|status|bereit|zustand|l\u00e4uft|look|ready|running|state|regarde|pr\u00eat|mira|listo|estado)\b/i.test(m) && reg.hasTool('lab-status')) {
        const st = await reg.executeSingleTool('lab-status', {});
        const sr = (st && st.result !== undefined) ? st.result : st;
        if (sr && (sr.content || sr.error)) return sr.content || sr.error;
      }
      return 'Gib mir den Code f\u00fcr das Labor \u2014 nach einem Doppelpunkt oder als ```-Block.';
    }
    const head = fence ? m.slice(0, fence.index) : m.slice(0, colonIdx >= 0 ? colonIdx : m.length);
    const language = /\bpython|\bpy\b/i.test(head) ? 'python' : 'js';
    const input = { code, language };
    const tMatch = head.match(/(\d{1,3})\s*sek/i);
    if (tMatch) input.timeoutSec = parseInt(tMatch[1], 10);
    try {
      const r = await reg.executeSingleTool('lab-run', input);
      const rr = (r && r.result !== undefined) ? r.result : r;
      if (rr && rr.ok) return rr.content;
      if (rr && rr.error) return rr.error;
      return String((rr && rr.content) || rr || 'Das Labor gab keine Antwort.');
    } catch (e) {
      return 'Labor-Fehler: ' + String((e && e.message) || e).slice(0, 200);
    }
  },
};

module.exports = { commandHandlersLab };
