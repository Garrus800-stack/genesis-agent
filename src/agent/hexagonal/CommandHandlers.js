// @ts-checked-v5.7
// ============================================================
// GENESIS — CommandHandlers.js
// Lightweight handlers for operational intents.
// Each method handles one intent type.
// Registers all handlers with a ChatOrchestrator in one call.
// ============================================================

const { TIMEOUTS } = require('../core/Constants');
class CommandHandlers {
  constructor({ bus, lang, sandbox, fileProcessor, network, daemon, idleMind, analyzer, goalStack, settings, webFetcher, shellAgent, mcpClient}) {
    this.bus = bus || null;
    this.lang = lang || { t: (k) => k, detect: () => {}, current: 'en' };
    this.sandbox = sandbox;
    this.fp = fileProcessor;
    this.network = network;
    this.daemon = daemon;
    this.idleMind = idleMind;
    this.analyzer = analyzer;
    this.goalStack = goalStack;
    this.settings = settings;
    this.web = webFetcher;
    this.shell = shellAgent;
    this.mcp = mcpClient;
    /** @type {*} */ this.skillManager = null; // late-bound v5.9.1
  }

  /** Register all handlers with the orchestrator */
  registerHandlers(orchestrator) {
    orchestrator.registerHandler('execute-code', (msg) => this.executeCode(msg));
    orchestrator.registerHandler('execute-file', (msg) => this.executeFile(msg));
    orchestrator.registerHandler('analyze-code', (msg) => this.analyzeCode(msg));
    orchestrator.registerHandler('peer', (msg) => this.peer(msg));
    orchestrator.registerHandler('daemon', (msg) => this.daemonControl(msg));
    orchestrator.registerHandler('journal', () => this.journal());
    orchestrator.registerHandler('plans', () => this.plans());
    orchestrator.registerHandler('goals', (msg) => this.goals(msg));
    orchestrator.registerHandler('settings', (msg) => this.handleSettings(msg));
    orchestrator.registerHandler('web-lookup', (msg) => this.webLookup(msg));
    orchestrator.registerHandler('undo', () => this.undo());
    orchestrator.registerHandler('shell-task', (msg) => this.shellTask(msg));
    orchestrator.registerHandler('shell-run', (msg) => this.shellRun(msg));
    orchestrator.registerHandler('project-scan', (msg) => this.projectScan(msg));
    orchestrator.registerHandler('mcp', (msg) => this.mcpControl(msg));
    // v5.9.1: Run installed skill
    orchestrator.registerHandler('run-skill', (msg) => this.runSkill(msg));
    // v6.0.2: Trust level control via chat
    orchestrator.registerHandler('trust-control', (msg) => this.trustControl(msg));
    // v6.0.2: Open folder/file in OS file explorer
    orchestrator.registerHandler('open-path', (msg) => this.openPath(msg));
  }

  // ── Code Execution ───────────────────────────────────────

  async executeCode(message) {
    const m = message.match(/```(?:\w+)?\n([\s\S]+?)```/);
    if (!m) return this.lang.t('agent.no_code_block');
    const r = await this.sandbox.execute(m[1]);
    return `\`\`\`\n${r.output || this.lang.t('agent.no_output')}\n\`\`\`${r.error ? `\n**${this.lang.t('agent.error')}:** ${r.error}` : ''}`;
  }

  // ── File Execution ───────────────────────────────────────

  async executeFile(message) {
    const fileMatch = message.match(/(\S+\.\w{2,4})\b/);
    if (!fileMatch) return this.lang.t('agent.no_file');

    const info = this.fp.getFileInfo(fileMatch[1]);
    if (!info) return this.lang.t('agent.file_not_found', { file: fileMatch[1] });
    if (!info.canExecute) {
      const runtimes = Object.entries(this.fp.getRuntimes()).filter(([_, v]) => v).map(([k]) => k).join(', ');
      return this.lang.t('agent.cannot_execute', { ext: info.extension, runtimes });
    }

    const result = await this.fp.executeFile(fileMatch[1]);
    return `**${info.name}** (${info.language}):\n\`\`\`\n${result.output || this.lang.t('agent.no_output')}\n\`\`\`${result.error ? `\n**${this.lang.t('agent.error')}:** ${result.error}` : ''}`;
  }

  // ── Code Analysis ────────────────────────────────────────

  async analyzeCode(message) {
    return this.analyzer.analyze(message);
  }

  // ── Peer Network ─────────────────────────────────────────

  async peer(message) {
    // Scan for peers
    if (/scan|such|discover|entdeck/i.test(message)) {
      const peers = await this.network.scanLocalPeers();
      if (peers.length === 0) return this.lang.t('peer.none_found');
      const lines = [`**${peers.length} Peer(s) ${this.lang.t('peer.found')}:**`, ''];
      for (const p of peers) {
        lines.push(`- **${p.id}** v${p.version} (Protocol v${p.protocol || '?'})`);
        if (p.skills?.length > 0) lines.push(`  Skills: ${p.skills.join(', ')}`);
        if (p.capabilities?.length > 0) lines.push(`  Capabilities: ${p.capabilities.slice(0, 5).join(', ')}`);
      }
      return lines.join('\n');
    }

    // Trust a peer: "peer trust <peerId>" or "peer vertrauen <peerId>"
    const trustMatch = message.match(/(?:trust|vertrau)\s+(\S+)/i);
    if (trustMatch) {
      const peerId = trustMatch[1];
      const peer = this.network.peers.get(peerId);
      if (!peer) return `**${this.lang.t('agent.error')}:** Peer "${peerId}" not found. Run peer scan first.`;
      // Use own token for mutual trust (in production, exchange tokens via secure channel)
      const token = this.network._token;
      const ok = this.network.trustPeer(peerId, token);
      if (ok) return `**${peerId}** is now trusted. Skill import and code exchange enabled.`;
      return `**${this.lang.t('agent.error')}:** Could not trust "${peerId}".`;
    }

    // Import skill from peer: "peer import <peerId> <skillName>"
    const importMatch = message.match(/(?:import|importiere?|hole?)\s+(?:skill\s+)?(\S+)\s+(?:von|from)\s+(\S+)/i) ||
                         message.match(/(?:import|importiere?)\s+(\S+)\s+(\S+)/i);
    if (importMatch) {
      const skillName = importMatch[1];
      const peerId = importMatch[2];
      try {
        const result = await this.network.importPeerSkill(peerId, skillName);
        if (result.success) return `**Skill "${skillName}"** imported from **${peerId}**.\n${result.reason}`;
        return `**Import failed:** ${result.reason}`;
      } catch (err) {
        return `**${this.lang.t('agent.error')}:** ${err.message}`;
      }
    }

    // Compare module with peer: "peer compare <peerId> <module>"
    const compareMatch = message.match(/(?:compare|vergleich)\s+(\S+)\s+(?:mit|with)\s+(\S+)/i) ||
                          message.match(/(?:compare|vergleich)\s+(\S+)\s+(\S+)/i);
    if (compareMatch) {
      const moduleName = compareMatch[1];
      const peerId = compareMatch[2];
      try {
        const result = await this.network.compareWithPeer(peerId, moduleName);
        const lines = [
          `**Code-Vergleich: ${moduleName}**`,
          `**Verdict:** ${result.decision}`,
          '',
          result.analysis?.slice(0, 1000) || '',
        ];
        return lines.join('\n');
      } catch (err) {
        return `**${this.lang.t('agent.error')}:** ${err.message}`;
      }
    }

    // Skills from a specific peer: "peer skills <peerId>"
    const skillsMatch = message.match(/(?:skills?|faehigkeit)\s+(?:von|from|of)\s+(\S+)/i);
    if (skillsMatch) {
      const peerId = skillsMatch[1];
      const peer = this.network.peers.get(peerId);
      if (!peer) return `Peer "${peerId}" not found.`;
      if (peer.skills?.length > 0) {
        return `**Skills von ${peerId}:**\n${peer.skills.map(s => `- ${s}`).join('\n')}`;
      }
      return `Peer "${peerId}" has no skills.`;
    }

    // Default: show full status with health
    const status = this.network.getPeerStatus();
    if (status.length === 0) return this.lang.t('peer.none_hint');

    const stats = this.network.getNetworkStats();
    const lines = [
      `**Genesis Peer Network** (Protocol v${stats.protocol})`,
      `Listening: port ${stats.listening} | Peers: ${stats.totalPeers} (${stats.healthyPeers} healthy, ${stats.trustedPeers} trusted)`,
      '',
    ];
    for (const p of status) {
      const icon = p.health.isHealthy ? (p.trusted ? '[OK+T]' : '[OK]') : '[!!]';
      lines.push(`${icon} **${p.id}** (${p.host}:${p.port})`);
      lines.push(`    Protocol: v${p.protocol} | Latency: ${p.health.avgLatency}ms | Score: ${p.health.score}`);
      if (p.skills?.length > 0) lines.push(`    Skills: ${p.skills.join(', ')}`);
    }
    lines.push('');
    lines.push('**Commands:** peer scan | peer trust <id> | peer import <skill> from <id> | peer compare <module> <id>');
    return lines.join('\n');
  }

  // ── Daemon Control ───────────────────────────────────────

  async daemonControl(message) {
    if (/stop/i.test(message)) { this.daemon.stop(); return this.lang.t('daemon.stopped'); }
    if (/start/i.test(message)) { this.daemon.start(); return this.lang.t('daemon.started'); }
    const st = this.daemon.getStatus();
    return `**Daemon:** ${st.running ? this.lang.t('ui.active') : this.lang.t('ui.inactive')} | ${this.lang.t('health.cycles')}: ${st.cycleCount} | Gaps: ${st.knownGaps.length}`;
  }

  // ── Journal ──────────────────────────────────────────────

  async journal() {
    const entries = this.idleMind.readJournal(10);
    if (entries.length === 0) return this.lang.t('journal.empty');
    return `**Genesis Journal** (${this.lang.t('journal.last', { n: entries.length })}):\n\n${entries.map(e =>
      `**[${e.timestamp?.split('T')[0]} ${e.activity}]**\n${e.thought}`
    ).join('\n\n')}`;
  }

  // ── Plans ────────────────────────────────────────────────

  async plans() {
    const plans = this.idleMind.getPlans();
    if (plans.length === 0) return this.lang.t('plans.empty');
    return `**${this.lang.t('plans.title')}** (${plans.length}):\n\n${plans.slice(-5).map(p =>
      `**${p.title}** [${p.priority}] -- ${p.status}\n${p.description?.slice(0, 200) || ''}`
    ).join('\n\n')}`;
  }

  // ── Goals ────────────────────────────────────────────────

  async goals(message) {
    if (!this.goalStack) return this.lang.t('goals.unavailable');

    // ── Cancel / Abandon goals ────────────────────────────
    // "cancel all goals" / "lösche alle ziele" / "abandon all" / "clear goals"
    const cancelAllMatch = message.match(/(?:cancel|abandon|clear|lösch|entfern|reset).*(?:all|alle).*(?:goal|ziel)/i) ||
                           message.match(/(?:lösch|entfern|clear|reset).*(?:goal|ziel)/i) ||
                           message.match(/(?:goal|ziel).*(?:lösch|entfern|clear|cancel|reset|abandon)/i);
    if (cancelAllMatch) {
      const active = this.goalStack.getActiveGoals();
      if (active.length === 0) return '**Keine aktiven Ziele vorhanden.**';
      let count = 0;
      for (const g of active) {
        this.goalStack.abandonGoal(g.id);
        this.bus.emit('goal:abandoned', { id: g.id, description: g.description }, { source: 'CommandHandlers' });
        count++;
      }
      return `**${count} Ziel(e) abgebrochen.**`;
    }

    // "cancel goal 1" / "lösche ziel 2" / "stopp ziel 3"
    const cancelOneMatch = message.match(/(?:cancel|abandon|lösch|entfern|stopp).*(?:goal|ziel)\s*#?(\d+)/i);
    if (cancelOneMatch) {
      const idx = parseInt(cancelOneMatch[1], 10) - 1;
      const active = this.goalStack.getActiveGoals();
      if (idx < 0 || idx >= active.length) return `**Ziel #${idx + 1} nicht gefunden.** Aktive Ziele: ${active.length}`;
      const target = active[idx];
      this.goalStack.abandonGoal(target.id);
      this.bus.emit('goal:abandoned', { id: target.id, description: target.description }, { source: 'CommandHandlers' });
      return `**Ziel abgebrochen:** ${target.description}`;
    }

    // ── Add a goal ────────────────────────────────────────
    const addMatch = message.match(/ziel.*(?:setze|erstelle|hinzufuegen|add).*?:\s*(.+)/i) ||
                     message.match(/(?:setze|erstelle|add).*ziel.*?:\s*(.+)/i) ||
                     message.match(/(?:set|create|add).*goal.*?:\s*(.+)/i);
    if (addMatch) {
      const goal = await this.goalStack.addGoal(addMatch[1].trim(), 'user', 'high');
      return this.lang.t('goals.created', { description: goal.description }) +
        `\n\n**${this.lang.t('goals.steps')}:**\n${goal.steps.map((s, i) =>
        `${i + 1}. [${s.type}] ${s.action}`
      ).join('\n')}`;
    }

    // Show active goals
    const active = this.goalStack.getActiveGoals();
    const all = this.goalStack.getAll();

    if (all.length === 0) return this.lang.t('goals.empty');

    const lines = [`**Genesis — ${this.lang.t('goals.title')}**`, ''];
    for (const g of all.slice(-8)) {
      const icon = g.status === 'completed' ? '[OK]' : g.status === 'active' ? '[>>]' : g.status === 'failed' ? '[!!]' : '[--]';
      const progress = g.steps.length > 0 ? ` (${g.currentStep}/${g.steps.length})` : '';
      lines.push(`${icon} **${g.description}**${progress} [${g.priority}]`);
      if (g.status === 'active' && g.steps[g.currentStep]) {
        lines.push(`    ${this.lang.t('goals.next_step')}: ${g.steps[g.currentStep].action}`);
      }
    }
    return lines.join('\n');
  }

  // ── Settings ─────────────────────────────────────────────

  handleSettings(message) {
    if (!this.settings) return this.lang.t('settings.unavailable');

    // Set API key
    const apiMatch = message.match(/(?:anthropic|api).?key.*?[:=]\s*(\S+)/i);
    if (apiMatch) {
      this.settings.set('models.anthropicApiKey', apiMatch[1]);
      return this.lang.t('settings.api_key_saved', { key: apiMatch[1].slice(0, 8) });
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
  }

  // ── Web Lookup ───────────────────────────────────────────

  async webLookup(message) {
    if (!this.web) return this.lang.t('web.unavailable');

    // npm search
    const npmMatch = message.match(/npm.*(?:such|search|paket|package).*?(?:fuer|for)?\s+(\w[\w\s-]*)/i);
    if (npmMatch) {
      const result = await this.web.npmSearch(npmMatch[1].trim());
      if (result.error) return this.lang.t('web.npm_failed', { error: result.error });
      if (result.packages.length === 0) return this.lang.t('web.npm_no_results', { query: npmMatch[1] });
      return `**npm:**\n\n` + result.packages.map(p =>
        `**${p.name}** v${p.version}\n${p.description}`
      ).join('\n\n');
    }

    // URL fetch
    const urlMatch = message.match(/(https?:\/\/\S+)/);
    if (urlMatch) {
      const result = await this.web.fetchText(urlMatch[1]);
      if (!result.ok) return this.lang.t('web.fetch_failed', { url: urlMatch[1], error: result.error });
      return `**${urlMatch[1]}** (${result.status}):\n\n${result.body.slice(0, 3000)}`;
    }

    // Ping check — v7.2.8: supports both word orders ("ping X" and "X erreichbar")
    const pingMatch = message.match(/(?:erreichbar|reachable|online|ping).*?(https?:\/\/\S+|\S+\.\w{2,})/i)
      || message.match(/(\S+\.\w{2,})\s+(?:erreichbar|reachable|online|up|running)/i);
    if (pingMatch) {
      const url = pingMatch[1].startsWith('http') ? pingMatch[1] : 'https://' + pingMatch[1];
      const result = await this.web.ping(url);
      return result.reachable
        ? this.lang.t('web.reachable', { url, status: result.status })
        : this.lang.t('web.unreachable', { url, error: result.error });
    }

    // v7.2.8: Domain without protocol (e.g. "nodejs.org", "docs.python.org")
    const domainMatch = message.match(
      /\b((?:[a-zA-Z0-9][\w-]*\.)+(?:com|org|net|io|dev|de|ch|at|eu|co|uk|info|app|ai|fr|nl|se|ru))\b/i
    );
    if (domainMatch) {
      const url = 'https://' + domainMatch[1];
      const result = await this.web.fetchText(url);
      if (!result.ok) return this.lang.t('web.fetch_failed', { url, error: result.error });
      return `**${url}** (${result.status}):\n\n${result.body.slice(0, 3000)}`;
    }

    return this.lang.t('web.hint');
  }

  // ── Run Skill (v5.9.1) ──────────────────────────────────

  async runSkill(message) {
    if (!this.skillManager) return 'No SkillManager available — skills are not loaded.';

    // Extract skill name from message
    const nameMatch = message.match(/([\w-]+-skill)\b/i) ||
                      message.match(/(?:run|execute|use|start|starte?|nutze?|verwende?)\s+(?:the\s+|skill\s+|(?:de[nr]|dein(?:en?)?|mein(?:en?)?)\s+)?["']?([\w-]+)["']?/i);
    const skillName = nameMatch ? (nameMatch[1] || nameMatch[2]) : null;

    if (!skillName || skillName === 'skill' || skillName === 'skills' || /^(dein|mein|den|der|die|das|the|my)$/i.test(skillName)) {
      // List available skills
      const all = this.skillManager.listSkills();
      if (all.length === 0) return 'No skills installed. Use "create a skill..." to build one.';
      return `Available skills:\n${all.map(s => `  • ${s.name}: ${s.description || '(no description)'}`).join('\n')}\n\nUsage: "run <skill-name>"`;
    }

    try {
      const result = await this.skillManager.executeSkill(skillName, {});
      if (result.error) return `⚠️ Skill "${skillName}" error: ${result.error}`;
      const output = result.output || result.result || result;
      return `✅ Skill "${skillName}" result:\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``;
    } catch (err) {
      // v5.9.1: If skill not found but shell is available, try as shell command
      if (err.message?.includes('not found') && this.shell) {
        return this.shellRun(message);
      }
      return `❌ Skill "${skillName}" failed: ${err.message}`;
    }
  }

  // ── Shell Task (multi-step planned execution) ────────────

  async shellTask(message) {
    if (!this.shell) return this.lang.t('agent.shell_unavailable');

    const task = message
      .replace(/^(?:bitte\s+)?(?:richte|setup|einrichten|installiere|baue|build|deploy|teste|please\s+)?/i, '')
      .replace(/^(?:fuehr|starte?|run|set\s+up|install)\s*/i, '')
      .trim() || message;

    const dirMatch = message.match(/(?:in|im|fuer|for)\s+(?:verzeichnis|ordner|dir|directory)?\s*['"]?([^\s'"]+)['"]?/i);
    const cwd = dirMatch ? dirMatch[1] : undefined;

    const result = await this.shell.plan(task, cwd);
    return result.summary;
  }

  // ── Shell Run (single command) ──────────────────────────

  async shellRun(message) {
    if (!this.shell) return this.lang.t('agent.shell_unavailable');

    let cmd = message.replace(/^[$>]\s*/, '')
      .replace(/^(?:fuehr|execute|run)\s+(?:den\s+)?(?:befehl|kommando|command)\s*/i, '')
      .replace(/\s*aus\s*$/i, '').trim();

    if (!cmd) return this.lang.t('agent.no_command');

    const result = await this.shell.run(cmd);
    // FIX v6.1.1: Emit outcome for learning systems (LessonsStore, SymbolicResolver)
    if (this.bus) {
      this.bus.emit('shell:outcome', {
        command: cmd, success: result.ok && !result.blocked,
        error: result.blocked ? 'blocked' : result.stderr?.slice(0, 200) || null,
        platform: process.platform,
      }, { source: 'CommandHandlers' });
    }
    const lines = [`**$ ${cmd}**`, ''];
    if (result.blocked) {
      lines.push(`**${this.lang.t('agent.blocked_command', { reason: result.stderr })}**`);
    } else if (result.ok) {
      lines.push(result.stdout.trim() ? '```\n' + result.stdout.trim().slice(0, 3000) + '\n```' : `*${this.lang.t('agent.no_output')}*`);
      lines.push(`\n*${result.duration}ms*`);
    } else {
      if (result.stdout.trim()) lines.push('```\n' + result.stdout.trim().slice(0, 1500) + '\n```');
      lines.push(`**${this.lang.t('agent.error')} (exit ${result.exitCode}):**`);
      lines.push('```\n' + result.stderr.slice(0, 1500) + '\n```');
    }
    return lines.join('\n');
  }

  // ── Project Scan ────────────────────────────────────────

  async projectScan(message) {
    if (!this.shell) return this.lang.t('agent.shell_unavailable');

    const dirMatch = message.match(/(?:verzeichnis|ordner|dir|pfad|path|directory)\s*['":]?\s*([^\s'"]+)/i);
    const dir = dirMatch ? dirMatch[1] : undefined;

    const result = await this.shell.openWorkspace(dir || this.fp?.rootDir || process.cwd());
    return result.description;
  }

  // ── MCP Control ──────────────────────────────────────────

  async mcpControl(message) {
    if (!this.mcp) return this.lang.t('mcp.unavailable');

    // Add server: "mcp connect github https://mcp.github.com/sse"
    const addMatch = message.match(/(?:mcp|server).*(?:connect|verbind|add|hinzufuegen)\s+(\S+)\s+(https?:\/\/\S+)/i);
    if (addMatch) {
      try {
        const result = await this.mcp.addServer({ name: addMatch[1], url: addMatch[2] });
        return this.lang.t('mcp.server_added', { name: addMatch[1], url: addMatch[2] }) +
          `\n**Status:** ${result.status} | **Tools:** ${result.toolCount}`;
      } catch (err) {
        return this.lang.t('mcp.error', { name: addMatch[1], error: err.message });
      }
    }

    // Remove server: "mcp disconnect github"
    const removeMatch = message.match(/(?:mcp|server).*(?:disconnect|trenn|remove|entfern)\s+(\S+)/i);
    if (removeMatch) {
      const ok = await this.mcp.removeServer(removeMatch[1]);
      return ok ? this.lang.t('mcp.server_removed', { name: removeMatch[1] }) : this.lang.t('mcp.server_not_found', { name: removeMatch[1] });
    }

    // Reconnect: "mcp reconnect github"
    const reconMatch = message.match(/(?:mcp|server).*(?:reconnect|neu.*verbind)\s+(\S+)/i);
    if (reconMatch) {
      try {
        const result = await this.mcp.reconnect(reconMatch[1]);
        return `**${reconMatch[1]}** reconnected. Status: ${result.status}, Tools: ${result.toolCount}`;
      } catch (err) {
        return this.lang.t('mcp.error', { name: reconMatch[1], error: err.message });
      }
    }

    // Serve Genesis: "mcp serve" / "genesis als server starten"
    if (/(?:serve|server\s*starten|bereitstellen|anbieten)/i.test(message)) {
      try {
        const port = await this.mcp.startServer();
        return this.lang.t('mcp.server_started', { port });
      } catch (err) {
        return this.lang.t('mcp.server_start_failed', { error: err.message });
      }
    }

    // Search tools: "mcp tools filesystem"
    const searchMatch = message.match(/(?:mcp|server).*(?:tools?|werkzeug).*?(?:such|search|fuer|for)?\s+(.+)/i);
    if (searchMatch && !searchMatch[1].match(/^(?:status|connect|disconnect|serve)/i)) {
      const results = this.mcp.findRelevantTools(searchMatch[1].trim(), 8);
      if (results.length === 0) {
        // Fallback to meta-tool search
        const allTools = this.mcp._allTools();
        const query = searchMatch[1].toLowerCase();
        const filtered = allTools.filter(t =>
          t.name.toLowerCase().includes(query) || (t.description || '').toLowerCase().includes(query)
        );
        if (filtered.length === 0) return this.lang.t('mcp.no_tools_found', { query: searchMatch[1] });
        return `**MCP-Tools** (${filtered.length}):\n\n` +
          filtered.slice(0, 10).map(t => `- **${t.server}:${t.name}** — ${t.description}`).join('\n');
      }
      return `**MCP-Tools** (${results.length} relevant):\n\n` +
        results.map(t => `- **${t.server}:${t.name}** — ${t.description}`).join('\n');
    }

    // Status (default)
    const status = this.mcp.getStatus();
    if (status.serverCount === 0) return this.lang.t('mcp.no_servers') + '\n\n' + this.lang.t('mcp.connect_hint');

    const lines = [
      `**${this.lang.t('mcp.status_title')}**`, '',
      `**${this.lang.t('mcp.servers')}:** ${status.connectedCount}/${status.serverCount}`,
      `**${this.lang.t('mcp.total_tools')}:** ${status.totalTools}`,
      `**Meta-Tools:** ${status.metaTools.join(', ')}`,
      `**Recipes:** ${status.recipes} | **Skill candidates:** ${status.skillCandidates}`,
      status.serving ? `**Genesis-Server:** Port ${status.serving}` : '',
      '',
    ];

    for (const s of status.servers) {
      const icon = s.status === 'ready' ? '[OK]' : s.status === 'error' ? '[!!]' : '[--]';
      lines.push(`${icon} **${s.name}** (${s.url})`);
      lines.push(`    ${s.toolCount} Tools | ${s.transport} | ${s.status}${s.error ? ' — ' + s.error : ''}`);
    }

    return lines.filter(Boolean).join('\n');
  }

  // ── Undo (Git Revert) ──────────────────────────────────

  async undo() {
    try {
      // FIX v4.0.1: async execFile — no longer blocks the main thread.
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const cwd = this.fp?.rootDir || process.cwd();
      const opts = { cwd, encoding: 'utf-8', timeout: TIMEOUTS.GIT_OP, windowsHide: true };

      const { stdout: log } = await execFileAsync('git', ['log', '--oneline', '-5'], opts);
      if (!log.trim()) return this.lang.t('agent.undo_failed', { error: 'No git repository' });

      const lines = log.trim().split('\n');
      const lastCommit = lines[0];

      if (lines.length <= 1) return this.lang.t('agent.undo_only_one');

      await execFileAsync('git', ['revert', '--no-edit', 'HEAD'], { ...opts, timeout: TIMEOUTS.COMMAND_EXEC });

      return `**${this.lang.t('agent.undo_done', { commit: lastCommit })}**\n\n\`\`\`\n${lines.slice(0, 4).join('\n')}\n\`\`\``;
    } catch (err) {
      const msg = err.stderr || err.message || '';
      if (msg.includes('nothing to commit') || msg.includes('MERGE_HEAD')) {
        return this.lang.t('agent.undo_conflict');
      }
      return `**${this.lang.t('agent.undo_failed', { error: msg })}**`;
    }
  }

  // ── Open Path (v6.0.2) ───────────────────────────────────

  async openPath(message) {
    if (!this.shell) return this.lang.t('agent.shell_unavailable');

    // FIX v6.1.1: Resolve semantic folder names (Desktop, Downloads, etc.)
    const os = require('os');
    const path = require('path');
    const home = os.homedir();
    const folderAliases = {
      'desktop': path.join(home, 'Desktop'),
      'schreibtisch': path.join(home, 'Desktop'),
      'downloads': path.join(home, 'Downloads'),
      'dokumente': path.join(home, 'Documents'),
      'documents': path.join(home, 'Documents'),
      'bilder': path.join(home, 'Pictures'),
      'pictures': path.join(home, 'Pictures'),
      'musik': path.join(home, 'Music'),
      'music': path.join(home, 'Music'),
      'home': home,
    };

    // Check for semantic folder reference first
    const lower = message.toLowerCase();
    let targetPath = null;
    for (const [alias, resolved] of Object.entries(folderAliases)) {
      if (lower.includes(alias)) {
        // Check if there's a subfolder/file mentioned after the alias
        const afterAlias = message.slice(lower.indexOf(alias) + alias.length).trim();
        const subMatch = afterAlias.match(/(?:ordner|folder|datei|file)?\s*[\"']?([^\s\"']+)[\"']?/i);
        targetPath = subMatch && subMatch[1] ? path.join(resolved, subMatch[1]) : resolved;
        break;
      }
    }

    if (!targetPath) {
      // Extract path from message — try quoted first, then Windows full path, then Unix
      const quoted = message.match(/["']([^"']+)["']/);
      // Windows path: grab everything from drive letter to end (may include spaces)
      const winPath = message.match(/([A-Za-z]:\\[^\n"']+)/i);
      const unixPath = message.match(/(~\/[^\s"']+|\/[^\s"']+)/);

      if (quoted) {
        targetPath = quoted[1].trim();
      } else if (winPath) {
        targetPath = winPath[1].trim().replace(/[.,;!?]+$/, ''); // strip trailing punctuation
      } else if (unixPath) {
        targetPath = unixPath[1];
      }
    }

    if (!targetPath) {
      // FIX v6.1.1: Detect application launch requests (öffne firefox, chrome, etc.)
      const appMatch = message.match(/(?:oeffne|öffne|open|start|starte)\s+(?:den\s+|das\s+|die\s+)?(\w[\w\s.-]*\w)/i);
      if (appMatch) {
        const appName = appMatch[1].trim();
        const platform = process.platform;
        const cmd = platform === 'win32' ? `start "" "${appName}"` : platform === 'darwin' ? `open -a "${appName}"` : `xdg-open "${appName}" 2>/dev/null || ${appName}`;
        try {
          const result = await this.shell.run(cmd, 'read');
          return `Anwendung gestartet: ${appName}`;
        } catch (err) { return `Konnte "${appName}" nicht starten: ${err.message}`; }
      }
      return 'Welchen Ordner oder welche Datei soll ich öffnen? Gib mir den Pfad an.';
    }

    // Determine OS-specific open command
    const platform = process.platform;
    let cmd;
    if (platform === 'win32') {
      cmd = `explorer "${targetPath}"`;
    } else if (platform === 'darwin') {
      cmd = `open "${targetPath}"`;
    } else {
      cmd = `xdg-open "${targetPath}"`;
    }

    try {
      const result = await this.shell.run(cmd, 'read');
      if (result.ok || result.exitCode === 0 || result.exitCode === 1) {
        // explorer returns exit 1 even on success sometimes
        return `Ordner geöffnet: \`${targetPath}\``;
      }
      return `Konnte den Pfad nicht öffnen: ${result.stderr || 'unbekannter Fehler'}`;
    } catch (err) {
      return `Fehler beim Öffnen: ${err.message}`;
    }
  }

  // ── Trust Level Control (v6.0.2) ────────────────────────

  async trustControl(message) {
    // Resolve TrustLevelSystem via container
    const trustSystem = this.bus?._container?.resolve?.('trustLevelSystem');
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
  }
}

module.exports = { CommandHandlers };
