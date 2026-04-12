// ============================================================
// GENESIS — EventPayloads.d.ts (auto-generated)
// Generated: 2026-04-12
// Source: EventPayloadSchemas.js (335 events)
//
// DO NOT EDIT — regenerate with:
//   node scripts/generate-event-types.js
// ============================================================

/** Payload type map for all Genesis EventBus events. */
export interface EventPayloadMap {
  'agent-loop:started': {
    goalId: any;
    goal: any;
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
    type: any;
  };
  'agent-loop:step-failed': {
    goalId: any;
    stepIndex: any;
    type: any;
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
    error: any;
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
    pattern: any;
    count: any;
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
  'idle:thinking': {
    activity: any;
    thought: any;
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
    result: any;
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
  'surprise:novel-event': {
    summary: any;
  };
  'selfmod:success': {
    file: any;
  };
  'daemon:skill-created': {
    skill: any;
    reason: any;
  };
  'shell:complete': {
    command?: any;
    exitCode?: any;
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
  'deploy:request': {
    target: any;
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
  'selfmod:consciousness-blocked': {
    coherence: any;
  };
  'idle:curiosity-targeted': {
    weakness: any;
    targetModule: any;
    insight: any;
  };
  'goal:abandoned': {
    goalId: any;
    reason: any;
    stepsCompleted?: any;
  };
  'goal:created': {
    goalId: any;
    description: any;
  };
  'goal:resumed': {
    goalId: any;
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
    goalId: any;
    stepIndex: any;
  };
  'agent-loop:timeout': {
    goalId: any;
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
    reason: any;
  };
  'shell:planning': {
    task: any;
  };
  'shell:step': {
    step: any;
    command: any;
  };
  'shell:outcome': {
    command: any;
    success: any;
    error?: any;
    platform?: any;
  };
  'shell:permission-changed': {
    command: any;
  };
  'shell:rate-limited': {
    command: any;
  };
  'goal:failed': {
    id: any;
    reason: any;
  };
  'goal:replanned': {
    goalId: any;
  };
  'goal:unblocked': {
    goalId: any;
  };
  'goal:step-start': {
    goalId: any;
    stepIndex: any;
  };
  'goal:create-file': {
    goalId: any;
    path: any;
  };
  'memory:fact-stored': {
    key: any;
    source?: any;
  };
  'memory:unified-recall': {
    query: any;
  };
  'memory:conflicts-resolved': {
    count: any;
  };
  'memory:consolidated': {
    count?: any;
  };
  'mcp:connected': {
    server: any;
  };
  'mcp:connecting': {
    server: any;
  };
  'mcp:disconnected': {
    server: any;
  };
  'mcp:degraded': {
    server: any;
    reason: any;
  };
  'mcp:error': {
    server: any;
    error: any;
  };
  'mcp:tools-discovered': {
    server: any;
    tools: any;
  };
  'mcp:server-removed': {
    server: any;
  };
  'mcp:pattern-detected': {
    pattern: any;
  };
  'mcp:notification': {
    server: any;
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
    peerId: any;
  };
  'peer:trusted': {
    peerId: any;
  };
  'peer:evicted': {
    peerId: any;
    reason: any;
  };
  'peer:unhealthy': {
    peerId: any;
  };
  'peer:skill-imported': {
    peerId: any;
    skill: any;
  };
  'peer:sync-applied': {
    peerId: any;
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
    count: any;
  };
  'workspace:consolidate': {
    goalId: any;
    items: any;
    workspaceStats: any;
  };
  'hot-reload:success': {
    module: any;
  };
  'hot-reload:failed': {
    module: any;
    error: any;
  };
  'hot-reload:syntax-error': {
    module: any;
    error: any;
  };
  'hot-reload:rollback': {
    module: any;
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
    type: any;
  };
  'llm:call-complete': {
    model?: any;
    tokens?: any;
    durationMs?: any;
  };
  'llm:call-error': {
    error: any;
  };
  'llm:rate-limited': {
    model: any;
  };
  'llm:budget-warning': {
    usage: any;
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
    task: any;
  };
  'reasoning:solve': {
    task: any;
  };
  'reasoning:impact-analysis': {
    target: any;
  };
  'simulation:started': {
    plan: any;
  };
  'simulation:branched': {
    branch: any;
  };
  'simulation:complete': {
    result: any;
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
    task: any;
  };
  'spawner:completed': {
    task: any;
    success: any;
  };
  'spawner:progress': {
    task: any;
  };
  'spawner:error': {
    task: any;
    error: any;
  };
  'file:import-blocked': {
    path: any;
    resolved: any;
  };
  'file:imported': {
    path: any;
  };
  'file:executed': {
    path: any;
  };
  'health:started': Record<string, never>;
  'health:tick': Record<string, never>;
  'health:metric': {
    name: any;
    value: any;
  };
  'htn:plan-validated': {
    plan: any;
  };
  'htn:dry-run': {
    plan: any;
  };
  'htn:cost-estimated': {
    plan: any;
    cost: any;
  };
  'embodied:panel-changed': {
    panel: any;
  };
  'embodied:focus-changed': {
    focus: any;
  };
  'embodied:engagement-changed': {
    engagement: any;
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
    type: any;
  };
  'expectation:compared': {
    type: any;
    match: any;
  };
  'expectation:calibrated': {
    type: any;
  };
  'genome:loaded': Record<string, never>;
  'genome:trait-adjusted': {
    trait: any;
    value: any;
  };
  'genome:reproduced': {
    generation: any;
  };
  'metabolism:consumed': {
    tokens: any;
  };
  'metabolism:insufficient': {
    required: any;
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
    promoted: any;
  };
  'prompt-evolution:rollback': {
    section: any;
    reason: any;
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
    episode: any;
  };
  'ui:heartbeat': Record<string, never>;
  'router:routed': {
    backend: any;
  };
  'store:integrity-violation': {
    key: any;
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
    error: any;
  };
  'classifier:trained': {
    samples: any;
  };
  'notification:show': {
    message: any;
  };
  'fitness:evaluated': {
    score: any;
  };
  'safety:degraded': {
    reason: any;
  };
  'boot:degraded': {
    reason: any;
  };
  'error:health-summary': {
    errors: any;
  };
  'circuit:fallback': {
    service: any;
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
    surprise: any;
  };
  'surprise:amplified-learning': {
    surprise: any;
  };
  'steering:model-escalation': {
    from: any;
    to: any;
  };
  'steering:rest-mode': Record<string, never>;
  'intent:llm-classified': {
    intent: any;
    message?: any;
  };
  'intent:learned': {
    type: any;
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
    plan: any;
  };
  'planner:truncated': {
    reason: any;
  };
  'preservation:violation': {
    rule: any;
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
}

/** All known event names. */
export type EventName = keyof EventPayloadMap;
