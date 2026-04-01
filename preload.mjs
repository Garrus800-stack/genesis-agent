// ============================================================
// GENESIS AGENT — preload.mjs (KERNEL — IMMUTABLE)
// Secure bridge. Only exposes whitelisted channels.
//
// v4.10.0: Migrated from CJS (preload.js) to ESM (preload.mjs).
// This enables sandbox:true in the BrowserWindow webPreferences,
// removing the largest single security surface area.
//
// Electron 28+ supports ESM preload scripts via the .mjs extension.
// ============================================================

import { contextBridge, ipcRenderer } from 'electron';

const ALLOWED_INVOKE = [
  'agent:chat',
  'agent:chat:stop',
  'agent:get-self-model',
  'agent:get-file',
  'agent:save-file',
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
