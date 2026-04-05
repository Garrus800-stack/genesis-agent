// ============================================================
// GENESIS AGENT — CodeAnalyzer.js
// Reads and understands code — own and external.
// Can compare solutions and suggest integrations.
// ============================================================

const fs = require('fs');
const path = require('path');

class CodeAnalyzer {
  constructor(selfModel, model, prompts) {
    this.selfModel = selfModel;
    this.model = model;
    this.prompts = prompts;
  }

  /**
   * Analyze code based on user question
   */
  analyze(message) {
    // Check if message references a specific file
    const fileMatch = message.match(/(?:datei|file|in)\s+(\S+\.(?:js|ts|json|py|html|css))/i);

    if (fileMatch) {
      return this._analyzeFile(fileMatch[1], message);
    }

    // Check if message contains inline code
    const codeMatch = message.match(/```(?:\w+)?\n([\s\S]+?)```/);
    if (codeMatch) {
      return this._analyzeInlineCode(codeMatch[1], message);
    }

    // General analysis of own codebase
    return this._analyzeOwnCode(message);
  }

  async _analyzeFile(fileName, question) {
    const code = this.selfModel.readModule(fileName);
    if (!code) {
      return `File "${fileName}" not found. Available files:\n${
        this.selfModel.getFileTree().map(f => `- ${f.path}`).join('\n')
      }`;
    }

    // Focus on relevant part if question mentions a function
    const funcMatch = question.match(/(?:funktion|function|methode|method)\s+(\w+)/i);
    const focusedCode = funcMatch
      ? this.prompts.focusCode(code, funcMatch[1])
      : code;

    const prompt = this.prompts.build('analyze-code', {
      code: focusedCode,
      file: fileName,
      question,
    });

    return await this.model.chat(prompt, [], 'analysis');
  }

  async _analyzeInlineCode(code, question) {
    const prompt = this.prompts.build('analyze-code', {
      code,
      file: 'inline',
      question,
    });

    return await this.model.chat(prompt, [], 'analysis');
  }

  async _analyzeOwnCode(question) {
    const summary = this.selfModel.getModuleSummary();
    const prompt = `You are a code analyst. Here is the module structure of a project:

${JSON.stringify(summary, null, 2)}

QUESTION: ${question}

Analyze the overall architecture and answer the question.
Name specific files and classes in your answer.`;

    return await this.model.chat(prompt, [], 'analysis');
  }

  /**
   * Compare own implementation with an alternative approach
   */
  async compareWith(ownFile, alternativeCode, context) {
    const ownCode = this.selfModel.readModule(ownFile);
    if (!ownCode) return `File "${ownFile}" not found.`;

    const prompt = `You are a code comparison expert.

OWN CODE (${ownFile}):
${this.prompts.focusCode(ownCode, null)}

ALTERNATIVE:
${alternativeCode}

CONTEXT: ${context || 'Compare quality, performance, and maintainability'}

Compare both approaches:
1. What does each approach do well?
2. What does each approach do poorly?
3. Recommendation: Keep own, adopt alternative, or combine?

Be specific and objective.`;

    return await this.model.chat(prompt, [], 'analysis');
  }
}

module.exports = { CodeAnalyzer };
