// @ts-checked-v7.8.4
// ============================================================
// GENESIS — CommandHandlersCleanup.js (v7.8.4)
//
// Cleanup-domain handlers. Wraps CleanupVerifier so the user
// can run a pre-deletion audit manually via /cleanup-check
// without going through a SHELL/CODE step.
//
//   /cleanup-check <path>
//     → analysis report on whether the file is safe to delete
//
// Prototype-Delegation from CommandHandlers.js via Object.assign.
// External API: cleanupCheck.
// ============================================================

'use strict';

const path = require('path');
const { CleanupVerifier } = require('../capabilities/CleanupVerifier');

const commandHandlersCleanup = {

  /**
   * /cleanup-check <relative-path>
   *
   * Runs CleanupVerifier on the target and returns a formatted
   * report. Output language follows this.lang.current.
   */
  async cleanupCheck(message) {
    const text = String(message || '').replace(/^\/cleanup-check\b\s*/i, '').trim();
    const isDE = this.lang && this.lang.current === 'de';

    if (!text) {
      return isDE
        ? 'Verwendung: `/cleanup-check <relativer pfad>` — prüft ob eine Datei sicher gelöscht werden kann.'
        : 'Usage: `/cleanup-check <relative-path>` — checks whether a file is safe to delete.';
    }

    // Strip surrounding quotes a user might paste in
    const target = text.replace(/^["'`]|["'`]$/g, '');
    // Reject absolute paths or escapes — verifier scope is the repo
    if (path.isAbsolute(target) || target.includes('..')) {
      return isDE
        ? `Pfad muss relativ zum Projekt-Root sein und darf keine \`..\` enthalten. Bekommen: \`${target}\``
        : `Path must be relative to project root and contain no \`..\` segments. Got: \`${target}\``;
    }

    let report;
    try {
      const verifier = new CleanupVerifier({
        rootDir: this.rootDir,
        bus: this.bus,
      });
      report = await verifier.verify(target);
    } catch (err) {
      return isDE
        ? `Pre-deletion audit fehlgeschlagen: ${err.message}`
        : `Pre-deletion audit failed: ${err.message}`;
    }

    return this._formatCleanupReport(report, isDE);
  },

  /**
   * @param {{safe: boolean, target: string, findings: Array}} report
   * @param {boolean} isDE
   * @returns {string}
   */
  _formatCleanupReport(report, isDE) {
    const lines = [];
    const header = isDE
      ? `**Pre-deletion audit — \`${report.target}\`**`
      : `**Pre-deletion audit — \`${report.target}\`**`;
    lines.push(header);
    lines.push('');

    if (report.findings.length === 0) {
      lines.push(
        isDE
          ? '✅ Keine Findings — die Datei sieht sicher löschbar aus.'
          : '✅ No findings — the file looks safe to delete.'
      );
      return lines.join('\n');
    }

    // Summary line
    if (report.safe) {
      lines.push(
        isDE
          ? '⚠ Findings vorhanden, aber keine blockierenden (kein Importer, kein Entry-Point):'
          : '⚠ Findings present, but none blocking (no importers, not an entry point):'
      );
    } else {
      lines.push(
        isDE
          ? '🛑 Blockierende Findings — die Datei sollte NICHT ohne weitere Prüfung gelöscht werden:'
          : '🛑 Blocking findings — the file should NOT be deleted without further review:'
      );
    }
    lines.push('');

    for (const f of report.findings) {
      lines.push(`- **${f.kind}** — ${f.message}`);
      if (f.refs && f.refs.length > 0) {
        for (const ref of f.refs.slice(0, 10)) {
          lines.push(`    - \`${ref}\``);
        }
        if (f.refs.length > 10) {
          lines.push(
            isDE
              ? `    - … und ${f.refs.length - 10} weitere`
              : `    - … and ${f.refs.length - 10} more`
          );
        }
      }
      if (f.paths && f.paths.length > 0) {
        for (const p of f.paths.slice(0, 10)) {
          lines.push(`    - \`${p}\``);
        }
        if (f.paths.length > 10) {
          lines.push(
            isDE
              ? `    - … und ${f.paths.length - 10} weitere`
              : `    - … and ${f.paths.length - 10} more`
          );
        }
      }
    }

    lines.push('');
    lines.push(
      isDE
        ? '_Hinweis: dynamische `require()`/`import()`-Aufrufe werden nicht erkannt — bei Unsicherheit manuell prüfen._'
        : '_Note: dynamic `require()`/`import()` calls are not detected — verify manually when in doubt._'
    );

    return lines.join('\n');
  },
};

module.exports = { commandHandlersCleanup };
