// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/MCPExplore.js (v7.3.1)
// Explores connected MCP servers, ideates skill candidates.
// Conditional: requires mcpClient with at least 1 connected server.
// Boost: Genome curiosity multiplier.
// ============================================================

'use strict';

module.exports = {
  name: 'mcp-explore',
  weight: 1.0,
  cooldown: 0,

  shouldTrigger(ctx) {
    // Availability gate — no MCP connections means not a candidate
    if ((ctx.snap.mcpConnected || 0) === 0) return 0;

    let boost = 1.0;

    // Genome curiosity
    const cur = ctx.snap.genomeTraits?.curiosity;
    if (cur !== undefined) boost *= (0.5 + cur);

    return boost;
  },

  async run(idleMind) {
    if (!idleMind.mcpClient) return null;
    const mcpCtx = idleMind.mcpClient.getExplorationContext();
    if (mcpCtx.servers.length === 0) return null;

    const server = mcpCtx.servers[Math.floor(Math.random() * mcpCtx.servers.length)];

    const candidates = mcpCtx.skillCandidates;
    if (candidates.length > 0) {
      const c = candidates[0];
      const prompt = `You are Genesis. You discovered a recurring MCP call pattern:\n\nPattern: ${c.pattern} (used ${c.count}x)\nChain: ${c.chain.map(s => s.server + ':' + s.tool).join(' → ')}\n\nCreate a brief description for a Genesis Skill that automates this chain.\nName (one word), what it does (1 sentence), when it is useful (1 sentence).`;

      const thought = await idleMind.model.chat(prompt, [], 'analysis');
      idleMind.mcpClient.markPatternSuggested(c.pattern);

      if (idleMind.kg) {
        idleMind.kg.addNode('idea', `MCP-Skill: ${c.pattern.slice(0, 50)}`, {
          type: 'mcp-skill-candidate', pattern: c.pattern, thought: thought.slice(0, 300),
        });
      }
      return `[MCP-Skill idea] ${thought}`;
    }

    const toolSample = server.tools.slice(0, 8)
      .map(t => `- ${t.name}: ${t.description} (params: ${t.params.join(', ') || 'none'})`).join('\n');

    const prompt = `You are Genesis. You are exploring a connected MCP server.\n\nServer: ${server.name}\n${server.info?.name ? 'Description: ' + server.info.name : ''}\nTools (${server.tools.length}):\n${toolSample}\n\nBrief note to yourself (max 3 sentences):\n- Which tools could be usefully combined?\n- What tasks could I accomplish for the user with these?`;

    const thought = await idleMind.model.chat(prompt, [], 'analysis');

    if (idleMind.kg) {
      idleMind.kg.addNode('insight', `MCP ${server.name}: ${thought.slice(0, 80)}`, {
        type: 'mcp-exploration', server: server.name, thought: thought.slice(0, 300),
      });
    }

    return `[MCP-Exploration: ${server.name}] ${thought}`;
  },
};
