// ============================================================
// GENESIS — foundation/ModelBridgeContext.js (v7.8.6)
//
// Call-context-resolution mixin extracted from ModelBridge.js in
// v7.8.6. Holds the four helpers that resolve the temperature,
// routing, backend target, and priority for a single chat() /
// streamChat() call:
//
//   _resolveTemperature(taskType, options)
//   _resolveRouting(taskType, options)
//   _resolveBackendTarget(taskType, routedSwitch)
//   _resolvePriority(taskType, options)
//
// Why split: ModelBridge.js sat at 697 LOC (File-Size-Guard warn
// threshold 700). _prepareCallContext was a 56-LOC monolithic block
// doing four logically separate things. Extracting the helpers to
// this mixin shrinks ModelBridge.js to 653 LOC and makes each
// resolution step independently testable. Same pattern as
// ModelBridgeAvailability.js (v7.5.6), ModelBridgeDiscovery.js,
// and ModelBridgeFailover.js (v7.6.5).
//
// Mixed onto ModelBridge.prototype at module-load via Object.assign
// — see ModelBridge.js bottom.
// ============================================================

'use strict';

// Alias-map: caller taskType -> ModelRouter category. Without these
// aliases dream/wakeup/memory paths would fall back to the chat route
// and never actually get routed — yet they are the prime auto-routing
// target. Co-located with the routing helper that consumes it.
const TASK_TYPE_ROUTING_MAP = {
  'code':            'code-gen',
  'dream-judgment':  'classification',
  'dream-summarize': 'summarization',
  'memory-classify': 'classification',
  'wakeup':          'reasoning',
};

const contextMixin = {

  _resolveTemperature(taskType, options) {
    let temp = this.temperatures[taskType] || this.temperatures.chat;
    if (typeof options.temperature === 'number') temp = options.temperature;
    if (this.metaLearning && taskType !== 'chat' && options.temperature === undefined) {
      try {
        const rec = this.metaLearning.recommend(taskType, this.activeModel);
        if (rec && rec.temperature !== undefined) temp = rec.temperature;
      } catch (_e) { /* MetaLearning not ready */ }
    }
    return temp;
  },

  _resolveRouting(taskType, options) {
    if (this._settings?.get?.('agency.autoRouteByTask') === false) return null;
    if (!this._modelRouter || !taskType) return null;
    if (options._userChat === true) return null;
    try {
      const routerCategory = TASK_TYPE_ROUTING_MAP[taskType] || taskType;
      const routed = this._modelRouter.route(routerCategory);
      if (!routed?.model || routed.model === this.activeModel) return null;
      const found = this.availableModels.find(m => m.name === routed.model);
      if (!found?.backend) return null;
      const routedSwitch = {
        originalModel: this.activeModel,
        routedModel: routed.model,
        routedBackend: found.backend,
        taskType,
        reason: routed.reason,
      };
      this._routingStats.autoRouted++;
      this._routingStats.lastRouted = { ...routedSwitch, at: Date.now() };
      this.bus.fire('model:auto-switched', routedSwitch, { source: 'ModelBridge' });
      return routedSwitch;
    } catch (_e) {
      return null;
    }
  },

  _resolveBackendTarget(taskType, routedSwitch) {
    const roleOverride = this._resolveForTask(taskType);
    const targetBackend = routedSwitch?.routedBackend
                       || roleOverride?.backend
                       || this.activeBackend;
    const effectiveModel = routedSwitch?.routedModel
                        || roleOverride?.model;
    const calledModel = effectiveModel || this.activeModel;
    return { targetBackend, effectiveModel, calledModel, roleOverride };
  },

  _resolvePriority(taskType, options) {
    return options.priority ?? (taskType === 'chat' ? 10 : 0);
  },

};

module.exports = { contextMixin, TASK_TYPE_ROUTING_MAP };
