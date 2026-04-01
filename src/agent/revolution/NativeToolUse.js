// @ts-checked-v5.7
// ============================================================
// GENESIS — NativeToolUse.js (v3.5.0 — REVOLUTION)
//
// PROBLEM: Genesis parses tool calls from LLM text output
// using regex (<tool_call>...</tool_call>). This is:
// - Fragile (LLM formats vary)
// - Unreliable (hallucinated tool names, broken JSON)
// - Wasteful (LLM generates text wrapper around the call)
//
// SOLUTION: Use NATIVE function calling APIs:
// - Ollama: tools parameter in /api/chat
// - Anthropic: tools parameter in /v1/messages
// - OpenAI: tools parameter in /v1/chat/completions
//
// Genesis tools are auto-converted to the API's tool schema.
// The LLM returns structured tool_call objects, not text.
// Results are fed back as tool_result messages for multi-turn.
//
// This is the bridge between Genesis's ToolRegistry and the
// LLM's native capabilities. It doesn't replace ModelBridge —
// it augments it with a tool-aware chat method.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { safeJsonParse } = require('../core/utils');

class NativeToolUse {
  static containerConfig = {
    name: 'nativeToolUse',
    phase: 8,
    deps: ['model', 'tools'],
    tags: ['revolution'],
    lateBindings: [],
  };

  constructor({ bus, model, tools, lang }) {
    this.bus = bus || NullBus;
    this.model = model;
    this.tools = tools;
    this.lang = lang || { t: k => k };

    this._maxToolRounds = 5;   // Max tool-call rounds per message
    this._toolCallCount = 0;
    this._stats = { totalCalls: 0, totalRounds: 0, failures: 0 };
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Chat with native tool use. The LLM can call tools and
   * receive their results in a structured multi-turn loop.
   *
   * @param {string} systemPrompt - System prompt
   * @param {Array} messages - Conversation history [{role, content}]
   * @param {string} taskType - Temperature profile
   * @param {object} options - { maxRounds, allowedTools }
   * @returns {Promise<object>} { text, toolCalls: [{name, input, result}] }
   */
  async chat(systemPrompt, messages, taskType = 'chat', options = {}) {
    const maxRounds = options.maxRounds || this._maxToolRounds;
    const allowedTools = options.allowedTools || null; // null = all tools
    const backend = this.model.activeBackend;

    // Convert Genesis tools to the backend's schema format
    const toolSchemas = this._buildToolSchemas(allowedTools);

    if (toolSchemas.length === 0 || !this._supportsNativeTools(backend)) {
      // Fallback: regular chat (no tool support)
      const text = await this.model.chat(systemPrompt, messages, taskType);
      return { text, toolCalls: [] };
    }

    // Multi-turn tool loop
    let currentMessages = [...messages];
    const allToolCalls = [];

    for (let round = 0; round < maxRounds; round++) {
      this._stats.totalRounds++;

      const response = await this._chatWithTools(
        backend, systemPrompt, currentMessages, toolSchemas, taskType
      );

      // Check if the response contains tool calls
      if (!response.toolCalls || response.toolCalls.length === 0) {
        // No more tool calls — return final text
        return { text: response.text, toolCalls: allToolCalls };
      }

      // Execute each tool call
      const toolResults = [];
      for (const call of response.toolCalls) {
        this._stats.totalCalls++;
        this._toolCallCount++;

        this.bus.fire('tool:native-call', {
          name: call.name,
          round: round + 1,
          input: call.input,
        }, { source: 'NativeToolUse' });

        try {
          const result = await this.tools.executeSingleTool(call.name, call.input);
          toolResults.push({
            id: call.id,
            name: call.name,
            result: result,
            error: null,
          });
          allToolCalls.push({ name: call.name, input: call.input, result, error: null });
        } catch (err) {
          this._stats.failures++;
          toolResults.push({
            id: call.id,
            name: call.name,
            result: null,
            error: err.message,
          });
          allToolCalls.push({ name: call.name, input: call.input, result: null, error: err.message });
        }
      }

      // Build tool result messages for next round
      currentMessages = this._appendToolResults(backend, currentMessages, response, toolResults);
    }

    // Max rounds reached — do a final synthesis
    const finalText = await this.model.chat(
      systemPrompt,
      [...currentMessages, { role: 'user', content: 'Summarize what you found from the tool calls and provide your final answer.' }],
      taskType
    );

    return { text: finalText, toolCalls: allToolCalls };
  }

  /**
   * Stream with native tool use. Tools are executed between stream chunks.
   */
  async stream(systemPrompt, messages, onChunk, abortSignal, taskType = 'chat', options = {}) {
    // For streaming, we do a non-streaming tool loop first, then stream the final answer
    const allowedTools = options.allowedTools || null;
    const toolSchemas = this._buildToolSchemas(allowedTools);
    const backend = this.model.activeBackend;

    if (toolSchemas.length === 0 || !this._supportsNativeTools(backend)) {
      // No tools — direct stream
      return this.model.streamChat(systemPrompt, messages, onChunk, abortSignal, taskType);
    }

    // First: non-streaming tool rounds
    const result = await this.chat(systemPrompt, messages, taskType, options);

    // If there were tool calls, report them
    if (result.toolCalls.length > 0) {
      for (const tc of result.toolCalls) {
        onChunk(`\n*[Tool: ${tc.name}]* `);
      }
      onChunk('\n\n');
    }

    // Stream the final text
    for (let i = 0; i < result.text.length; i += 20) {
      if (abortSignal?.aborted) break;
      onChunk(result.text.slice(i, i + 20));
      await new Promise(r => setTimeout(r, 10)); // Simulate streaming
    }
  }

  getStats() { return { ...this._stats, toolCallCount: this._toolCallCount }; }

  // ════════════════════════════════════════════════════════
  // TOOL SCHEMA CONVERSION
  // ════════════════════════════════════════════════════════

  /**
   * Convert Genesis ToolRegistry tools to native API schemas.
   * Each backend has a slightly different format.
   */
  _buildToolSchemas(allowedTools) {
    const tools = this.tools.listTools();
    const schemas = [];

    for (const tool of tools) {
      const name = tool.name || tool;
      if (allowedTools && !allowedTools.includes(name)) continue;

      const def = this.tools.getToolDefinition?.(name);
      if (!def) continue;

      schemas.push({
        name: name,
        description: def.description || `Tool: ${name}`,
        parameters: this._convertInputSchema(def.input || def.parameters || {}),
      });
    }

    return schemas;
  }

  /** Convert Genesis input spec to JSON Schema (for API) */
  _convertInputSchema(input) {
    if (input.type === 'object' && input.properties) return input; // Already JSON Schema

    // Convert simple { key: "description" } to JSON Schema
    const properties = {};
    const required = [];

    for (const [key, desc] of Object.entries(input)) {
      if (typeof desc === 'string') {
        properties[key] = { type: 'string', description: desc };
        required.push(key);
      } else if (typeof desc === 'object') {
        properties[key] = desc;
        if (desc.required !== false) required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      required,
    };
  }

  _supportsNativeTools(backend) {
    return ['ollama', 'anthropic', 'openai'].includes(backend);
  }

  // ════════════════════════════════════════════════════════
  // BACKEND-SPECIFIC TOOL CALLING
  // ════════════════════════════════════════════════════════

  _chatWithTools(backend, systemPrompt, messages, toolSchemas, taskType) {
    const temp = this.model.temperatures[taskType] || 0.7;

    switch (backend) {
      case 'ollama':    return this._ollamaToolChat(systemPrompt, messages, toolSchemas, temp);
      case 'anthropic': return this._anthropicToolChat(systemPrompt, messages, toolSchemas, temp);
      case 'openai':    return this._openaiToolChat(systemPrompt, messages, toolSchemas, temp);
      default:
        throw new Error(`Backend ${backend} does not support native tool use`);
    }
  }

  /** Ollama: tools parameter in /api/chat */
  async _ollamaToolChat(systemPrompt, messages, toolSchemas, temperature) {
    const http = require('http');
    const url = this.model.backends.ollama.baseUrl;

    const body = {
      model: this.model.activeModel,
      stream: false,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
      ],
      tools: toolSchemas.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      options: { temperature },
    };

    const data = await this._httpPost(`${url}/api/chat`, body);

    const toolCalls = (data.message?.tool_calls || []).map((tc, i) => ({
      id: `call_${i}`,
      name: tc.function?.name,
      input: tc.function?.arguments || {},
    }));

    return {
      text: data.message?.content || '',
      toolCalls,
      rawMessage: data.message,
    };
  }

  /** Anthropic: tools parameter in /v1/messages */
  async _anthropicToolChat(systemPrompt, messages, toolSchemas, temperature) {
    const https = require('https');
    const backend = this.model.backends.anthropic;

    const body = {
      model: this.model._getModelForBackend('anthropic'),
      max_tokens: 4096,
      system: systemPrompt || undefined,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      tools: toolSchemas.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
      temperature,
    };

    const data = await this._httpPost(
      `${backend.baseUrl}/v1/messages`,
      body,
      { 'x-api-key': backend.apiKey, 'anthropic-version': '2023-06-01' }
    );

    const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const toolCalls = (data.content || []).filter(b => b.type === 'tool_use').map(b => ({
      id: b.id,
      name: b.name,
      input: b.input || {},
    }));

    return {
      text: textBlocks.join(''),
      toolCalls,
      rawContent: data.content,
      stopReason: data.stop_reason,
    };
  }

  /** OpenAI-compatible: tools parameter in /v1/chat/completions */
  async _openaiToolChat(systemPrompt, messages, toolSchemas, temperature) {
    const backend = this.model.backends.openai;

    const body = {
      model: this.model._getModelForBackend('openai'),
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
      ],
      tools: toolSchemas.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      temperature,
    };

    const url = backend.baseUrl.endsWith('/') ? backend.baseUrl : backend.baseUrl + '/';
    const data = await this._httpPost(
      `${url}v1/chat/completions`,
      body,
      { 'Authorization': `Bearer ${backend.apiKey}` }
    );

    const choice = data.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function?.name,
      input: safeJsonParse(tc.function?.arguments || '{}', {}, 'NativeToolUse'),
    }));

    return {
      text: choice?.message?.content || '',
      toolCalls,
    };
  }

  // ════════════════════════════════════════════════════════
  // TOOL RESULT FORMATTING
  // ════════════════════════════════════════════════════════

  /**
   * Append tool results to messages for next round.
   * Each backend has different format for tool results.
   */
  _appendToolResults(backend, messages, response, toolResults) {
    switch (backend) {
      case 'ollama':
        return [
          ...messages,
          response.rawMessage, // assistant message with tool_calls
          ...toolResults.map(tr => ({
            role: 'tool',
            content: tr.error ? `Error: ${tr.error}` : JSON.stringify(tr.result).slice(0, 2000),
          })),
        ];

      case 'anthropic':
        return [
          ...messages,
          { role: 'assistant', content: response.rawContent },
          {
            role: 'user',
            content: toolResults.map(tr => ({
              type: 'tool_result',
              tool_use_id: tr.id,
              content: tr.error ? `Error: ${tr.error}` : JSON.stringify(tr.result).slice(0, 2000),
            })),
          },
        ];

      case 'openai':
        return [
          ...messages,
          {
            role: 'assistant',
            content: response.text || null,
            tool_calls: response.toolCalls?.map((tc, i) => ({
              id: tc.id || `call_${i}`,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            })),
          },
          ...toolResults.map(tr => ({
            role: 'tool',
            tool_call_id: tr.id,
            content: tr.error ? `Error: ${tr.error}` : JSON.stringify(tr.result).slice(0, 2000),
          })),
        ];

      default:
        return messages;
    }
  }

  // ── HTTP Helper ──────────────────────────────────────────

  _httpPost(urlStr, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? require('https') : require('http');
      const postData = JSON.stringify(body);

      const req = client.request({
        hostname: url.hostname,
        port: url.port || String(isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          ...extraHeaders,
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (_e) { console.debug('[catch] JSON parse:', _e.message); reject(new Error(`Invalid JSON from ${urlStr }: ${data.slice(0, 200)}`)); }
        });
      });

      req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}

module.exports = { NativeToolUse };
