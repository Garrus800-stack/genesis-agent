// ============================================================
// GENESIS — manifest/phase3-capabilities.js
// Phase 3: Capabilities services
// ============================================================

function phase3(ctx, R) {
  const { rootDir, genesisDir, guard, bus, intervals } = ctx;
  const path = require('path');

  return [
    ['skills', {
      phase: 3, deps: ['sandbox', 'llm', 'prompts'], tags: ['capability'],
      // v5.1.0 (DI-1): CodeSafety via port
      lateBindings: [
        { prop: '_codeSafety', service: 'codeSafety' },
      ],
      factory: (c) => new (R('SkillManager').SkillManager)(
        path.join(rootDir, 'src', 'skills'), c.resolve('sandbox'), c.resolve('llm'), c.resolve('prompts'), guard
      ),
    }],

    // v5.9.8 (V6-6): SkillRegistry — install/uninstall/update from external sources
    ['skillRegistry', {
      phase: 3, deps: ['bus'], tags: ['capability', 'skills', 'v6-6'],
      lateBindings: [
        { prop: 'skillManager', service: 'skills', optional: true },
        { prop: '_settings', service: 'settings', optional: true },
      ],
      factory: (c) => new (R('SkillRegistry').SkillRegistry)({
        skillsDir: path.join(rootDir, 'src', 'skills'),
        bus,
        config: c.tryResolve('settings')
          ?.get('skills.registry') || {},
      }),
    }],

    ['reflector', {
      phase: 3, deps: ['selfModel', 'llm', 'prompts', 'sandbox'], tags: ['capability'],
      factory: (c) => new (R('Reflector').Reflector)(
        c.resolve('selfModel'), c.resolve('llm'), c.resolve('prompts'), c.resolve('sandbox'), guard
      ),
    }],

    ['cloner', {
      phase: 3, deps: ['selfModel', 'llm', 'prompts'], tags: ['capability'],
      // v5.0.0: Genome for offspring reproduction
      lateBindings: [
        { prop: 'genome', service: 'genome', optional: true },
        // v5.1.0 (DI-1): CodeSafety via port
        { prop: '_codeSafety', service: 'codeSafety' },
      ],
      factory: (c) => new (R('CloneFactory').CloneFactory)(rootDir, c.resolve('selfModel'), c.resolve('llm'), c.resolve('prompts'), guard),
    }],

    ['fileProcessor', {
      phase: 3, deps: ['sandbox'], tags: ['capability'],
      factory: (c) => new (R('FileProcessor').FileProcessor)(rootDir, c.resolve('sandbox'), bus),
    }],

    ['hotReloader', {
      phase: 3, deps: [], tags: ['capability'],
      factory: () => new (R('HotReloader').HotReloader)(rootDir, guard, bus),
    }],

    ['network', {
      phase: 3, deps: ['selfModel', 'skills', 'llm', 'prompts'], tags: ['capability', 'network'],
      lateBindings: [
        // v4.12.8: PeerConsensus for state sync
        { prop: 'peerConsensus', service: 'peerConsensus', optional: true },
        // v5.1.0 (DI-1): CodeSafety via port
        { prop: '_codeSafety', service: 'codeSafety' },
      ],
      factory: (c) => {
        const net = new (R('PeerNetwork').PeerNetwork)(
          c.resolve('selfModel'), c.resolve('skills'), c.resolve('llm'), c.resolve('prompts'),
          { bus, intervals, guard }
        );
        net._genesisDir = genesisDir;
        return net;
      },
    }],

    ['shellAgent', {
      phase: 3,
      deps: ['model', 'selfModel', 'memory', 'eventStore', 'knowledgeGraph', 'sandbox'],
      tags: ['capability'],
      factory: (c) => new (R('ShellAgent').ShellAgent)({
        bus, lang: R('Language').lang, model: c.resolve('llm'), selfModel: c.resolve('selfModel'),
        memory: c.resolve('memory'), guard,
        knowledgeGraph: c.resolve('knowledgeGraph'),
        sandbox: c.resolve('sandbox'),
        eventStore: c.resolve('eventStore'), rootDir,
      }),
    }],

    ['mcpClient', {
      phase: 3,
      deps: ['settings', 'tools', 'sandbox', 'knowledgeGraph', 'eventStore', 'storage'],
      tags: ['capability', 'mcp'],
      optional: true,
      factory: (c) => {
        if (c.resolve('settings').get('mcp.enabled') === false) return null;
        return new (R('McpClient').McpClient)({
          bus, settings: c.resolve('settings'),
          toolRegistry: c.resolve('tools'),
          sandbox: c.resolve('sandbox'),
          knowledgeGraph: c.resolve('knowledgeGraph'),
          eventStore: c.resolve('eventStore'),
          storageDir: genesisDir,
          storage: c.resolve('storage'),
        });
      },
    }],

    // v5.2.0: PluginRegistry — was orphaned (never wired in manifests).
    // Registered with codeSafety injection to eliminate cross-layer fallback.
    ['pluginRegistry', {
      phase: 3,
      deps: ['sandbox', 'tools', 'storage', 'codeSafety'],
      tags: ['capability', 'plugins'],
      factory: (c) => new (R('PluginRegistry').PluginRegistry)({
        bus, sandbox: c.resolve('sandbox'),
        toolRegistry: c.resolve('tools'),
        storage: c.resolve('storage'),
        pluginsDir: path.join(rootDir, 'plugins'),
        guard,
        codeSafety: c.resolve('codeSafety'),
      }),
    }],

    // v4.12.2: SnapshotManager — named source code snapshots for safe rollback.
    // v7.1.2: Registered in DI for DeploymentManager integration (V7-4B real rollback).
    ['snapshotManager', {
      phase: 3, deps: [], tags: ['capabilities', 'safety'],
      factory: () => new (R('SnapshotManager').SnapshotManager)({
        rootDir, storage: null, guard,
      }),
    }],

    // v5.8.0: McpServerToolBridge — exposes Genesis capabilities as MCP tools.
    // Late-binds to phase-9 services (ArchitectureReflection, ProjectIntelligence).
    ['mcpToolBridge', {
      phase: 3,
      deps: ['tools'],
      tags: ['capability', 'mcp'],
      optional: true,
      lateBindings: [
        { prop: '_mcpClient',          service: 'mcpClient', optional: true },
        { prop: '_verification',       service: 'verifier', optional: true }, // v7.1.6: was 'verificationEngine' (dangling)
        { prop: '_codeSafety',         service: 'codeSafety', optional: true },
        { prop: '_projectIntel',       service: 'projectIntelligence', optional: true },
        { prop: '_archReflection',     service: 'architectureReflection', optional: true },
        { prop: '_knowledgeGraph',     service: 'knowledgeGraph', optional: true },
        { prop: '_lessonsStore',       service: 'lessonsStore', optional: true },
      ],
      factory: () => new (R('McpServerToolBridge').McpServerToolBridge)({ bus }),
    }],
  ];
}

module.exports = { phase3 };
