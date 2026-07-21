// ============================================================
// GENESIS — src/agent/revolution/AgentLoopStepsCode.js
//
// v7.9.29 (hygiene #9): the code + sandbox execution step handlers,
// v7.9.37 (V-A): _stripLeadingProse below — models mix prose into fenced
// blocks (field 11.07.: acorn "Unexpected token (1:5)" on every CODE step);
// drop leading lines until the first line that starts like JS.
// extracted as one contiguous block from AgentLoopSteps to keep it under
// the 700-LOC guard. _stepCode stays immediately followed by _stepSandbox
// so body-extracting contract tests keep their delimiter. Class methods
// copied onto AgentLoopStepsDelegate.prototype via the mixin. this.* only.
// ============================================================

const { TIMEOUTS } = require('../core/Constants');

// v7.9.40 (B0): code-step tests may READ the project's own src/ tree —
// the same read-only allowance testPatch has had (Sandbox.js:262/:283).
// Genesis' self-inspection goals structurally died without it (field
// 17.07.: "Read access blocked" on reading its own source). Write access
// stays fully sandboxed at every level; the sandbox guard itself is
// untouched. Not-Aus: set GENESIS_CODESTEP_ALLOW_SRC_READ=0 to withdraw
// the allowance without a code change.
function _codeStepSandboxEnv(loop) {
  try {
    if (process.env.GENESIS_CODESTEP_ALLOW_SRC_READ === '0') return {};
    const root = loop && loop.sandbox && loop.sandbox.rootDir;
    if (!root) return {};
    return { GENESIS_SANDBOX_ALLOW_READ_ROOT: require('path').join(root, 'src') };
  } catch (_e) { return {}; }
}

class _AgentLoopStepsCodeHost {
  async _stepCode(step, context, onProgress) {
    // v7.9.37 pass 6 (S-C): steps that want to CREATE/MOVE Genesis source
    // files are self-modification — they go through the proposal pipeline,
    // never through auto-generated sandbox code (field 11.07.: "Create or
    // relocate the missing Logger.js module" at trust 2).
    if (/(create|relocate|move|add|write|generate)\b[^\n]{0,80}\b(?:src[\\/]|Logger\.js|module)/i.test(step.description || '')
        && /(?:\.js|\.ts|module)\b/i.test(step.description || '')
        && /(creat|relocat|mov|add|writ|generat)/i.test(step.description || '')) {
      return { error: 'self-modification blocked: creating/relocating Genesis source files requires a proposal (SelfModificationPipeline), not sandbox code', selfModBlocked: true, success: false };
    }
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
      `  - Container:    constructor-injected as 'c' or this.container — never reach into globals.\n` +
      `  - STANDALONE SCRIPTS (v7.9.37): load project modules ONLY via GENESIS_ROOT — const p=require('path'); const M=require(p.join(process.env.GENESIS_ROOT,'src/agent/core/Logger.js')); NEVER copy relative require('./x') lines out of source files.\n` +
      `  - CONSTANTS: never reference module-internal constants (TIMEOUTS, caps, maps) from outside — re-declare the value you need locally.\n`;

    const prompt = `${context}${apiConventions}\nCODE TASK: ${step.description}\n${/verification[- ]parse|Verification failed/i.test(String(context).slice(-600)) ? 'PREVIOUS OUTPUT FAILED SYNTAX VERIFICATION — output ONLY code in ONE fenced block, no prose before or inside it.\n' : ''}SANDBOX RULES: The script runs in an isolated sandbox dir (NOT the project root). For any Genesis self-inspection use ABSOLUTE requires via process.env.GENESIS_ROOT, e.g. require(require('path').join(process.env.GENESIS_ROOT, 'src', 'agent', '...')). NEVER use relative './src/...' (it will fail). ALWAYS double-quote any absolute path you place into a command or string \u2014 real paths contain spaces (\"D:\\\\Genesis Home\\\\...\"). Do NOT create or modify files under the project's src/ — inspection is read-only. OUTPUT BUDGET: reply with ONE compact script (under 200 lines). NEVER reproduce file contents in your answer — read files programmatically and print only distilled findings.\n${step.target ? `TARGET FILE: ${step.target}` : ''}${existingCode ? '\n\nExisting code:\n```javascript\n' + sourceForPrompt(existingCode, 4000) + '\n```' : ''}\n\nGenerate the complete file content. Respond ONLY with the code inside a single code block.`;

    const response = await loop.model.chat(prompt, [], 'code');

    // Extract code from response
    const codeMatch = response.match(/```(?:\w+)?\n([\s\S]+?)```/);
    if (!codeMatch) {
      return { output: response, error: 'No code block found in LLM response' };
    }

    const newCode = _stripLeadingProse(codeMatch[1]);
    if (!newCode) {
      return { output: response.slice(0, 400), error: 'verification-parse: fenced block contains no code (prose only)' };
    }

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
    // v7.9.41 (D1/K1): carry the CODE itself for verification — the neutral
    // output sentence was being parsed as JS (field: "Unexpected token (1:5)"
    // = the 'w' of "Code written"). The verifier gets code; output stays prose.
    return { output: `Code written: ${step.target || 'sandbox'} (${newCode.split('\n').length} lines)`, code: newCode, error: null };
  }

  async _stepSandbox(step, context) {
    const loop = this.loop;
    // Generate test code and run in sandbox
    const prompt = `${context}\n\nSANDBOX TEST: ${step.description}\n\nGenerate a JavaScript test that verifies this. Use console.log for output. Respond ONLY with code in a code block.`;

    const response = await loop.model.chat(prompt, [], 'code');
    const codeMatch = response.match(/```(?:\w+)?\n([\s\S]+?)```/);
    const testCode = codeMatch ? _stripLeadingProse(codeMatch[1]) : ''; // v7.9.37 (V-A): never parse a file PATH as code

    if (!testCode) {
      return { output: 'No test code generated', error: 'Empty test' };
    }

    const result = await loop.sandbox.execute(testCode, { timeout: TIMEOUTS.SANDBOX_EXEC, env: _codeStepSandboxEnv(loop) });
    return {
      output: result.output || '',
      error: result.error || null,
    };
  }

}

const CODE_START = /^\s*(?:'use strict'|"use strict"|const |let |var |function |async |class |import |export |module\.|require\(|if \(|for \(|while \(|return |\/\/|\/\*|\{|\()/;
function _stripLeadingProse(raw) {
  const lines = String(raw || '').split('\n');
  const idx = lines.findIndex(l => CODE_START.test(l));
  return idx === -1 ? '' : lines.slice(idx).join('\n').trim();
}

const agentLoopStepsCodeMixin = {};
for (const name of Object.getOwnPropertyNames(_AgentLoopStepsCodeHost.prototype)) {
  if (name !== 'constructor') agentLoopStepsCodeMixin[name] = _AgentLoopStepsCodeHost.prototype[name];
}

module.exports = { agentLoopStepsCodeMixin };
