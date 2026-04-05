// ============================================================
// GENESIS - WorldStateSnapshot.js (v5.4.0 - WorldState Decomposition)
//
// Extracted from WorldState.js to complete CQRS-lite split:
//   WorldState.js           - live state, mutations, lifecycle
//   WorldStateQueries.js    - read-only queries, preconditions
//   WorldStateSnapshot.js   - immutable clone for plan simulation
//
// Used by FormalPlanner and MentalSimulator for branching
// plan evaluation without mutating live state.
// ============================================================

'use strict';

const path = require('path');

class WorldStateSnapshot {
  constructor(state) {
    this.state = JSON.parse(JSON.stringify(state));
    this._kernelFiles = new Set();
    this._shellBlocklist = new Set();
    this.rootDir = '';
    this._simulatedChanges = [];
  }

  // Mirror the precondition API
  canWriteFile(filePath) {
    if (!filePath) return false;
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.rootDir, filePath);
    if (this._kernelFiles.has(resolved)) return false;
    if (resolved.includes(path.sep + 'node_modules' + path.sep)) return false;
    return resolved.startsWith(this.rootDir + path.sep);
  }

  isKernelFile(filePath) {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.rootDir, filePath);
    return this._kernelFiles.has(resolved);
  }

  canRunTests() { return this.state.project.testScript !== null; }
  canUseModel(name) {
    if (!name) return this.state.runtime.ollamaStatus === 'running';
    return this.state.runtime.ollamaModels.includes(name);
  }
  canRunShell(command) {
    if (!command) return false;
    const lower = command.toLowerCase();
    for (const blocked of this._shellBlocklist) {
      if (lower.includes(blocked)) return false;
    }
    return true;
  }

  // Simulate effects
  markFileModified(filePath) {
    this._simulatedChanges.push({ type: 'file-modified', path: filePath });
  }

  // v4.0: Extended simulation support for MentalSimulator

  /** Simulate a test failure (breaks canRunTests in subsequent steps) */
  markTestsFailed() {
    this._simulatedChanges.push({ type: 'tests-failed' });
  }

  /** Simulate a model becoming unavailable */
  markModelUnavailable(model) {
    this._simulatedChanges.push({ type: 'model-unavailable', model });
    this.state.runtime.ollamaModels =
      this.state.runtime.ollamaModels.filter(m => m !== model);
  }

  /** Deep clone for branching simulation (MentalSimulator tree nodes) */
  deepClone() {
    const cloned = new WorldStateSnapshot(this.state); // JSON deep-copies in constructor
    cloned._kernelFiles = new Set(this._kernelFiles);
    cloned._shellBlocklist = new Set(this._shellBlocklist);
    cloned.rootDir = this.rootDir;
    cloned._simulatedChanges = [...this._simulatedChanges];
    return cloned;
  }

  getSimulatedChanges() { return this._simulatedChanges; }
}

module.exports = { WorldStateSnapshot };
