// @ts-checked-v5.7
// ============================================================
// GENESIS — CommandHandlersSelf.js (v7.5.5)
//
// Self-Domain handlers. New file in the v7.4.2 domain-split
// pattern. Currently:
//   - selfRecall — /recall — query Self-Statement-Log
//
// Future Self-Handler-Kandidaten (kein commitment):
//   - selfPending — /pending — show goal proposals awaiting confirmation
//   - selfMood — /mood — show current emotional state
//
// Prototype-Delegation from CommandHandlers.js via Object.assign.
// External API: selfRecall.
// ============================================================

'use strict';

const commandHandlersSelf = {

  /**
   * /recall [type] [since:YYYY-MM-DD] [N]
   *
   * Examples:
   *   /recall                    → last 10, any type, last 7 days
   *   /recall structural         → last 10 structural statements
   *   /recall promise 5          → last 5 promise-statements
   *   /recall since:2026-04-25   → all types since that date
   */
  async selfRecall(message) {
    if (!this.selfStatementLog) {
      return this.lang.current === 'de'
        ? 'Self-Statement-Log ist momentan nicht verfügbar.'
        : 'Self-Statement-Log is not currently available.';
    }

    // Parse args after the /recall command itself.
    const text = String(message || '').replace(/^\/recall\b\s*/i, '').trim();
    const args = text.split(/\s+/).filter(Boolean);

    let type = null;
    let since = null;
    let limit = 10;

    // Map English/German type aliases to canonical values.
    const typeMap = {
      structural:   'strukturell',
      strukturell:  'strukturell',
      promise:      'versprechen',
      versprechen:  'versprechen',
      emotional:    'emotional',
      uncertain:    'uncertain',
    };

    for (const arg of args) {
      const lc = arg.toLowerCase();
      if (typeMap[lc]) {
        type = typeMap[lc];
      } else if (/^since:/i.test(arg)) {
        since = arg.slice(6);
      } else if (/^\d+$/.test(arg)) {
        limit = Math.min(parseInt(arg, 10), 50);
      }
    }

    let records;
    try {
      records = await this.selfStatementLog.recall({ type, since, limit });
    } catch (_e) {
      return this.lang.current === 'de'
        ? 'Konnte Self-Statement-Log nicht abfragen.'
        : 'Could not query Self-Statement-Log.';
    }

    if (records.length === 0) {
      return this.lang.current === 'de'
        ? 'Noch keine passenden Self-Statements aufgezeichnet.'
        : 'No matching self-statements recorded yet.';
    }

    const header = this.lang.current === 'de'
      ? `Letzte ${records.length} Self-Statements${type ? ` (Typ: ${type})` : ''}:`
      : `Last ${records.length} self-statements${type ? ` (type: ${type})` : ''}:`;

    const lines = records.map(r => {
      const dataMarker = r.type === 'strukturell'
        ? (r.introspectionPopulated ? '✓verified' : 'no-data')
        : '—';
      const tsShort = r.ts.slice(0, 16).replace('T', ' ');
      return `${tsShort} [${r.type}, ${dataMarker}] "${r.text.slice(0, 120)}"`;
    });

    return [header, '', ...lines].join('\n');
  },

};

module.exports = { commandHandlersSelf };
