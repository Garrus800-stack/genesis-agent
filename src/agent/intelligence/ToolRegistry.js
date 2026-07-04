// @ts-checked-v5.6
// ============================================================
// GENESIS AGENT — ToolRegistry.js (v2 — System Tools)
//
// UPGRADE: Added shell execution, file-read/write, and
// structured JSON output parsing for tool calls.
// ============================================================

const { execFile } = require('child_process');
const { TIMEOUTS } = require('../core/Constants');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');

const { robustJsonParse } = require('../core/utils');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
// v7.5.9 live-fix: filename-variant resolution for file-read tool. Shared
// helper from SelfModelSourceRead so the LLM's tool-call gets the same
// readme→README.md / ontogenesis→docs/ONTOGENESIS.md resolution that the
// internal _maybeReadSourceSync already gets.
const { _resolveFileWithVariants } = require('../foundation/SelfModelSourceRead');
// v7.9.11: Win console codepage handling for shell/git output decoding
const { decodeWinConsole } = require('../core/shell/WinConsoleEncoding');
const { adaptCommand } = require('../core/shell/ShellOSAdapter');
const _log = createLogger('ToolRegistry');

const { toolRegistryBuiltinsMixin } = require('./ToolRegistryBuiltins'); // v7.9.29 (hygiene)

class ToolRegistry {
  /** @param {{ bus?: *, lang?: * }} [config] */
  constructor({ bus, lang } = {}) {
    this.bus = bus || NullBus;
    this.lang = lang || null;
    this.tools = new Map();
    this.callHistory = [];
    this.historyLimit = 200;
    // v5.7.0 SA-P8: Dynamic tool synthesis (late-bound)
    this._toolSynthesis = null;
    // v7.9.27: held so execute() can register a just-created skill on demand
    // (before falling through to synthesis) when refreshSkills has not yet run
    // for it.
    this._skillManager = null;
    // v7.5.9 ZIP2 v3 (Bug 4): late-bound trust + settings so file-read /
    // file-list can use the 3-tier sandbox. Keep null when unwired —
    // _resolveProjectPath then falls back to default trust=1.
    this._trustLevelSystem = null;
    this._settings = null;
  }

  register(name, schema, handler, source = 'system') {
    if (this.tools.has(name)) _log.warn(`[TOOLS] Overwriting: ${name}`);
    this.tools.set(name, {
      name, schema, handler, source,
      stats: { calls: 0, errors: 0, avgDuration: 0, lastCall: null },
    });
    this.bus.fire('tools:registered', { name, source, schema }, { source: 'ToolRegistry' });
  }

  unregister(name) {
    const removed = this.tools.delete(name);
    if (removed) this.bus.fire('tools:unregistered', { name }, { source: 'ToolRegistry' });
    return removed;
  }

  /**
   * v7.9.4: Re-register all skill:* tools from SkillManager. Called by
   * SkillPromotionEvaluator after promotion so newly-loaded skills become
   * callable as tools without restart. Idempotent.
   */
  refreshSkills(skillManager) {
    if (!skillManager || typeof skillManager.listSkills !== 'function') return;
    // v7.9.27: remember the manager so execute() can re-register on demand.
    this._skillManager = skillManager;
    const toRemove = [...this.tools.keys()].filter(n => n.startsWith('skill:'));
    for (const name of toRemove) this.tools.delete(name);
    let count = 0;
    try {
      for (const skill of skillManager.listSkills()) {
        this.register(`skill:${skill.name}`, {
          description: skill.description,
          input: skill.interface?.input || {},
          output: skill.interface?.output || {},
        }, (input) => skillManager.executeSkill(skill.name, input), 'skill');
        count++;
      }
    } catch (err) {
      _log.warn(`[TOOLS] refreshSkills failed: ${err.message}`);
    }
    _log.info(`[TOOLS] refreshSkills: ${toRemove.length} removed, ${count} registered`);
  }

  hasTool(name) { return this.tools.has(name); }

  async execute(name, input = {}) {
    let tool = this.tools.get(name);
    // FIX v6.1.1: Fallback to skill: prefix (skills registered as "skill:name")
    if (!tool) tool = this.tools.get(`skill:${name}`);
    // v7.9.27: if a skill of this name exists but isn't registered as a tool yet
    // (created after the last refreshSkills), register on demand before falling
    // through to synthesis — so the real skill is used instead of a synthesized
    // duplicate.
    if (!tool && this._skillManager && typeof this._skillManager.listSkills === 'function') {
      try {
        if (this._skillManager.listSkills().some(s => s.name === name)) {
          this.refreshSkills(this._skillManager);
          tool = this.tools.get(`skill:${name}`);
        }
      } catch (_e) { /* fall through to synthesis */ }
    }
    // v5.7.0 SA-P8: Auto-synthesize missing tools
    if (!tool && this._toolSynthesis) {
      try {
        const result = await this._toolSynthesis.synthesize(
          `A tool called "${name}" that ${name.replace(/-/g, ' ')}s. Infer inputs/outputs from the name.`,
          { name }
        );
        if (result.success) {
          tool = this.tools.get(name);
          _log.info(`[TOOLS] Auto-synthesized "${name}" on first call`);
        }
      } catch (err) { _log.debug(`[TOOLS] Auto-synthesis for "${name}" failed:`, err.message); }
    }
    if (!tool) throw new Error(`Tool not found: ${name}`);
    const startTime = Date.now();
    this.bus.fire('tools:calling', { name, input }, { source: 'ToolRegistry' });
    try {
      const result = await tool.handler(input);
      const duration = Date.now() - startTime;
      tool.stats.calls++;
      tool.stats.avgDuration = (tool.stats.avgDuration * (tool.stats.calls - 1) + duration) / tool.stats.calls;
      tool.stats.lastCall = new Date().toISOString();
      this._recordCall(name, input, result, duration, null);
      this.bus.fire('tools:result', { name, duration, success: true }, { source: 'ToolRegistry' });
      return result;
    } catch (err) {
      tool.stats.errors++;
      this._recordCall(name, input, null, Date.now() - startTime, err.message);
      this.bus.fire('tools:error', { name, error: err.message }, { source: 'ToolRegistry' });
      throw err;
    }
  }

  /**
   * Execute a single tool by name (alias for execute).
   * Used by NativeToolUse for native function calling.
   * FIX v3.5.0: Method was missing — NativeToolUse crashed on every tool call.
   */
  executeSingleTool(name, input = {}) {
    return this.execute(name, input);
  }

  /**
   * Get the schema/definition for a tool by name.
   * Used by NativeToolUse to build API-compatible tool schemas.
   * FIX v3.5.0: Method was missing — NativeToolUse couldn't build tool schemas.
   */
  getToolDefinition(name) {
    const tool = this.tools.get(name);
    return tool ? tool.schema : null;
  }

  listTools() {
    return [...this.tools.values()].map(t => ({
      name: t.name, description: t.schema.description,
      input: t.schema.input, output: t.schema.output,
      source: t.source, stats: { ...t.stats },
    }));
  }

  generateToolPrompt() {
    if (this.tools.size === 0) return '';
    const isDE = this.lang && this.lang.current === 'de';
    const noParams = isDE ? '(keine Parameter)' : '(no parameters)';
    const descLabel = isDE ? 'Beschreibung' : 'Description';

    const descriptions = [];
    for (const [name, tool] of this.tools) {
      const inputParams = tool.schema.input
        ? Object.entries(tool.schema.input).map(([k, v]) => `    ${k}: ${v}`).join('\n')
        : `    ${noParams}`;
      descriptions.push(`TOOL: ${name}\n  ${descLabel}: ${tool.schema.description}\n  Input:\n${inputParams}`);
    }

    const intro = isDE
      ? 'Du hast Zugang zu folgenden Tools. Um ein Tool zu benutzen, antworte mit:'
      : 'You have access to the following tools. To use a tool, respond with:';
    const header = isDE ? 'VERFUEGBARE TOOLS:' : 'AVAILABLE TOOLS:';

    return `${intro}
<tool_call>
{"name": "tool-name", "input": {"param": "value"}}
</tool_call>

${header}
${descriptions.join('\n\n')}`;
  }

  /**
   * v7.9.28: normalize ANY plausible tool-call object into { name, input },
   * regardless of which field names the model used. This is the future-proof
   * core — instead of a regex per model, one mapper covers the common shapes:
   *   name:     name | tool | tool_name | function.name
   *   input:    input | arguments | args | parameters | params
   * Handles the OpenAI nesting { type:'function', function:{ name, arguments } }
   * and an `arguments` value that is itself a JSON string. Returns null if no
   * usable name is present.
   */
  _normalizeToolCall(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const fn = (obj.function && typeof obj.function === 'object' && !Array.isArray(obj.function)) ? obj.function : obj;
    let name;
    for (const k of ['name', 'tool', 'tool_name']) {
      if (typeof fn[k] === 'string' && fn[k].trim()) { name = fn[k].trim(); break; }
      if (typeof obj[k] === 'string' && obj[k].trim()) { name = obj[k].trim(); break; }
    }
    if (!name) return null;
    let input;
    for (const k of ['input', 'arguments', 'args', 'parameters', 'params']) {
      if (fn[k] !== undefined) { input = fn[k]; break; }
      if (obj[k] !== undefined) { input = obj[k]; break; }
    }
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch (_e) { input = {}; } }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) input = {};
    return { name, input };
  }

  /**
   * v7.9.28: return the top-level balanced {...} substrings of text, respecting
   * quoted strings. Used to find bare (un-fenced) JSON tool calls without
   * greedily mangling nested braces.
   */
  _findJsonObjectSpans(text) {
    const spans = [];
    let depth = 0; let start = -1; let inStr = false; let esc = false; let quote = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false; else if (c === '\\') esc = true; else if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
      if (c === '{') { if (depth === 0) start = i; depth++; } else if (c === '}') {
        if (depth > 0) { depth--; if (depth === 0 && start >= 0) { spans.push(text.slice(start, i + 1)); start = -1; } }
      }
    }
    return spans;
  }

  parseToolCalls(response) {
    const toolCalls = [];
    let text = response;
    let match;

    // Format 1: <tool_call>{...}</tool_call> (canonical) — flexible fields.
    const tagRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
    while ((match = tagRegex.exec(response))) {
      try { const n = this._normalizeToolCall(this._robustJsonParse(match[1])); if (n) toolCalls.push(n); } catch (_err) { /* skip */ }
    }
    text = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');

    // Format 2: ```tool_call ... ``` markdown-fence variant — flexible fields.
    const fenceRegex = /```tool_call\s*\n?([\s\S]*?)```/g;
    while ((match = fenceRegex.exec(response))) {
      try { const n = this._normalizeToolCall(this._robustJsonParse(match[1].trim())); if (n) toolCalls.push(n); } catch (_err) { /* skip */ }
    }
    text = text.replace(/```tool_call\s*\n?[\s\S]*?```/g, '');

    // Format 4 (v7.9.28): Anthropic-style XML — <function_calls><invoke name="X">
    // <parameter name="k">v</parameter></invoke></function_calls>. Bare or antml:.
    const invokeRegex = /<(?:antml:)?invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/(?:antml:)?invoke>/gi;
    while ((match = invokeRegex.exec(response))) {
      const name = match[1].trim();
      const input = {};
      const paramRegex = /<(?:antml:)?parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/(?:antml:)?parameter>/gi;
      let pm;
      while ((pm = paramRegex.exec(match[2]))) {
        const key = pm[1].trim();
        let val = pm[2].replace(/^\r?\n/, '').replace(/\r?\n$/, '');
        try { const j = JSON.parse(val.trim()); if (j !== null && typeof j !== 'string') val = j; else if (j === null) val = null; } catch (_e) { /* keep raw */ }
        input[key] = val;
      }
      if (name) toolCalls.push({ name, input });
    }
    text = text
      .replace(/<(?:antml:)?function_calls>[\s\S]*?<\/(?:antml:)?function_calls>/gi, '')
      .replace(/<(?:antml:)?invoke\s+name=["'][^"']+["']\s*>[\s\S]*?<\/(?:antml:)?invoke>/gi, '');

    // Format 5 (v7.9.28): <tool name="X">{args}</tool> and <tool_use name="X">…</tool_use>.
    // The inner JSON is the arguments object directly (or wraps input/arguments).
    const namedTagRegex = /<(tool|tool_use)\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/\1>/gi;
    while ((match = namedTagRegex.exec(response))) {
      const name = match[2].trim();
      let input = {};
      const inner = match[3].trim();
      if (inner) {
        try {
          const j = this._robustJsonParse(inner);
          if (j && typeof j === 'object') {
            const wrapped = this._normalizeToolCall(j);
            input = (wrapped && Object.keys(wrapped.input).length) ? wrapped.input
              : (j.input || j.arguments || j.args || j.parameters || j.params || j);
            if (typeof input !== 'object' || input === null) input = {};
          }
        } catch (_e) { /* no args */ }
      }
      if (name) toolCalls.push({ name, input });
    }
    text = text.replace(/<(tool|tool_use)\s+name=["'][^"']+["']\s*>[\s\S]*?<\/\1>/gi, '');

    // Format 6 (v7.9.28): generalized JSON tool calls. Flexible field names, so a
    // model emitting yet another JSON shape (e.g.
    // {"tool_type":"function","tool":"system-info","arguments":{}}) still runs.
    // Scans fenced and bare top-level JSON. To avoid false-positives, a candidate
    // is accepted only if it carries a tool marker (tool_type / type:function /
    // a function object / a tool field) OR its normalized name is a registered
    // tool. Only runs when nothing was parsed above.
    if (toolCalls.length === 0) {
      const seen = new Set();
      const candidates = [];
      const jf = /```(?:json|tool|function)?\s*\n?(\{[\s\S]*?\})\s*```/g;
      while ((match = jf.exec(text))) candidates.push(match[1]);
      for (const span of this._findJsonObjectSpans(text)) candidates.push(span);
      for (const cand of candidates) {
        const key = cand.trim();
        if (seen.has(key)) continue; seen.add(key);
        let parsed;
        try { parsed = this._robustJsonParse(key); } catch (_e) { continue; }
        const norm = this._normalizeToolCall(parsed);
        if (!norm) continue;
        const marker = parsed && (parsed.tool_type !== undefined || parsed.type === 'function'
          || (parsed.function && typeof parsed.function === 'object')
          || typeof parsed.tool === 'string' || typeof parsed.tool_name === 'string');
        if (marker || (this.tools && this.tools.has && this.tools.has(norm.name))) {
          toolCalls.push(norm);
          text = text.split(cand).join('');
        }
      }
    }

    return { text: text.trim(), toolCalls };
  }

  /**
   * v7.5.9 ZIP1 Phase 0.2: Detect when LLM said it would use a tool but
   * never emitted a tool_call block. Used by ChatOrchestrator to issue
   * a single re-prompt with the format example before giving up.
   *
   * Returns true ONLY if the response contains tool-intent language AND
   * has no parseable tool calls. The check is conservative — false matches
   * cost a wasted re-prompt; missed matches preserve current (broken)
   * behavior.
   *
   * @param {string} response - LLM response text (after parseToolCalls strip)
   * @returns {boolean}
   */
  detectToolIntentWithoutCall(response) {
    if (!response || typeof response !== 'string') return false;
    // Already stripped of tool_call blocks → if any of these patterns match
    // in the visible text, the model intended a tool but emitted no call.
    const patterns = [
      /\bTools?\s+(?:ausf[üu]hren|ausgef[üu]hrt|aufrufen)/i,           // DE
      /\b(?:I will|let me|ich werde)\s+(?:use|call|run|verwende[n]?|nutze[n]?|rufe)\s+(?:the\s+)?[\w-]+\s*(?:tool)?/i,
      /\b(?:calling|aufruf|nutze)\s+(?:tool|werkzeug)\s*[:\-]/i,
      /\btool[_\-]?call\s*[:\-]/i,
      /\bführe\s+(?:das\s+)?tool\b/i,
    ];
    for (const p of patterns) {
      if (p.test(response)) return true;
    }
    return false;
  }

  /** FIX v3.5.0: Delegates to shared utility (was duplicated in ModelBridge) */
  _robustJsonParse(str) {
    return robustJsonParse(str);
  }

  async executeToolCalls(toolCalls) {
    const results = [];
    for (const call of toolCalls) {
      try {
        const result = await this.execute(call.name, call.input);
        results.push({ name: call.name, success: true, result });
      } catch (err) {
        results.push({ name: call.name, success: false, error: err.message });
      }
    }
    return results;
  }

  // ── Built-in Tool Registration ────────────────────────────


  getHistory(limit = 50) { return this.callHistory.slice(-limit); }

  getStats() {
    const stats = {};
    for (const [name, tool] of this.tools) stats[name] = { ...tool.stats };
    return stats;
  }

  _recordCall(name, input, result, duration, error) {
    this.callHistory.push({
      name, input: JSON.stringify(input).slice(0, 200),
      result: result ? JSON.stringify(result).slice(0, 200) : null,
      error, duration, timestamp: new Date().toISOString(),
    });
    if (this.callHistory.length > this.historyLimit) this.callHistory = this.callHistory.slice(-this.historyLimit);
  }
}

Object.assign(ToolRegistry.prototype, toolRegistryBuiltinsMixin); // v7.9.29 (hygiene)

module.exports = { ToolRegistry };
