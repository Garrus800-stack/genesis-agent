// @ts-checked-v5.7
// ============================================================
// GENESIS — CommandHandlersNetwork.js (v7.4.2 "Kassensturz")
//
// Extracted from CommandHandlers.js as part of the v7.4.2 domain
// split. Handles external Network and MCP I/O:
//   - peer        — peer discovery, trust, import, compare (PeerNetwork)
//   - mcpControl  — MCP server connect/disconnect/reconnect/tools
//   - webLookup   — URL fetch, npm search, ping, domain lookup
//
// Prototype-Delegation from CommandHandlers.js via Object.assign.
// External API unchanged.
// ============================================================

'use strict';

const commandHandlersNetwork = {

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
  },

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
  },

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
  },

};

module.exports = { commandHandlersNetwork };
