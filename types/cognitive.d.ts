// ============================================================
// GENESIS — types/cognitive.d.ts
// TypeScript definitions for Phase 9-12 modules.
// v4.10.0
// ============================================================

// ── Phase 9: Cognitive Architecture ─────────────────────────

export interface ExpectationResult {
  expectedOutcome: string;
  confidence: number;
  basis: string;
  risks: string[];
}

export interface ExpectationEngine {
  predict(goalId: string, step: { type: string; [key: string]: any }): Promise<ExpectationResult>;
  updateFromOutcome(goalId: string, actual: { success: boolean; detail?: string }): void;
  getAccuracy(): { total: number; correct: number; rate: number };
}

export interface SimulationBranch {
  id: string;
  steps: Array<{ action: string; outcome: string; risk: number }>;
  totalRisk: number;
  feasibility: number;
}

export interface MentalSimulator {
  simulate(plan: Array<{ type: string; [key: string]: any }>, worldState: any): Promise<{
    branches: SimulationBranch[];
    bestBranch: SimulationBranch | null;
    warnings: string[];
  }>;
}

export interface SurpriseSignal {
  intensity: number;
  sourceEvent: string;
  expected: any;
  actual: any;
  timestamp: number;
}

export interface SurpriseAccumulator {
  record(expected: any, actual: any, context: string): SurpriseSignal;
  getRecentSignals(limit?: number): SurpriseSignal[];
  getAverageSurprise(windowMs?: number): number;
  reset(): void;
}

export interface DreamPhaseResult {
  phase: string;
  duration: number;
  schemasExtracted: number;
  memoriesConsolidated: number;
  insightsFound: number;
}

export interface DreamCycle {
  dream(): Promise<{
    phases: DreamPhaseResult[];
    totalDuration: number;
    newSchemas: number;
  }>;
  getLastDreamReport(): any;
  isDreaming(): boolean;
}

export interface Schema {
  id: string;
  pattern: string;
  confidence: number;
  usageCount: number;
  created: number;
  lastUsed: number;
  source: string;
}

export interface SchemaStore {
  store(pattern: string, source: string, confidence?: number): Schema;
  find(query: string, limit?: number): Schema[];
  get(id: string): Schema | null;
  decay(rate?: number): number;
  prune(minConfidence?: number): number;
  getStats(): { total: number; avgConfidence: number; staleCount: number };
}

export interface SelfNarrative {
  getNarrative(): string;
  getIdentityTraits(): Record<string, number>;
  maybeUpdate(): Promise<boolean>;
  getHistory(): Array<{ timestamp: number; narrative: string; trigger: string }>;
}

// ── Phase 10: Persistent Agency ─────────────────────────────

export type FailureCategory = 'TRANSIENT' | 'DETERMINISTIC' | 'ENVIRONMENTAL' | 'CAPABILITY';

export interface FailureClassification {
  category: FailureCategory;
  confidence: number;
  suggestedAction: string;
  retryable: boolean;
  maxRetries: number;
  backoffMs?: number;
}

export interface FailureTaxonomy {
  classify(error: Error | string, context?: { step?: any; goal?: any }): FailureClassification;
  getStats(): Record<FailureCategory, number>;
}

export interface ContextBudget {
  code: number;
  conversation: number;
  memory: number;
  tools: number;
  system: number;
}

export interface DynamicContextBudget {
  allocate(intent: string, totalTokens: number): ContextBudget;
  adjustFromFeedback(intent: string, success: boolean): void;
  getBudgets(): Record<string, ContextBudget>;
}

export interface SteeringSignals {
  escalateModel: boolean;
  capPlanSteps: number | null;
  restMode: boolean;
  explorationBoost: boolean;
}

export interface EmotionalSteering {
  getSignals(): SteeringSignals;
  start(): void;
  stop(): void;
}

export interface GoalCheckpoint {
  goalId: string;
  step: number;
  timestamp: number;
  state: any;
}

export interface GoalPersistence {
  save(goalId: string, state: any): void;
  resume(): Promise<Array<{ goalId: string; state: any }>>;
  checkpoint(goalId: string, step: number, state: any): void;
  archive(goalId: string): void;
  gc(maxAgeDays?: number): number;
}

// ── Phase 11: Extended Perception ───────────────────────────

export type TrustLevel = 0 | 1 | 2 | 3;
export type TrustLevelName = 'SUPERVISED' | 'ASSISTED' | 'AUTONOMOUS' | 'FULL_AUTONOMY';
export type ActionRisk = 'safe' | 'medium' | 'high' | 'critical';

export interface TrustLevelSystem {
  getLevel(): TrustLevel;
  getLevelName(): TrustLevelName;
  canPerform(actionRisk: ActionRisk): boolean;
  requestUpgrade(targetLevel: TrustLevel): { allowed: boolean; reason?: string };
  suggestUpgrade(): { suggested: boolean; targetLevel?: TrustLevel; evidence?: string };
  start(): void;
  stop(): void;
}

export interface EffectorAction {
  name: string;
  description: string;
  risk: ActionRisk;
  schema: Record<string, any>;
  execute(params: any): Promise<any>;
  dryRun(params: any): Promise<any>;
}

export interface EffectorRegistry {
  register(action: EffectorAction): void;
  execute(name: string, params: any, options?: { dryRun?: boolean }): Promise<any>;
  list(): EffectorAction[];
  getByRisk(risk: ActionRisk): EffectorAction[];
}

// ── Phase 12: Symbolic + Neural Hybrid ──────────────────────

export interface GraphQuery {
  type: 'dependencies' | 'impact' | 'cycles' | 'path' | 'contradictions';
  source?: string;
  target?: string;
  depth?: number;
}

export interface GraphReasonerResult {
  answered: boolean;
  result: any;
  confidence: number;
  queryTimeMs: number;
}

export interface GraphReasoner {
  tryAnswer(query: string): Promise<GraphReasonerResult>;
  queryDependencies(moduleId: string, depth?: number): any[];
  analyzeImpact(moduleId: string): { affected: string[]; riskScore: number };
  findCycles(): string[][];
  findContradictions(): Array<{ nodeA: string; nodeB: string; contradiction: string }>;
}

export interface RetentionScore {
  surprise: number;
  emotionalIntensity: number;
  accessFrequency: number;
  semanticImportance: number;
  recency: number;
  total: number;
}

export interface AdaptiveMemory {
  computeRetention(memoryId: string): RetentionScore;
  consolidate(): Promise<{ consolidated: number; forgotten: number }>;
  getRetentionStats(): { avgRetention: number; atRisk: number; total: number };
}
