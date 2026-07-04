// ============================================================
// GENESIS — src/agent/hexagonal/ChatOrchestratorLessons.js
//
// v7.9.29 (hygiene): the two best-effort lesson-capture helpers
// (_captureNotFoundLesson, _captureUnknownCmdLesson), extracted from
// ChatOrchestratorHelpers to keep it under the 700-LOC guard. Self-
// contained — this._lessonsStore only, no module deps. Merged onto the
// helpers object via Object.assign, mirroring the existing mixin style.
// ============================================================

const chatOrchestratorLessons = {

  // v7.8.0: capture a lesson when a tool call fails because the
  // referenced path/command doesn't exist. Records into LessonsStore
  // as obstacle-resolution so AgentLoopPlanner sees it next time.
  // Best-effort, swallows all errors — never blocks a tool result.
  _captureNotFoundLesson(toolName, requestedPath) {
    try {
      const lessonsStore = this._lessonsStore || this.lessonsStore;
      if (!lessonsStore || typeof lessonsStore.record !== 'function') return;
      if (!requestedPath || requestedPath === '<unknown>') return;
      lessonsStore.record({
        category: 'obstacle-resolution',
        insight: `Tool '${toolName}' was called with path '${String(requestedPath).slice(0, 120)}' which does not exist. Check the path before referencing it; use file-list on the parent dir to verify.`,
        evidence: { confidence: 0.6, sampleSize: 1, surprise: 0.5 },
        tags: ['tool-failure', 'path-not-found', toolName],
        source: 'tool-failure',
      });
    } catch (_e) { /* best-effort */ }
  },

  _captureUnknownCmdLesson(cmd) {
    try {
      const lessonsStore = this._lessonsStore || this.lessonsStore;
      if (!lessonsStore || typeof lessonsStore.record !== 'function') return;
      if (!cmd) return;
      lessonsStore.record({
        category: 'obstacle-resolution',
        insight: `Shell command '${String(cmd).slice(0, 60)}' was not found on this system. Different OSes have different commands — verify availability before using.`,
        evidence: { confidence: 0.6, sampleSize: 1, surprise: 0.5 },
        tags: ['tool-failure', 'unknown-command', cmd],
        source: 'tool-failure',
      });
    } catch (_e) { /* best-effort */ }
  },

};

module.exports = { chatOrchestratorLessons };
