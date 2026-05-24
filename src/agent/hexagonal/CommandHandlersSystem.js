// @ts-checked-v5.7
// ============================================================
// GENESIS — CommandHandlersSystem.js (v7.4.2 "Kassensturz")
//
// Extracted from CommandHandlers.js as part of the v7.4.2 domain
// split. Handles System configuration:
//   - handleSettings  — show/set Genesis settings (API keys, toggles)
//   - daemonControl   — daemon start/stop/status
//   - trustControl    — Trust Level System (SUPERVISED/AUTONOMOUS/FULL)
//
// Prototype-Delegation from CommandHandlers.js via Object.assign.
// External API unchanged.
// ============================================================

'use strict';

const commandHandlersSystem = {

  async daemonControl(message) {
    if (/stop/i.test(message)) { this.daemon.stop(); return this.lang.t('daemon.stopped'); }
    if (/start/i.test(message)) { this.daemon.start(); return this.lang.t('daemon.started'); }
    const st = this.daemon.getStatus();
    return `**Daemon:** ${st.running ? this.lang.t('ui.active') : this.lang.t('ui.inactive')} | ${this.lang.t('health.cycles')}: ${st.cycleCount} | Gaps: ${st.knownGaps.length}`;
  },

  handleSettings(message) {
    if (!this.settings) return this.lang.t('settings.unavailable');

    // Set API key (legacy specific match)
    const apiMatch = message.match(/(?:anthropic|api).?key.*?[:=]\s*(\S+)/i);
    if (apiMatch) {
      this.settings.set('models.anthropicApiKey', apiMatch[1]);
      return this.lang.t('settings.api_key_saved', { key: apiMatch[1].slice(0, 8) });
    }

    // v7.9.0 follow-up: strip the leading "/settings" or "settings" command
    // verb so dot-path expressions reach the parsers below. Without this,
    // `/settings cognitive.koennen.enabled false` was treated as one long
    // line with no `=`/`:` and fell through to the generic overview.
    const body = message.replace(/^\s*\/?\s*settings\s+/i, '').trim();

    // Coerce a raw string token into typed value.
    const coerce = (raw) => {
      raw = raw.trim();
      if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
        raw = raw.slice(1, -1);
      }
      if (raw === 'true')  return true;
      if (raw === 'false') return false;
      if (/^-?\d+$/.test(raw))       return parseInt(raw, 10);
      if (/^-?\d+\.\d+$/.test(raw))  return parseFloat(raw);
      return raw;
    };

    // v7.4.5: Original dot-path setter — `<dotted.path> = <value>` / `:`
    const dotMatch = body.match(/^\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*[=:]\s*(.+?)\s*$/);
    if (dotMatch && dotMatch[1].includes('.')) {
      const path = dotMatch[1];
      const value = coerce(dotMatch[2]);
      try {
        this.settings.set(path, value);
        return `✓ ${path} = ${JSON.stringify(value)}`;
      } catch (err) {
        return `✗ Failed to set ${path}: ${err.message}`;
      }
    }

    // v7.9.0 follow-up: Whitespace-form setter — `<dotted.path> <value>`.
    // Matches the slash-conventional `/settings foo.bar.baz true` form.
    const wsMatch = body.match(/^\s*([a-zA-Z][a-zA-Z0-9_.]*)\s+(.+?)\s*$/);
    if (wsMatch && wsMatch[1].includes('.')) {
      const path = wsMatch[1];
      const value = coerce(wsMatch[2]);
      try {
        this.settings.set(path, value);
        return `✓ ${path} = ${JSON.stringify(value)}`;
      } catch (err) {
        return `✗ Failed to set ${path}: ${err.message}`;
      }
    }

    // v7.9.0 follow-up: GET — `<dotted.path>` alone shows the current value.
    // Accepts paths that point to a leaf (returns the value) OR to a subtree
    // (returns a pretty-printed JSON snippet, capped at 2000 chars).
    const getMatch = body.match(/^\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*$/);
    if (getMatch && getMatch[1].includes('.')) {
      const path = getMatch[1];
      try {
        const v = this.settings.get(path);
        if (v === undefined) return `✗ ${path} is not set`;
        const out = (typeof v === 'object' && v !== null)
          ? JSON.stringify(v, null, 2)
          : JSON.stringify(v);
        return `${path} = ${out.length > 2000 ? out.slice(0, 2000) + '\n…(truncated)' : out}`;
      } catch (err) {
        return `✗ Failed to read ${path}: ${err.message}`;
      }
    }

    // Show settings (generic overview)
    const s = this.settings.getAll();
    return [
      `**Genesis — ${this.lang.t('ui.settings')}**`, '',
      `**Anthropic API:** ${s.models.anthropicApiKey || this.lang.t('settings.not_configured')}`,
      `**OpenAI API:** ${s.models.openaiBaseUrl || this.lang.t('settings.not_configured')}`,
      `**${this.lang.t('settings.preferred_model')}:** ${s.models.preferred || 'auto'}`,
      `**Daemon:** ${s.daemon.enabled ? this.lang.t('ui.active') : this.lang.t('ui.inactive')} (${this.lang.t('settings.every_n_min', { n: s.daemon.cycleMinutes })})`,
      `**IdleMind:** ${s.idleMind.enabled ? this.lang.t('ui.active') : this.lang.t('ui.inactive')} (${this.lang.t('settings.idle_after_min', { n: s.idleMind.idleMinutes })})`,
      `**${this.lang.t('ui.self_mod')}:** ${s.security.allowSelfModify ? this.lang.t('ui.allowed') : this.lang.t('ui.blocked')}`,
      '',
      this.lang.t('settings.api_key_hint'),
    ].join('\n');
  },

  async trustControl(message) {
    // v7.4.5.fix: prefer late-bound `this.trustLevelSystem` (wired via
    // phase5 manifest), fall back to container-lookup for legacy paths.
    const trustSystem = this.trustLevelSystem
                     || this.bus?._container?.resolve?.('trustLevelSystem');
    if (!trustSystem) return 'Trust level system not available.';

    const current = trustSystem.getLevel();
    // v7.9.7: 3-level system. SANDBOX/ASSISTED removed.
    const NAMES = { 0: 'SUPERVISED', 1: 'AUTONOMOUS', 2: 'FULL' };
    const currentName = NAMES[current] || `Level ${current}`;

    // Parse desired level from message
    const msg = message.toLowerCase();
    let target = null;

    if (/supervised|sandbox|stufe\s*0|level\s*0/.test(msg)) target = 0;
    else if (/autonom|stufe\s*1|level\s*1/.test(msg)) target = 1;
    else if (/full|voll|stufe\s*2|level\s*2/.test(msg)) target = 2;
    else if (/(?:freigeb|enabl|erlaub|gewähr|grant|hoch|up|erhöh|more)/.test(msg)) {
      target = Math.min(2, current + 1);
    } else if (/(?:einschränk|reduz|lower|runter|weniger|restrict)/.test(msg)) {
      target = Math.max(0, current - 1);
    }

    // No target parsed → show current status
    if (target === null) {
      const lines = [
        `**Trust Level:** ${currentName} (${current}/2)`,
        '',
        '| Level | Name | What Genesis can do |',
        '|-------|------|---------------------|',
        `| 0 | SUPERVISED | ${current === 0 ? '◀' : ''} Read-only analysis, every action needs approval |`,
        `| 1 | AUTONOMOUS | ${current === 1 ? '◀' : ''} Auto-approved safe/medium/high actions; only critical asks |`,
        `| 2 | FULL | ${current === 2 ? '◀' : ''} Full self-modification, shell access, deployment — never asks |`,
        '',
        'Change with: "trust level 1", "autonomie freigeben", "trust autonomous"',
      ];
      return lines.join('\n');
    }

    // Same level → no change needed
    if (target === current) {
      return `Already at ${NAMES[target]} (level ${target}).`;
    }

    // Apply change
    const targetName = NAMES[target] || `Level ${target}`;
    try {
      const result = await trustSystem.setLevel(target);
      const direction = target > current ? '⬆' : '⬇';
      return `${direction} **Trust Level changed:** ${NAMES[result.from]} → **${NAMES[result.to]}**\n\nGenesis ${target >= 1 ? 'can now act autonomously.' : 'will ask for approval before making changes.'}`;
    } catch (err) {
      return `Trust level change failed: ${err.message}`;
    }
  },

  // v7.9.5 live-fix: surface daemon optimization suggestions that previously
  // disappeared into a fire-and-forget event with no subscriber. Reads the
  // rolling jsonl persisted by AutonomousDaemon._persistSuggestions.
  daemonSuggestions(message) {
    const m = String(message || '').match(/\b(\d{1,3})\b/);
    const want = m ? Math.min(Math.max(parseInt(m[1], 10), 1), 50) : 5;
    return this._readDaemonJsonl('daemon-suggestions.jsonl', want, 'suggestions', 'Optimization suggestions');
  },

  // v7.9.5 live-fix: surface daemon health-check issues that previously only
  // existed as a count in the log.
  daemonHealthIssues(message) {
    const m = String(message || '').match(/\b(\d{1,3})\b/);
    const want = m ? Math.min(Math.max(parseInt(m[1], 10), 1), 50) : 5;
    return this._readDaemonJsonl('daemon-health-issues.jsonl', want, 'issues', 'Health issues');
  },

  _readDaemonJsonl(filename, want, listKey, heading) {
    try {
      const fs = require('fs');
      const path = require('path');
      const rootDir = this.fp?.rootDir || process.cwd();
      const file = path.join(rootDir, '.genesis', filename);
      if (!fs.existsSync(file)) return `**${heading}**: no entries yet (the daemon has not run a relevant cycle since boot).`;
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      if (lines.length === 0) return `**${heading}**: empty log.`;
      const recent = lines.slice(-want).reverse();
      const out = [`**${heading}** — last ${recent.length} snapshot(s):`];
      for (const line of recent) {
        try {
          const e = JSON.parse(line);
          const when = new Date(e.ts || 0).toISOString().replace('T', ' ').slice(0, 19);
          out.push(`\n_${when} · cycle #${e.cycle ?? '?'} · ${e.count ?? 0} item(s)_`);
          for (const item of (e[listKey] || []).slice(0, 8)) {
            const desc = item.detail || item.type || item.message || JSON.stringify(item).slice(0, 120);
            out.push(`  • ${desc}`);
          }
          if ((e[listKey] || []).length > 8) out.push(`  • _(+${e[listKey].length - 8} more truncated)_`);
        } catch { out.push(`  • _(parse error in entry)_`); }
      }
      return out.join('\n');
    } catch (err) {
      return `**${heading}**: read failed — ${err.message}`;
    }
  },

};

module.exports = { commandHandlersSystem };
