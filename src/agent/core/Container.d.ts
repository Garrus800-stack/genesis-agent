// ============================================================
// GENESIS — Container.d.ts (v7.1.2)
//
// Type declarations for the DI Container. Provides typed
// resolve<T>() and tryResolve<T>() via ServiceMap interface.
//
// Usage in JSDoc:
//   /** @type {import('../core/Container').Container} */
//   const container = ...;
//   const sandbox = container.resolve('sandbox'); // → Sandbox
//
// This file is a TYPE-ONLY layer — no runtime changes.
// The agent ignores .d.ts files during self-modification.
// ============================================================

import { EventBus } from './EventBus';

// ── Service Map ─────────────────────────────────────────────
// Maps service names to their resolved types.
// Add new entries when registering services in phase manifests.

export interface ServiceMap {
  // Phase 1: Foundation
  settings: import('../foundation/Settings').Settings;
  selfModel: import('../foundation/SelfModel').SelfModel;
  model: import('../foundation/ModelBridge').ModelBridge;
  llmCache: any;
  sandbox: import('../foundation/Sandbox').Sandbox;
  storage: any;
  eventStore: import('./EventBus').EventBus;
  knowledgeGraph: any;
  awareness: any;

  // Phase 2: Intelligence
  intentRouter: any;
  promptBuilder: any;
  context: any;
  tools: any;
  codeSafety: any;
  verifier: any;

  // Phase 3: Capabilities
  skills: any;
  shellAgent: any;
  mcpClient: any;
  skillRegistry: any;
  hotReloader: any;

  // Phase 4: Planning
  goalStack: any;
  metaLearning: any;
  schemaStore: any;

  // Phase 5: Hexagonal
  chatOrchestrator: any;
  unifiedMemory: any;
  selfModPipeline: any;
  episodicMemory: any;

  // Phase 6: Autonomy
  daemon: any;
  daemonController: any;
  healthMonitor: any;
  serviceRecovery: any;
  deploymentManager: any;
  autoUpdater: any;

  // Phase 7: Organism
  emotionalState: any;
  homeostasis: any;
  needsSystem: any;
  genome: any;
  metabolism: any;
  immuneSystem: any;

  // Phase 8: Revolution
  agentLoop: any;
  sessionPersistence: any;
  vectorMemory: any;
  colonyOrchestrator: any;

  // Phase 9: Cognitive
  cognitiveSelfModel: any;
  taskOutcomeTracker: any;
  reasoningTracer: any;
  adaptiveStrategy: any;
  inferenceEngine: any;
  dreamCycle: any;

  // Phase 10: Agency
  goalPersistence: any;
  conversationCompressor: any;
  userModel: any;
  fitnessEvaluator: any;

  // Phase 11: Extended
  trustLevelSystem: any;
  webPerception: any;

  // Phase 12: Hybrid
  graphReasoner: any;

  // Catch-all for dynamically registered services
  [key: string]: any;
}

// ── Container Class ─────────────────────────────────────────

export class Container {
  constructor(config?: { bus?: EventBus });

  bus: EventBus;

  register(name: string, factory: (container: Container) => any, options?: {
    singleton?: boolean;
    deps?: string[];
    tags?: string[];
    lateBindings?: Array<{ prop: string; service: string; optional?: boolean }>;
    phase?: number;
  }): void;

  registerInstance(name: string, instance: any, options?: {
    deps?: string[];
    tags?: string[];
    lateBindings?: Array<{ prop: string; service: string; optional?: boolean }>;
  }): void;

  /**
   * Resolve a service by name (typed).
   * Throws if service is not registered.
   */
  resolve<K extends keyof ServiceMap>(name: K): ServiceMap[K];
  resolve(name: string): any;

  /**
   * Resolve a service by name, returning null if not found.
   */
  tryResolve<K extends keyof ServiceMap>(name: K): ServiceMap[K] | null;
  tryResolve(name: string): any | null;

  has(name: string): boolean;

  resolveAll(): Map<string, any>;

  getByTag(tag: string): any[];

  wireLateBindings(): void;

  postBoot(): Promise<void>;

  alias(alias: string, canonical: string): void;

  getRegistrationCount(): number;

  getServiceNames(): string[];

  getLateBindingCount(): number;
}
