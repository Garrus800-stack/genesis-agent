// @ts-checked-v5.7
// ============================================================
// GENESIS — CommandHandlersSystem.js (v7.4.2 "Kassensturz")
//
// Extracted from CommandHandlers.js as part of the v7.4.2 domain
// split. Handles System configuration:
//   - handleSettings  — show/set Genesis settings (API keys, toggles)
//   - daemonControl   — daemon start/stop/status
//   - trustControl    — Trust Level System (SANDBOX/ASSISTED/AUTONOMOUS/FULL)
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

    // v7.4.5.fix: Generic dot-path setter — `<dotted.path> = <value>`
    // Examples:
    //   agency.autoResumeGoals = always
    //   daemon.enabled = true
    //   idleMind.idleMinutes = 5
    // Booleans, integers, and quoted/unquoted strings are coerced.
    const dotMatch = message.match(/^\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*[=:]\s*(.+?)\s*$/);
    if (dotMatch && dotMatch[1].includes('.')) {
      const path = dotMatch[1];
      let raw = dotMatch[2].trim();
      // strip surrounding quotes
      if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
        raw = raw.slice(1, -1);
      }
      // coerce
      let value;
      if (raw === 'true') value = true;
      else if (raw === 'false') value = false;
      else if (/^-?\d+$/.test(raw)) value = parseInt(raw, 10);
      else if (/^-?\d+\.\d+$/.test(raw)) value = parseFloat(raw);
      else value = raw;
      try {
        this.settings.set(path, value);
        return `✓ ${path} = ${JSON.stringify(value)}`;
      } catch (err) {
        return `✗ Failed to set ${path}: ${err.message}`;
      }
    }

    // Show settings
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
    const NAMES = { 0: 'SANDBOX', 1: 'ASSISTED', 2: 'AUTONOMOUS', 3: 'FULL' };
    const currentName = NAMES[current] || `Level ${current}`;

    // Parse desired level from message
    const msg = message.toLowerCase();
    let target = null;

    if (/sandbox|stufe\s*0|level\s*0/.test(msg)) target = 0;
    else if (/assisted|stufe\s*1|level\s*1/.test(msg)) target = 1;
    else if (/autonom|stufe\s*2|level\s*2/.test(msg)) target = 2;
    else if (/full|voll|stufe\s*3|level\s*3/.test(msg)) target = 3;
    else if (/(?:freigeb|enabl|erlaub|gewähr|grant|hoch|up|erhöh|more)/.test(msg)) {
      target = Math.min(3, current + 1);
    } else if (/(?:einschränk|reduz|lower|runter|weniger|restrict)/.test(msg)) {
      target = Math.max(0, current - 1);
    }

    // No target parsed → show current status
    if (target === null) {
      const lines = [
        `**Trust Level:** ${currentName} (${current}/3)`,
        '',
        '| Level | Name | What Genesis can do |',
        '|-------|------|---------------------|',
        `| 0 | SANDBOX | ${current === 0 ? '◀' : ''} Read-only analysis, no file writes |`,
        `| 1 | ASSISTED | ${current === 1 ? '◀' : ''} Write with approval, self-modification with safety checks |`,
        `| 2 | AUTONOMOUS | ${current === 2 ? '◀' : ''} Independent file operations, auto-approved safe actions |`,
        `| 3 | FULL | ${current === 3 ? '◀' : ''} Full self-modification, shell access, deployment |`,
        '',
        'Change with: "trust level 2", "autonomie freigeben", "trust autonomous"',
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
      return `${direction} **Trust Level changed:** ${NAMES[result.from]} → **${NAMES[result.to]}**\n\nGenesis ${target >= 2 ? 'can now act autonomously.' : 'will ask for approval before making changes.'}`;
    } catch (err) {
      return `Trust level change failed: ${err.message}`;
    }
  },

};

module.exports = { commandHandlersSystem };
