// @ts-checked-v5.7
// ============================================================
// GENESIS — _self-worker.js
// Child process worker for SelfSpawner.
//
// Receives a task via IPC, executes it with minimal context,
// and returns the result. NOT a full Genesis instance.
//
// Capabilities:
//   - LLM calls via IPC to parent (parent uses ModelBridge — same
//     concurrency/cache/keep-alive as the rest of Genesis).
//     v7.5.7-fix Phase 2: was direct Ollama HTTP, which bypassed
//     the LLM_MAX_CONCURRENT semaphore — workers could pile up calls
//     against Ollama in parallel even when ModelBridge was full.
//   - Code execution via vm sandbox
//   - File read/write within project scope
// ============================================================

const { TIMEOUTS } = require('../core/Constants');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/Logger');
const _log = createLogger('_self-worker');

let taskPayload = null;

// v7.5.7-fix Phase 2: pending LLM requests waiting for parent's response.
// Map<requestId, { resolve, reject }>
const _pendingLlm = new Map();
let _llmRequestCounter = 0;

process.on('message', async (/** @type {*} */ msg) => {
  if (msg.type === 'task') {
    taskPayload = msg.payload;
    try {
      const result = await executeTask(taskPayload);
      process.send?.({ type: 'result', success: true, result });
    } catch (err) {
      process.send?.({ type: 'result', success: false, error: err.message });
    }
    process.exit(0);
  } else if (msg.type === 'llm-response') {
    // v7.5.7-fix Phase 2: parent answered our llm-request
    const pending = _pendingLlm.get(msg.requestId);
    if (pending) {
      _pendingLlm.delete(msg.requestId);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.text || '');
    }
  }
});

async function executeTask(payload) {
  const { description, type, context, modelConfig, rootDir } = payload;

  switch (type) {
    case 'llm-query':
      return await llmQuery(description, context, modelConfig);

    case 'code-execute':
      return codeExecute(context.code, rootDir);

    case 'file-analyze':
      return fileAnalyze(context.filePath, rootDir);

    case 'generic':
    default:
      // Use LLM for generic tasks
      if (modelConfig) {
        return await llmQuery(description, context, modelConfig);
      }
      return { output: 'No model configured for worker', type: 'passthrough' };
  }
}

// ── LLM Query (via IPC to parent — uses ModelBridge) ───────
//
// v7.5.7-fix Phase 2: was a direct HTTP call to Ollama which bypassed
// the LLM_MAX_CONCURRENT semaphore. Now sends `llm-request` to parent
// SelfSpawner; parent calls model.chat() (going through the semaphore,
// cache, keep_alive logic) and replies with `llm-response`.

function _ipcLlmQuery(systemPrompt, userPrompt, taskType) {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error('Worker has no IPC channel to parent'));
      return;
    }
    const requestId = `llm_${++_llmRequestCounter}_${Date.now()}`;
    _pendingLlm.set(requestId, { resolve, reject });
    process.send({
      type: 'llm-request',
      requestId,
      systemPrompt: systemPrompt || 'You are a focused sub-task worker. Be concise and precise.',
      userPrompt: userPrompt || '',
      taskType: taskType || 'analysis',
    });
    // Hard timeout in case parent never responds (parent crashed, etc.)
    const timeoutMs = TIMEOUTS.LLM_RESPONSE_LOCAL || 180000;
    setTimeout(() => {
      if (_pendingLlm.has(requestId)) {
        _pendingLlm.delete(requestId);
        reject(new Error(`LLM IPC timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}

async function llmQuery(prompt, context, modelConfig) {
  if (!modelConfig) throw new Error('No model configuration');
  const systemPrompt = (context && context.systemPrompt) || null;
  const text = await _ipcLlmQuery(systemPrompt, prompt, 'analysis');
  return { output: text, model: modelConfig.activeModel };
}

// ── Code Execution (vm sandbox) ───────────────────────────

function codeExecute(code, rootDir) {
  if (!code) throw new Error('No code provided');

  const sandbox = {
    console: { log: (...a) => {}, error: (...a) => {}, warn: (...a) => {} },
    result: null,
    require: (mod) => {
      const allowed = ['path', 'url', 'querystring', 'util', 'assert', 'buffer', 'crypto'];
      if (!allowed.includes(mod)) throw new Error(`Module ${mod} not allowed in worker sandbox`);
      return require(mod);
    },
  };

  const context = vm.createContext(sandbox);
  const script = new vm.Script(code, { timeout: TIMEOUTS.COMMAND_EXEC });
  script.runInContext(context);

  return { output: sandbox.result, executed: true };
}

// ── File Analysis ─────────────────────────────────────────

function fileAnalyze(filePath, rootDir) {
  if (!filePath || !rootDir) throw new Error('filePath and rootDir required');

  const resolved = path.resolve(rootDir, filePath);
  if (!resolved.startsWith(path.resolve(rootDir))) {
    throw new Error('Path traversal blocked');
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  const stats = fs.statSync(resolved);

  return {
    path: filePath,
    size: stats.size,
    lines: content.split('\n').length,
    content: content.slice(0, 5000), // Cap at 5KB for IPC
  };
}

// Safety: exit after 5 minutes if no task received
setTimeout(() => {
  _log.error('[WORKER] No task received — exiting');
  process.exit(1);
}, 5 * 60 * 1000);
