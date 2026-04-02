// @ts-checked-v5.7
// ============================================================
// GENESIS — _self-worker.js
// Child process worker for SelfSpawner.
//
// Receives a task via IPC, executes it with minimal context,
// and returns the result. NOT a full Genesis instance.
//
// Capabilities:
//   - LLM calls via Ollama HTTP (direct, no ModelBridge overhead)
//   - Code execution via vm sandbox
//   - File read/write within project scope
// ============================================================

const http = require('http');
const { TIMEOUTS } = require('../core/Constants');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/Logger');
const _log = createLogger('_self-worker');

let taskPayload = null;

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

// ── LLM Query (direct Ollama HTTP) ────────────────────────

async function llmQuery(prompt, context, modelConfig) {
  if (!modelConfig) throw new Error('No model configuration');

  const url = new URL(modelConfig.ollamaUrl || 'http://127.0.0.1:11434');

  const body = JSON.stringify({
    model: modelConfig.activeModel || modelConfig.model,
    messages: [
      { role: 'system', content: context.systemPrompt || 'You are a focused sub-task worker. Be concise and precise.' },
      { role: 'user', content: prompt },
    ],
    stream: false,
    options: { temperature: 0.3 },
  });

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 11434,
      path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: TIMEOUTS.TEST_INSTALL,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve({ output: data.message?.content || '', model: modelConfig.activeModel });
        } catch (err) { reject(new Error('LLM parse error')); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('LLM timeout')); });
    req.write(body);
    req.end();
  });
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
  // @ts-ignore — vm.Script accepts timeout at runtime
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
