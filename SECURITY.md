# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 7.2.x  | ✅ Active |
| 7.1.x  | ⚠️ Critical fixes only |
| 7.0.x  | ❌ Unsupported |
| < 6.0  | ❌ Unsupported |

## Reporting a Vulnerability

If you discover a security vulnerability in Genesis, **please do not open a public issue.**

Instead, report it privately via:
- **Email:** Open a GitHub issue titled "Security Report" with minimal detail, then DM the maintainer
- **GitHub Security Advisories:** [Create a private advisory](https://github.com/Garrus800-stack/genesis-agent/security/advisories/new)

We aim to acknowledge reports within 48 hours and provide a fix within 7 days for critical issues.

## Security Architecture

Genesis is a self-modifying AI agent, which makes its security model uniquely important. The system employs **ten layers of defense-in-depth**:

### Layer 1: Immutable Kernel
`main.js`, `preload.js`, `preload.mjs`, and `src/kernel/` are SHA-256 hash-locked at boot. The agent **cannot modify, delete, or replace** these files. `SafeGuard.lockKernel()` enforces this at every write operation.

### Layer 2: Hash-Locked Critical Files
Fifteen agent files are hash-locked via `SafeGuard.lockCritical()` (expanded in v7.0.8, v7.1.3):
- `CodeSafetyScanner.js` — AST-based code analysis
- `VerificationEngine.js` — programmatic result verification
- `Constants.js` — system limits and thresholds
- `EventBus.js` — inter-module communication
- `Container.js` — dependency injection core
- `McpWorker.js` — worker isolation boundary (v5.1.0)
- `PreservationInvariants.js` — semantic safety rules (v5.5.0)
- `Sandbox.js` — execution isolation (v7.0.8)
- `CapabilityGuard.js` — capability token system (v7.0.8)
- `TrustLevelSystem.js` — trust evaluation (v7.0.8)
- `ModuleSigner.js` — module signing (v7.0.8)
- `EarnedAutonomy.js` — autonomy gating (v7.0.8)
- `DisclosurePolicy.js` — information sovereignty (v7.0.8)
- `ApprovalGate.js` — approval workflow (v7.0.8)
- `ImmuneSystem.js` — self-modification monitoring (v7.0.8)

This prevents the agent from weakening its own safety checks through self-modification.

### Layer 3: AST Code Safety Scanner
Every piece of LLM-generated code is parsed into an Abstract Syntax Tree (via `acorn`) and scanned against 20+ rules before being written to disk. This catches:
- `eval()`, `new Function()`, indirect eval via string concatenation
- Kernel file access attempts
- `process.exit()`, `require('child_process')` outside approved contexts
- Electron security flag manipulation (`nodeIntegration: true`, `contextIsolation: false`)
- System directory writes

If `acorn` is not installed, the scanner falls back to regex-only mode and **blocks all self-modification** as a safety measure.

### Layer 4: Capability Token System
`CapabilityGuard` issues scoped, signed tokens to modules. A module requesting `fs:write` receives a token valid only for that scope. Tokens can be revoked individually or by module. Compromised modules cannot exceed their granted permissions.

### Layer 5: IPC Channel Whitelisting
The Electron preload script (`preload.js`) explicitly whitelists every allowed IPC channel. The renderer process can only invoke, send, or receive on declared channels — all others throw errors.

### Layer 6: Content Security Policy
The Electron window enforces a strict CSP:
```
default-src 'self';
script-src 'self' https://cdnjs.cloudflare.com;
style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com;
connect-src 'self';
```
This blocks execution of any injected script even if other layers are bypassed.

### Layer 7: Sandbox Isolation
Code execution uses two modes:
- **VM mode:** `vm.createContext` with frozen prototypes, no `process`/`require`/`eval` access. For quick evals only — not security-grade.
- **Process mode:** Fork-based execution with timeout (15s), memory limit (128MB), and blocked module list.
- **Linux Namespace mode:** Full PID/Network/Mount/IPC isolation via `unshare` (when available).

### Layer 8: Worker Thread Isolation `v5.1`
MCP Code Mode executes user code in a `worker_thread` with no `require`/`process`/`fs` access, 64MB heap limit, and hard-kill on timeout. Tool calls are bridged via `postMessage` RPC — the worker never touches McpClient internals directly.

### Layer 9: Circuit Breaker `v5.2`
Per-MCP-connection `CircuitBreaker` wraps every tool call. Configurable failure threshold, cooldown period, retry logic, and timeout detection. State machine: CLOSED → OPEN (rejects fast) → HALF_OPEN (probe) → CLOSED. Prevents cascading failures from degraded external services.

### Layer 10: Immune System `v5.0`
Monitors self-modification patterns for anomalies. Detects unusual file change frequency, kernel-adjacent modifications, and code safety regressions. Integrated with DreamCycle for pattern consolidation.

### Additional Measures
- **IPC Rate Limiting** — Per-channel token bucket prevents abuse from compromised renderer
- **IPC has() Guards** `v4.12.7` — All `container.resolve()` calls in IPC handlers check `container.has()` first to prevent throws during degraded boot
- **Atomic Writes** — All file operations use temp-file + rename to prevent half-written files
- **Shell Blocklist** — ShellAgent blocks dangerous commands (`rm -rf /`, `format`, `mkfs`, etc.)
- **Peer Network Encryption** — AES-256-GCM with PBKDF2 (600K iterations) for inter-agent communication
- **Module Signing** — HMAC-SHA256 signatures track self-modified vs. original modules
- **Kernel Integrity Checks** — Periodic SHA-256 verification of all locked files during runtime
- **API Key Masking** `v4.12.4` — Settings IPC handler deep-clones and masks API keys before sending to renderer
- **Dashboard XSS Hardening** `v4.12.4` — All dynamic strings in Dashboard `innerHTML` escaped via `_esc()` sanitizer
- **SSRF Protection** `v4.12.4` — McpTransport blocks connections to private IPs, loopback, link-local, and numeric IP obfuscation
- **Streaming Backend Hardening** `v4.12.7` — All backends track consecutive JSON parse errors and warn at threshold ≥3
- **Safety Coverage Gate** `v4.12.7` — `npm run test:coverage:safety` enforces 80/70/75 on kernel + safety-critical modules
- **Eval Alias Detection** `v4.12.6` — CodeSafetyScanner detects `const e = eval; e()` aliasing via AST VariableDeclarator/AssignmentExpression rules
- **Peer Import Hardening** `v4.12.6` — `child_process` and `process.env` are hard blocks (not just warnings) for peer-imported skills

## Threat Model

| Threat | Mitigation |
|--------|-----------|
| Agent weakens its own safety | Hash-locked critical files (Layer 2) |
| LLM generates malicious code | AST scanner (Layer 3) + sandbox execution (Layer 7) |
| Renderer-side XSS/injection | CSP (Layer 6) + contextIsolation + IPC whitelist (Layer 5) + Dashboard XSS escape |
| Compromised module escalates privileges | Capability tokens with revocation (Layer 4) |
| Agent escapes project directory | SafeGuard blocks writes outside `rootDir` |
| Shell command injection | `execFile` with array args (no shell interpolation) |
| Peer imports malicious code | Schema validation + AST scan + hard-block on child_process/process.env |
| Eval aliasing bypass | AST VariableDeclarator + AssignmentExpression detection (v4.12.6) |
| MCP SSRF to internal services | Private IP / loopback / link-local blocking in McpTransport |
| API key leakage to renderer | Deep-clone + mask before IPC send (v4.12.4) |
| Service unavailable during degraded boot | IPC `has()` guards prevent unhandled throws (v4.12.7) |
| Concurrent write corruption | WriteLock (per-file mutex) + atomic writes (temp + rename) |
| Runaway self-repair loops | Circuit breaker: 3 consecutive failures → freeze + require user reset (v4.12.8) |
| Boot crash from self-modification | BootRecovery sentinel + auto-restore from last-known-good snapshot (v4.12.8) |

## Scope

This security policy covers the Genesis Agent application. It does **not** cover:
- The security of LLM backends (Anthropic, OpenAI, Ollama)
- The security of the host operating system
- Third-party plugins/skills installed by the user (see [SKILL-SECURITY.md](docs/SKILL-SECURITY.md) for sandbox boundaries)
