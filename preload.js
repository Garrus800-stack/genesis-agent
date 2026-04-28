// ============================================================
// GENESIS AGENT — preload.js (KERNEL — CJS FALLBACK)
// Secure bridge. Only exposes whitelisted channels.
//
// v7.5.1.x: CJS counterpart to preload.mjs. Both files MUST be
// kept in sync — same channels, same validation logic. The CJS
// version is used as Tier 3 fallback on Windows + Electron 33,
// where ESM preload reliably fails with "Cannot use import
// statement outside a module" in the sandboxed renderer.
// Tier 1 (ESM) is preferred when supported; Tier 2 (bundled)
// is preferred when esbuild has produced dist/preload.js;
// Tier 3 (this file) keeps the agent functional everywhere.
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_INVOKE = [
  'agent:chat',
  'agent:chat:stop',
  'agent:get-self-model',
  'agent:get-file',
  'agent:save-file',
  'agent:open-path',
  'agent:run-in-sandbox',
  'agent:get-file-tree',
  'agent:get-health',
  'agent:switch-model',
  'agent:list-models',
  'agent:clone',
  'agent:import-file',
  'agent:file-info',
  'agent:execute-file',
  'agent:read-external-file',
  'agent:get-settings',
  'agent:set-setting',
  'agent:get-goals',
  'agent:get-goal-tree',
  'agent:undo',
  'agent:get-lang-strings',
  'agent:set-lang',
  'agent:mcp-status',
  'agent:mcp-add-server',
  'agent:mcp-remove-server',
  'agent:mcp-reconnect',
  'agent:mcp-start-server',
  'agent:mcp-stop-server',
  // v3.5.0: Agent Loop + Session
  'agent:loop-status',
  'agent:loop-approve',
  'agent:loop-reject',
  'agent:loop-stop',
  'agent:get-session',
  // v4.0.0: Dashboard event debug
  'agent:get-event-debug',
  // v5.5.0: Reasoning Trace UI
  'agent:get-reasoning-traces',
  // v5.8.0: Dashboard cognitive panels
  'agent:get-architecture',
  'agent:get-architecture-graph',
  'agent:get-project-intel',
  'agent:get-tool-synthesis',
  'agent:get-task-outcomes',
  'agent:get-selfmodel-report',
  // v6.1.0: Self-modification gate statistics
  'agent:get-gate-stats',
  // v6.0.0: Memory consolidation + Replay
  'agent:get-consolidation-report',
  'agent:trigger-consolidation',
  'agent:get-replay-report',
  'agent:get-replay-diff',
  // v6.0.1: Safety infrastructure
  'agent:get-cost-budget',
  'agent:export-data',
  'agent:import-data',
  'agent:get-crash-log',
  'agent:check-update',
  // v6.0.2: Meta-cognitive adaptation loop
  'agent:get-adaptation-report',
  'agent:run-adaptation-cycle',
  // v6.0.5: Network + Provenance
  'agent:get-network-status',
  'agent:force-network-probe',
  'agent:get-provenance-report',
  // v6.0.7: Earned Autonomy
  'agent:get-autonomy-report',
  // v7.2.4: Filesystem-based first-boot detection
  'agent:is-first-boot',
  // v7.4.5: GoalDriver
  'agent:goal-driver-status',
  'agent:goal-driver-queue',
  'agent:resume-decision',
];

const ALLOWED_SEND = [
  'agent:request-stream',
  'ui:heartbeat',       // v5.6.0 SA-P4: UI embodied perception
];

const ALLOWED_RECEIVE = [
  'agent:stream-chunk',
  'agent:stream-done',
  'agent:status-update',
  'agent:open-in-editor',
  // v3.5.0: Agent Loop events
  'agent:loop-progress',
  'agent:loop-approval-needed',
  // v7.4.7: Settings toggle confirmation messages
  'agent:chat-system-message',
  // v7.4.5: GoalDriver resume-prompt (only event with UI-anchored schema; the
  // 4 sibling telemetry events — goal:driver-pickup / goal:resumed-auto /
  // goal:discarded / driver:unresponsive — were removed in v7.5.1 because
  // they had no UI consumer; they remain backend-only telemetry on the bus)
  'ui:resume-prompt',
];

contextBridge.exposeInMainWorld('genesis', {
  invoke: (channel, ...args) => {
    if (!ALLOWED_INVOKE.includes(channel)) {
      throw new Error(`IPC channel not allowed: ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  send: (channel, data) => {
    if (!ALLOWED_SEND.includes(channel)) {
      throw new Error(`IPC send channel not allowed: ${channel}`);
    }
    ipcRenderer.send(channel, data);
  },

  on: (channel, callback) => {
    if (!ALLOWED_RECEIVE.includes(channel)) {
      throw new Error(`IPC receive channel not allowed: ${channel}`);
    }
    const sub = (event, ...args) => callback(...args);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },
});
