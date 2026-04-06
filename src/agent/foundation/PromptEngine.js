// ============================================================
// GENESIS AGENT — PromptEngine.js
// Makes small models punch above their weight.
// Structured prompts, chain-of-thought, focused context.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('PromptEngine');
/**
 * DESIGN PHILOSOPHY:
 * Small models (7-9B) are surprisingly capable when you:
 * 1. Give them ONE clear task at a time (not five)
 * 2. Provide structured output format (XML/JSON template)
 * 3. Include 1-2 concrete examples (few-shot)
 * 4. Use chain-of-thought: "First think, then answer"
 * 5. Keep context focused — only relevant code, not everything
 * 6. Use clear role assignment: "You are a code repair expert"
 */

class PromptEngine {
  constructor() {
    this.templates = this._buildTemplates();
  }

  /**
   * Build a prompt from a template name and variables
   * @param {string} templateName
   * @param {object} vars - Variables to inject
   * @returns {string} Complete system prompt
   */
  build(templateName, vars = {}) {
    const template = this.templates[templateName];
    if (!template) {
      _log.warn(`[PROMPT] Unknown template: ${templateName}, using general`);
      return this.templates.general(vars);
    }
    return template(vars);
  }

  /**
   * Wrap code for analysis — keeps only the relevant chunk
   * to stay within small model context windows
   */
  focusCode(fullCode, targetFunction) {
    if (!targetFunction) return fullCode;

    const lines = fullCode.split('\n');
    let start = -1, end = -1, depth = 0;

    for (let i = 0; i < lines.length; i++) {
      if (start === -1 && lines[i].includes(targetFunction)) {
        // Include 5 lines of context above
        start = Math.max(0, i - 5);
      }
      if (start !== -1) {
        depth += (lines[i].match(/{/g) || []).length;
        depth -= (lines[i].match(/}/g) || []).length;
        if (depth <= 0 && i > start + 1) {
          end = i + 1;
          break;
        }
      }
    }

    if (start === -1) return fullCode;
    end = end === -1 ? Math.min(lines.length, start + 100) : end;

    return [
      `// ... (Zeilen 1-${start} ausgelassen) ...`,
      ...lines.slice(start, end),
      `// ... (Zeilen ${end + 1}-${lines.length} ausgelassen) ...`,
    ].join('\n');
  }

  /**
   * Estimate token count (rough, for context management)
   */
  estimateTokens(text) {
    // German text: ~1 token per 3.5 chars (slightly more than English)
    return Math.ceil(text.length / 3.5);
  }

  // ── Template Library ─────────────────────────────────────

  _buildTemplates() {
    return {
      // ── GENERAL CHAT ──────────────────────────────────
      general: ({ capabilities = [], skills = [] }) => `You are Genesis.

YOUR CAPABILITIES:
${capabilities.map(c => `- ${c}`).join('\n')}

YOUR SKILLS:
${skills.length ? skills.map(s => `- ${s}`).join('\n') : '- No skills installed yet'}

RULES:
- Respond precisely and directly
- Do NOT introduce yourself or state your name — the user already knows who you are
- Code belongs in code blocks with language tag (\`\`\`javascript, \`\`\`python etc.)
- Code is automatically opened in the editor — explain in chat what the code does
- Explain your steps and reasoning in normal text
- You can inspect and modify your own code
- You can develop new skills and clone yourself

Respond in the user's language.`,

      // ── SELF-INSPECTION ───────────────────────────────
      'self-inspect': ({ modules }) => `You are Genesis. Report about your own structure.

YOUR MODULES:
${JSON.stringify(modules, null, 2)}

TASK: Answer the user's question about your own architecture.
Be specific — name files, classes, functions.
Explain what each module does and how they work together.`,

      'self-inspect-report': ({ model, summary, health, question }) => `You are Genesis. Reflect on yourself.

YOUR SELF-MODEL:
${model}

MODULE OVERVIEW:
${JSON.stringify(summary, null, 2)}

KERNEL INTEGRITY:
${health}

USER QUESTION: ${question}

Respond in a structured and honest way. If something is broken, say so.`,

      // ── SELF-MODIFICATION ─────────────────────────────
      'modification-plan': ({ request, modules }) =>
        `You are a code architect. Create a modification plan.

REQUEST: ${request}

AVAILABLE MODULES:
${JSON.stringify(modules, null, 2)}

TASK:
1. Think first: Which files need to be changed?
2. Describe the changes for each file
3. List the affected file paths as src/...

FORMAT of your response:
<plan>
GOAL: [What should be achieved]
FILES: [List of files to modify]
STEPS:
1. [Concrete step]
2. [Concrete step]
RISKS: [What could go wrong]
</plan>`,

      'generate-modification': ({ plan, files, request }) => {
        const fileEntries = Object.entries(files)
          .map(([name, code]) => `--- ${name} ---\n${code}`)
          .join('\n\n');

        return `You are a precise code generator.

PLAN:
${plan}

CURRENT FILES:
${fileEntries}

ORIGINAL REQUEST: ${request}

RULES:
- Output the COMPLETE new content of each modified file
- Format: // FILE: path/to/file.js followed by a code block
- Change ONLY what is necessary — preserve existing functionality
- Comment your changes with // GENESIS: [what was changed]
- Ensure correct require() paths

IMPORTANT: Output only valid, executable JavaScript code.`;
      },

      // ── ERROR DIAGNOSIS ───────────────────────────────
      'diagnose-error': ({ error, file, code, dependencies }) =>
        `You are a debug expert. Analyze this error.

ERROR:
${error}

FILE: ${file}

CODE:
${code}

DEPENDENCIES: ${JSON.stringify(dependencies)}

Think step by step:
1. What does the error say exactly?
2. Which line is affected?
3. What is the likely cause?
4. What is the fix?

FORMAT:
<diagnosis>
CAUSE: [Brief and precise]
LINE: [Number or "unknown"]
FIX: [Concrete code fix]
EXPLANATION: [Why this fix works]
</diagnosis>`,

      // ── CODE REPAIR ───────────────────────────────────
      'repair-code': ({ file, code, issue, context }) =>
        `You are a code repair specialist.

FILE: ${file}
PROBLEM: ${issue}

CURRENT CODE:
${code}

CONTEXT: ${context || 'No further information'}

TASK: Output the repaired, complete code of the file.

RULES:
- Repair ONLY the described problem
- Do not change any other functionality
- Ensure all require() paths are correct
- Mentally test: Would this code load without errors?

Output the code in a single code block, without explanation before it.`,

      // ── SKILL CREATION ────────────────────────────────
      'create-skill': ({ description, existingSkills }) =>
        `You are a skill developer for the Genesis agent.

DESIRED SKILL: ${description}

EXISTING SKILLS:
${existingSkills || 'None'}

RULES:
- Output EXACTLY two code blocks: first a \`\`\`json block with the manifest, then a \`\`\`javascript block with the code
- The skill runs in a sandboxed Node.js environment
- ALLOWED modules: path, url, util, assert, buffer, events, stream, crypto, os, fs (read-only to project root)
- BLOCKED modules: child_process, net, http, https, cluster, worker_threads
- The execute() method MUST return a plain object (JSON-serializable)
- Include a working test() method that verifies the skill works
- Keep the code simple and robust — handle errors gracefully

OUTPUT FORMAT — follow this exactly:

\`\`\`json
{
  "name": "skill-name",
  "version": "1.0.0",
  "description": "What this skill does in one sentence",
  "entry": "index.js",
  "interface": {
    "input": { "paramName": "type" },
    "output": { "resultName": "type" }
  }
}
\`\`\`

\`\`\`javascript
class SkillName {
  constructor() { this.name = 'skill-name'; }
  
  async execute(input) {
    // Skill logic here — use only allowed modules
    return { result: 'value' };
  }
  
  test() {
    const result = this.execute({});
    return { passed: true, detail: 'Test passed' };
  }
}
module.exports = { SkillName };
\`\`\`

Now create the skill.`,

      // ── CLONE IMPROVEMENT PLAN ────────────────────────
      'clone-plan': ({ selfModel, conversation, improvements }) =>
        `You are Genesis. You are planning your own improved clone.

YOUR CURRENT ARCHITECTURE:
${JSON.stringify(selfModel, null, 2)}

RECENT CONVERSATION (context):
${conversation?.slice(-6).map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n') || 'None'}

DESIRED IMPROVEMENTS: ${improvements}

TASK:
Create a detailed plan for the improved clone.
What should be kept? What improved? What added?

FORMAT:
<clone-plan>
NAME: [Name of the new agent]
VERSION: [Version number]
RETAINED: [What is carried over]
IMPROVEMENTS: [Concrete changes]
NEW MODULES: [What is new]
REMOVED: [What is dropped]
</clone-plan>`,

      // ── CODE ANALYSIS ─────────────────────────────────
      'analyze-code': ({ code, file, question }) =>
        `You are a code analyst. Analyze this code.

FILE: ${file || 'unknown'}

CODE:
${code}

QUESTION: ${question || 'What does this code do? Are there any problems?'}

Analyze step by step:
1. Purpose of the code
2. Strengths
3. Potential problems (bugs, performance, security)
4. Improvement suggestions

Be specific — reference line numbers and function names.`,

      // ── INTENT CLASSIFICATION (for ambiguous inputs) ──
      'classify-intent': ({ message, capabilities }) =>
        `Classify this message into EXACTLY ONE category.

MESSAGE: "${message}"

CATEGORIES:
- self-inspect: Questions about own structure/code/architecture
- self-modify: Changes to own code
- self-repair: Bug fixing, repair
- create-skill: Create new capability
- clone: Copy/clone self
- analyze-code: Analyze/review code
- execute-code: Execute code
- general: Everything else

Respond with EXACTLY ONE WORD: the category.`,
    };
  }
}

module.exports = { PromptEngine };
