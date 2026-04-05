// ============================================================
// GENESIS — manifest/phase4-planning.js
// Phase 4: Planning & Intelligence L2
// ============================================================

function phase4(ctx, R) {
  const { rootDir, genesisDir, guard, bus, intervals } = ctx;

  return [
    ['goalStack', {
      phase: 4, deps: ['llm', 'prompts', 'storage'], tags: ['intelligence'],
      factory: (c) => {
        const { lang } = R('Language');
        return new (R('GoalStack').GoalStack)({
          bus, lang, model: c.resolve('llm'), prompts: c.resolve('prompts'),
          storageDir: genesisDir, storage: c.resolve('storage'),
        });
      },
    }],

    ['anticipator', {
      phase: 4, deps: ['memory', 'knowledgeGraph', 'eventStore', 'llm'], tags: ['intelligence'],
      factory: (c) => new (R('Anticipator').Anticipator)({
        bus, memory: c.resolve('memory'), knowledgeGraph: c.resolve('knowledgeGraph'),
        eventStore: c.resolve('eventStore'), model: c.resolve('llm'),
      }),
    }],

    ['solutionAccumulator', {
      phase: 4, deps: ['memory', 'knowledgeGraph', 'storage'], tags: ['intelligence'],
      factory: (c) => new (R('SolutionAccumulator').SolutionAccumulator)({
        bus, memory: c.resolve('memory'), knowledgeGraph: c.resolve('knowledgeGraph'),
        storageDir: genesisDir, storage: c.resolve('storage'),
      }),
    }],

    ['selfOptimizer', {
      phase: 4, deps: ['eventStore', 'memory', 'goalStack', 'storage'], tags: ['intelligence'],
      factory: (c) => new (R('SelfOptimizer').SelfOptimizer)({
        bus, eventStore: c.resolve('eventStore'), memory: c.resolve('memory'),
        goalStack: c.resolve('goalStack'), storageDir: genesisDir, storage: c.resolve('storage'),
      }),
    }],

    ['metaLearning', {
      phase: 4, deps: ['storage'], tags: ['intelligence', 'learning'],
      factory: (c) => new (R('MetaLearning').MetaLearning)({
        bus, storage: c.resolve('storage'), intervals,
      }),
    }],

    // Phase 9 foundation: SchemaStore lives in planning layer
    // because schemas are abstracted planning knowledge.
    ['schemaStore', {
      phase: 4, deps: ['storage'], tags: ['intelligence', 'memory', 'cognitive'],
      factory: (c) => new (R('SchemaStore').SchemaStore)({
        bus, storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('cognitive.schemas') || {},
      }),
    }],

    // v4.12.4: ValueStore — learned principles and preferences
    ['valueStore', {
      phase: 4, deps: ['storage'], tags: ['intelligence', 'values', 'ethics'],
      factory: (c) => new (R('ValueStore').ValueStore)({
        bus, storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('cognitive.values') || {},
      }),
    }],
  ];
}

module.exports = { phase4 };
