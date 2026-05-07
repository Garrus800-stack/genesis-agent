// @ts-checked-v5.8
// ============================================================
// GENESIS — ShellPlanner.js (v7.5.4)
//
// LLM-based shell-step planner. Generates a list of executable
// shell commands for a natural-language task, given a project
// context. Does NOT execute — the orchestrator (ShellAgent) does
// that and emits step lifecycle events.
//
// Extracted from ShellAgent.js as part of the v7.5.4 split.
// ============================================================

'use strict';

const { NullBus } = require('../../core/EventBus');
const { buildOsContext } = require('../../core/EnvironmentContext');

class ShellPlanner {
  /**
   * @param {object} deps
   * @param {object} deps.model — must have async chatStructured(prompt, history, type)
   * @param {object} [deps.memory] — optional, with recallPattern(task)
   * @param {object} [deps.lang] — i18n stub with t(key, params)
   * @param {object} [deps.bus] — EventBus for shell:planning emit
   * @param {object} [deps.selfStatementLog] — optional, with recordPromise(entry).
   *                                          Default null (no-op). Hook for v7.5.x+
   *                                          self-statement-log integration.
   */
  constructor({ model, memory, lang, bus, selfStatementLog = null }) {
    this.model = model;
    this.memory = memory;
    this.lang = lang || { t: (k) => k };
    this.bus = bus || NullBus;
    this.selfStatementLog = selfStatementLog;
  }

  /**
   * Generate a plan for the given task. Does NOT execute.
   *
   * @param {string} task
   * @param {object} context
   * @param {object} context.project — result of ShellAgent.scanProject(cwd)
   * @param {string} context.cwd
   * @param {boolean} context.isWindows
   * @param {string} context.permissionLevel
   * @returns {Promise<{steps: object[]|null, error?: string}>}
   */
  async generate(task, context) {
    const { project, cwd, isWindows, permissionLevel } = context;

    this.bus.fire('shell:planning', { task: task.slice(0, 100) }, { source: 'ShellPlanner' });

    const pastPatterns = this.memory?.recallPattern(task);
    const pastContext = pastPatterns
      ? `\nPREVIOUSLY SUCCESSFUL: For "${pastPatterns.trigger}", "${pastPatterns.action}" worked (${Math.round(pastPatterns.successRate * 100)}% success).`
      : '';

    const { osContext, osName } = buildOsContext({ rootDir: cwd, isWindows });

    const planPrompt = `You are a shell expert for ${osName}.
${osContext}
TASK: ${task}

PROJECT CONTEXT:
- Directory: ${cwd}
- Project type: ${project.type || 'unknown'}
- Available scripts: ${JSON.stringify(project.scripts || {})}
- Git status: ${project.gitStatus || 'unknown'}
- Existing files: ${(project.keyFiles || []).join(', ')}
${pastContext}

RULES:
- Only commands that work on ${osName}
- Each command must be independently executable
- Permission tier: "${permissionLevel}"

Respond ONLY with a JSON list:
[{"cmd": "command", "description": "what", "critical": false, "condition": null}]`;

    let steps;
    try {
      const raw = await this.model.chatStructured(planPrompt, [], 'code');

      // Salvage steps from many shapes (preserved from v7.5.3):
      //   1. Direct array              [{cmd, ...}]
      //   2. Wrapped in {steps:[...]}
      //   3. Wrapped in {plan:[...]}
      //   4. Wrapped in {commands:[..]}
      //   5. Single step object        {cmd, description}
      //   6. _raw text fallback        {_raw: "...", _parseError: true}
      if (Array.isArray(raw)) {
        steps = raw;
      } else if (raw && Array.isArray(raw.steps)) {
        steps = raw.steps;
      } else if (raw && Array.isArray(raw.plan)) {
        steps = raw.plan;
      } else if (raw && Array.isArray(raw.commands)) {
        steps = raw.commands;
      } else if (raw && typeof raw.cmd === 'string') {
        steps = [raw];
      } else if (raw && raw._raw && typeof raw._raw === 'string') {
        steps = this._salvageStepsFromText(raw._raw);
      } else {
        steps = null;
      }

      if (!steps || !Array.isArray(steps) || steps.length === 0) {
        const rawHint = (() => {
          try {
            if (raw && raw._raw) return String(raw._raw).slice(0, 300);
            return JSON.stringify(raw).slice(0, 300);
          } catch (_e) { return '<unparseable>'; }
        })();
        return {
          steps: null,
          error: `${this.lang.t('agent.plan_failed')}\n\nLLM response had no recognizable plan schema. Excerpt:\n\`\`\`\n${rawHint}\n\`\`\``,
        };
      }

      // Hook for future self-statement-log. Schema may evolve;
      // current shape ({kind, task, steps}) is provisional.
      this.selfStatementLog?.recordPromise?.({ kind: 'plan', task, steps });

      return { steps };
    } catch (err) {
      return { steps: null, error: this.lang.t('shell.plan_error', { message: err.message }) };
    }
  }

  /**
   * Extract step-like fragments from free-form LLM text when the
   * structured call fails. Tries fenced blocks, backticks, prompt
   * lines, then numbered lists. Returns up to 10 steps.
   *
   * @param {string} text
   * @returns {object[]}
   */
  _salvageStepsFromText(text) {
    if (typeof text !== 'string' || !text.trim()) return [];
    const found = [];
    const seen = new Set();
    const push = (cmd, desc) => {
      const c = (cmd || '').trim().replace(/^\$\s*|^>\s*/, '');
      if (!c || seen.has(c)) return;
      seen.add(c);
      found.push({ cmd: c, description: (desc || c).slice(0, 120), critical: false, condition: null });
    };

    // 1. Fenced code blocks: ```...``` or ```bash ... ```
    const fenceRe = /```(?:\w+\n)?([\s\S]*?)```/g;
    let m;
    while ((m = fenceRe.exec(text))) {
      const block = m[1].trim();
      for (const line of block.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('//')) continue;
        push(t);
      }
    }

    // 2. Backticked single commands
    if (found.length === 0) {
      const tickRe = /`([^`\n]{2,200})`/g;
      while ((m = tickRe.exec(text))) push(m[1]);
    }

    // 3. Shell-prompt lines: $ cmd  or  > cmd
    if (found.length === 0) {
      for (const line of text.split('\n')) {
        if (/^\s*[\$>]\s+\S/.test(line)) push(line.trim());
      }
    }

    // 4. Numbered/bulleted list items that look like commands
    if (found.length === 0) {
      const listRe = /^[\s]*(?:[-*]|\d+[.)])\s+(.+)$/gm;
      while ((m = listRe.exec(text))) {
        const t = m[1].trim();
        if (/^(?:dir|ls|cat|type|cd|pwd|echo|find|grep|findstr|where|which|wc|head|tail|node|npm|git|python|pip|cargo|make|docker|powershell|cmd)\b/i.test(t)) {
          push(t);
        }
      }
    }

    return found.slice(0, 10);
  }
}

module.exports = { ShellPlanner };
