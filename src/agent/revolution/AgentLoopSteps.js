// @ts-checked-v5.7
// ============================================================
// GENESIS — AgentLoopSteps.js (v3.8.0 — Composition Delegate)
//
// v3.8.0 UPGRADE: Converted from loose functions (prototype mixin)
// to a proper delegate class. All methods access the parent
// AgentLoop via this.loop instead of directly via `this`.
//
// Methods:
//   _executeStep(step, context, onProgress) → result
//   _stepAnalyze, _stepCode, _stepSandbox, _stepShell,
//   _stepSearch, _stepAsk, _stepDelegate
//   _extractSkills(description) → string[]
// ============================================================

const { TIMEOUTS } = require('../core/Constants');
const { createLogger } = require('../core/Logger');
const path = require('path');
const fs = require('fs');
const _log = createLogger('AgentLoopSteps');

class AgentLoopStepsDelegate {
  /**
   * @param {import('./AgentLoop').AgentLoop} loop - Parent AgentLoop instance
   */
  constructor(loop) {
    this.loop = loop;
  }

  async _executeStep(step, context, onProgress) {
    const start = Date.now();
    const loop = this.loop;

    // v6.0.8: Symbolic resolution — check if we already know the answer
    let enrichedContext = context;
    let symbolicResult = null;
    if (loop._symbolicResolver) {
      try {
        symbolicResult = loop._symbolicResolver.resolve(
          step.type, step.description, step.target,
          { model: loop.model?.activeModel, goalId: loop.currentGoalId }
        );

        if (symbolicResult.level === 'direct' && symbolicResult.lesson) {
          // DIRECT: bypass LLM entirely — use known solution
          const lesson = symbolicResult.lesson;
          const output = lesson.strategy?.command
            ? `[SYMBOLIC-DIRECT] Applying known fix: ${lesson.insight}`
            : `[SYMBOLIC-DIRECT] ${lesson.insight}`;

          // Execute the known command if available
          if (lesson.strategy?.command && step.type === 'SHELL' && loop.shell) {
            try {
              const shellResult = await loop.shell.run(lesson.strategy.command);
              loop._symbolicResolver.recordOutcome('direct', lesson.id, !shellResult.error);
              return { output: shellResult.output || output, error: shellResult.error || null, durationMs: Date.now() - start, symbolic: 'direct' };
            } catch (err) {
              loop._symbolicResolver.recordOutcome('direct', lesson.id, false);
              // Fall through to normal LLM pipeline
            }
          } else {
            // For non-shell DIRECT, return the insight as the analysis
            loop._symbolicResolver.recordOutcome('direct', lesson.id, true);
            return { output, error: null, durationMs: Date.now() - start, symbolic: 'direct' };
          }
        }

        if (symbolicResult.level === 'guided' && symbolicResult.directive) {
          // GUIDED: enrich the context with the directive
          enrichedContext = symbolicResult.directive + '\n\n' + context;
        }
      } catch (err) {
        // Symbolic resolution should never block the pipeline
        _log.debug('[STEPS] Symbolic resolution error:', err.message);
      }
    }

    try {
      switch (step.type) {
        case 'ANALYZE':
          return { ...(await this._stepAnalyze(step, enrichedContext)), durationMs: Date.now() - start };

        case 'CODE':
          return { ...(await this._stepCode(step, enrichedContext, onProgress)), durationMs: Date.now() - start };

        case 'SANDBOX':
          return { ...(await this._stepSandbox(step, enrichedContext)), durationMs: Date.now() - start };

        case 'SHELL':
          return { ...(await this._stepShell(step, enrichedContext, onProgress)), durationMs: Date.now() - start };

        case 'SEARCH':
          return { ...(await this._stepSearch(step, enrichedContext)), durationMs: Date.now() - start };

        case 'ASK':
          return { ...(await this._stepAsk(step, onProgress)), durationMs: Date.now() - start };

        case 'DELEGATE':
          return { ...(await this._stepDelegate(step, enrichedContext, onProgress)), durationMs: Date.now() - start };

        default:
          return { output: `Unknown step type: ${step.type}`, error: null, durationMs: Date.now() - start };
      }
    } catch (err) {
      return { output: '', error: err.message, durationMs: Date.now() - start };
    }
  }

  async _stepAnalyze(step, context) {
    const loop = this.loop;
    // Read target file/module and analyze
    let fileContent = '';
    if (step.target && loop.selfModel) {
      fileContent = loop.selfModel.readModule(step.target) || '';
    }

    const prompt = `${context}\n\nANALYZE: ${step.description}${fileContent ? '\n\nFile content:\n```\n' + fileContent.slice(0, 3000) + '\n```' : ''}\n\nProvide a concise analysis (max 5 key points). If code changes are needed, describe them specifically.`;

    const analysis = await loop.model.chat(prompt, [], 'analysis');

    // Store insights in KG
    if (loop.kg && analysis) {
      loop.kg.learnFromText(analysis, 'agent-loop-analysis');
    }

    return { output: analysis, error: null };
  }

  async _stepCode(step, context, onProgress) {
    const loop = this.loop;
    // Generate code for the target file
    const existingCode = step.target && loop.selfModel
      ? loop.selfModel.readModule(step.target) || ''
      : '';

    const prompt = `${context}\n\nCODE TASK: ${step.description}\n${step.target ? `TARGET FILE: ${step.target}` : ''}${existingCode ? '\n\nExisting code:\n```javascript\n' + existingCode.slice(0, 4000) + '\n```' : ''}\n\nGenerate the complete file content. Respond ONLY with the code inside a single code block.`;

    const response = await loop.model.chat(prompt, [], 'code');

    // Extract code from response
    const codeMatch = response.match(/```(?:\w+)?\n([\s\S]+?)```/);
    if (!codeMatch) {
      return { output: response, error: 'No code block found in LLM response' };
    }

    const newCode = codeMatch[1].trim();

    // Security: validate write target
    if (step.target) {
      const fullPath = path.join(loop.rootDir, step.target);
      try {
        loop.guard.validateWrite(fullPath);
      } catch (err) {
        return { output: '', error: `Security: ${err.message}` };
      }
    }

    // Test the code first
    const test = await loop.sandbox.testPatch(step.target || 'agent-loop-output.js', newCode);
    if (!test.success) {
      return {
        output: `Code generated but test failed: ${test.error}`,
        error: `Test failed: ${test.error}`,
        code: newCode,
      };
    }

    // Request approval for file writes (safety)
    if (step.target) {
      onProgress({
        phase: 'approval-needed',
        detail: `Write ${newCode.split('\n').length} lines to ${step.target}?`,
        action: 'write-file',
      });

      const approved = await loop._requestApproval(
        'write-file',
        `Write ${newCode.split('\n').length} lines to ${step.target}`
      );

      if (!approved) {
        return { output: 'User rejected file write', error: null, code: newCode };
      }

      // Write the file — FIX v4.10.0: Async atomic write
      const { atomicWriteFile } = require('../core/utils');
      const fullPath = path.join(loop.rootDir, step.target);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await atomicWriteFile(fullPath, newCode, 'utf-8');
    }

    return { output: `Code written: ${step.target || 'sandbox'} (${newCode.split('\n').length} lines, test passed)`, error: null };
  }

  async _stepSandbox(step, context) {
    const loop = this.loop;
    // Generate test code and run in sandbox
    const prompt = `${context}\n\nSANDBOX TEST: ${step.description}\n\nGenerate a JavaScript test that verifies this. Use console.log for output. Respond ONLY with code in a code block.`;

    const response = await loop.model.chat(prompt, [], 'code');
    const codeMatch = response.match(/```(?:\w+)?\n([\s\S]+?)```/);
    const testCode = codeMatch ? codeMatch[1].trim() : step.target || '';

    if (!testCode) {
      return { output: 'No test code generated', error: 'Empty test' };
    }

    const result = await loop.sandbox.execute(testCode, { timeout: TIMEOUTS.SANDBOX_EXEC });
    return {
      output: result.output || '',
      error: result.error || null,
    };
  }

  async _stepShell(step, context, onProgress) {
    const loop = this.loop;
    // Extract or generate shell command
    let command = step.target || '';

    if (!command) {
      const prompt = `${context}\n\nSHELL TASK: ${step.description}\n\nWhat is the exact shell command to run? Respond with ONLY the command, no explanation.`;
      command = (await loop.model.chat(prompt, [], 'code')).trim().replace(/^```\w*\n?|\n?```$/g, '');
    }

    // Safety: request approval for shell commands
    onProgress({
      phase: 'approval-needed',
      detail: `Run: ${command}`,
      action: 'shell-command',
    });

    const approved = await loop._requestApproval('shell-command', `Run: ${command}`);
    if (!approved) {
      return { output: 'User rejected shell command', error: null };
    }

    // Execute via ShellAgent if available, otherwise direct
    if (loop.shell) {
      const result = loop.shell.run(command, { cwd: loop.rootDir, timeout: TIMEOUTS.SHELL_EXEC });
      return { output: result.stdout || '', error: result.stderr || null };
    }

    // Fallback: direct exec (async, no shell)
    // FIX v4.0.1: execFile with array args — prevents shell injection
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    try {
      // Split command into bin + args for shell-free execution
      const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [command];
      const bin = parts[0];
      const args = parts.slice(1).map(a => a.replace(/^["']|["']$/g, ''));
      const { stdout } = await execFileAsync(bin, args, {
        cwd: loop.rootDir,
        timeout: TIMEOUTS.SHELL_EXEC,
        encoding: 'utf-8',
        windowsHide: true,
      });
      return { output: stdout, error: null };
    } catch (err) {
      return { output: err.stdout || '', error: err.stderr || err.message };
    }
  }

  async _stepSearch(step, context) {
    const loop = this.loop;
    // Use WebFetcher or KnowledgeGraph for information lookup
    const searchResult = await loop.bus.request('web:search', {
      query: step.description,
    });

    if (searchResult) {
      return { output: typeof searchResult === 'string' ? searchResult : JSON.stringify(searchResult).slice(0, 2000), error: null };
    }

    // Fallback: ask the LLM from its training knowledge
    const response = await loop.model.chat(
      `Research task: ${step.description}\n\nProvide the key information needed. Be specific and factual.`,
      [], 'analysis'
    );
    return { output: response, error: null };
  }

  async _stepAsk(step, onProgress) {
    const loop = this.loop;
    // Pause and wait for user input
    onProgress({
      phase: 'waiting-for-user',
      detail: step.description,
      action: 'user-input-needed',
    });

    loop.bus.fire('agent-loop:needs-input', {
      goalId: loop.currentGoalId,
      question: step.description,
    }, { source: 'AgentLoop' });

    // The response will come through the approval mechanism
    const approved = await loop._requestApproval('user-input', step.description);
    return { output: approved ? 'User confirmed' : 'User declined', error: null };
  }

  // v3.5.0: DELEGATE step — send sub-task to a peer agent
  async _stepDelegate(step, context, onProgress) {
    const loop = this.loop;
    if (!loop.taskDelegation) {
      // Fallback: treat as ANALYZE (no peers available)
      return this._stepAnalyze({
        ...step, type: 'ANALYZE',
        description: `[Delegation unavailable — local analysis] ${step.description}`,
      }, context);
    }

    const requiredSkills = step.skills || this._extractSkills(step.description);

    onProgress({
      phase: 'delegating',
      detail: `Delegiere an Peer: ${step.description.slice(0, 80)}`,
      action: 'delegation',
      skills: requiredSkills,
    });

    // Request approval — user should know work leaves this agent
    const approved = await loop._requestApproval(
      'delegate-task',
      `Aufgabe an Peer delegieren: ${step.description.slice(0, 120)}\nSkills: [${requiredSkills.join(', ') || 'allgemein'}]`
    );

    if (!approved) {
      onProgress({ phase: 'delegation-rejected', detail: 'Delegation rejected — executing locally' });
      return this._stepAnalyze(step, context);
    }

    loop.bus.emit('agent-loop:step-delegating', {
      description: step.description, skills: requiredSkills,
    }, { source: 'AgentLoop' });

    const result = await loop.taskDelegation.delegate(
      step.description, requiredSkills,
      { parentGoalId: loop.currentGoalId, deadline: Date.now() + 5 * 60 * 1000 }
    );

    if (result.success) {
      onProgress({ phase: 'delegation-complete', detail: `Peer ${result.peerId} delivered result` });
      const output = typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result, null, 2).slice(0, 3000);
      return { output: `[Delegiert an ${result.peerId}]\n${output}`, error: null };
    }

    // Failed — fall back to local
    onProgress({ phase: 'delegation-failed', detail: `${result.error} — executing locally` });
    return this._stepAnalyze({
      ...step, type: 'ANALYZE',
      description: `[Delegation failed: ${result.error}] ${step.description}`,
    }, context);
  }

  _extractSkills(description) {
    const d = description.toLowerCase();
    const skills = [];
    if (/(?:test|pruef|spec|jest|mocha)/.test(d)) skills.push('testing');
    if (/(?:code|implement|refactor|schreib|write)/.test(d)) skills.push('coding');
    if (/(?:deploy|docker|kubernetes|ci|cd|pipeline)/.test(d)) skills.push('devops');
    if (/(?:design|ui|css|layout|figma)/.test(d)) skills.push('design');
    if (/(?:daten|data|sql|database|db)/.test(d)) skills.push('data');
    if (/(?:security|auth|encrypt|sicher)/.test(d)) skills.push('security');
    if (/(?:api|endpoint|rest|graphql)/.test(d)) skills.push('api');
    return skills;
  }
}

// v3.8.0: Export delegate class. Legacy bare-function exports removed.
module.exports = { AgentLoopStepsDelegate };
