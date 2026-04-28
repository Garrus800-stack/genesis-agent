// ============================================================
// GENESIS — Language.js
// Auto-detect user language, translate all user-facing text.
//
// Design decisions:
// - LLM prompts stay English (better performance on small models)
// - User-facing responses adapt to detected language
// - Detection from first user message, persisted in settings
// - Singleton pattern: require('./Language').lang
// ============================================================

const fs = require('fs');
const path = require('path');
const { safeJsonParse, atomicWriteFileSync } = require('./utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('Language');

class Language {
  constructor() {
    this.current = 'en'; // default
    this.confidence = 0;
    this.sampleCount = 0;
    this._settingsPath = null;
  }

  /** Point to settings dir for persistence */
  init(storageDir) {
    this._settingsPath = path.join(storageDir, 'language.json');
    try {
      if (fs.existsSync(this._settingsPath)) {
        const data = safeJsonParse(fs.readFileSync(this._settingsPath, 'utf-8'), {}, 'Language');
        if (data.lang && data.confidence > 0.3) {
          this.current = data.lang;
          this.confidence = data.confidence;
        }
      }
    } catch (err) { _log.debug('[LANG] Settings load failed:', err.message); }
  }

  /** Detect language from user text. Call on every user message. */
  detect(text) {
    if (!text || text.length < 3) return this.current;

    const scores = {};
    for (const [code, markers] of Object.entries(MARKERS)) {
      let score = 0;
      for (const { pattern, weight } of markers) {
        if (pattern.test(text)) score += weight;
      }
      if (score > 0) scores[code] = score;
    }

    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];

    if (best) {
      this.sampleCount++;
      // Exponential moving average for stability
      const alpha = Math.min(0.4, 1 / this.sampleCount);
      if (best[0] === this.current) {
        this.confidence = this.confidence * (1 - alpha) + 1.0 * alpha;
      } else if (best[1] > 3 || this.confidence < 0.4) {
        this.current = best[0];
        this.confidence = alpha;
      }
    }

    this._persist();
    return this.current;
  }

  /** Force a specific language */
  set(langCode) {
    if (STRINGS[langCode]) {
      this.current = langCode;
      this.confidence = 1.0;
      this._persist();
    }
  }

  /** Get current language code */
  get() { return this.current; }

  /** Translate a key. Falls back to English. Supports {{var}} interpolation. */
  t(key, vars = {}) {
    const dict = STRINGS[this.current] || STRINGS.en;
    let str = dict[key] || STRINGS.en[key] || key;
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
    }
    return str;
  }

  /** Get all strings for current language (for UI bulk transfer) */
  getUIStrings() {
    const en = STRINGS.en;
    const loc = STRINGS[this.current] || {};
    return { ...en, ...loc, _lang: this.current };
  }

  _persist() {
    if (!this._settingsPath) return;
    try {
      const dir = path.dirname(this._settingsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // FIX v5.1.0 (N-3): Atomic write for language settings.
      atomicWriteFileSync(this._settingsPath, JSON.stringify({
        lang: this.current, confidence: this.confidence,
      }), 'utf-8');
    } catch (err) { _log.debug('[LANG] Settings save failed:', err.message); }
  }
}

const MARKERS = {
  de: [
    { pattern: /\b(ich|mich|mir|mein|dein|sein|ihr|wir|uns|sie|ist|sind|hat|haben|kann|werden|nicht|auch|aber|oder|und|dass|wenn|weil|noch|schon|jetzt|hier|dort|diese|dieser|dieses)\b/i, weight: 2 },
    { pattern: /\b(bitte|danke|hallo|tschüss|moin|servus|guten|morgen|abend)\b/i, weight: 3 },
    { pattern: /[äöüßÄÖÜ]/, weight: 4 },
    { pattern: /\b(zeig|mach|gib|sag|hilf|finde|suche|erstell|reparier|verbess|analys)\w*/i, weight: 3 },
    { pattern: /\b(Datei|Fehler|Ergebnis|Einstellung|Verzeichnis|Ordner|Befehl)\b/i, weight: 3 },
  ],
  fr: [
    { pattern: /\b(je|tu|il|elle|nous|vous|ils|elles|est|sont|avoir|être|faire|aller|les|des|une|pas|que|qui|dans|pour|avec|sur|comme|mais|plus|très)\b/i, weight: 2 },
    { pattern: /\b(bonjour|merci|salut|bonsoir|oui|non|sil vous plaît|comment|pourquoi|quand|où)\b/i, weight: 3 },
    { pattern: /[àâæçéèêëîïôœùûüÿÀÂÆÇÉÈÊËÎÏÔŒÙÛÜŸ]/, weight: 4 },
  ],
  es: [
    { pattern: /\b(yo|tú|él|ella|nosotros|ustedes|ellos|es|son|tiene|hacer|estar|ser|ir|los|las|una|unos|que|por|para|como|pero|más|muy)\b/i, weight: 2 },
    { pattern: /\b(hola|gracias|buenas|buenos|sí|no|por favor|cómo|cuándo|dónde)\b/i, weight: 3 },
    { pattern: /[áéíóúñ¿¡ÁÉÍÓÚÑü]/i, weight: 4 },
  ],
  en: [
    { pattern: /\b(the|is|are|was|were|have|has|had|will|would|can|could|should|this|that|with|from|they|them|their|been|being|about|into|just|very|also|than)\b/i, weight: 1.5 },
    { pattern: /\b(please|thanks|hello|yes|no|why|how|what|when|where|which|would|could|should)\b/i, weight: 2 },
  ],
};

// ── Translation strings ─────────────────────────────────────

const STRINGS = {
  en: {
    // UI
    'ui.booting': 'Booting...',
    'ui.ready': 'Ready',
    'ui.error': 'Error',
    'ui.starting': 'Starting...',
    'ui.placeholder': 'Message to Genesis...',
    'ui.editor': 'Editor',
    'ui.files': 'Files',
    'ui.status': 'Status',
    'ui.settings': 'Settings',
    'ui.undo': 'Undo',
    'ui.save': 'Save',
    'ui.run': 'Run in sandbox',
    'ui.project_structure': 'Project structure',
    'ui.no_file': 'No file open',
    'ui.no_model': 'No model',
    'ui.no_goals': 'No active goals',
    'ui.still_starting': 'Genesis is still starting...',
    'ui.saved': 'Saved: {{file}}',
    'ui.code_in_editor': 'Code in editor: {{file}}',
    'ui.model_switched': 'Model: {{model}}',
    'ui.switch_failed': 'Switch failed',
    'ui.settings_saved': 'Settings saved',
    'ui.settings_title': 'Settings',
    'ui.cancel': 'Cancel',
    'ui.daemon': 'Daemon',
    'ui.idle_mind': 'IdleMind',
    'ui.self_mod': 'Self-modification',
    'ui.active': 'Active',
    'ui.inactive': 'Off',
    'ui.allowed': 'Allowed',
    'ui.blocked': 'Blocked',
    // v7.4.7
    'ui.trust_level': 'Trust Level',
    'ui.trust_supervised': 'Supervised (always ask)',
    'ui.trust_assisted': 'Assisted (ask for risky)',
    'ui.trust_autonomous': 'Autonomous (ask only for critical)',
    'ui.trust_full': 'Full Autonomy (never ask)',
    'ui.auto_resume': 'Auto-Resume Open Goals',
    'ui.auto_resume_ask': 'Ask (Default)',
    'ui.auto_resume_always': 'Always resume',
    'ui.auto_resume_never': 'Never resume',
    'ui.mcp_serve': 'MCP Server (provide Genesis)',
    'ui.mcp_serve_off': 'Off',
    'ui.mcp_serve_on': 'On',
    'ui.mcp_port': 'MCP Server Port',
    'ui.approval_timeout': 'Approval Timeout in Seconds',
    'ui.takes_effect_after_restart': '(takes effect after restart)',
    // v7.4.7: Runtime toggle confirmation messages (chat:system-message)
    'ui.toggle.daemon_on':       'Daemon enabled.',
    'ui.toggle.daemon_off':      'Daemon disabled.',
    'ui.toggle.idlemind_on':     'IdleMind enabled.',
    'ui.toggle.idlemind_off':    'IdleMind disabled.',
    'ui.toggle.selfmod_on':      'Self-modification allowed.',
    'ui.toggle.selfmod_off':     'Self-modification blocked.',
    'ui.toggle.trust_level':     'Trust Level: {{level}}.',
    'ui.toggle.auto_resume':     'Auto-Resume Open Goals: {{mode}}.',
    'ui.toggle.mcp_started':     'MCP Server started on port {{port}}.',
    'ui.toggle.mcp_stopped':     'MCP Server stopped.',
    'ui.toggle.mcp_failed':      'MCP Server toggle failed: {{error}}',
    'ui.open_in_editor': 'Open in editor',
    'ui.file_opened': 'Opened: {{file}}',
    'ui.file_imported': 'Imported: {{file}}',
    'ui.drop_file': 'Drop file here',
    'ui.undo_success': 'Change reverted: {{detail}}',
    'ui.undo_failed': 'Undo failed: {{error}}',
    'ui.undo_nothing': 'Nothing to undo',
    'ui.goals': 'Goals',

    // Welcome
    'welcome.first': "I'm Genesis. I can understand my own source code, repair myself, develop new capabilities, and create improved clones.\n\nTell me your name and I'll remember you next time.",
    'welcome.returning': 'Hello {{name}}!',
    'welcome.returning_anon': "Hey! Good to have you back. What's on your mind?",
    'welcome.returning_familiar': "Hey! Good to see you again.",
    'welcome.working_on': 'What I\'m working on:',
    'welcome.thoughts': "I've had {{thoughts}} independent thoughts and know {{facts}} facts so far.",

    // Agent responses
    'agent.no_code_block': 'No code block found. Use ``` to wrap your code.',
    'agent.no_file': 'No file detected. Include a filename with extension.',
    'agent.file_not_found': 'File "{{file}}" not found.',
    'agent.cannot_execute': 'Cannot execute {{ext}}. Available runtimes: {{runtimes}}',
    'agent.shell_unavailable': 'ShellAgent not available.',
    'agent.no_command': 'No command detected. Write e.g. `$ git status` or "run npm test".',
    'agent.blocked_command': 'Blocked: {{reason}}',
    'agent.undo_only_one': 'Only one commit exists — cannot revert.',
    'agent.undo_conflict': 'Revert not possible — possible merge conflict. Manual fix: `git revert --abort` then `git reset --hard HEAD~1`.',
    'agent.undo_failed': 'Undo failed: {{error}}',
    'agent.undo_done': 'Reverted: `{{commit}}`',
    'agent.plan_failed': 'Could not create a plan.',
    'agent.plan_result': 'Result: {{ok}} succeeded, {{fail}} failed',
    'agent.no_output': '(no output)',
    'agent.error': 'Error',
    'agent.no_test_cmd': 'No test command detected for this project type.',
    'agent.no_install_cmd': 'No install command detected for this project type.',

    // Shell
    'shell.blocked_tier': 'Command blocked on tier "{{tier}}": {{cmd}}',
    'shell.permission_unknown': 'Unknown permission level: {{level}}',

    // Health
    'health.title': 'Genesis — System status',
    'health.kernel': 'Kernel',
    'health.intact': 'Intact',
    'health.problem': 'PROBLEM',
    'health.model': 'Model',
    'health.none': 'none',
    'health.modules': 'Modules',
    'health.skills': 'Skills',
    'health.tools': 'Tools',
    'health.memory': 'Memory',
    'health.facts': 'facts',
    'health.episodes': 'episodes',
    'health.daemon': 'Daemon',
    'health.cycles': 'cycles',
    'health.services': 'Services',
    'health.uptime': 'Uptime',
    'health.shell': 'Shell',
    'health.commands': 'commands',

    // Project scan
    'project.title': 'Project',
    'project.type': 'Type',
    'project.language': 'Language',
    'project.files': 'Files',
    'project.git': 'Git',
    'project.unknown': 'unknown',
    'project.no_git': 'no git',
    'project.commands': 'Available commands',
    'project.dependencies': 'Dependencies',
    'project.clean': 'clean',
    'project.changes': '{{n}} changes',

    // Tool descriptions
    'tool.file_info': 'File information',
    'tool.execute_file': 'Execute file',
    'tool.knowledge_search': 'Search knowledge graph',
    'tool.knowledge_connect': 'Connect concepts',
    'tool.event_query': 'Past events',
    'tool.web_fetch': 'Fetch a URL (documentation, API reference, npm packages)',
    'tool.npm_search': 'Search npm packages',
    'tool.web_ping': 'Check if a URL is reachable',
    'tool.shell_task': 'Plan and execute a complex system task in multiple steps (with safety tiers, git snapshots, and recipe learning)',

    // MCP (Model Context Protocol)
    'mcp.connecting': 'Connecting to MCP server {{name}}...',
    'mcp.connected': 'MCP server {{name}} connected ({{tools}} tools)',
    'mcp.disconnected': 'MCP server {{name}} disconnected',
    'mcp.error': 'MCP error ({{name}}): {{error}}',
    'mcp.no_servers': 'No MCP servers configured',
    'mcp.server_added': 'MCP server **{{name}}** added ({{url}})',
    'mcp.server_removed': 'MCP server **{{name}}** removed',
    'mcp.tools_discovered': '{{count}} tools discovered from {{name}}',
    'mcp.tool_call_failed': 'MCP tool call failed: {{error}}',
    'mcp.status_title': 'MCP Status',
    'mcp.servers': 'Servers',
    'mcp.total_tools': 'Total tools',

    // Inspect / Self-report
    'inspect.title': 'Genesis — Self-report',
    'inspect.identity': 'Identity',
    'inspect.modules': 'Modules',
    'inspect.files': 'files',
    'inspect.kernel': 'Kernel',
    'inspect.kernel_intact': 'Intact',
    'inspect.kernel_compromised': 'COMPROMISED',
    'inspect.capabilities': 'Capabilities',
    'inspect.skills': 'Skills',
    'inspect.none': 'none',
    'inspect.tools': 'Tools',
    'inspect.tools_registered': 'registered',
    'inspect.model': 'Model',
    'inspect.modules_header': 'Modules',
    'inspect.protected': 'protected',

    // Chat status
    'chat.error': 'Error: {{message}}',
    'chat.tools_executing': 'Executing tools...',
    'chat.no_revertable_commit': 'No revertable commit available',

    // Shell
    'shell.plan_error': 'Planning error: {{message}}',
    'shell.step_skipped': 'Previous step failed',

    // Goals
    'goal.no_code': 'No code generated',
    'goal.file_requested': 'File creation requested: {{detail}}',
    'goals.unavailable': 'GoalStack not available.',
    'goals.created': 'New goal created: **{{description}}**',
    'goals.steps': 'Steps',
    'goals.empty': 'No goals set yet. Say e.g. "/goal add Improve error handling"',
    'goals.title': 'Goals',
    'goals.next_step': 'Next step',
    // v7.5.0 — slash-discipline + negotiation
    'goals.add_empty': 'Empty goal description. Try: /goal add <description>',
    'goals.add_failed': 'Could not create goal.',
    'goals.cancel_needs_number': 'Which goal? Try: /goal cancel <n>  (use /goal list for numbers)',
    'goals.cancel_one_done': '**Goal cancelled:** {{description}}',
    'goals.cancel_one_not_found': '**Goal #{{idx}} not found.** {{count}} active goals.',
    'goals.cancel_all_confirm': 'Confirm: cancel all {{count}} active goals? Send `/goal clear` again within 30 seconds to confirm.',
    'goals.cancel_all_done': '**{{count}} goal(s) cancelled.**',
    'goals.none_active': '**No active goals.**',
    'goals.unknown_subcommand': 'Unknown subcommand: `{{sub}}`. Try `/goal list`, `/goal add <text>`, `/goal cancel <n>`, `/goal clear`.',
    'goals.help': '**Goal commands:**\n- `/goal list` — show goals\n- `/goal add <text>` — add a goal\n- `/goal cancel <n>` — cancel goal #n\n- `/goal clear` — cancel all (asks confirmation)\n- `/goal confirm <id>` — confirm pending proposal\n- `/goal revise <id>: <text>` — revise pending\n- `/goal dismiss <id>` — drop pending',
    'goals.proposed': 'Goal proposed: **"{{description}}"**. Genesis is reviewing it before it becomes active.\n\nUse `/goal confirm {{pendingId}}` to accept, `/goal revise {{pendingId}}: <new text>` to refine, or `/goal dismiss {{pendingId}}` to drop.',
    'goals.confirmed': 'Goal confirmed and added: **{{description}}**',
    'goals.revised': 'Proposal revised: **"{{description}}"** (`{{pendingId}}`). Genesis will review again.',
    'goals.dismissed': 'Proposal dismissed: {{description}}',
    'goals.pending_id_missing': 'Pending ID missing. Use `/goal list` to see pending IDs.',
    'goals.pending_not_found': 'Pending proposal `{{pendingId}}` not found (may have expired after 1h).',
    'goals.pending_title': 'Pending (awaiting confirmation)',
    'goals.confirm_failed': 'Could not confirm: {{error}}',
    'goals.revise_format': 'Format: `/goal revise <id>: <new description>`',
    'goals.negotiation_unavailable': 'Goal negotiation is not available in this build.',

    // Peers
    'peer.none_found': 'No peers found.',
    'peer.none_hint': 'No peers. Say "peer scan" to discover.',
    'peer.found': 'found',

    // Daemon
    'daemon.stopped': 'Daemon stopped.',
    'daemon.started': 'Daemon started.',

    // Journal & Plans
    'journal.empty': 'No thoughts in the journal yet.',
    'journal.last': 'last {{n}}',
    'plans.empty': 'No improvement plans yet. I think about them when idle.',
    'plans.title': 'Improvement plans',

    // Settings
    'settings.unavailable': 'Settings not available.',
    'settings.api_key_saved': 'Anthropic API key saved ({{key}}...). Restart to activate.',
    'settings.not_configured': 'not configured',
    'settings.preferred_model': 'Preferred model',
    'settings.every_n_min': 'every {{n}} min',
    'settings.idle_after_min': 'idle after {{n}} min',
    'settings.api_key_hint': 'Say e.g. "Anthropic API-Key: sk-ant-..." to set a key.',

    // Web
    'web.unavailable': 'Web access not available.',
    'web.npm_failed': 'npm search failed: {{error}}',
    'web.npm_no_results': 'No packages found for: {{query}}',
    'web.fetch_failed': 'Could not fetch {{url}}: {{error}}',
    'web.reachable': '**{{url}}** is reachable (status {{status}})',
    'web.unreachable': '**{{url}}** is not reachable: {{error}}',
    'web.hint': 'Provide a URL, or say e.g. "npm search express" or "check if nodejs.org is reachable".',

    // MCP extended
    'mcp.unavailable': 'MCP not available.',
    'mcp.server_not_found': 'Server "{{name}}" not found.',
    'mcp.server_started': 'Genesis MCP server started on **port {{port}}**.\nOther agents: `http://127.0.0.1:{{port}}`',
    'mcp.server_start_failed': 'MCP server start failed: {{error}}',
    'mcp.no_tools_found': 'No MCP tools found for "{{query}}".',
    'mcp.connect_hint': 'Say e.g.: `mcp connect github https://mcp.github.com/sse`',

    // Self-modification
    'selfmod.applied': 'Modification applied.',
    'selfmod.files': 'Files',
    'selfmod.all_intact': 'All systems intact.',
    'selfmod.tests_failed': 'Tests failed:',
    'selfmod.astdiff_applied': 'Precise modification (ASTDiff) applied:',
    'selfmod.warnings': 'Warnings',
    'selfmod.repair': 'Repair',
    'selfmod.greeting': "Hey! What can I do for you?",
  },

  de: {
    'ui.booting': 'Startet...',
    'ui.ready': 'Bereit',
    'ui.error': 'Fehler',
    'ui.starting': 'Startet...',
    'ui.placeholder': 'Nachricht an Genesis...',
    'ui.editor': 'Editor',
    'ui.files': 'Dateien',
    'ui.status': 'Status',
    'ui.settings': 'Einstellungen',
    'ui.undo': 'Rückgängig',
    'ui.save': 'Speichern',
    'ui.run': 'In Sandbox ausführen',
    'ui.project_structure': 'Projektstruktur',
    'ui.no_file': 'Keine Datei geöffnet',
    'ui.no_model': 'Kein Modell',
    'ui.no_goals': 'Keine aktiven Ziele',
    'ui.still_starting': 'Genesis startet noch...',
    'ui.saved': 'Gespeichert: {{file}}',
    'ui.code_in_editor': 'Code im Editor: {{file}}',
    'ui.model_switched': 'Modell: {{model}}',
    'ui.switch_failed': 'Wechsel fehlgeschlagen',
    'ui.settings_saved': 'Einstellungen gespeichert',
    'ui.settings_title': 'Einstellungen',
    'ui.cancel': 'Abbrechen',
    'ui.daemon': 'Daemon',
    'ui.idle_mind': 'IdleMind',
    'ui.self_mod': 'Selbst-Modifikation',
    'ui.active': 'Aktiv',
    'ui.inactive': 'Aus',
    'ui.allowed': 'Erlaubt',
    'ui.blocked': 'Gesperrt',
    // v7.4.7
    'ui.trust_level': 'Vertrauensstufe',
    'ui.trust_supervised': 'Überwacht (immer fragen)',
    'ui.trust_assisted': 'Assistiert (bei Risiko fragen)',
    'ui.trust_autonomous': 'Autonom (nur bei Kritischem fragen)',
    'ui.trust_full': 'Volle Autonomie (nie fragen)',
    'ui.auto_resume': 'Auto-Resume offener Ziele',
    'ui.auto_resume_ask': 'Fragen (Standard)',
    'ui.auto_resume_always': 'Immer fortsetzen',
    'ui.auto_resume_never': 'Nie fortsetzen',
    'ui.mcp_serve': 'MCP-Server (Genesis bereitstellen)',
    'ui.mcp_serve_off': 'Aus',
    'ui.mcp_serve_on': 'An',
    'ui.mcp_port': 'MCP-Server Port',
    'ui.approval_timeout': 'Approval-Timeout in Sekunden',
    'ui.takes_effect_after_restart': '(wirkt nach Neustart)',
    // v7.4.7
    'ui.toggle.daemon_on':       'Daemon aktiviert.',
    'ui.toggle.daemon_off':      'Daemon deaktiviert.',
    'ui.toggle.idlemind_on':     'IdleMind aktiviert.',
    'ui.toggle.idlemind_off':    'IdleMind deaktiviert.',
    'ui.toggle.selfmod_on':      'Selbst-Modifikation erlaubt.',
    'ui.toggle.selfmod_off':     'Selbst-Modifikation blockiert.',
    'ui.toggle.trust_level':     'Vertrauensstufe: {{level}}.',
    'ui.toggle.auto_resume':     'Auto-Resume offener Ziele: {{mode}}.',
    'ui.toggle.mcp_started':     'MCP-Server gestartet auf Port {{port}}.',
    'ui.toggle.mcp_stopped':     'MCP-Server gestoppt.',
    'ui.toggle.mcp_failed':      'MCP-Server-Toggle fehlgeschlagen: {{error}}',
    'ui.open_in_editor': 'Im Editor öffnen',
    'ui.file_opened': 'Geöffnet: {{file}}',
    'ui.file_imported': 'Importiert: {{file}}',
    'ui.drop_file': 'Datei hier ablegen',
    'ui.undo_success': 'Änderung rückgängig: {{detail}}',
    'ui.undo_failed': 'Undo fehlgeschlagen: {{error}}',
    'ui.undo_nothing': 'Nichts zum Rückgängig machen',
    'ui.goals': 'Ziele',

    'welcome.first': 'Ich bin Genesis. Ich kann meinen eigenen Code verstehen, mich reparieren, neue Fähigkeiten entwickeln und verbesserte Klone von mir erstellen.\n\nSag mir deinen Namen, dann erinnere ich mich beim nächsten Mal an dich.',
    'welcome.returning': 'Hallo {{name}}!',
    'welcome.returning_anon': 'Hey! Schön, dass du wieder da bist. Was steht an?',
    'welcome.returning_familiar': 'Hey! Schön, dass du wieder da bist.',
    'welcome.working_on': 'Woran ich gerade arbeite:',
    'welcome.thoughts': 'Ich hatte bisher {{thoughts}} eigene Gedanken und kenne {{facts}} Fakten.',

    'agent.no_code_block': 'Kein Code-Block gefunden. Benutze ``` um Code einzuschließen.',
    'agent.no_file': 'Keine Datei erkannt. Nenne den Dateinamen mit Endung.',
    'agent.file_not_found': 'Datei "{{file}}" nicht gefunden.',
    'agent.cannot_execute': 'Kann {{ext}} nicht ausführen. Verfügbare Runtimes: {{runtimes}}',
    'agent.shell_unavailable': 'ShellAgent nicht verfügbar.',
    'agent.no_command': 'Kein Befehl erkannt. Schreibe z.B. `$ git status` oder "führe npm test aus".',
    'agent.blocked_command': 'Blockiert: {{reason}}',
    'agent.undo_only_one': 'Nur ein Commit vorhanden — kann nicht rückgängig gemacht werden.',
    'agent.undo_conflict': 'Revert nicht möglich — evtl. Merge-Konflikt. Manuell: `git revert --abort` dann `git reset --hard HEAD~1`.',
    'agent.undo_failed': 'Undo fehlgeschlagen: {{error}}',
    'agent.undo_done': 'Rückgängig gemacht: `{{commit}}`',
    'agent.plan_failed': 'Konnte keinen Plan erstellen.',
    'agent.plan_result': 'Ergebnis: {{ok}} erfolgreich, {{fail}} fehlgeschlagen',
    'agent.no_output': '(keine Ausgabe)',
    'agent.error': 'Fehler',
    'agent.no_test_cmd': 'Kein Test-Befehl für diesen Projekttyp erkannt.',
    'agent.no_install_cmd': 'Kein Install-Befehl für diesen Projekttyp erkannt.',

    'shell.blocked_tier': 'Befehl blockiert auf Tier "{{tier}}": {{cmd}}',
    'shell.permission_unknown': 'Unbekanntes Permission-Level: {{level}}',

    'health.title': 'Genesis — Systemstatus',
    'health.kernel': 'Kernel',
    'health.intact': 'Intakt',
    'health.problem': 'PROBLEM',
    'health.model': 'Modell',
    'health.none': 'keins',
    'health.modules': 'Module',
    'health.skills': 'Skills',
    'health.tools': 'Tools',
    'health.memory': 'Gedächtnis',
    'health.facts': 'Fakten',
    'health.episodes': 'Episoden',
    'health.daemon': 'Daemon',
    'health.cycles': 'Zyklen',
    'health.services': 'Services',
    'health.uptime': 'Uptime',
    'health.shell': 'Shell',
    'health.commands': 'Befehle',

    'project.title': 'Projekt',
    'project.type': 'Typ',
    'project.language': 'Sprache',
    'project.files': 'Dateien',
    'project.git': 'Git',
    'project.unknown': 'unbekannt',
    'project.no_git': 'kein Git',
    'project.commands': 'Verfügbare Befehle',
    'project.dependencies': 'Abhängigkeiten',
    'project.clean': 'sauber',
    'project.changes': '{{n}} Änderungen',

    'tool.file_info': 'Datei-Informationen',
    'tool.execute_file': 'Datei ausführen',
    'tool.knowledge_search': 'Wissensgraph durchsuchen',
    'tool.knowledge_connect': 'Konzepte verbinden',
    'tool.event_query': 'Vergangene Events',
    'tool.web_fetch': 'Eine URL abrufen (Dokumentation, API-Referenz, npm-Pakete)',
    'tool.npm_search': 'npm-Pakete suchen',
    'tool.web_ping': 'Prüfen ob eine URL erreichbar ist',
    'tool.shell_task': 'Plant und führt eine komplexe System-Aufgabe in mehreren Schritten aus (mit Safety-Tiers, Git-Snapshots und Rezept-Lernen)',

    // MCP
    'mcp.connecting': 'Verbinde mit MCP-Server {{name}}...',
    'mcp.connected': 'MCP-Server {{name}} verbunden ({{tools}} Tools)',
    'mcp.disconnected': 'MCP-Server {{name}} getrennt',
    'mcp.error': 'MCP-Fehler ({{name}}): {{error}}',
    'mcp.no_servers': 'Keine MCP-Server konfiguriert',
    'mcp.server_added': 'MCP-Server **{{name}}** hinzugefügt ({{url}})',
    'mcp.server_removed': 'MCP-Server **{{name}}** entfernt',
    'mcp.tools_discovered': '{{count}} Tools von {{name}} entdeckt',
    'mcp.tool_call_failed': 'MCP-Tool-Aufruf fehlgeschlagen: {{error}}',
    'mcp.status_title': 'MCP-Status',
    'mcp.servers': 'Server',
    'mcp.total_tools': 'Tools gesamt',

    'inspect.title': 'Genesis — Selbstbericht',
    'inspect.identity': 'Identität',
    'inspect.modules': 'Module',
    'inspect.files': 'Dateien',
    'inspect.kernel': 'Kernel',
    'inspect.kernel_intact': 'Intakt',
    'inspect.kernel_compromised': 'KOMPROMITTIERT',
    'inspect.capabilities': 'Fähigkeiten',
    'inspect.skills': 'Skills',
    'inspect.none': 'keine',
    'inspect.tools': 'Tools',
    'inspect.tools_registered': 'registriert',
    'inspect.model': 'Modell',
    'inspect.modules_header': 'Module',
    'inspect.protected': 'geschützt',

    'chat.error': 'Fehler: {{message}}',
    'chat.tools_executing': 'Tools ausführen...',
    'chat.no_revertable_commit': 'Kein revertierbarer Commit vorhanden',

    // Shell
    'shell.plan_error': 'Planungsfehler: {{message}}',
    'shell.step_skipped': 'Vorheriger Schritt fehlgeschlagen',

    // Goals
    'goal.no_code': 'Kein Code generiert',
    'goal.file_requested': 'Datei-Erstellung angefordert: {{detail}}',
    'goals.unavailable': 'GoalStack nicht verfügbar.',
    'goals.created': 'Neues Ziel erstellt: **{{description}}**',
    'goals.steps': 'Schritte',
    'goals.empty': 'Noch keine Ziele gesetzt. Sage z.B. "/goal add Bessere Fehlerbehandlung einbauen"',
    'goals.title': 'Ziele',
    'goals.next_step': 'Nächster Schritt',
    // v7.5.0 — slash-discipline + negotiation
    'goals.add_empty': 'Leere Ziel-Beschreibung. Versuche: /goal add <beschreibung>',
    'goals.add_failed': 'Ziel konnte nicht erstellt werden.',
    'goals.cancel_needs_number': 'Welches Ziel? Versuche: /goal cancel <n>  (mit /goal list siehst du die Nummern)',
    'goals.cancel_one_done': '**Ziel abgebrochen:** {{description}}',
    'goals.cancel_one_not_found': '**Ziel #{{idx}} nicht gefunden.** {{count}} aktive Ziele.',
    'goals.cancel_all_confirm': 'Bestätigen: alle {{count}} aktiven Ziele abbrechen? Schicke `/goal clear` nochmal innerhalb von 30 Sekunden zur Bestätigung.',
    'goals.cancel_all_done': '**{{count}} Ziel(e) abgebrochen.**',
    'goals.none_active': '**Keine aktiven Ziele.**',
    'goals.unknown_subcommand': 'Unbekannter Subcommand: `{{sub}}`. Versuche `/goal list`, `/goal add <text>`, `/goal cancel <n>`, `/goal clear`.',
    'goals.help': '**Ziel-Befehle:**\n- `/goal list` — Ziele anzeigen\n- `/goal add <text>` — Ziel hinzufügen\n- `/goal cancel <n>` — Ziel #n abbrechen\n- `/goal clear` — alle abbrechen (fragt nach Bestätigung)\n- `/goal confirm <id>` — vorgeschlagenes Ziel bestätigen\n- `/goal revise <id>: <text>` — Vorschlag überarbeiten\n- `/goal dismiss <id>` — Vorschlag verwerfen',
    'goals.proposed': 'Ziel vorgeschlagen: **"{{description}}"**. Genesis prüft es bevor es aktiv wird.\n\nNutze `/goal confirm {{pendingId}}` zum Annehmen, `/goal revise {{pendingId}}: <neuer text>` zum Überarbeiten, oder `/goal dismiss {{pendingId}}` zum Verwerfen.',
    'goals.confirmed': 'Ziel bestätigt und angelegt: **{{description}}**',
    'goals.revised': 'Vorschlag überarbeitet: **"{{description}}"** (`{{pendingId}}`). Genesis prüft erneut.',
    'goals.dismissed': 'Vorschlag verworfen: {{description}}',
    'goals.pending_id_missing': 'Pending-ID fehlt. Nutze `/goal list` um die Pending-IDs zu sehen.',
    'goals.pending_not_found': 'Vorschlag `{{pendingId}}` nicht gefunden (kann nach 1 Stunde abgelaufen sein).',
    'goals.pending_title': 'Pending (warten auf Bestätigung)',
    'goals.confirm_failed': 'Konnte nicht bestätigen: {{error}}',
    'goals.revise_format': 'Format: `/goal revise <id>: <neue beschreibung>`',
    'goals.negotiation_unavailable': 'Ziel-Verhandlung ist in diesem Build nicht verfügbar.',

    // Peers
    'peer.none_found': 'Keine Peers gefunden.',
    'peer.none_hint': 'Keine Peers. Sage "peer scan" zum Suchen.',
    'peer.found': 'gefunden',

    // Daemon
    'daemon.stopped': 'Daemon gestoppt.',
    'daemon.started': 'Daemon gestartet.',

    // Journal & Plans
    'journal.empty': 'Noch keine Gedanken im Journal.',
    'journal.last': 'letzte {{n}}',
    'plans.empty': 'Noch keine Verbesserungspläne. Ich denke darüber nach wenn ich nicht beschäftigt bin.',
    'plans.title': 'Verbesserungspläne',

    // Settings
    'settings.unavailable': 'Einstellungen nicht verfügbar.',
    'settings.api_key_saved': 'Anthropic API-Key gespeichert ({{key}}...). Neustart für Aktivierung nötig.',
    'settings.not_configured': 'nicht konfiguriert',
    'settings.preferred_model': 'Bevorzugtes Modell',
    'settings.every_n_min': 'alle {{n}} Min',
    'settings.idle_after_min': 'idle nach {{n}} Min',
    'settings.api_key_hint': 'Sage z.B. "Anthropic API-Key: sk-ant-..." um einen Key zu setzen.',

    // Web
    'web.unavailable': 'Web-Zugriff nicht verfügbar.',
    'web.npm_failed': 'npm-Suche fehlgeschlagen: {{error}}',
    'web.npm_no_results': 'Keine Pakete gefunden für: {{query}}',
    'web.fetch_failed': 'Konnte {{url}} nicht abrufen: {{error}}',
    'web.reachable': '**{{url}}** ist erreichbar (Status {{status}})',
    'web.unreachable': '**{{url}}** ist nicht erreichbar: {{error}}',
    'web.hint': 'Gib eine URL an, oder sage z.B. "npm search express" oder "prüfe ob nodejs.org erreichbar ist".',

    // MCP extended
    'mcp.unavailable': 'MCP nicht verfügbar.',
    'mcp.server_not_found': 'Server "{{name}}" nicht gefunden.',
    'mcp.server_started': 'Genesis MCP-Server gestartet auf **Port {{port}}**.\nAndere Agents: `http://127.0.0.1:{{port}}`',
    'mcp.server_start_failed': 'MCP-Server Start fehlgeschlagen: {{error}}',
    'mcp.no_tools_found': 'Keine MCP-Tools gefunden für "{{query}}".',
    'mcp.connect_hint': 'Sage z.B.: `mcp connect github https://mcp.github.com/sse`',

    'selfmod.applied': 'Modifikation angewendet.',
    'selfmod.files': 'Dateien',
    'selfmod.all_intact': 'Alle Systeme intakt.',
    'selfmod.tests_failed': 'Tests fehlgeschlagen:',
    'selfmod.astdiff_applied': 'Präzise Modifikation (ASTDiff) angewendet:',
    'selfmod.warnings': 'Warnungen',
    'selfmod.repair': 'Reparatur',
    'selfmod.greeting': 'Hey! Was kann ich fuer dich tun?',
  },

  fr: {
    'ui.booting': 'Démarrage...',
    'ui.ready': 'Prêt',
    'ui.error': 'Erreur',
    'ui.placeholder': 'Message à Genesis...',
    'ui.settings': 'Paramètres',
    'ui.undo': 'Annuler',
    'ui.still_starting': 'Genesis démarre encore...',
    'ui.settings_saved': 'Paramètres enregistrés',
    'ui.cancel': 'Annuler',

    'welcome.first': "Je suis Genesis. Je peux comprendre mon propre code source, me réparer, développer de nouvelles capacités et créer des clones améliorés.\n\nDis-moi ton nom et je m'en souviendrai la prochaine fois.",
    'welcome.returning': 'Bonjour {{name}} !',
    'welcome.returning_anon': 'Salut ! Content de te revoir. Quoi de neuf ?',
    'welcome.returning_familiar': 'Salut ! Content de te revoir.',

    'agent.error': 'Erreur',
    'agent.no_output': '(aucune sortie)',

    'inspect.title': 'Genesis — Auto-rapport',
    'inspect.kernel_intact': 'Intact',
    'inspect.kernel_compromised': 'COMPROMIS',
    'chat.error': 'Erreur: {{message}}',
    'chat.tools_executing': 'Exécution des outils...',
    'chat.no_revertable_commit': 'Aucun commit réversible disponible',
  },

  es: {
    'ui.booting': 'Iniciando...',
    'ui.ready': 'Listo',
    'ui.error': 'Error',
    'ui.placeholder': 'Mensaje a Genesis...',
    'ui.settings': 'Configuración',
    'ui.undo': 'Deshacer',
    'ui.still_starting': 'Genesis aún está iniciando...',
    'ui.settings_saved': 'Configuración guardada',
    'ui.cancel': 'Cancelar',

    'welcome.first': 'Soy Genesis. Puedo entender mi propio código fuente, repararme, desarrollar nuevas capacidades y crear clones mejorados.\n\nDime tu nombre y te recordaré la próxima vez.',
    'welcome.returning': '¡Hola {{name}}!',
    'welcome.returning_anon': '¡Hola! Me alegra verte de nuevo. ¿Qué hay?',
    'welcome.returning_familiar': '¡Hola! Me alegra verte de nuevo.',

    'agent.error': 'Error',
    'agent.no_output': '(sin salida)',

    'inspect.title': 'Genesis — Autoinforme',
    'inspect.kernel_intact': 'Intacto',
    'inspect.kernel_compromised': 'COMPROMETIDO',
    'chat.error': 'Error: {{message}}',
    'chat.tools_executing': 'Ejecutando herramientas...',
    'chat.no_revertable_commit': 'No hay commit reversible disponible',
  },
};

// Singleton
const lang = new Language();

module.exports = { Language, lang, STRINGS };
