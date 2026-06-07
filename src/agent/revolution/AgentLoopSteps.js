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

const { TIMEOUTS, THRESHOLDS } = require('../core/Constants');
const { createLogger } = require('../core/Logger');
const { normalizeStepType, getStepRequirements } = require('../core/step-types');
const { _filterImplausibleFilePaths } = require('./PathPlausibility');
const { extractDeleteTarget } = require('./DeleteCommandHeuristic');
const { trySkillStep } = require('./skill-step');
// v7.9.11: Win console codepage handling for SHELL-step fallback
const { decodeWinConsole } = require('../core/shell/WinConsoleEncoding');
const { toPosix } = require('../core/utils');
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

  // v7.9.20 (C): thin delegate — the triple-gated skill-step logic lives in
  // skill-step.js so this file stays under the File Size Guard.
  async _stepHandledBySkill(step, _context) {
    const skillManager = this.loop && this.loop.skillManager;
    if (!skillManager) return null;
    return trySkillStep({ step, skillManager, log: _log });
  }

  async _executeStep(step, context, onProgress) {
    const start = Date.now();
    const loop = this.loop;

    // v6.0.8: Symbolic resolution — check if we already know the answer
    let enrichedContext = context;
    let symbolicResult = null;
    if (loop._symbolicResolver) {
      try {
        // v7.9.9 Fix 1: pass current goalDescription to resolver so it
        // can gate AVOID-past-failure lessons by token-overlap to the
        // current pursuit, preventing cross-goal contamination.
        const _goalDesc = (loop.goalStack?.goals?.find?.(g => g.id === loop.currentGoalId)?.description) || '';
        symbolicResult = loop._symbolicResolver.resolve(
          step.type, step.description, step.target,
          { model: loop.model?.activeModel, goalId: loop.currentGoalId, goalDescription: _goalDesc }
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

    // v7.0.9 Phase 1: Causal tracking — snapshot WorldState before step
    const worldState = loop.worldState || loop._worldState;
    const causalAnnotation = loop._causalAnnotation;
    const beforeSnap = worldState?.snapshot?.() || null;

    let stepResult;
    try {
      // v7.3.5: Normalize step type before dispatch. Catches plans from any
      // source — AgentLoopPlanner, FormalPlanner, _salvagePlan, manually-set
      // goals, HTN-produced plans — so aliases like WRITE_FILE or GIT_SNAPSHOT
      // are rewritten to CODE/SHELL instead of hitting the default branch.
      // v7.9.7: defensive guard against bare-string steps. normalizeStepTypes
      // (plan-context.js) wraps these at the replan boundary, but a step
      // can reach _executeStep through other paths (preset steps, HTN
      // output, _salvagePlan, manually-injected goals) so the fallback
      // below also needs the type-guard. Without it, `step.description =
      // ...` on a string entry crashes with "Cannot create property
      // 'description' on string" — the v7.9.6 outpost-trace pattern.
      // Reassign the local param (step is a function arg, not an array
      // entry) so the rest of the step-execution pipeline sees a real
      // object.
      if (typeof step !== 'object' || step === null || Array.isArray(step)) {
        const kind = step === null ? 'null' : (Array.isArray(step) ? 'array' : typeof step);
        let asText;
        if (typeof step === 'string') {
          asText = step;
        } else {
          try { asText = JSON.stringify(step); } catch (_e) { asText = String(step); }
          if (typeof asText !== 'string') asText = String(step);
        }
        _log.warn(`[STEPS] Step was not a plan object (${kind}) — wrapping as ANALYZE: "${asText.slice(0, 80)}"`);
        // eslint-disable-next-line no-param-reassign
        step = { type: 'ANALYZE', description: `[was ${kind}] ${asText}`.trim() };
      }
      const normalizedType = normalizeStepType(step.type);
      if (normalizedType && normalizedType !== step.type) {
        _log.debug(`[STEPS] Normalized step type "${step.type}" → "${normalizedType}"`);
        step.type = normalizedType;
      } else if (!normalizedType) {
        // v7.7.9 (post-Phase-3b): defensive fallback for steps that arrive
        // with missing/unknown type. Pre-fix shape: a step with type=undefined
        // (LLM produced JSON without the `type` field, or an upstream path
        // bypassed AgentLoopPlanner's normalisation loop) fell through Z. 92's
        // truthy-check and hit the switch default with "Unknown step type:
        // undefined". Live-Befund 2026-05-12 burn-in: 6/9 steps in
        // "Automated Error Lesson Generation" showed this exact symptom,
        // and the goal was still marked completed by GoalDriver despite
        // zero substantive execution. Fallback: rewrite to ANALYZE (same
        // strategy AgentLoopPlanner Z. 158 uses) so the step at least gets
        // read-only treatment instead of silently no-oping into a fake
        // success-summary. The description is annotated so the fallback is
        // visible in logs and self-statements.
        const _origType = (typeof step.type === 'string' && step.type)
          ? step.type
          : '<missing>';
        _log.warn(`[STEPS] Step had unknown/missing type "${_origType}" — falling back to ANALYZE`);
        step.description = `[was ${_origType}] ${step.description || ''}`.trim();
        step.type = 'ANALYZE';
      }

      // v7.4.5 Baustein C: Pre-existence check.
      // Resolve required resources for this step type and ask the
      // ResourceRegistry. If anything is missing, return a special
      // "blocked" result so AgentLoop can park the goal until the
      // resource(s) come back, instead of failing the step.
      //
      // v7.7.9 Phase 3 (bug-3 fix): Before blocking, run a pathPlausibility
      // check on any missing file:-resources. The LLM-step-generator can
      // hallucinate paths that will never exist (live-Befund 2026-05-10:
      // "logs\self-statement.log" — neither inside the project nor created
      // anywhere). Blocking on those resources parks the goal forever and
      // bypasses the failure-reflection path entirely (PSE pipeline never
      // sees them). We catch implausible paths here and convert them to
      // a normal step failure instead, which routes through the standard
      // reflection mechanism.
      const resourceRegistry = loop.resourceRegistry || loop._resourceRegistry;
      if (resourceRegistry && resourceRegistry.requireAll) {
        try {
          const required = getStepRequirements(step.type, step);
          if (required.length > 0) {
            const check = resourceRegistry.requireAll(required);
            if (!check.ok) {
              // v7.7.9 Phase 3: path-plausibility filter on missing file:-tokens.
              // If ALL missing tokens are file:-tokens AND none is plausible,
              // fail the step instead of blocking. If at least one missing
              // resource is plausible (or non-file:), keep the block — those
              // are legitimate waits.
              const implausiblePaths = _filterImplausibleFilePaths(
                check.missing, loop.rootDir || process.cwd()
              );
              if (implausiblePaths.length > 0 &&
                  implausiblePaths.length === check.missing.length) {
                _log.info(`[STEPS] step failed — implausible paths: ${implausiblePaths.join(', ')}`);
                return {
                  output: null,
                  error: `Plausibility check failed for: ${implausiblePaths.join(', ')} (path does not exist and parent directory not within project scope)`,
                  durationMs: Date.now() - start,
                };
              }
              _log.info(`[STEPS] step blocked — missing resources: ${check.missing.join(', ')}`);
              // v7.9.9 final: for idle-mind-sourced goals, never block-and-wait
              // for resources. Idle-mind goals are agent-initiated activities,
              // not user-driven requests — there is nobody who is going to
              // make the missing file appear. Field-test 2026-05-24 showed
              // a 15-minute stall waiting on a hallucinated test\AgentCoreHealth.test.js.
              // Convert to immediate failure so the recovery path (FailureTaxonomy,
              // decompose-on-failure) runs instead of the StalledGoalWatchdog.
              const goalSource = loop?.goalStack?.getById?.(loop.currentGoalId)?.source;
              if (goalSource === 'idle-mind') {
                return {
                  output: null,
                  error: `Resource(s) unavailable for idle-mind goal: ${check.missing.join(', ')}`,
                  durationMs: Date.now() - start,
                };
              }
              return {
                output: null,
                error: `Resource(s) unavailable: ${check.missing.join(', ')}`,
                durationMs: Date.now() - start,
                blocked: true,
                blockedByResources: check.missing,
              };
            }
          }
        } catch (err) {
          // Pre-check is best-effort — never let it fail the step
          _log.debug('[STEPS] resource pre-check error (continuing):', err.message);
        }
      }

      // v7.9.20 (C): an installed, autonomous, AST-cleared skill may fulfil
      // this step before the built-in switch. Gate failures fall through.
      const _skillStepResult = await this._stepHandledBySkill(step, enrichedContext);
      if (_skillStepResult) {
        stepResult = { ..._skillStepResult, durationMs: Date.now() - start };
      } else
      switch (step.type) {
        case 'ANALYZE':
          stepResult = { ...(await this._stepAnalyze(step, enrichedContext)), durationMs: Date.now() - start };
          break;
        case 'CODE':
          stepResult = { ...(await this._stepCode(step, enrichedContext, onProgress)), durationMs: Date.now() - start };
          break;
        case 'SANDBOX':
          stepResult = { ...(await this._stepSandbox(step, enrichedContext)), durationMs: Date.now() - start };
          break;
        case 'SHELL':
          stepResult = { ...(await this._stepShell(step, enrichedContext, onProgress)), durationMs: Date.now() - start };
          break;
        case 'SEARCH':
          stepResult = { ...(await this._stepSearch(step, enrichedContext)), durationMs: Date.now() - start };
          break;
        case 'ASK':
          stepResult = { ...(await this._stepAsk(step, onProgress)), durationMs: Date.now() - start };
          break;
        case 'DELEGATE':
          stepResult = { ...(await this._stepDelegate(step, enrichedContext, onProgress)), durationMs: Date.now() - start };
          break;
        default:
          // v7.7.9 (post-Phase-3b): defense-in-depth. With the pre-switch
          // normalisation above this branch should be unreachable, but if
          // a step somehow arrives with an unknown type that the normaliser
          // ALSO declines (shouldn't happen because we fall back to ANALYZE),
          // mark it as an actual error so it doesn't count as success in
          // verification/summary stats. Pre-fix: error=null caused the
          // post-execution summary to count "Unknown step type" outputs as
          // success, inflating the success rate (live: "9 steps: 0
          // verified, 7 ambiguous, 2 errors. Success rate: 78%" with all
          // executed steps actually being no-ops).
          stepResult = {
            output: '',
            error: `Unknown step type: ${step.type} (post-normalisation; this should not happen)`,
            durationMs: Date.now() - start,
          };
      }
    } catch (err) {
      stepResult = { output: '', error: err.message, durationMs: Date.now() - start };
    }

    // v7.0.9 Phase 1: Causal tracking — diff and record
    if (beforeSnap && worldState?.diff && causalAnnotation) {
      try {
        const afterSnap = worldState.snapshot();
        const delta = worldState.diff(beforeSnap, afterSnap);
        if (delta.changes.length > 0) {
          causalAnnotation.record({
            stepId: step.id || `step-${Date.now()}`,
            toolCalls: [{ tool: step.type, args: { target: step.target, description: step.description }, timestamp: start }],
            delta,
            outcome: stepResult.error ? 'failure' : 'success',
            source: loop.currentGoalSource || 'user-task',
          });
        }
      } catch (causalErr) {
        // Causal tracking should never block the pipeline
        _log.debug('[STEPS] Causal tracking error:', causalErr.message);
      }
    }

    return stepResult;
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

    // v7.9.20 (F2): consolidation primitive. Write a durable, language-agnostic
    // insight node DIRECTLY (the way ReadSource does) instead of routing through
    // learnFromText, whose DE-first patterns drop English code analyses — the
    // field had 0 agent-loop-analysis nodes despite repeated inspections. Keyed
    // by the POSIX module path (F1) so the same file has one stable key.
    // Novelty-gated: a repeat that learns nothing new is not stored, which —
    // together with L1 reading these nodes — is what ends the inspection loop.
    if (loop.kg && analysis) {
      const moduleKey = toPosix(step.target || '');
      if (this._isNovelAnalysis(loop.kg, moduleKey, analysis)) {
        const label = moduleKey
          ? `review: ${moduleKey}: ${analysis.slice(0, 60)}`
          : `analysis: ${analysis.slice(0, 60)}`;
        loop.kg.addNode('insight', label, {
          type: 'agent-loop-analysis',
          module: moduleKey || null,
          full: analysis.slice(0, 400),
        });
      }
    }

    return { output: analysis, error: null };
  }

  // v7.9.20 (F2): novelty gate for consolidation. Returns false only when an
  // agent-loop-analysis insight for the SAME module already exists and the new
  // analysis is substantially the same (token-Jaccard >= 0.8). A first analysis,
  // a different module, or a genuinely new finding is always novel. Defensive: a
  // KG without getNodesByType, or no module key, defaults to novel (store it).
  _isNovelAnalysis(kg, moduleKey, analysis) {
    if (!moduleKey || typeof kg.getNodesByType !== 'function') return true;
    let existing;
    try { existing = kg.getNodesByType('insight') || []; } catch (_e) { return true; }
    const tok = (s) => new Set(String(s || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
    const novelTokens = tok(analysis);
    if (novelTokens.size === 0) return true;
    for (const n of existing) {
      const p = (n && n.properties) || {};
      if (p.type !== 'agent-loop-analysis' || (p.module || '') !== moduleKey) continue;
      const prev = tok(p.full || (n && n.label) || '');
      let inter = 0;
      for (const t of novelTokens) if (prev.has(t)) inter++;
      const union = novelTokens.size + prev.size - inter;
      if (union > 0 && inter / union >= 0.8) return false; // substantially the same
    }
    return true;
  }

  async _stepCode(step, context, onProgress) {
    const loop = this.loop;
    // Generate code for the target file
    const existingCode = step.target && loop.selfModel
      ? loop.selfModel.readModule(step.target) || ''
      : '';

    // v7.9.7 R4: PROJECT_API_CONVENTIONS block. The LLM in the outpost
    // trace repeatedly generated code patterns that violate Genesis'
    // module APIs — `new Logger(...)` instead of `createLogger(...)`,
    // `new EventBus()` constructed by clients instead of resolved via
    // the container, `require('../../core/EventBus')` from positions
    // that don't resolve. The conventions block surfaces the API
    // shapes the LLM keeps getting wrong, so it sees the correct
    // pattern in the prompt before generating.
    const apiConventions = `\nPROJECT API CONVENTIONS (use these EXACT shapes):\n` +
      `  - Logger:       const { createLogger } = require('<path>/core/Logger');  // factory, NOT 'new Logger(...)'\n` +
      `  - EventBus:     resolve via Container.resolve('bus') — clients NEVER call 'new EventBus()' directly.\n` +
      `  - Storage:      const storage = c.resolve('storage');  // read/writeJSON methods, NOT 'new StorageService(...)'\n` +
      `  - Container:    constructor-injected as 'c' or this.container — never reach into globals.\n`;

    const prompt = `${context}${apiConventions}\nCODE TASK: ${step.description}\n${step.target ? `TARGET FILE: ${step.target}` : ''}${existingCode ? '\n\nExisting code:\n```javascript\n' + existingCode.slice(0, 4000) + '\n```' : ''}\n\nGenerate the complete file content. Respond ONLY with the code inside a single code block.`;

    const response = await loop.model.chat(prompt, [], 'code');

    // Extract code from response
    const codeMatch = response.match(/```(?:\w+)?\n([\s\S]+?)```/);
    if (!codeMatch) {
      return { output: response, error: 'No code block found in LLM response' };
    }

    const newCode = codeMatch[1].trim();

    // v7.9.7 R4: pre-flight scan for hallucinated require paths. Match
    // any `require('...')` literal whose target does not resolve relative
    // to the target file (or the project root if no target). Skip
    // node-builtins and npm packages (no leading dot). Anything that
    // looks like a relative project import and resolves to nothing
    // gets surfaced as a structural failure BEFORE the heavier
    // sandbox.testPatch round-trip — same shape the failure-patterns
    // regex recognises so GoalDriver fast-tracks to obsolete on retry.
    try {
      const fs = require('fs');
      const requireRe = /require\(\s*['"]((?:\.\.?\/)[^'"]+)['"]\s*\)/g;
      const targetPath = step.target ? path.join(loop.rootDir, step.target) : path.join(loop.rootDir, 'src/agent/__placeholder__.js');
      const targetDir = path.dirname(targetPath);
      const invalidPaths = [];
      let m;
      while ((m = requireRe.exec(newCode)) !== null) {
        const rel = m[1];
        const tryPaths = [rel, rel + '.js', rel + '/index.js'];
        let resolved = false;
        for (const p of tryPaths) {
          try {
            const abs = path.resolve(targetDir, p);
            if (fs.existsSync(abs)) { resolved = true; break; }
          } catch (_e) { /* ignore */ }
        }
        if (!resolved) invalidPaths.push(rel);
      }
      if (invalidPaths.length > 0) {
        const shown = invalidPaths.slice(0, 3).join(', ');
        return {
          output: '',
          error: `Invalid target path (hallucinated): ${shown}${invalidPaths.length > 3 ? ` (+${invalidPaths.length - 3} more)` : ''}`,
          code: newCode,
        };
      }
    } catch (_e) { /* best-effort; fall through to sandbox check */ }

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

      const approved = await loop.approval.request(
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

    // v7.8.4: do NOT pre-declare "test passed" — that's the verifier's
    // job in AgentLoopPursuit, which runs after this step. Saying it
    // here would be a lie when verification later fails. Output stays
    // neutral; pursuit-layer overlays a verification marker if needed.
    return { output: `Code written: ${step.target || 'sandbox'} (${newCode.split('\n').length} lines)`, error: null };
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
    // v7.4.6.fix #28: read both step.target and step.command — LLM often puts the command in either.
    let command = step.target || step.command || '';

    if (!command) {
      // v7.4.6.fix #28: enrich the fallback prompt with OS + rootDir +
      // explicit don'ts. Previously the fallback had only step.description
      // and the LLM had no way to know it was on Windows or where to run.
      const platform = process.platform;
      const isWindows = platform === 'win32';
      const osName = isWindows ? 'Windows' : (platform === 'darwin' ? 'macOS' : 'Linux');
      const rootDir = loop.rootDir || process.cwd();
      const osHints = isWindows
        ? `OS: Windows (cmd.exe). Use "dir /b" not "ls". Use "type" not "cat". Use "where" not "which".\nDO NOT use "/s" with absolute paths like C:\\ — Windows blocks system folders.\nUse RELATIVE paths inside the working directory.`
        : `OS: ${osName} (bash). Use POSIX commands.\nUse RELATIVE paths inside the working directory.`;
      const prompt = `${context}\n\nSHELL TASK: ${step.description}\n\nWorking directory: ${rootDir}\n${osHints}\n\nWhat is the exact shell command to run? Respond with ONLY the command, no explanation, no markdown fence.`;
      command = (await loop.model.chat(prompt, [], 'code')).trim().replace(/^```\w*\n?|\n?```$/g, '');
    }

    // v7.4.6.fix #28: hard-refuse if still empty. Empty command on
    // Windows previously got interpreted by cmd.exe as a no-op that
    // wrote a stray byte to the current dir → "Zugriff verweigert".
    // Better to fail fast with a clear message.
    if (!command || !command.trim()) {
      return {
        output: '',
        error: 'SHELL step has no command (target/command both empty, fallback LLM returned blank). Plan likely malformed — check FormalPlanner output.',
        command: '',
      };
    }

    // v7.8.4: pre-deletion audit. Run CleanupVerifier on a shell-delete
    // target and surface findings in the approval text. Skipped silently
    // when the command is not a single-file delete inside rootDir.
    let cleanupReport = null;
    const deleteTarget = extractDeleteTarget(command, loop.rootDir);
    if (deleteTarget) {
      try {
        const { CleanupVerifier } = require('../capabilities/CleanupVerifier');
        cleanupReport = await new CleanupVerifier({ rootDir: loop.rootDir, bus: loop.bus }).verify(deleteTarget);
      } catch (err) { _log.debug(`[AGENT-LOOP] CleanupVerifier failed: ${err.message}`); }
    }

    // Safety: request approval for shell commands
    let approvalDetail = `Run: ${command}`;
    if (cleanupReport && !cleanupReport.safe && cleanupReport.findings.length > 0) {
      approvalDetail += `\n\n⚠ Pre-deletion audit findings for ${cleanupReport.target}:`;
      for (const f of cleanupReport.findings) approvalDetail += `\n  • [${f.kind}] ${f.message}`;
    }

    onProgress({
      phase: 'approval-needed',
      detail: approvalDetail,
      action: 'shell-command',
    });

    const approved = await loop.approval.request('shell-command', approvalDetail);
    if (!approved) {
      return { output: 'User rejected shell command', error: null };
    }

    // Execute via ShellAgent if available, otherwise direct
    if (loop.shell) {
      // v7.4.5.fix #26: ShellAgent.run() is async — without await,
      // `result` was the Promise itself, `result.stdout` was undefined,
      // and the SHELL step silently returned an empty output. The
      // Verifier saw `error: null` and counted it as success, while
      // the user got no actual command output. The shell command was
      // either never observed to completion (fire-and-forget) or the
      // output was lost because we returned before resolution.
      const result = await loop.shell.run(command, { cwd: loop.rootDir, timeout: TIMEOUTS.SHELL_EXEC });
      // v7.4.6.fix #28: include command + adapted command in result so
      // Verifier _formatOutputs can show the user what actually ran.
      return {
        output: result.stdout || '',
        error: result.stderr || null,
        command,
        adaptedCommand: result.adaptedCommand || command,
      };
    }

    // Fallback: direct exec (async, no shell)
    // FIX v4.0.1: execFile with array args — prevents shell injection
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    try {
      // Split command into bin + args for shell-free execution.
      // v7.7.7: length-guard before regex match — the regex
      // `(?:[^\s"']+|"[^"]*"|'[^']*')+` has a quantified group around an
      // alternation that could backtrack quadratically on pathological
      // inputs (long unquoted strings without whitespace). Real risk is
      // very low (input is LLM-generated, execFile not shell, AGENT_LOOP
      // timeout would unstick it), but the guard is 1 LOC.
      if (command.length > 2000) {
        return { output: '', error: 'command too long', command };
      }
      const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [command];
      const bin = parts[0];
      const args = parts.slice(1).map(a => a.replace(/^["']|["']$/g, ''));
      const isWin = process.platform === 'win32';
      const { stdout } = await execFileAsync(bin, args, {
        cwd: loop.rootDir,
        timeout: TIMEOUTS.SHELL_EXEC,
        // v7.9.11: read raw buffer on Win, decode with detected codepage.
        // Pre-fix utf-8 produced U+FFFD on cp850 output.
        encoding: isWin ? 'buffer' : 'utf-8',
        windowsHide: true,
      });
      const output = isWin ? decodeWinConsole(stdout) : stdout;
      return { output, error: null, command };
    } catch (err) {
      const isWin = process.platform === 'win32';
      const errOut = isWin ? decodeWinConsole(err.stdout) : (err.stdout || '');
      const errErr = isWin ? decodeWinConsole(err.stderr) : (err.stderr || err.message);
      return { output: errOut, error: errErr, command };
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
    const approved = await loop.approval.request(
      'delegate-task',
      `Aufgabe an Peer delegieren: ${step.description.slice(0, 120)}\nSkills: [${requiredSkills.join(', ') || 'allgemein'}]`
    );

    if (!approved) {
      onProgress({ phase: 'delegation-rejected', detail: 'Delegation rejected — executing locally' });
      return this._stepAnalyze(step, context);
    }

    loop.bus.fire('agent-loop:step-delegating', {
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

  // ═══════════════════════════════════════════════════════════
  // Extracted from AgentLoop — repair, verification, tags
  // ═══════════════════════════════════════════════════════════

  /**
   * Attempt to repair a failed step via LLM analysis + retry.
   */
  async attemptRepair(failedStep, failedResult, allResults, onProgress) {
    const loop = this.loop;
    onProgress({ phase: 'repairing', detail: `Attempting to fix: ${failedResult.error}` });

    const prompt = `You are Genesis. A step in your autonomous execution failed.

Failed step: ${failedStep.type} — ${failedStep.description}
Error: ${failedResult.error}
Output: ${(failedResult.output || '').slice(0, 500)}

What went wrong and how can you fix it? Provide a corrected approach.
If the error is unfixable (e.g., missing dependency, permission denied), say "UNFIXABLE: reason".`;

    const analysis = await loop.model.chat(prompt, [], 'analysis');

    if (analysis.includes('UNFIXABLE')) {
      return { recovered: false, output: analysis };
    }

    const repairedStep = { ...failedStep };
    const repairContext = `REPAIR ATTEMPT: Previous error was "${failedResult.error}". Fix: ${analysis.slice(0, 500)}`;
    const retryResult = await this._executeStep(repairedStep, repairContext, onProgress);

    return {
      recovered: !retryResult.error,
      output: retryResult.output,
      error: retryResult.error,
    };
  }

  /**
   * Verify whether a goal was achieved based on step results.
   */
  async verifyGoal(plan, allResults) {
    const loop = this.loop;
    const errors = allResults.filter(r => r.error);
    const successRate = (allResults.length - errors.length) / allResults.length;

    const verified = allResults.filter(r => r.verification);
    const programmaticPasses = verified.filter(r => r.verification.status === 'pass').length;
    const programmaticFails = verified.filter(r => r.verification.status === 'fail').length;
    const ambiguous = verified.filter(r => r.verification.status === 'ambiguous').length;

    if (verified.length > 0 && programmaticFails === 0 && successRate >= THRESHOLDS.GOAL_SUCCESS_PROGRAMMATIC) {
      return {
        success: true,
        summary: `Goal "${plan.title}" completed. ${allResults.length} steps: ${programmaticPasses} verified, ${ambiguous} ambiguous, ${errors.length} errors. Success rate: ${Math.round(successRate * 100)}%.`,
        verificationMethod: 'programmatic',
      };
    }

    if (successRate >= THRESHOLDS.GOAL_SUCCESS_HEURISTIC && programmaticFails === 0) {
      return {
        success: true,
        summary: `Goal "${plan.title}" completed. ${allResults.length} steps, ${errors.length} errors. Success rate: ${Math.round(successRate * 100)}%.`,
        verificationMethod: 'heuristic',
      };
    }

    const verificationContext = verified.length > 0
      ? `\nProgrammatic verification: ${programmaticPasses} pass, ${programmaticFails} fail, ${ambiguous} ambiguous`
      : '';

    const prompt = `Goal: "${plan.title}"
Success criteria: ${plan.successCriteria || 'All steps complete'}
Steps completed: ${allResults.length}
Errors: ${errors.length}
Error details: ${errors.map(e => e.error).join('; ')}${verificationContext}

Was this goal achieved? Respond with: SUCCESS or PARTIAL or FAILED, followed by a brief explanation.`;

    const evaluation = await loop.model.chat(prompt, [], 'analysis');

    if (loop.episodicMemory) {
      try {
        const success = evaluation.toUpperCase().startsWith('SUCCESS');
        // v7.9.20: the loop exposes no per-step surprise signal, so derive a
        // pursuit-level emotional weight from the outcome — a failed pursuit, or
        // one that hit errors along the way, is the salient episode DreamCycle
        // should consolidate first. Bounded to [0,1].
        const errorRate = allResults.length ? errors.length / allResults.length : (errors.length ? 1 : 0);
        const emotionalWeight = Math.min(1, (success ? 0.2 : 0.6) + 0.3 * errorRate);
        loop.episodicMemory.recordEpisode({
          topic: plan.title || 'Agent goal execution',
          summary: evaluation.slice(0, 200),
          outcome: success ? 'success' : 'failed',
          toolsUsed: [...new Set(allResults.map(r => r.type).filter(Boolean))],
          artifacts: allResults
            .filter(r => r.target)
            .map(r => ({ type: 'file-modified', path: r.target })),
          tags: this.extractTags(plan.title + ' ' + (plan.successCriteria || '')),
          emotionalWeight,
          metadata: { surprise: emotionalWeight },
        });
      } catch (_err) { /* episode recording optional */ }
    }

    return {
      success: evaluation.toUpperCase().startsWith('SUCCESS'),
      summary: evaluation.slice(0, 300),
      verificationMethod: 'llm-fallback',
    };
  }

  /** Extract topic tags from text for episodic memory. */
  extractTags(text) {
    const tags = [];
    const lower = (text || '').toLowerCase();
    const patterns = [
      { pattern: /(?:test|spec|jest|mocha)/i, tag: 'testing' },
      { pattern: /(?:refactor|clean|simplif)/i, tag: 'refactoring' },
      { pattern: /(?:bug|fix|repair|error)/i, tag: 'bugfix' },
      { pattern: /(?:feature|add|new|implement)/i, tag: 'feature' },
      { pattern: /(?:security|auth|encrypt)/i, tag: 'security' },
      { pattern: /(?:mcp|server|client|transport)/i, tag: 'mcp' },
      { pattern: /(?:ui|render|display|css)/i, tag: 'ui' },
      { pattern: /(?:memory|knowledge|embedding)/i, tag: 'memory' },
      { pattern: /(?:api|endpoint|rest)/i, tag: 'api' },
    ];
    for (const { pattern, tag } of patterns) {
      if (pattern.test(lower)) tags.push(tag);
    }
    return tags;
  }
}

// v3.8.0: Export delegate class. Legacy bare-function exports removed.
module.exports = { AgentLoopStepsDelegate };
