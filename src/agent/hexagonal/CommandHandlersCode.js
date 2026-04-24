// @ts-checked-v5.7
// ============================================================
// GENESIS — CommandHandlersCode.js (v7.4.2 "Kassensturz")
//
// Extracted from CommandHandlers.js as part of the v7.4.2 domain
// split. Handles Code and Skill execution:
//   - executeCode  — run a code block from the message in the sandbox
//   - executeFile  — execute a file by path via FileProcessor
//   - analyzeCode  — delegate to the code analyzer
//   - runSkill     — execute a named installed skill
//
// Prototype-Delegation from CommandHandlers.js via Object.assign.
// Same pattern as DreamCyclePhases.js, ChatOrchestratorSourceRead.js.
// External API unchanged.
// ============================================================

'use strict';

const commandHandlersCode = {

  async executeCode(message) {
    const m = message.match(/```(?:\w+)?\n([\s\S]+?)```/);
    if (!m) return this.lang.t('agent.no_code_block');
    const r = await this.sandbox.execute(m[1]);
    return `\`\`\`\n${r.output || this.lang.t('agent.no_output')}\n\`\`\`${r.error ? `\n**${this.lang.t('agent.error')}:** ${r.error}` : ''}`;
  },

  async executeFile(message) {
    const fileMatch = message.match(/(\S+\.\w{2,4})\b/);
    if (!fileMatch) return this.lang.t('agent.no_file');

    const info = this.fp.getFileInfo(fileMatch[1]);
    if (!info) return this.lang.t('agent.file_not_found', { file: fileMatch[1] });
    if (!info.canExecute) {
      const runtimes = Object.entries(this.fp.getRuntimes()).filter(([_, v]) => v).map(([k]) => k).join(', ');
      return this.lang.t('agent.cannot_execute', { ext: info.extension, runtimes });
    }

    const result = await this.fp.executeFile(fileMatch[1]);
    return `**${info.name}** (${info.language}):\n\`\`\`\n${result.output || this.lang.t('agent.no_output')}\n\`\`\`${result.error ? `\n**${this.lang.t('agent.error')}:** ${result.error}` : ''}`;
  },

  async analyzeCode(message) {
    return this.analyzer.analyze(message);
  },

  async runSkill(message) {
    if (!this.skillManager) return 'No SkillManager available — skills are not loaded.';

    // Extract skill name from message
    const nameMatch = message.match(/([\w-]+-skill)\b/i) ||
                      message.match(/(?:run|execute|use|start|starte?|nutze?|verwende?)\s+(?:the\s+|skill\s+|(?:de[nr]|dein(?:en?)?|mein(?:en?)?)\s+)?["']?([\w-]+)["']?/i);
    const skillName = nameMatch ? (nameMatch[1] || nameMatch[2]) : null;

    if (!skillName || skillName === 'skill' || skillName === 'skills' || /^(dein|mein|den|der|die|das|the|my)$/i.test(skillName)) {
      // List available skills
      const all = this.skillManager.listSkills();
      if (all.length === 0) return 'No skills installed. Use "create a skill..." to build one.';
      return `Available skills:\n${all.map(s => `  • ${s.name}: ${s.description || '(no description)'}`).join('\n')}\n\nUsage: "run <skill-name>"`;
    }

    try {
      const result = await this.skillManager.executeSkill(skillName, {});
      if (result.error) return `⚠️ Skill "${skillName}" error: ${result.error}`;
      const output = result.output || result.result || result;
      return `✅ Skill "${skillName}" result:\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``;
    } catch (err) {
      // v5.9.1: If skill not found but shell is available, try as shell command
      if (err.message?.includes('not found') && this.shell) {
        return this.shellRun(message);
      }
      return `❌ Skill "${skillName}" failed: ${err.message}`;
    }
  },

};

module.exports = { commandHandlersCode };
