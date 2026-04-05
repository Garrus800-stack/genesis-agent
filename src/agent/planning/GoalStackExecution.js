// @ts-checked-v5.7 — unbound `this` in prototype-delegation object
// ============================================================
// GENESIS — GoalStackExecution.js (v5.6.0)
//
// Extracted from GoalStack.js — step execution (think/code/
// check/create-file), LLM decomposition, and replanning.
// Attached via prototype delegation.
//
// Each method accesses GoalStack instance state via `this`.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('GoalStack');

const execution = {

  // ── Step Execution ───────────────────────────────────────

  _executeStep(step, goal) {
    switch (step.type) {
      case 'think':
        return this._stepThink(step, goal);
      case 'code':
        return this._stepCode(step, goal);
      case 'check':
        return this._stepCheck(step, goal);
      case 'create-file':
        return this._stepCreateFile(step, goal);
      default:
        return this._stepThink(step, goal);
    }
  },

  async _stepThink(step, goal) {
    const prompt = `You are Genesis. You are working on a goal.

GOAL: ${goal.description}
CURRENT STEP (${goal.currentStep + 1}/${goal.steps.length}): ${step.action}
${goal.results.length > 0 ? 'PREVIOUS RESULTS:\n' + goal.results.map(r => `- ${r.action}: ${r.success ? 'OK' : 'FAIL'} ${r.output?.slice(0, 100)}`).join('\n') : ''}

Execute this step. Respond briefly and concretely (max 5 sentences).`;

    const response = await this.model.chat(prompt, [], 'analysis');
    return { success: true, output: response };
  },

  async _stepCode(step, goal) {
    const prompt = `You are Genesis. Generate code for this step.

GOAL: ${goal.description}
STEP: ${step.action}
DETAILS: ${step.detail || 'No further details'}

Output ONLY the code in a code block. No explanation.`;

    const response = await this.model.chat(prompt, [], 'code');
    const codeMatch = response.match(/```(?:\w+)?\n([\s\S]+?)```/);
    if (!codeMatch) return { success: false, output: this.lang.t('goal.no_code'), error: 'no-code' };

    return { success: true, output: codeMatch[1].trim(), type: 'code' };
  },

  async _stepCheck(step, goal) {
    const prompt = `You are Genesis. Check whether a sub-goal has been achieved.

GOAL: ${goal.description}
TO CHECK: ${step.action}
PREVIOUS RESULTS:
${goal.results.map(r => `- ${r.action}: ${r.success ? 'OK' : 'FAIL'} ${r.output?.slice(0, 150)}`).join('\n')}

Respond with EXACTLY one word: YES or NO. Then briefly explain why.`;

    const response = await this.model.chat(prompt, [], 'analysis');
    const passed = /^(YES|JA)\b/i.test(response.trim());
    return { success: passed, output: response };
  },

  async _stepCreateFile(step, goal) {
    this.bus.emit('goal:create-file', { step, goal: goal.description }, { source: 'GoalStack' });
    return { success: true, output: this.lang.t('goal.file_requested', { detail: step.detail || step.action }) };
  },

  // ── Decomposition ────────────────────────────────────────

  async _decompose(description) {
    const prompt = `You are Genesis. Decompose this goal into concrete steps.

GOAL: ${description}

Rules:
- Maximum ${this.maxStepsPerGoal} steps
- Each step must be independently executable
- Types: think (reason/analyze), code (write code), check (verify), create-file (create file)

Format (EXACTLY like this, one line per step):
TYPE: Description

Example:
think: Analyze which modules are affected
code: Write the new function
check: Verify the code is syntactically correct`;

    const response = await this.model.chat(prompt, [], 'analysis');

    const steps = [];
    const lines = response.split('\n').filter(l => l.trim());

    for (const line of lines) {
      const match = line.match(/^(think|code|check|create-file)\s*:\s*(.+)/i);
      if (match) {
        steps.push({
          type: match[1].toLowerCase(),
          action: match[2].trim(),
          detail: null,
          status: 'pending',
        });
      }
    }

    if (steps.length === 0) {
      steps.push(
        { type: 'think', action: 'Analyze the goal: ' + description, detail: null, status: 'pending' },
        { type: 'think', action: 'Create an implementation plan', detail: null, status: 'pending' },
        { type: 'check', action: 'Check whether the goal was achieved', detail: null, status: 'pending' },
      );
    }

    return steps.slice(0, this.maxStepsPerGoal);
  },

  // ── Replanning ───────────────────────────────────────────

  async _replan(goal, lastError) {
    const prompt = `You are Genesis. A step in your plan has failed ${goal.maxAttempts}x.

GOAL: ${goal.description}
FAILED STEP: ${goal.steps[goal.currentStep]?.action}
ERROR: ${lastError || 'Unknown'}
PREVIOUS RESULTS:
${goal.results.slice(-3).map(r => `- ${r.action}: ${r.success ? 'OK' : 'FAIL'}`).join('\n')}

Create a new plan from this point. Same rules as before.
Or respond with GIVE_UP if the goal is not achievable.`;

    const response = await this.model.chat(prompt, [], 'analysis');

    if (/GIVE_UP|AUFGEBEN/i.test(response)) return false;

    const newSteps = [];
    for (const line of response.split('\n')) {
      const match = line.match(/^(think|code|check|create-file)\s*:\s*(.+)/i);
      if (match) newSteps.push({ type: match[1].toLowerCase(), action: match[2].trim(), detail: null, status: 'pending' });
    }

    if (newSteps.length > 0) {
      goal.steps = [...goal.steps.slice(0, goal.currentStep), ...newSteps];
      goal.attempts = 0;
      this._save();
      this.bus.emit('goal:replanned', { id: goal.id, newSteps: newSteps.length }, { source: 'GoalStack' });
      return true;
    }

    return false;
  },

};

module.exports = { execution };
