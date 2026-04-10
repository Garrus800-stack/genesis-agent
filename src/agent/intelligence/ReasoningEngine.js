// @ts-checked-v5.6
// ============================================================
// GENESIS AGENT — ReasoningEngine.js
// Structured thinking. This is what separates a chatbot from
// an agent that can actually solve complex problems.
//
// Capabilities:
// - Chain-of-thought: think step-by-step before answering
// - Task decomposition: break complex requests into sub-tasks
// - Tool use mid-thought: call skills/tools during reasoning
// - Self-evaluation: judge own output quality
// - Iterative refinement: improve answers across cycles
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('ReasoningEngine');

class ReasoningEngine {
  constructor(model, prompts, toolRegistry, bus) {
    this.bus = bus || NullBus;
    this.model = model;
    this.prompts = prompts;
    this.tools = toolRegistry;

    // v4.10.0: GraphReasoner — set via late-binding
    this._graphReasoner = null;

    // Reasoning configuration
    this.config = {
      maxReasoningSteps: 8,    // Prevent infinite loops
      maxToolCalls: 5,          // Max tool calls per reasoning chain
      evaluationThreshold: 0.6, // Min quality score to accept answer
      maxRefinements: 2,        // Max refinement cycles
    };

    // NOTE: reasoning:solve is registered by AgentCore._wireAndStart()
    // with full container context (memory, selfModel). Do NOT self-register here.
  }

  /**
   * Solve a complex task using structured reasoning.
   * This is the main entry point — it decides whether to use
   * simple response, chain-of-thought, or full decomposition.
   *
   * @param {string} task - The user's request
   * @param {object} context - { history, memory, selfModel, activeFile }
   * @returns {Promise<{ answer: string, reasoning: any, toolsUsed: any[] }>}
   */
  async solve(task, context = {}) {
    // v4.10.0: Try GraphReasoner first for structural questions (no LLM needed)
    if (this._graphReasoner) {
      try {
        const graphAnswer = this._graphReasoner.tryAnswer(task);
        if (graphAnswer && graphAnswer.answered) {
          this.bus.emit('reasoning:started', {
            task: task.slice(0, 100),
            complexity: { level: 'graph', strategy: 'deterministic' },
            strategy: graphAnswer.method,
          }, { source: 'ReasoningEngine' });

          return {
            answer: graphAnswer.result,
            reasoning: { strategy: 'graph-deterministic', method: graphAnswer.method, data: graphAnswer.data },
            toolsUsed: [],
          };
        }
      } catch (_e) { _log.debug('[catch] GraphReasoner not available or failed — proceed normally:', _e.message); }
    }

    // v7.0.9 Phase 2: Try InferenceEngine for causal reasoning (no LLM needed)
    if (this._inferenceEngine) {
      try {
        const inferred = this._inferenceEngine.infer({ from: task.slice(0, 200), relation: 'caused' });
        if (inferred.length > 0 && inferred[0].confidence >= 0.7) {
          this.bus.emit('reasoning:started', {
            task: task.slice(0, 100),
            complexity: { level: 'inferred', strategy: 'deterministic-inferred' },
            strategy: 'inference-engine',
          }, { source: 'ReasoningEngine' });

          return {
            answer: inferred.map(i => `${i.source} → ${i.target} (${i.relation}, confidence ${(i.confidence * 100).toFixed(0)}%)`).join('\n'),
            reasoning: { strategy: 'deterministic-inferred', rule: inferred[0].rule, inferences: inferred },
            toolsUsed: [],
          };
        }
      } catch (_e) { _log.debug('[catch] InferenceEngine failed:', _e.message); }
    }

    // Step 1: Classify complexity
    const complexity = await this._assessComplexity(task, context);

    this.bus.emit('reasoning:started', {
      task: task.slice(0, 100),
      complexity: complexity.level,
      strategy: complexity.strategy,
    }, { source: 'ReasoningEngine' });

    let result;

    switch (complexity.strategy) {
      case 'direct':
        // Simple question — answer directly
        result = await this._directAnswer(task, context);
        break;

      case 'chain-of-thought':
        // Medium complexity — think step by step
        result = await this._chainOfThought(task, context);
        break;

      case 'decompose':
        // Complex — break into sub-tasks and solve each
        result = await this._decompose(task, context);
        break;

      case 'research':
        // Needs information gathering first
        result = await this._research(task, context);
        break;

      default:
        result = await this._directAnswer(task, context);
    }

    // Step 2: Self-evaluate the answer
    if (complexity.level >= 2) {
      result = await this._evaluateAndRefine(task, result, context);
    }

    this.bus.emit('reasoning:completed', {
      task: task.slice(0, 100),
      strategy: complexity.strategy,
      steps: result.reasoning?.steps?.length || 1,
      toolsUsed: result.toolsUsed?.length || 0,
      quality: result.quality || null,
    }, { source: 'ReasoningEngine' });

    return result;
  }

  // ── Complexity Assessment ────────────────────────────────

  _assessComplexity(task, context) {
    // Fast heuristic first (no LLM call needed for obvious cases)
    const lower = task.toLowerCase();
    const wordCount = task.split(/\s+/).length;

    // Short factual questions → direct
    if (wordCount < 10 && /^(was|wer|wie|wann|wo|ist|hat|kann)\s/i.test(task)) {
      return { level: 1, strategy: 'direct' };
    }

    // Code execution → direct with tool
    if (task.includes('```')) {
      return { level: 1, strategy: 'direct' };
    }

    // Self-modification / repair → decompose (multi-step required)
    if (/modifiz|änder.*dich|repar|klon|erstell.*skill/i.test(task)) {
      return { level: 3, strategy: 'decompose' };
    }

    // Analysis / comparison → chain-of-thought
    if (/analys|vergleich|erklär|warum|wie funktioniert/i.test(task)) {
      return { level: 2, strategy: 'chain-of-thought' };
    }

    // Multi-part requests (und, außerdem, dann, danach) → decompose
    if (/\b(und dann|außerdem|danach|erstens|zweitens|zusätzlich)\b/i.test(task)) {
      return { level: 3, strategy: 'decompose' };
    }

    // Research-style questions → research
    if (/such|find|recherch|best practice|aktuell/i.test(task)) {
      return { level: 2, strategy: 'research' };
    }

    // Default: medium complexity
    return { level: 2, strategy: wordCount > 30 ? 'chain-of-thought' : 'direct' };
  }

  // ── Strategy: Direct Answer ──────────────────────────────

  async _directAnswer(task, context) {
    const prompt = this._buildContextualPrompt(task, context);
    const answer = await this.model.chat(prompt, context.history || [], 'chat');

    return {
      answer,
      reasoning: { strategy: 'direct', steps: [{ type: 'answer', content: answer }] },
      toolsUsed: [],
    };
  }

  // ── Strategy: Chain of Thought ───────────────────────────

  async _chainOfThought(task, context) {
    const steps = [];
    const toolsUsed = [];

    // Phase 1: Think
    const thinkPrompt = `${this._buildContextualPrompt(task, context)}

IMPORTANT: Before answering, think step by step.
Structure your thoughts in <think>...</think> tags.
Then give your actual answer AFTER thinking.

Format:
<think>
Step 1: [What is the core question?]
Step 2: [What information do I have?]
Step 3: [What do I need to consider?]
Step 4: [My conclusion]
</think>

[Your answer here]`;

    const rawResponse = await this.model.chat(thinkPrompt, context.history || [], 'analysis');

    // Parse thinking and answer
    const thinkMatch = rawResponse.match(/<think>([\s\S]*?)<\/think>/);
    const thinking = thinkMatch ? thinkMatch[1].trim() : '';
    const answer = rawResponse.replace(/<think>[\s\S]*?<\/think>/, '').trim();

    steps.push({ type: 'think', content: thinking });

    // Phase 2: Check if tools are needed
    const toolNeed = this._detectToolNeed(task, answer);
    if (toolNeed && this.tools) {
      const toolResult = await this._callTool(toolNeed.tool, toolNeed.input);
      if (toolResult) {
        toolsUsed.push({ tool: toolNeed.tool, result: toolResult });
        steps.push({ type: 'tool-call', tool: toolNeed.tool, result: toolResult });

        // Synthesize with tool result
        const synthesizePrompt = `You answered the following question: "${task}"

Your first answer: ${answer}

Additional information from tool "${toolNeed.tool}":
${JSON.stringify(toolResult, null, 2)}

Provide an improved, complete answer incorporating the tool results.`;

        const improvedAnswer = await this.model.chat(synthesizePrompt, [], 'chat');
        steps.push({ type: 'synthesize', content: improvedAnswer });
        return { answer: improvedAnswer, reasoning: { strategy: 'chain-of-thought', steps }, toolsUsed };
      }
    }

    steps.push({ type: 'answer', content: answer });
    return { answer, reasoning: { strategy: 'chain-of-thought', steps, thinking }, toolsUsed };
  }

  // ── Strategy: Decompose ──────────────────────────────────

  async _decompose(task, context) {
    const steps = [];
    const toolsUsed = [];

    // Phase 1: Break into sub-tasks
    const decomposePrompt = `Break down this complex task into individual steps.

TASK: ${task}

AVAILABLE TOOLS: ${this.tools ? this.tools.listTools().map(t => t.name).join(', ') : 'none'}

List the steps as a numbered list:
1. [Concrete step]
2. [Concrete step]
...

Each step should be independently executable.
Maximum ${this.config.maxReasoningSteps} steps.`;

    const planResponse = await this.model.chat(decomposePrompt, [], 'analysis');
    const subTasks = this._parseSubTasks(planResponse);

    steps.push({ type: 'plan', content: planResponse, subTasks });

    // Phase 2: Execute each sub-task
    const subResults = [];
    let accumulatedContext = '';

    for (let i = 0; i < Math.min(subTasks.length, this.config.maxReasoningSteps); i++) {
      const subTask = subTasks[i];

      this.bus.emit('reasoning:step', {
        step: i + 1,
        total: subTasks.length,
        task: subTask.slice(0, 80),
      }, { source: 'ReasoningEngine' });

      // Check if this step needs a tool
      const toolNeed = this._detectToolNeed(subTask, '');
      if (toolNeed && this.tools && toolsUsed.length < this.config.maxToolCalls) {
        const toolResult = await this._callTool(toolNeed.tool, toolNeed.input);
        if (toolResult) {
          toolsUsed.push({ tool: toolNeed.tool, step: i + 1, result: toolResult });
          accumulatedContext += `\nStep ${i + 1} (Tool: ${toolNeed.tool}): ${JSON.stringify(toolResult).slice(0, 500)}`;
          subResults.push({ step: i + 1, task: subTask, result: toolResult, type: 'tool' });
          steps.push({ type: 'tool-call', step: i + 1, tool: toolNeed.tool, result: toolResult });
          continue;
        }
      }

      // Otherwise, reason about this step
      const stepPrompt = `Execute this step:

OVERALL TASK: ${task}
CURRENT STEP (${i + 1}/${subTasks.length}): ${subTask}
${accumulatedContext ? `\nPREVIOUS RESULTS:\n${accumulatedContext}` : ''}

Provide a precise result for this step.`;

      const stepResult = await this.model.chat(stepPrompt, [], 'analysis');
      accumulatedContext += `\nStep ${i + 1}: ${stepResult.slice(0, 300)}`;
      subResults.push({ step: i + 1, task: subTask, result: stepResult, type: 'reasoning' });
      steps.push({ type: 'sub-task', step: i + 1, task: subTask, result: stepResult });
    }

    // Phase 3: Synthesize all results into final answer
    const synthesizePrompt = `Combine the results of all steps into a complete answer.

ORIGINAL TASK: ${task}

RESULTS:
${subResults.map(r => `Step ${r.step} (${r.task}): ${typeof r.result === 'string' ? r.result.slice(0, 400) : JSON.stringify(r.result).slice(0, 400)}`).join('\n\n')}

Provide a coherent, complete answer.`;

    const finalAnswer = await this.model.chat(synthesizePrompt, [], 'chat');
    steps.push({ type: 'synthesize', content: finalAnswer });

    return {
      answer: finalAnswer,
      reasoning: { strategy: 'decompose', steps, subTasks, subResults },
      toolsUsed,
    };
  }

  // ── Strategy: Research ───────────────────────────────────

  async _research(task, context) {
    const steps = [];
    const toolsUsed = [];

    // Phase 1: Determine what information is needed
    const researchPrompt = `What needs to be researched to answer this question?

QUESTION: ${task}

List the needed information sources:
1. [What needs to be looked up]
2. [What needs to be checked]`;

    const researchPlan = await this.model.chat(researchPrompt, [], 'analysis');
    steps.push({ type: 'research-plan', content: researchPlan });

    // Phase 2: Gather information from available tools
    if (this.tools) {
      const availableTools = this.tools.listTools();
      for (const tool of availableTools) {
        const relevant = this._isToolRelevant(tool, task);
        if (relevant && toolsUsed.length < this.config.maxToolCalls) {
          const result = await this._callTool(tool.name, { query: task });
          if (result) {
            toolsUsed.push({ tool: tool.name, result });
            steps.push({ type: 'research-result', tool: tool.name, result });
          }
        }
      }
    }

    // Phase 3: Check memory for relevant past knowledge
    if (context.memory) {
      const memoryContext = context.memory.buildContext(task);
      if (memoryContext) {
        steps.push({ type: 'memory-recall', content: memoryContext });
      }
    }

    // Phase 4: Synthesize
    const allFindings = steps
      .filter(s => s.type === 'research-result' || s.type === 'memory-recall')
      .map(s => s.content || JSON.stringify(s.result).slice(0, 500))
      .join('\n\n');

    const answer = await this.model.chat(
      `Answer based on these research findings:\n\n${allFindings}\n\nQUESTION: ${task}`,
      context.history || [],
      'chat'
    );

    steps.push({ type: 'answer', content: answer });
    return { answer, reasoning: { strategy: 'research', steps }, toolsUsed };
  }

  // ── Self-Evaluation & Refinement ─────────────────────────

  async _evaluateAndRefine(task, result, context) {
    for (let cycle = 0; cycle < this.config.maxRefinements; cycle++) {
      const evalPrompt = `Evaluate this answer on a scale of 0.0 to 1.0.

QUESTION: ${task}
ANSWER: ${result.answer.slice(0, 1500)}

Criteria:
- Completeness (answers all aspects?)
- Correctness (factually correct?)
- Clarity (clearly formulated?)
- Usefulness (helps the user?)

Respond with EXACTLY this format:
SCORE: [0.0-1.0]
WEAKNESS: [What is missing or wrong, or "none"]
IMPROVEMENT: [Concrete suggestion, or "not needed"]`;

      const evalResponse = await this.model.chat(evalPrompt, [], 'analysis');

      const scoreMatch = evalResponse.match(/SCORE:\s*([\d.]+)/);
      const weaknessMatch = evalResponse.match(/WEAKNESS:\s*(.+?)(?:\n|$)/);
      const improvementMatch = evalResponse.match(/IMPROVEMENT:\s*(.+?)(?:\n|$)/);

      const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0.7;
      const weakness = weaknessMatch?.[1]?.trim() || '';
      const improvement = improvementMatch?.[1]?.trim() || '';

      result.quality = score;
      result.reasoning.evaluation = { score, weakness, improvement, cycle };

      // If quality is good enough, or no improvement possible, stop
      if (score >= this.config.evaluationThreshold ||
          weakness.toLowerCase().includes('none') ||
          weakness.toLowerCase().includes('keine') ||
          improvement.toLowerCase().includes('not needed') ||
          improvement.toLowerCase().includes('nicht nötig')) {
        break;
      }

      // Refine the answer
      const refinePrompt = `Improve this answer.

ORIGINAL QUESTION: ${task}
CURRENT ANSWER: ${result.answer.slice(0, 1500)}
IDENTIFIED WEAKNESS: ${weakness}
SUGGESTED IMPROVEMENT: ${improvement}

Provide the improved answer:`;

      result.answer = await this.model.chat(refinePrompt, [], 'chat');
      result.reasoning.steps.push({
        type: 'refinement',
        cycle: cycle + 1,
        weakness,
        improvement,
      });

      this.bus.emit('reasoning:refined', { cycle: cycle + 1, score, weakness }, { source: 'ReasoningEngine' });
    }

    return result;
  }

  // ── Tool Integration ─────────────────────────────────────

  _detectToolNeed(task, currentAnswer) {
    if (!this.tools) return null;
    const lower = task.toLowerCase();

    // Map patterns to tools
    const toolPatterns = [
      { pattern: /system.*(info|status|hardware|gpu|ram|cpu)/i, tool: 'system-info', input: {} },
      { pattern: /datei.*(lesen|öffnen|zeig)|read.*file|open.*file/i, tool: 'file-read', input: { query: task } },
      { pattern: /code.*ausführ|execute|run.*code/i, tool: 'sandbox', input: { code: task } },
      { pattern: /such|search|find/i, tool: 'search', input: { query: task } },
    ];

    for (const { pattern, tool, input } of toolPatterns) {
      if (pattern.test(lower) && this.tools.hasTool(tool)) {
        return { tool, input };
      }
    }

    return null;
  }

  async _callTool(toolName, input) {
    if (!this.tools) return null;
    try {
      return await this.tools.execute(toolName, input);
    } catch (err) {
      _log.warn(`[REASONING] Tool call failed: ${toolName}:`, err.message);
      return null;
    }
  }

  _isToolRelevant(tool, task) {
    // Simple keyword overlap check
    const taskWords = task.toLowerCase().split(/\s+/);
    const toolWords = `${tool.name} ${tool.description || ''}`.toLowerCase().split(/\s+/);
    return taskWords.some(w => toolWords.includes(w));
  }

  // ── Helpers ──────────────────────────────────────────────

  _buildContextualPrompt(task, context) {
    const parts = ['You are Genesis.'];

    if (context.memory) {
      const memCtx = context.memory.buildContext(task);
      if (memCtx) parts.push('\n' + memCtx);
    }

    if (context.selfModel) {
      parts.push(`\nYOUR CAPABILITIES: ${context.selfModel.getCapabilities().join(', ')}`);
    }

    return parts.join('\n');
  }

  _parseSubTasks(response) {
    const lines = response.split('\n');
    return lines
      .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
      .filter(l => l.length > 5 && !l.startsWith('#') && !l.startsWith('-'));
  }
}

module.exports = { ReasoningEngine };
