// ============================================================
// GENESIS — EventPayloads.d.ts (auto-generated)
// Generated: 2026-05-17
// Source: EventPayloadSchemas.js (446 events)
//
// DO NOT EDIT — regenerate with:
//   node scripts/generate-event-types.js
// ============================================================

/** Payload type map for all Genesis EventBus events. */
export interface EventPayloadMap {
  'agent-loop:started': {
    goalId: any;
    goal?: any;
  };
  'agent-loop:complete': {
    goalId: any;
    title: any;
    steps: any;
    success: any;
  };
  'agent-loop:step-complete': {
    goalId: any;
    stepIndex: any;
    type?: any;
  };
  'agent-loop:step-failed': {
    goalId: any;
    stepIndex: any;
    type?: any;
    error: any;
  };
  'agentloop:colony-escalated': {
    runId: any;
    reason: any;
    subtasks: any;
  };
  'agent-loop:approval-needed': {
    action: any;
    description: any;
  };
  'agent-loop:auto-approved': {
    action: any;
    description: any;
    reason: any;
  };
  'agent-loop:needs-input': {
    goalId: any;
    question: any;
  };
  'agent:status': {
    state: any;
    detail?: any;
  };
  'agent:shutdown': {
    errors?: any;
  };
  'chat:completed': {
    message: any;
    response: any;
    intent: any;
    success: any;
  };
  'chat:error': {
    message: any;
  };
  'chat:llm-failure': {
    stage: any;
    errorType: any;
    backend: any;
    model: any;
    userVisible: any;
    sourceReadAttempted: any;
    retriesUsed: any;
    details: any;
  };
  'injection:blocked': {
    signals: any;
    toolCount: any;
  };
  'injection:tool-result-flagged': {
    toolName: any;
    toolSource: any;
    signals: any;
    score: any;
  };
  'tool-call:unverified': {
    verdict: any;
    flagCount: any;
    categories: any;
  };
  'read-source:called': {
    path: any;
    bytes: any;
    turnId?: any;
  };
  'read-source:soft-limit': {
    turnCount: any;
    softLimit: any;
    hardLimit: any;
    turnId?: any;
  };
  'self-gate:warned': {
    actionType: any;
    signals: any;
    triggerSource: any;
  };
  'self-statement:contradiction': {
    text: any;
    type: any;
    intent: any;
    ts: any;
  };
  'self-statement:activity-hint': {
    text: any;
    intent: any;
    activeGoalCount: any;
    ts: any;
  };
  'circuit:state-change': {
    from: any;
    to: any;
  };
  'code:safety-blocked': {
    file?: any;
    issues: any;
  };
  'cognitive:circularity-detected': {
    pattern?: any;
    count?: any;
  };
  'cognitive:overload': {
    metric: any;
    value: any;
  };
  'health:degradation': {
    service: any;
    reason: any;
    level: any;
  };
  'health:memory-leak': {
    heapUsedMB: any;
    trend: any;
  };
  'health:circuit-forced-open': {
    service: any;
    reason: any;
  };
  'health:recovery': {
    service: any;
    strategy: any;
    reason: any;
    attemptsUsed: any;
  };
  'health:recovery-failed': {
    service: any;
    strategy: any;
    error: any;
  };
  'health:recovery-exhausted': {
    service: any;
    totalAttempts: any;
  };
  'idle:cycle-start': {
    thoughtCount: any;
    timeSinceUser: any;
    energy: any;
  };
  'idle:thinking': {
    activity: any;
    thought: any;
  };
  'idle:research-started': {
    topic: any;
    source: any;
  };
  'idle:research-complete': {
    topic: any;
    source: any;
    insight?: any;
  };
  'idle:self-defined': {
    revision: any;
  };
  'idle:thought-complete': Record<string, never>;
  'idle:proactive-insight': {
    activity: any;
    insight: any;
  };
  'model:ollama-unavailable': {
    error: any;
  };
  'model:no-models': Record<string, never>;
  'planner:started': {
    goal: any;
  };
  'planner:replanning': {
    issues: any;
  };
  'reasoning:started': {
    task: any;
    complexity?: any;
    strategy?: any;
  };
  'reasoning:step': {
    step: any;
    total: any;
  };
  'tools:registered': {
    name: any;
    source: any;
  };
  'tools:calling': {
    name: any;
  };
  'tools:result': {
    name: any;
    duration: any;
    success: any;
  };
  'tools:error': {
    name: any;
    error: any;
  };
  'user:message': {
    length?: any;
  };
  'verification:complete': {
    result?: any;
  };
  'homeostasis:pause-autonomy': Record<string, never>;
  'homeostasis:state-change': {
    to: any;
  };
  'homeostasis:prune-caches': {
    memoryPressure: any;
  };
  'homeostasis:prune-knowledge': {
    nodeCount: any;
  };
  'homeostasis:reduce-context': {
    latency: any;
  };
  'homeostasis:reduce-load': {
    circuit: any;
  };
  'homeostasis:correction-applied': {
    type: any;
  };
  'emotion:shift': {
    dimension: any;
    from: any;
    to: any;
    mood: any;
  };
  'emotional-frontier:imprint-written': {
    sessionId: any;
    peaks: any;
    sustained: any;
    dominantMood: any;
  };
  'emotional-frontier:boot-restored': {
    shifted: any;
    imprintId: any;
  };
  'metabolism:cost': {
    cost: any;
    tokens: any;
  };
  'immune:intervention': {
    description: any;
  };
  'immune:quarantine': {
    source: any;
    durationMs: any;
  };
  'intent:classified': {
    type: any;
    confidence?: any;
  };
  'intent:tool-mismatch': {
    kind: any;
    intent: any;
    tool: any;
    category: any;
    severity: any;
    note: any;
    correlationId?: any;
  };
  'surprise:novel-event': {
    summary: any;
  };
  'selfmod:success': {
    file: any;
  };
  'selfmod:settings-blocked': {
    message?: any;
  };
  'selfmod:language-guard-blocked': {
    targetFile: any;
    ext: any;
    allowedExt: any;
  };
  'selfmod:trigger-sanity-blocked': {
    intentClass: any;
    originText?: any;
    message?: any;
  };
  'agent:goal-failed-classified': {
    goalId?: any;
    goalDescription?: any;
    errorMessage: any;
    classification: any;
    stepsExecuted?: any;
  };
  'agent:inner-thought': {
    thoughtId: any;
    kind: any;
    sourceModule: any;
    significance?: any;
    novelty?: any;
    textLength: any;
    timestamp: any;
  };
  'agent:self-message-candidate': {
    thoughtId: any;
    kind: any;
    score: any;
    threshold: any;
    passed: any;
  };
  'agent:self-message': {
    thoughtId: any;
    kind: any;
    score: any;
    textLength: any;
    timestamp: any;
  };
  'agent:self-message-suppressed': {
    thoughtId?: any;
    kind: any;
    reason: any;
    detail?: any;
    hadGeneratedText?: any;
    timestamp: any;
  };
  'chat:self-message-appended': {
    role: any;
    content: any;
    timestamp: any;
    initiatedBy: any;
    selfMeta?: any;
  };
  'daemon:skill-created': {
    skill: any;
    reason: any;
  };
  'install:completed': {
    packageName: any;
    path?: any;
  };
  'cleanup-verifier:scan-complete': {
    target: any;
    safe: any;
    findingKinds: any;
    findingCount: any;
  };
  'mcp:tool-call': {
    server: any;
    tool: any;
  };
  'mcp:server-started': {
    port: any;
  };
  'mcp:bridge-started': {
    tools: any;
    resources?: any;
  };
  'mcp:resource-read': {
    uri: any;
  };
  'error:trend': {
    category: any;
    type: any;
  };
  'goal:completed': {
    id: any;
    description: any;
  };
  'tool:synthesized': {
    name: any;
    description: any;
    attempt: any;
  };
  'tool:synthesis-failed': {
    description: any;
  };
  'tool-use:reprompt-needed': {
    round: any;
    excerpt: any;
  };
  'colony:run-started': {
    id: any;
    goal: any;
  };
  'colony:run-completed': {
    id: any;
    goal: any;
    subtasks: any;
    duration: any;
  };
  'colony:run-failed': {
    id: any;
    error: any;
  };
  'colony:run-request': {
    goal: any;
  };
  'colony:merge-completed': {
    runId: any;
    merged: any;
    conflicts: any;
  };
  'deploy:started': {
    id: any;
    target: any;
    strategy: any;
  };
  'deploy:completed': {
    id: any;
    target: any;
    strategy: any;
    duration: any;
  };
  'deploy:failed': {
    id: any;
    target: any;
    error: any;
  };
  'deploy:rollback': {
    id: any;
    target: any;
    snapshot: any;
  };
  'deploy:rollback-unavailable': {
    id: any;
    target: any;
    reason: any;
  };
  'deploy:swap': {
    target: any;
    from: any;
    to: any;
  };
  'task-outcome:recorded': {
    taskType: any;
    backend: any;
    success: any;
  };
  'task-outcome:stats-updated': {
    byTaskType: any;
    byBackend: any;
    total: any;
  };
  'context:compressed': {
    originalTokens: any;
    compressedTokens: any;
    messagesCompressed: any;
    tokensSaved: any;
  };
  'context:overflow-prevented': {
    totalTokens: any;
    budget: any;
    messagesCompressed: any;
  };
  'skill:installed': {
    name: any;
    version: any;
    source: any;
  };
  'skill:uninstalled': {
    name: any;
  };
  'memory:consolidation-complete': {
    kgMerged: any;
    kgPruned: any;
    lessonsArchived: any;
    durationMs: any;
  };
  'memory:consolidation-failed': {
    error: any;
  };
  'workspace:slot-evicted': {
    key: any;
    salience: any;
  };
  'replay:recording-complete': {
    id: any;
    goalId: any;
    steps: any;
    durationMs: any;
  };
  'llm:cost-cap-reached': {
    scope: any;
    used: any;
    limit: any;
    taskType: any;
  };
  'llm:cost-warning': {
    scope: any;
    pct: any;
    used: any;
    limit: any;
  };
  'backup:exported': {
    path: any;
    files: any;
    rawSize: any;
    archiveSize: any;
  };
  'backup:imported': {
    source: any;
    imported: any;
    skipped: any;
  };
  'update:available': {
    current: any;
    latest: any;
    url: any;
  };
  'idle:consolidate-memory': Record<string, never>;
  'adaptation:proposed': {
    id: any;
    type: any;
  };
  'adaptation:applied': {
    id: any;
    type: any;
    revertAvailable: any;
  };
  'adaptation:validated': {
    id: any;
    type: any;
    baselineScore: any;
    postScore: any;
    delta: any;
    decision: any;
  };
  'adaptation:rolled-back': {
    id: any;
    type: any;
    reason: any;
    lessonStored: any;
  };
  'adaptation:validation-deferred': {
    id: any;
    reason: any;
  };
  'adaptation:cycle-complete': {
    outcome: any;
    cyclesRun: any;
  };
  'router:empirical-strength-injected': {
    taskTypes: any;
  };
  'network:status': {
    online: any;
  };
  'network:failover': {
    from: any;
    to: any;
    reason: any;
  };
  'network:restored': {
    model: any;
    backend: any;
  };
  'lesson:learned': {
    category: any;
    title: any;
    content: any;
  };
  'lesson:applied': {
    id: any;
    category: any;
  };
  'lesson:confirmed': {
    id: any;
    category: any;
    confirmed: any;
  };
  'lesson:contradicted': {
    id: any;
    category: any;
    contradicted: any;
  };
  'lesson:quarantined': {
    id: any;
    category: any;
    contradicted: any;
    confirmed: any;
  };
  'koennen:candidate-recorded': {
    candidateId: any;
    goalId: any;
    gatePass: any;
  };
  'koennen:candidates-noticed': {
    count: any;
    windowMs: any;
    sampleTitles?: any;
  };
  'dream:skills-crystallized': {
    crystallized: any;
    rejected: any;
  };
  'skill:quarantined': {
    skillName: any;
    reason: any;
    details?: any;
  };
  'skill:forge-attempt': {
    source: any;
    attempt: any;
    maxAttempts: any;
  };
  'skill:forge-succeeded': {
    source: any;
    skillName: any;
    attempts: any;
  };
  'skill:forge-failed': {
    source: any;
    attempts: any;
    lastError: any;
  };
  'prompt:strategy-updated': {
    intents: any;
    recommendations: any;
  };
  'replay:started': {
    id: any;
    totalEvents: any;
  };
  'replay:event': {
    recordingId: any;
    index: any;
    kind: any;
  };
  'replay:completed': {
    id: any;
    eventsReplayed: any;
  };
  'trust:level-changed': {
    from: any;
    to: any;
  };
  'trust:upgrades-available': {
    count: any;
    actions: any;
  };
  'trust:upgrade-accepted': {
    actionType: any;
    newLevel: any;
  };
  'autonomy:earned': {
    actionType: any;
    wilsonLower: any;
    samples: any;
    successes: any;
  };
  'autonomy:revoked': {
    actionType: any;
    wilsonLower: any;
    samples: any;
    reason: any;
  };
  'symbolic:resolved': {
    level: any;
    stepType: any;
    confidence: any;
    source: any;
  };
  'symbolic:fallback': {
    reason: any;
    stepType: any;
  };
  'eventstore:corrupted-row': {
    file: any;
    line: any;
    error: any;
    total: any;
  };
  'selfmod:consciousness-blocked': {
    coherence: any;
  };
  'idle:curiosity-targeted': {
    weakness: any;
    targetModule: any;
    insight: any;
  };
  'goal:abandoned': {
    id?: any;
    description?: any;
  };
  'goal:created': {
    goalId: any;
    description: any;
  };
  'goal:resumed': {
    goalId?: any;
  };
  'shell:plan-complete': {
    task: any;
    success: any;
  };
  'daemon:started': Record<string, never>;
  'daemon:stopped': Record<string, never>;
  'daemon:cycle-complete': Record<string, never>;
  'daemon:auto-repair': {
    issues: any;
    fixed: any;
    trustLevel: any;
  };
  'daemon:suggestions': {
    suggestions: any;
  };
  'daemon:control-listening': {
    path: any;
  };
  'daemon:control-closed': Record<string, never>;
  'daemon:control-connected': {
    clients: any;
  };
  'daemon:control-disconnected': {
    clients: any;
  };
  'daemon:control-command': {
    method: any;
    id?: any;
  };
  'daemon:control-error': {
    error: any;
  };
  'cognitive:started': Record<string, never>;
  'cognitive:service-recovered': {
    service: any;
    previousState: any;
    totalRecoveries: any;
  };
  'cognitive:service-degraded': {
    service: any;
    failures: any;
    backoffMs: any;
  };
  'cognitive:service-disabled': {
    service: any;
    failures: any;
    totalFailures: any;
  };
  'cognitive:token-budget-warning': {
    usage: any;
    estimated: any;
    max: any;
  };
  'cognitive:decision-evaluated': {
    decision: any;
    outcome: any;
    rollingQuality: any;
  };
  'model:failover': {
    from: any;
    to: any;
    error: any;
    reason: any;
    effectiveModel?: any;
    preferredModel?: any;
  };
  'model:failover-unavailable': {
    from: any;
    reason: any;
    error: any;
  };
  'model:auto-switched': {
    originalModel: any;
    routedModel: any;
    routedBackend: any;
    taskType: any;
    reason?: any;
  };
  'model:marked-unavailable': {
    modelName: any;
    reason: any;
    ttlMs: any;
  };
  'model:unavailable-cleared': {
    modelName: any;
    automatic: any;
  };
  'model:cloud-without-fallback': {
    model: any;
    backend: any;
  };
  'model:thinking-trace': {
    text: any;
    modelName: any;
  };
  'value:stored': {
    id: any;
    name: any;
    weight: any;
    source: any;
  };
  'value:reinforced': {
    id: any;
    name: any;
    weight: any;
    evidence: any;
  };
  'module:signed': {
    path: any;
    hash: any;
  };
  'module:tampered': {
    path: any;
    expected: any;
    actual: any;
  };
  'refactor:started': {
    description: any;
  };
  'refactor:complete': {
    description: any;
    filesChanged: any;
  };
  'refactor:rolled-back': {
    description: any;
    error: any;
  };
  'plugin:installed': {
    name: any;
    type: any;
    version: any;
  };
  'plugin:uninstalled': {
    name: any;
  };
  'peer:rejected': {
    ip: any;
    reason: any;
  };
  'peer:fitness-score': {
    genomeHash: any;
    score: any;
    generation: any;
  };
  'selfmod:failure': {
    reason: any;
  };
  'selfmod:frozen': {
    reason: any;
  };
  'selfmod:circuit-reset': Record<string, never>;
  'agent-loop:step-delegating': {
    goalId?: any;
    stepIndex?: any;
  };
  'agent-loop:timeout': {
    goalId?: any;
    elapsed?: any;
  };
  'agent:error': {
    error: any;
    source: any;
  };
  'agent:status-update': {
    state: any;
  };
  'agent:loop-approval-needed': {
    goalId: any;
    action: any;
  };
  'agent:loop-progress': {
    goalId: any;
    step: any;
  };
  'agent:open-in-editor': {
    path: any;
  };
  'shell:executed': {
    command: any;
    exitCode: any;
    duration?: any;
  };
  'shell:failed': {
    command: any;
    error: any;
  };
  'shell:blocked': {
    command: any;
    reason?: any;
  };
  'shell:planning': {
    task: any;
  };
  'shell:step': {
    step: any;
    command?: any;
  };
  'shell:outcome': {
    command: any;
    success: any;
    error?: any;
    platform?: any;
  };
  'shell:permission-changed': {
    command?: any;
  };
  'shell:rate-limited': {
    command?: any;
  };
  'goal:failed': {
    id: any;
    reason: any;
  };
  'goal:replanned': {
    goalId?: any;
  };
  'goal:unblocked': {
    goalId?: any;
  };
  'goal:step-start': {
    goalId: any;
    stepIndex: any;
  };
  'goal:create-file': {
    goalId: any;
    path: any;
  };
  'goal:stalled': {
    id: any;
    description?: any;
    reason: any;
    blockedAt?: any;
    stalledMinutes?: any;
  };
  'goal:obsolete': {
    id: any;
    description: any;
    reason: any;
  };
  'goal:driver-pickup': {
    goalId: any;
    priority: any;
    source: any;
  };
  'goal:discarded': {
    ids: any;
    via: any;
  };
  'goal:resumed-auto': {
    goalIds: any;
    mode: any;
  };
  'driver:unresponsive': {
    idleMs: any;
    queueDepth: any;
  };
  'ui:resume-prompt': {
    goalId: any;
    title?: any;
    currentStep?: any;
    totalSteps?: any;
    lastUpdated?: any;
    reason?: any;
  };
  'ui:resume-decision': {
    goalId: any;
    decision: any;
    rememberAs?: any;
  };
  'resource:available': {
    token: any;
    reason?: any;
    resourceId?: any;
    status?: any;
  };
  'resource:unavailable': {
    token: any;
    reason?: any;
    resourceId?: any;
    status?: any;
  };
  'goal:blocked-on-resources': {
    goalId: any;
    resources: any;
  };
  'goal:resumed-from-resource-block': {
    goalId: any;
    resource: any;
  };
  'agent-loop:blocked-on-resources': {
    goalId?: any;
    stepIndex?: any;
    stepType?: any;
    resources: any;
  };
  'perception:ollama-tick': {
    status?: any;
  };
  'goal:blocked-on-subgoal': {
    parentId: any;
    subId: any;
  };
  'goal:subgoal-spawned': {
    parentId: any;
    subId: any;
    obstacleType?: any;
    contextKey?: any;
    stepIndex?: any;
    description?: any;
  };
  'goal:obstacle-loop-protected': {
    parentId: any;
    obstacleType?: any;
    contextKey?: any;
    reason: any;
  };
  'goal:proposed': {
    id: any;
    description: any;
    source?: any;
  };
  'goal:negotiation-start': {
    pendingId: any;
    description: any;
    source?: any;
    revised?: any;
  };
  'goal:negotiation-confirmed': {
    pendingId: any;
    description: any;
  };
  'goal:negotiation-revised': {
    pendingId: any;
    description: any;
  };
  'goal:negotiation-dismissed': {
    pendingId: any;
    description: any;
  };
  'goal:negotiation-expired': {
    pendingId: any;
    description: any;
  };
  'settings:daemon-toggled': {
    from: any;
    to: any;
    key: any;
  };
  'settings:idlemind-toggled': {
    from: any;
    to: any;
    key: any;
  };
  'settings:selfmod-toggled': {
    from: any;
    to: any;
    key: any;
  };
  'settings:trust-level-changed': {
    from: any;
    to: any;
    key: any;
  };
  'settings:auto-resume-changed': {
    from: any;
    to: any;
    key: any;
  };
  'settings:auto-route-toggled': {
    from: any;
    to: any;
    key: any;
  };
  'settings:mcp-serve-toggled': {
    from: any;
    to: any;
    key: any;
  };
  'settings:koennen-toggled': {
    from: any;
    to: any;
    key: any;
  };
  'settings:koennen-crystallization-toggled': {
    from: any;
    to: any;
    key: any;
  };
  'settings:keys-unreadable': {
    keys: any;
  };
  'chat:system-message': {
    text: any;
  };
  'agent-loop:blocked-on-subgoal': {
    goalId?: any;
    stepIndex?: any;
    stepType?: any;
    subId: any;
  };
  'memory:fact-stored': {
    key: any;
    source?: any;
  };
  'memory:unified-recall': {
    query: any;
  };
  'memory:conflicts-resolved': {
    count?: any;
  };
  'memory:consolidated': {
    count?: any;
  };
  'memory:layer-transition-asked': {
    coreMemoryId: any;
    fromLayer: any;
    toLayer: any;
    decision: any;
  };
  'memory:transition-heuristic-fallback': {
    coreMemoryId: any;
    fromLayer: any;
    toLayer: any;
    reason: any;
  };
  'memory:layer-overflow': {
    layer: any;
    count: any;
    pendingTransitions?: any;
  };
  'memory:self-elevated': {
    episodeId: any;
    reason: any;
  };
  'memory:self-released': {
    episodeId: any;
  };
  'memory:marked': {
    id: any;
    episodeId: any;
    timestamp?: any;
    triggerContext?: any;
  };
  'mcp:connected': {
    server?: any;
  };
  'mcp:connecting': {
    server?: any;
  };
  'mcp:disconnected': {
    server?: any;
  };
  'mcp:degraded': {
    name: any;
    failRate: any;
  };
  'mcp:error': {
    server?: any;
    error: any;
  };
  'mcp:tools-discovered': {
    server?: any;
    tools?: any;
  };
  'mcp:server-removed': {
    server?: any;
  };
  'mcp:pattern-detected': {
    pattern: any;
  };
  'mcp:notification': {
    server?: any;
    method: any;
  };
  'homeostasis:critical': Record<string, never>;
  'homeostasis:recovering': Record<string, never>;
  'homeostasis:throttle': Record<string, never>;
  'homeostasis:correction-lifted': {
    type: any;
  };
  'homeostasis:simplified-mode': {
    recommendations: any;
  };
  'homeostasis:allostasis': {
    vital: any;
    oldThreshold?: any;
    newThreshold?: any;
  };
  'online-learning:streak-detected': {
    actionType: any;
    consecutiveFailures: any;
    suggestion: any;
  };
  'online-learning:escalation-needed': {
    actionType: any;
    currentModel: any;
    surprise: any;
    confidence: any;
  };
  'online-learning:temp-adjusted': {
    actionType: any;
  };
  'online-learning:calibration-drift': Record<string, never>;
  'online-learning:novelty-shift': Record<string, never>;
  'dream:started': {
    dreamNumber: any;
  };
  'dream:complete': {
    dreamNumber: any;
    duration: any;
    newSchemas: any;
    insights: any;
  };
  'dream:cycle-forced': {
    reason: any;
    layerCount: any;
  };
  'insight:actionable': {
    source: any;
    type: any;
    description: any;
  };
  'delegation:submitted': {
    taskId: any;
    peerId: any;
    description: any;
    estimatedMs: any;
  };
  'delegation:completed': {
    taskId: any;
    peerId: any;
    success: any;
  };
  'delegation:failed': {
    taskId: any;
    peerId: any;
    error: any;
  };
  'delegation:received': {
    taskId: any;
    description: any;
  };
  'delegation:rejected': {
    taskId: any;
    peerId: any;
    reason: any;
  };
  'peer:discovered': {
    peerId?: any;
  };
  'peer:trusted': {
    peerId?: any;
  };
  'peer:evicted': {
    peerId?: any;
    reason: any;
  };
  'peer:unhealthy': {
    peerId?: any;
  };
  'peer:skill-imported': {
    peerId: any;
    skill?: any;
  };
  'peer:sync-applied': {
    peerId?: any;
  };
  'schema:stored': {
    name: any;
  };
  'schema:merged': {
    name: any;
  };
  'schema:removed': {
    name: any;
  };
  'schema:pruned': {
    count?: any;
  };
  'workspace:consolidate': {
    goalId: any;
    items: any;
    workspaceStats: any;
  };
  'hot-reload:success': {
    module?: any;
  };
  'hot-reload:failed': {
    module?: any;
    error: any;
  };
  'hot-reload:syntax-error': {
    module?: any;
    error: any;
  };
  'hot-reload:rollback': {
    module?: any;
  };
  'learning:pattern-detected': {
    pattern: any;
  };
  'learning:frustration-detected': {
    message?: any;
  };
  'learning:capability-gap': {
    userRequest: any;
    response: any;
    timestamp: any;
  };
  'learning:intent-suggestion': {
    intent: any;
  };
  'learning:performance-alert': {
    type?: any;
  };
  'llm:call-complete': {
    taskType?: any;
    model?: any;
    backend?: any;
    latencyMs?: any;
    promptTokens?: any;
    responseTokens?: any;
    cached?: any;
    goalId?: any;
    correlationId?: any;
    failover?: any;
    effectiveModel?: any;
    tokens?: any;
    durationMs?: any;
  };
  'llm:call-error': {
    error: any;
  };
  'llm:rate-limited': {
    model?: any;
  };
  'llm:budget-warning': {
    usage?: any;
  };
  'llm:budget-auto-reset': {
    reason: any;
    triggeredBy: any;
  };
  'llm:budget-manual-reset': {
    timestamp: any;
  };
  'llm:continuation-started': {
    model: any;
    taskType?: any;
    capability?: any;
  };
  'llm:continuation-complete': {
    model: any;
    attempts: any;
    finalDoneReason?: any;
    totalTokens?: any;
    durationMs: any;
  };
  'llm:continuation-failed': {
    model: any;
    attempts: any;
    reason: any;
    partialContentLength?: any;
    durationMs: any;
  };
  'cost:recorded': {
    ts: any;
    taskType?: any;
    model?: any;
    backend?: any;
    promptTokens?: any;
    responseTokens?: any;
    latencyMs?: any;
    cached?: any;
    goalId?: any;
    correlationId?: any;
    failover?: any;
    effectiveModel?: any;
  };
  'perception:file-added': {
    path: any;
  };
  'perception:file-changed': {
    path: any;
  };
  'perception:file-removed': {
    path: any;
  };
  'perception:memory-pressure': {
    heapUsedPct: any;
    rss?: any;
  };
  'reasoning:completed': {
    task: any;
  };
  'reasoning:refined': {
    task?: any;
  };
  'reasoning:solve': {
    task: any;
  };
  'reasoning:impact-analysis': {
    target?: any;
  };
  'reasoning:trace-recorded': {
    type: any;
    summary: any;
    correlationId?: any;
    goalId?: any;
  };
  'simulation:started': {
    plan?: any;
  };
  'simulation:branched': {
    branch?: any;
  };
  'simulation:complete': {
    result?: any;
  };
  'effector:registered': {
    name: any;
  };
  'effector:executed': {
    name: any;
  };
  'effector:failed': {
    name: any;
    error: any;
  };
  'effector:blocked': {
    name: any;
    reason: any;
  };
  'spawner:starting': {
    task?: any;
  };
  'spawner:completed': {
    task?: any;
    success: any;
  };
  'spawner:progress': {
    task: any;
  };
  'spawner:error': {
    task?: any;
    error: any;
  };
  'file:import-blocked': {
    path: any;
    resolved: any;
  };
  'file:imported': {
    path?: any;
  };
  'file:executed': {
    path: any;
  };
  'health:started': Record<string, never>;
  'health:tick': Record<string, never>;
  'health:metric': {
    service: any;
    metric: any;
    value: any;
  };
  'htn:plan-validated': {
    valid: any;
    totalSteps: any;
    totalIssues?: any;
    totalWarnings?: any;
    crossIssues?: any;
  };
  'htn:dry-run': {
    plan?: any;
  };
  'htn:cost-estimated': {
    plan?: any;
    cost?: any;
  };
  'embodied:panel-changed': {
    panel?: any;
  };
  'embodied:focus-changed': {
    focus?: any;
  };
  'embodied:engagement-changed': {
    engagement?: any;
  };
  'web:search': {
    query: any;
  };
  'web:fetch': {
    url: any;
  };
  'web:fetched': {
    url: any;
    status?: any;
  };
  'exec:sandbox': {
    code: any;
  };
  'exec:shell': {
    command: any;
  };
  'exec:system': {
    command: any;
  };
  'expectation:formed': {
    type?: any;
  };
  'expectation:compared': {
    totalSurprise: any;
    valence?: any;
    actionType?: any;
    isNovel?: any;
    expected?: any;
    actual?: any;
  };
  'expectation:calibrated': {
    type?: any;
  };
  'genome:loaded': Record<string, never>;
  'genome:trait-adjusted': {
    trait: any;
    value?: any;
  };
  'genome:reproduced': {
    generation?: any;
  };
  'metabolism:consumed': {
    tokens: any;
  };
  'metabolism:insufficient': {
    required?: any;
    available: any;
  };
  'metabolism:state-changed': {
    state: any;
  };
  'prompt-evolution:experiment-started': {
    section: any;
    hypothesis: any;
  };
  'prompt-evolution:experiment-completed': {
    section: any;
    promoted?: any;
  };
  'prompt-evolution:rollback': {
    section: any;
    reason?: any;
  };
  'prompt-evolution:promoted': {
    section: any;
    variantId: any;
    improvement: any;
  };
  'chat:retry': {
    attempt: any;
    error: any;
    delayMs: any;
  };
  'ci:analyzed': {
    totalFailures: any;
    autoFixable: any;
  };
  'container:replaced': {
    name: any;
  };
  'container:binding-report': {
    timestamp: any;
    summary: any;
  };
  'context:built': Record<string, never>;
  'editor:open': {
    content: any;
    language?: any;
    filename?: any;
  };
  'embedding:ready': {
    model: any;
    dimensions: any;
  };
  'episodic:recorded': {
    episode?: any;
  };
  'ui:heartbeat': Record<string, never>;
  'router:routed': {
    backend?: any;
  };
  'store:integrity-violation': {
    key?: any;
  };
  'worldstate:file-changed': {
    path: any;
  };
  'narrative:updated': {
    chapter?: any;
  };
  'goals:loaded': {
    total: any;
    unfinished?: any;
    archived?: any;
  };
  'failure:classified': {
    category: any;
    error?: any;
  };
  'classifier:trained': {
    samples: any;
  };
  'notification:show': {
    message?: any;
  };
  'fitness:evaluated': {
    score: any;
  };
  'safety:degraded': {
    reason: any;
  };
  'boot:degraded': {
    reason?: any;
  };
  'boot:complete': {
    durationMs: any;
    serviceCount: any;
    timestamp: any;
  };
  'lifecycle:re-entry-complete': {
    duration: any;
    journalWritten?: any;
  };
  'error:health-summary': {
    errors: any;
  };
  'circuit:fallback': {
    service?: any;
  };
  'capability:issued': {
    module: any;
    scope: any;
    tokenId: any;
  };
  'capability:revoked': {
    tokenId: any;
  };
  'tool:native-call': {
    name: any;
    round: any;
    input: any;
  };
  'tools:unregistered': {
    name: any;
  };
  'worker:spawned': {
    workerId: any;
  };
  'worker:error': {
    workerId: any;
    error: any;
  };
  'fs:read': {
    path: any;
  };
  'fs:write': {
    path: any;
  };
  'net:external': {
    url: any;
  };
  'net:local': Record<string, never>;
  'surprise:processed': {
    surprise?: any;
  };
  'surprise:amplified-learning': {
    surprise: any;
  };
  'steering:model-escalation': {
    frustration: any;
  };
  'steering:rest-mode': Record<string, never>;
  'intent:llm-classified': {
    intent: any;
    message?: any;
  };
  'intent:learned': {
    type?: any;
  };
  'intent:cascade-decision': {
    stage: any;
    verdict: any;
    signalsMatched?: any;
  };
  'knowledge:learned': {
    count?: any;
    source?: any;
    text?: any;
  };
  'knowledge:node-added': {
    id: any;
    type?: any;
    label?: any;
  };
  'knowledge:nodes-pruned': {
    count: any;
    remaining: any;
  };
  'meta:outcome-recorded': {
    category: any;
    success: any;
    model?: any;
    total?: any;
  };
  'meta:recommendations-updated': Record<string, never>;
  'needs:high-drive': {
    need: any;
  };
  'needs:satisfied': {
    need: any;
  };
  'planner:complete': {
    plan?: any;
  };
  'planner:truncated': {
    reason: any;
  };
  'preservation:violation': {
    rule?: any;
  };
  'emotion:watchdog-reset': {
    dimension: any;
    from: any;
    to: any;
    stuckMs: any;
  };
  'emotion:watchdog-alert': {
    stuck: any;
  };
  'lessons:recorded': {
    category: any;
  };
  'colony:ipc-spawn': {
    runId: any;
    workerCount: any;
  };
  'disclosure:probe-detected': {
    count: any;
    pattern: any;
  };
  'system:security-degraded': {
    reason: any;
    preloadMode: any;
    mitigation: any;
  };
  'system:cloud-sync-root-detected': {
    rootDir: any;
  };
  'causal:recorded': {
    stepId: any;
    changes: any;
    relation: any;
  };
  'causal:promoted': {
    action: any;
    suspicion: any;
    observations: any;
  };
  'causal:staleness-triggered': {
    file: any;
    diffPct: any;
    threshold: any;
  };
  'goal:synthesized': {
    title: any;
    weakness: any;
    priority: any;
  };
  'goal:circuit-breaker': {
    regressions: any;
    pauseUntil: any;
  };
  'inference:contradictions-found': {
    count: any;
  };
  'abstraction:extracted': {
    lessonId: any;
    category: any;
  };
  'abstraction:contradiction': {
    lessonId: any;
    category: any;
  };
  'abstraction:obsolete': {
    lessonId: any;
    retries: any;
    lastReason: any;
  };
  'goal:blocked-as-duplicate': {
    goalId: any;
    matchScore: any;
    matchedCapability: any;
    source: any;
  };
  'goal:duplicate-warning': {
    goalId: any;
    matchScore: any;
    matchedCapability: any;
  };
  'goal:dissonance-pushback': {
    goalId: any;
    proposedDescription: any;
    matchedGoalId: any;
    dissonanceScore: any;
    source: any;
  };
  'idle:read-source': {
    module: any;
    reason?: any;
  };
  'idle:read-source-budget-exhausted': {
    cycleCount?: any;
    sessionCount?: any;
  };
  'core-memory:created': {
    id: any;
    type: any;
    significance: any;
    signals: any;
  };
  'core-memory:candidate': {
    candidateId: any;
    signals: any;
    signalCount: any;
  };
  'core-memory:veto': {
    id: any;
    userNote?: any;
  };
  'core-memory:user-marked': {
    id: any;
    type: any;
  };
  'core-memory:released': {
    id: any;
    reason: any;
    releasedAt?: any;
  };
  'journal:written': {
    visibility: any;
    source: any;
    byteLength?: any;
    tags?: any;
  };
}

/** All known event names. */
export type EventName = keyof EventPayloadMap;
