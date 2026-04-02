// ============================================================
// GENESIS — SolutionAccumulator.js
// Turns solved problems into reusable knowledge.
// Every successful interaction is a lesson, not just a reply.
//
// Extracts: code patterns, error fixes, tool chains,
// user preferences, recurring workflows.
// ============================================================

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('SolutionAccumulator');
class SolutionAccumulator {
  constructor({ bus,  memory, knowledgeGraph, storageDir, storage }) {
    this.bus = bus || NullBus;
    this.memory = memory;
    this.kg = knowledgeGraph;
    this.storage = storage || null;
    this.solutionsPath = path.join(storageDir, 'solutions.json');
    // v3.8.0: Moved to asyncLoad() — called by Container.bootAll()
    // this.solutions = this._load();
    this.solutions = [];

    // Listen for successful completions
    this.bus.on('chat:completed', (data) => {
      if (data.success !== false) this._extract(data);
    }, { source: 'SolutionAccumulator', priority: -2 });
  }

  /**
   * Extract reusable patterns from a completed interaction
   */
  _extract({ message, response, intent }) {
    if (!message || !response) return;

    // 1. Code solutions: if response contains code and question was a problem
    if (/```/.test(response) && /wie|how|warum|why|fehler|error|fix|loes/i.test(message)) {
      const codeMatch = response.match(/```(\w*)\n([\s\S]*?)```/);
      if (codeMatch && codeMatch[2].trim().length > 30) {
        this._addSolution({
          type: 'code-pattern',
          problem: message.slice(0, 200),
          solution: codeMatch[2].trim().slice(0, 1000),
          language: codeMatch[1] || 'javascript',
          intent,
        });
      }
    }

    // 2. Error fixes: if message mentions error and response fixes it
    if (/error|fehler|bug|crash|exception/i.test(message) && !/Fehler:/i.test(response)) {
      this._addSolution({
        type: 'error-fix',
        problem: message.slice(0, 200),
        solution: response.slice(0, 500),
        intent,
      });
    }

    // 3. Workflow patterns: if message involves a sequence of actions
    if (/dann|then|danach|anschliessend|next/i.test(message)) {
      this._addSolution({
        type: 'workflow',
        problem: message.slice(0, 200),
        solution: response.slice(0, 500),
        intent,
      });
    }

    // 4. Store in KnowledgeGraph for semantic search
    if (this.kg && message.length > 20) {
      const problemNode = this.kg.addNode('problem', message.slice(0, 80), {
        type: 'solved-problem', intent,
      });
      const solutionNode = this.kg.addNode('solution', response.slice(0, 80), {
        type: 'solution', intent,
      });
      if (problemNode && solutionNode) {
        this.kg.connect(problemNode, 'solved-by', solutionNode, 0.8);
      }
    }
  }

  /**
   * Find a previous solution for a similar problem
   */
  findSimilar(query) {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (queryWords.length === 0) return [];

    const scored = this.solutions.map(sol => {
      const problemWords = sol.problem.toLowerCase().split(/\s+/);
      const overlap = queryWords.filter(w => problemWords.some(pw => pw.includes(w))).length;
      return { ...sol, score: overlap / queryWords.length };
    });

    return scored
      .filter(s => s.score > 0.3)
      .sort((a, b) => b.score - a.score || b.useCount - a.useCount)
      .slice(0, 3);
  }

  /**
   * Build context for the prompt with relevant solutions
   */
  buildContext(query) {
    const similar = this.findSimilar(query);
    if (similar.length === 0) return '';

    const lines = ['FRUEHERE LOESUNGEN ZU AEHNLICHEN PROBLEMEN:'];
    for (const sol of similar) {
      lines.push(`- [${sol.type}] ${sol.problem.slice(0, 100)}`);
      if (sol.type === 'code-pattern') {
        lines.push(`  Loesung: ${sol.solution.slice(0, 200)}...`);
      }
      sol.useCount = (sol.useCount || 0) + 1;
    }
    this._save();

    return lines.join('\n');
  }

  /** Get stats */
  getStats() {
    const types = {};
    for (const sol of this.solutions) {
      types[sol.type] = (types[sol.type] || 0) + 1;
    }
    return { total: this.solutions.length, byType: types };
  }

  // ── Internal ─────────────────────────────────────────────

  _addSolution(sol) {
    sol.timestamp = new Date().toISOString();
    sol.useCount = 0;
    this.solutions.push(sol);

    // Keep last 200 solutions
    if (this.solutions.length > 200) {
      // Remove least-used first
      this.solutions.sort((a, b) => (b.useCount || 0) - (a.useCount || 0));
      this.solutions = this.solutions.slice(0, 200);
    }

    this._save();
  }

  _save() {
    try {
      if (this.storage) this.storage.writeJSONDebounced('solutions.json', this.solutions);
    } catch (err) { _log.debug('[SOLUTIONS] Save failed:', err.message); }
  }

  /**
   * v3.8.0: Async boot-time data loading.
   * Called by Container.bootAll() after all services are resolved.
   */
  async asyncLoad() {
    this.solutions = this._load();
  }


  _load() {
    try {
      if (this.storage) return this.storage.readJSON('solutions.json', []);
    } catch (err) { _log.debug('[SOLUTIONS] Load failed:', err.message); }
    return [];
  }
}

module.exports = { SolutionAccumulator };
