// ============================================================
// GENESIS — types/core.d.ts
// TypeScript type definitions for core infrastructure.
// Enables IDE autocompletion and type checking for contributors.
//
// Usage: Add to tsconfig.json or jsconfig.json:
//   { "compilerOptions": { "checkJs": true }, "include": ["types/*.d.ts", "src/**/*.js"] }
// ============================================================

// ── EventBus ─────────────────────────────────────────────────

export interface EventMeta {
  event: string;
  timestamp: number;
  source: string;
  [key: string]: any;
}

export type EventHandler = (data: any, meta: EventMeta) => any | Promise<any>;

export interface EventBus {
  on(event: string, handler: EventHandler, options?: { once?: boolean; priority?: number; source?: string }): () => void;
  once(event: string, handler: EventHandler, options?: { priority?: number; source?: string }): () => void;
  emit(event: string, data?: any, meta?: Partial<EventMeta>): Promise<any[]>;
  fire(event: string, data?: any, meta?: Partial<EventMeta>): void;
  request(event: string, data?: any, meta?: Partial<EventMeta>): Promise<any>;
  off(event: string, handlerOrSource: EventHandler | string): boolean;
  removeBySource(source: string): number;
  use(fn: (event: string, data: any, meta: EventMeta) => any): void;
  pause(event: string): void;
  resume(event: string): void;
  getListenerCount(): number;
  getRegisteredEvents(): string[];
  getStats(): Record<string, { emitCount: number; lastEmit: number; listenerCount: number }>;
  getHistory(limit?: number): Array<{ event: string; data: string; timestamp: number; source: string }>;
  middlewares?: Array<(event: string, data: any, meta: EventMeta) => any>;
}

export interface NullBus extends EventBus {}

// ── Container ────────────────────────────────────────────────

export interface LateBinding {
  prop: string;
  service: string;
  optional?: boolean;
}

export interface RegisterOptions {
  singleton?: boolean;
  deps?: string[];
  tags?: string[];
  lateBindings?: LateBinding[];
  phase?: number;
}

export interface Container {
  register(name: string, factory: (container: Container) => any, options?: RegisterOptions): void;
  registerInstance(name: string, instance: any, options?: Partial<RegisterOptions>): void;
  resolve<T = any>(name: string): T;
  has(name: string): boolean;
  replace(name: string, newFactory: (container: Container) => any): any;
  getTagged(tag: string): Array<{ name: string; instance: any }>;
  getDependencyGraph(): Record<string, { deps: string[]; tags: string[]; singleton: boolean; phase: number; resolved: boolean; lateBindings: string[] }>;
  wireLateBindings(): { wired: number; skipped: number; errors: string[] };
  verifyLateBindings(): { verified: number; missing: string[]; total: number };
  bootAll(): Promise<Array<{ name: string; status: string; error?: string }>>;
  postBoot(): Promise<string[]>;
  shutdownAll(): Promise<void>;
}

// ── WriteLock ────────────────────────────────────────────────

export interface WriteLockOptions {
  name?: string;
  defaultTimeoutMs?: number;
}

export interface WriteLock {
  acquire(timeoutMs?: number): Promise<void>;
  release(): void;
  withLock<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
  readonly isLocked: boolean;
  readonly queueLength: number;
  getStats(): { acquires: number; releases: number; timeouts: number; peakQueue: number; locked: boolean; queueLength: number; name: string };
}

// ── Constants ────────────────────────────────────────────────

export interface Timeouts {
  SANDBOX_EXEC: number;
  SHELL_EXEC: number;
  APPROVAL_DEFAULT: number;
  DISK_CHECK: number;
  SEMAPHORE_STARVATION: number;
}

export interface Limits {
  AGENT_LOOP_MAX_STEPS: number;
  AGENT_LOOP_STEP_EXTENSION: number;
  AGENT_LOOP_MAX_ERRORS: number;
  PLAN_MAX_STEPS: number;
  CHAT_HISTORY_MAX: number;
  CHAT_HISTORY_PERSISTED: number;
  CHAT_MAX_TOOL_ROUNDS: number;
  EVENTBUS_HISTORY: number;
  EVENTBUS_MAX_STATS: number;
  LLM_MAX_CONCURRENT: number;
  RESULT_SLICE: number;
  DISK_WARN_BYTES: number;
}

// ── StorageService ───────────────────────────────────────────

export interface StorageService {
  readJSON<T = any>(filename: string, defaultValue?: T): T;
  readText(filename: string, defaultValue?: string): string;
  writeJSON(filename: string, data: any): void;
  writeText(filename: string, text: string): void;
  appendText(filename: string, text: string): void;
  writeJSONDebounced(filename: string, data: any, delayMs?: number): void;
  exists(filename: string): boolean;
  delete(filename: string): boolean;
  list(prefix?: string): string[];
  getPath(filename: string): string;
  flush(): void;
  clearCache(): void;
  getStats(): { baseDir: string; fileCount: number; totalSizeKB: number; cacheEntries: number };
}

// ── ModelBridge ──────────────────────────────────────────────

export interface ModelBridge {
  activeModel: string | null;
  activeBackend: string | null;
  availableModels: Array<{ name: string; backend: string }>;
  chat(systemPrompt: string, messages: Array<{ role: string; content: string }>, taskType?: string, options?: { priority?: number; stream?: boolean; temperature?: number }): Promise<string>;
  detectAvailable(): Promise<void>;
  switchTo(modelName: string): Promise<{ ok: boolean; model?: string; error?: string }>;
  configureBackend(backend: string, config: Record<string, any>): void;
}

// ── SafeGuard ────────────────────────────────────────────────

export interface SafeGuard {
  lockKernel(): void;
  isProtected(filePath: string): boolean;
  validateWrite(filePath: string): boolean;
  validateDelete(filePath: string): boolean;
  verifyIntegrity(): { ok: boolean; issues: Array<{ file: string; issue: string }> };
  getProtectedFiles(): string[];
}

// ── AgentCore ────────────────────────────────────────────────

export interface AgentCore {
  boot(): Promise<void>;
  shutdown(): Promise<void>;
  handleChat(message: string): Promise<{ response: string; [key: string]: any }>;
  stopGeneration(): void;
  getSelfModel(): any;
  getHealth(): any;
  switchModel(model: string): Promise<any>;
  listModels(): Array<{ name: string; backend: string }>;
  cloneSelf(config?: { improvements?: string }): Promise<any>;
  undo(): Promise<{ ok: boolean; reverted?: string; error?: string }>;
  readonly booted: boolean;
}

// ── KnowledgeGraph ───────────────────────────────────────────

export interface KnowledgeNode {
  id: string;
  type: string;
  label: string;
  properties: Record<string, any>;
  created: number;
  accessed: number;
  accessCount: number;
}

export interface KnowledgeGraph {
  addNode(type: string, label: string, properties?: Record<string, any>): string;
  getNode(id: string): KnowledgeNode | null;
  findNode(query: string): KnowledgeNode | null;
  addEdge(sourceId: string, targetId: string, relation: string, weight?: number): string;
  connect(sourceLabel: string, relation: string, targetLabel: string, sourceType?: string, targetType?: string): string;
  removeNode(id: string): boolean;
  pruneStale(maxAgeDays?: number): number;
  search(query: string, limit?: number): Array<{ node: KnowledgeNode; score: number }>;
  searchAsync(query: string, limit?: number): Promise<Array<{ node: KnowledgeNode; score: number }>>;
  buildContext(query: string, maxTokens?: number): string;
  learnFromText(text: string, source?: string): number;
  getStats(): Record<string, any>;
  flush(): void;
}

// ── VerificationEngine ───────────────────────────────────────

export type VerificationStatus = 'pass' | 'fail' | 'ambiguous' | 'warn';

export interface VerificationResult {
  status: VerificationStatus;
  checks: Array<{ name: string; status: VerificationStatus; detail?: string }>;
  summary: string;
}

export interface VerificationEngine {
  verify(step: { type: string; [key: string]: any }, result: any): Promise<VerificationResult>;
  getStats(): { total: number; pass: number; fail: number; ambiguous: number };
}

// ── Manifest Entry ───────────────────────────────────────────

export interface ManifestEntry {
  phase: number;
  deps?: string[];
  tags?: string[];
  lateBindings?: LateBinding[];
  optional?: boolean;
  singleton?: boolean;
  factory: (container: Container) => any;
}

export type ManifestPhaseFunction = (ctx: {
  rootDir: string;
  genesisDir: string;
  guard: SafeGuard;
  bus: EventBus;
  intervals: any;
}, R: (mod: string) => any) => Array<[string, ManifestEntry]>;

// ── v3.8.0 Additions ─────────────────────────────────────────

// EventBus Listener Health Report
export interface ListenerReportEntry {
  event: string;
  count: number;
  sources: Record<string, number>;
}

export interface ListenerReport {
  total: number;
  events: number;
  suspects: ListenerReportEntry[];
  breakdown: Record<string, { count: number; sources: Record<string, number> }>;
}

// Augment EventBus with new method
export interface EventBusV2 extends EventBus {
  getListenerReport(options?: { warnThreshold?: number }): ListenerReport;
}

// Event Payload Validation
export interface PayloadSchema {
  [field: string]: 'required' | 'optional';
}

export interface PayloadValidationHandle {
  getStats(): { checked: number; warnings: number; events: number; schemasLoaded: number };
  removeMiddleware(): void;
}

export function installPayloadValidation(bus: EventBus): PayloadValidationHandle;

// PeerCrypto Session Key Cache
export interface KeyCacheStats {
  size: number;
  maxSize: number;
  totalHits: number;
  ttlMs: number;
}

export function deriveSessionKey(sharedSecret: string, salt: string): string;
export function getKeyCacheStats(): KeyCacheStats;
export function clearKeyCache(): void;
export function encrypt(plaintext: string, key: string): string;
export function decrypt(ciphertext: string, key: string): string;

// AsyncLoad lifecycle (v3.8.0+)
export interface AsyncLoadable {
  asyncLoad?(): Promise<void>;
}

// Plugin System (v3.8.0)
export interface PluginManifest {
  name: string;
  version: string;
  type: 'skill' | 'recipe' | 'extension';
  description: string;
  author?: string;
  entry: string;
  interface?: {
    input?: Record<string, string>;
    output?: Record<string, string>;
  };
  dependencies?: string[];
  permissions?: string[];
}

export interface PluginRegistry {
  install(manifest: PluginManifest, code: string): Promise<{ ok: boolean; error?: string }>;
  uninstall(name: string): boolean;
  list(): PluginManifest[];
  execute(name: string, input: any): Promise<any>;
  getStats(): Record<string, { calls: number; errors: number }>;
}

// ── v4.0.0 Additions ─────────────────────────────────────────

// CognitiveHealthTracker
export type CognitiveHealthState = 'healthy' | 'degraded' | 'disabled';

export interface CognitiveServiceHealth {
  state: CognitiveHealthState;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastError: string | null;
  lastErrorAt: string | null;
  backoffMs: number;
  backoffUntil: string | null;
  disabledAt: string | null;
  recoveries: number;
}

export interface CognitiveHealthReport {
  totalGuardCalls: number;
  totalFailures: number;
  totalSkipped: number;
  totalRecoveries: number;
  services: Record<string, CognitiveServiceHealth>;
  trackedCount: number;
}

export interface CognitiveHealthTracker {
  guard<T = any>(serviceName: string, fn: () => T | Promise<T>, options?: { fallback?: T; context?: string }): Promise<T>;
  guardSync<T = any>(serviceName: string, fn: () => T, options?: { fallback?: T; context?: string }): T;
  reset(serviceName: string): void;
  resetAll(): void;
  isAvailable(serviceName: string): boolean;
  getReport(): CognitiveHealthReport;
  getServiceHealth(serviceName: string): { state: CognitiveHealthState; consecutiveFailures: number; available: boolean; errorHistory: Array<{ message: string; context: string; timestamp: number }> } | null;
  asyncLoad(): Promise<void>;
}

// StorageService v4.0.0 upgrades
export interface StorageServiceV2 extends StorageService {
  readJSONAsync<T = any>(filename: string, defaultValue?: T): Promise<T>;
  readTextAsync(filename: string, defaultValue?: string): Promise<string>;
  writeJSONAsync(filename: string, data: any): Promise<void>;
  writeTextAsync(filename: string, text: string): Promise<void>;
  appendTextAsync(filename: string, text: string): Promise<void>;
  writeJSONDebounced(filename: string, data: any, delayMs?: number, mergeFn?: (existing: any, incoming: any) => any): void;
  writeJSONQueued(filename: string, updater: (current: any) => any): Promise<void>;
  existsAsync(filename: string): Promise<boolean>;
  getWriteStats(): { totalContentions: number; asyncQueueDepth: number; pendingDebounced: number; merges: number; hotFiles: Array<{ filename: string; contentions: number }> };
}

// Graceful Degradation Matrix entry
export interface DegradationEntry {
  service: string;
  phase: number;
  optional: boolean;
  dependents: string[];
  lateBindings: Array<{ consumer: string; prop: string; optional: boolean }>;
  impact: string;
}
