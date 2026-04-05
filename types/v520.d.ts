// ============================================================
// GENESIS — v5.2.0 Type Declarations
// ============================================================

// ── CorrelationContext ──────────────────────────────────────

declare module '../src/agent/core/CorrelationContext' {
  export const CorrelationContext: {
    run<T>(id: string | null, fn: () => T | Promise<T>, prefix?: string): Promise<T>;
    getId(): string | null;
    getContext(): { correlationId: string; startedAt: number; elapsedMs: number } | null;
    fork<T>(fn: () => T | Promise<T>, label?: string): Promise<T>;
    inject<T extends object>(obj: T): T & { correlationId?: string };
    generate(prefix?: string): string;
  };
}

// ── PromptEvolution ─────────────────────────────────────────

interface PromptEvolutionExperiment {
  sectionName: string;
  variantId: string;
  controlText: string;
  variantText: string;
  hypothesis: string;
  status: 'running' | 'completed' | 'cancelled';
  startedAt: number;
  controlTrials: number;
  controlSuccesses: number;
  variantTrials: number;
  variantSuccesses: number;
  generation: number;
  signature?: string;
  decision?: string;
  completedAt?: number;
  controlRate?: number;
  variantRate?: number;
  improvement?: number;
}

interface PromptEvolutionStatus {
  enabled: boolean;
  generation: number;
  activeExperiments: string[];
  promotedSections: string[];
  experiments: Record<string, PromptEvolutionExperiment>;
  promotedVariants: Record<string, { text: string; promotedAt: number; generation: number; improvement?: number }>;
  historyCount: number;
  recentHistory: Partial<PromptEvolutionExperiment>[];
}

declare module '../src/agent/intelligence/PromptEvolution' {
  export class PromptEvolution {
    static containerConfig: { name: string; phase: number; deps: string[]; tags: string[]; lateBindings: string[] };
    constructor(deps: { bus: any; storage: any; metaLearning: any });
    moduleSigner: any;
    model: any;
    asyncLoad(): Promise<void>;
    stop(): void;
    getSection(sectionName: string, defaultText: string): { text: string; variantId: string | null };
    recordOutcome(sectionName: string, variantId: string | null, success: boolean): void;
    startExperiment(sectionName: string, currentText: string, hypothesis?: string): Promise<PromptEvolutionExperiment | null>;
    rollback(sectionName: string): boolean;
    cancelExperiment(sectionName: string): boolean;
    getStatus(): PromptEvolutionStatus;
    setEnabled(enabled: boolean): void;
    buildPromptContext(): string;
  }
  export const EVOLVABLE_SECTIONS: Set<string>;
  export const MIN_TRIALS_PER_ARM: number;
}

// ── McpTransport — updated with CircuitBreaker ──────────────

declare module '../src/agent/capabilities/McpTransport' {
  export class McpServerConnection {
    constructor(config: {
      name: string;
      url: string;
      transport?: 'sse' | 'http';
      headers?: Record<string, string>;
      enabled?: boolean;
      circuitBreakerThreshold?: number;
      circuitBreakerCooldownMs?: number;
      circuitBreakerTimeoutMs?: number;
      circuitBreakerRetries?: number;
      circuitBreakerRetryDelayMs?: number;
    }, bus?: any);
    name: string;
    status: 'disconnected' | 'connecting' | 'ready' | 'degraded' | 'error';
    tools: Array<{ name: string; description: string; inputSchema: object; server: string }>;
    connect(): Promise<void>;
    disconnect(): void;
    discoverTools(): Promise<Array<{ name: string; description: string; inputSchema: object; server: string }>>;
    callTool(toolName: string, args?: object): Promise<any>;
    getStatus(): {
      name: string;
      status: string;
      circuitBreaker: { name: string; state: string; failures: number; stats: object };
      health: { totalRequests: number; failures: number; lastLatency: number; percentiles: object; queueDepth: number };
    };
  }
}
