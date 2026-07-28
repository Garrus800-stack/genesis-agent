// @ts-checked-v5.7
// ============================================================
// GENESIS — CommandHandlersMemory.js (v7.4.2 "Kassensturz")
//
// Extracted from CommandHandlers.js as part of the v7.4.2 domain
// split. Handles Core Memories (v7.3.2+):
//   - memoryMark  — /mark <text> — mark moment as significant
//   - memoryList  — /memories [all] — list stored core memories
//   - memoryVeto  — /veto <cm_id> — mark a memory as not-significant
//
// Prototype-Delegation from CommandHandlers.js via Object.assign.
// External API unchanged.
// ============================================================

'use strict';

const commandHandlersMemory = {

  async memoryMark(message) {
    if (!this.coreMemories) {
      return this.lang.current === 'de'
        ? 'Kern-Erinnerungen sind momentan nicht verfügbar.'
        : 'Core Memories are not currently available.';
    }
    // Extract the actual text — strip the command/trigger prefix
    let text = message
      .replace(/^\/mark\b[:\s]*/i, '')
      .replace(/^merk(?:e)? dir[:\s]*/i, '')
      .replace(/^remember (?:this|that)[:\s]*/i, '')
      .replace(/^erinnere dich (?:daran|an)[:\s]*/i, '')
      .trim();
    if (!text || text.length < 3) {
      return this.lang.current === 'de'
        ? 'Was soll ich mir merken? Formuliere den Moment bitte kurz.'
        : 'What should I remember? Please describe the moment briefly.';
    }
    try {
      const memory = await this.coreMemories.markAsSignificant({ summary: text });
      if (this.lang.current === 'de') {
        return `Habe diesen Moment als bedeutend vermerkt.\n\n\`${memory.id}\` · type: \`${memory.type}\` · ${memory.evidence.signals.length} Signal${memory.evidence.signals.length === 1 ? '' : 'e'}\n\n> ${memory.summary.slice(0, 120)}${memory.summary.length > 120 ? '…' : ''}`;
      }
      return `Marked this moment as significant.\n\n\`${memory.id}\` · type: \`${memory.type}\` · ${memory.evidence.signals.length} signal${memory.evidence.signals.length === 1 ? '' : 's'}\n\n> ${memory.summary.slice(0, 120)}${memory.summary.length > 120 ? '…' : ''}`;
    } catch (err) {
      return this.lang.current === 'de'
        ? `Konnte die Erinnerung nicht speichern: ${err.message}`
        : `Failed to store the memory: ${err.message}`;
    }
  },

  /**
   * /memories or /memories list — show last 5 core memories.
   * /memories all — show everything (with limit warning).
   */
  memoryList(message) {
    if (!this.coreMemories) {
      return this.lang.current === 'de'
        ? 'Kern-Erinnerungen sind momentan nicht verfügbar.'
        : 'Core Memories are not currently available.';
    }
    const all = this.coreMemories.list();
    if (all.length === 0) {
      return this.lang.current === 'de'
        ? 'Noch keine Kern-Erinnerungen gespeichert. Nutze `/mark <text>` um einen Moment als bedeutend zu markieren.'
        : 'No core memories stored yet. Use `/mark <text>` to mark a moment as significant.';
    }

    const showAll = /\ball\b|alle/i.test(message);
    const selected = showAll ? all : all.slice(-5);
    const ordered = [...selected].reverse();

    const lines = ordered.map(m => {
      const date = m.timestamp.slice(0, 10);
      const confirmedIcon = m.userConfirmed === true
        ? (this.lang.current === 'de' ? '✓ bestätigt' : '✓ confirmed')
        : m.userConfirmed === false
          ? (this.lang.current === 'de' ? '✗ verworfen' : '✗ vetoed')
          : (this.lang.current === 'de' ? '· offen' : '· pending');
      const signalCount = m.evidence?.signalCount ?? m.evidence?.signals?.length ?? 0;
      const source = m.createdBy === 'user' ? ' [user]' : '';
      return `**${m.id}**${source}\n${date} · ${m.type} · [${signalCount}/6] · ${confirmedIcon}\n> ${(m.summary || '').slice(0, 120)}${(m.summary || '').length > 120 ? '…' : ''}`;
    });

    const header = this.lang.current === 'de'
      ? `**Kern-Erinnerungen** (${selected.length} von ${all.length}):`
      : `**Core Memories** (${selected.length} of ${all.length}):`;
    const footer = !showAll && all.length > 5
      ? '\n\n' + (this.lang.current === 'de'
        ? `_Zeige 5 neueste. Nutze \`/memories all\` um alle ${all.length} zu sehen._`
        : `_Showing 5 most recent. Use \`/memories all\` to see all ${all.length}._`)
      : '';
    return `${header}\n\n${lines.join('\n\n')}${footer}`;
  },

  /**
   * /veto <memoryId> — mark a memory as not-significant.
   * Does not delete — memory stays in log with userConfirmed=false.
   */
  memoryVeto(message) {
    if (!this.coreMemories) {
      return this.lang.current === 'de'
        ? 'Kern-Erinnerungen sind momentan nicht verfügbar.'
        : 'Core Memories are not currently available.';
    }

    // Extract memory id
    const match = message.match(/\b(cm_[\w\-]+)\b/);
    if (!match) {
      return this.lang.current === 'de'
        ? 'Gib bitte die Memory-ID an, z.B. `/veto cm_2026-04-19T18-30-00_u1`. Liste per `/memories`.'
        : 'Please provide a memory ID, e.g. `/veto cm_2026-04-19T18-30-00_u1`. List via `/memories`.';
    }
    const memoryId = match[1];
    const all = this.coreMemories.list();
    const memory = all.find(m => m.id === memoryId);
    if (!memory) {
      return this.lang.current === 'de'
        ? `Keine Erinnerung mit ID \`${memoryId}\` gefunden.`
        : `No memory found with ID \`${memoryId}\`.`;
    }
    if (memory.userConfirmed === false) {
      return this.lang.current === 'de'
        ? `Diese Erinnerung ist bereits als verworfen markiert.`
        : `This memory is already marked as vetoed.`;
    }

    // Extract optional user-note (anything after the id)
    const afterId = message.split(memoryId)[1] || '';
    const userNote = afterId.trim().replace(/^[—\-:]\s*/, '') || null;

    const ok = this.coreMemories.veto(memoryId, userNote);
    if (!ok) {
      return this.lang.current === 'de'
        ? `Konnte die Erinnerung nicht verwerfen.`
        : `Could not veto the memory.`;
    }

    if (this.lang.current === 'de') {
      return `Vermerkt. Der Moment bleibt im Protokoll, wird aber nicht mehr als Teil meiner Identität behandelt.`;
    }
    return `Noted. The moment stays in the log but is no longer treated as part of my identity.`;
  },

  // v7.9.33 (AP-2, S7): /changes [n] — read the change register. Reads the
  // journal file directly via this._genesisDir (exactly how skillsPending
  // reads its folder — no service binding, never on the runtime path).
  /**
   * v7.9.47: /crashlog in chat. The flight recorder was readable only from the
   * CLI branch in cli.js — the same file, the same ring buffer, but invisible
   * to the partner in the app. Reads the file directly, like /changes does,
   * so it needs no service wiring and works even when CrashLog is not running.
   */
  async crashlog(message) {
    const fs = require('fs');
    const path = require('path');
    const genesisDir = this._genesisDir || '.genesis';
    const file = path.join(genesisDir, 'flight-recorder.log');

    const m = String(message || '').match(/\/crashlog\s+(\d{1,3})/i);
    const limit = Math.min(m ? parseInt(m[1], 10) : 20, 100);

    let lines = [];
    try {
      if (fs.existsSync(file)) {
        lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      }
    } catch (_e) { /* unreadable → treated as empty */ }

    if (lines.length === 0) return 'Flight recorder is empty — no warnings or errors recorded.';

    const tail = lines.slice(-limit).reverse();
    const out = tail.map((l) => {
      try {
        const e = JSON.parse(l);
        const when = e.ts ? new Date(e.ts).toISOString().slice(5, 19).replace('T', ' ') : '?';
        return `${when}  ${String(e.level || '?').toUpperCase().padEnd(5)} ${e.module || '-'}: ${String(e.msg || '').slice(0, 160)}`;
      } catch (_e) { return l.slice(0, 200); }
    });
    return `Flight recorder — last ${out.length} of ${lines.length}:\n${out.join('\n')}`;
  },

  async changes(message) {
    const fs = require('fs');
    const path = require('path');
    const genesisDir = this._genesisDir || '.genesis';
    const file = path.join(genesisDir, 'change-register.jsonl');

    const m = String(message || '').match(/\/changes\s+(\d{1,3})/i);
    const limit = Math.min(m ? parseInt(m[1], 10) : 20, 100);

    let lines = [];
    try {
      if (fs.existsSync(file)) {
        lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      }
    } catch (_e) { /* unreadable → treated as empty */ }

    if (lines.length === 0) {
      return this.lang.current === 'de'
        ? 'Noch keine Wandel-Einträge — das Register beginnt mit dem ersten Wandel oder der ersten Fitness-Evaluation.'
        : 'No change entries yet — the register begins with the first change or the first fitness evaluation.';
    }

    const tail = lines.slice(-limit).map(l => {
      try { return JSON.parse(l); } catch (_e) { return null; }
    }).filter(Boolean);

    const groups = new Map();
    for (const e of tail) {
      const k = e.kind || 'unknown';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }

    const fmt = (e) => {
      const ts = (e.ts || '').replace('T', ' ').slice(0, 16);
      switch (e.kind) {
        case 'kg-pruned': {
          const ex = Array.isArray(e.examples) && e.examples.length
            ? ' — ' + e.examples.slice(0, 3).map(x => x.label || x.id).join(' · ') + (e.examples.length > 3 ? ' …' : '')
            : '';
          return `  ${ts} · ${e.count} node(s) [${e.cause}] · ${e.remaining} remain${ex}`;
        }
        case 'schema-pruned': {
          const ex = Array.isArray(e.examples) && e.examples.length ? ' — ' + e.examples.slice(0, 3).join(' · ') : '';
          return `  ${ts} · ${e.removed} schema(ta) · ${e.remaining} remain${ex}`;
        }
        case 'core-memory-released':
          return `  ${ts} · ${e.id} (${e.reason})${e.label ? ' — „' + e.label + '“' : ''}`;
        case 'memory-self-released':
          return `  ${ts} · ${e.episodeId}${e.label ? ' — „' + e.label + '“' : ''}`;
        case 'memory-consolidated':
          return `  ${ts} · ${e.episodeId} L${e.from}→L${e.to}${e.label ? ' — „' + e.label + '“' : ''}`;
        case 'fitness':
          return `  ${ts} · score ${typeof e.score === 'number' ? e.score.toFixed(3) : e.score} · baseline ${e.baseline ?? '—'}${e.belowMedian ? ' · below' : ''}${e.archival ? ' · archival!' : ''}`;
        default:
          return `  ${ts} · ${JSON.stringify(e).slice(0, 100)}`;
      }
    };

    const title = this.lang.current === 'de'
      ? `Wandel-Register — letzte ${tail.length} Einträge:`
      : `Change register — last ${tail.length} entries:`;
    const out = [title];
    for (const [k, es] of groups) {
      out.push(`\n${k} (${es.length}):`);
      for (const e of es) out.push(fmt(e));
    }
    return out.join('\n');
  },

};

module.exports = { commandHandlersMemory };
