# Skill Security Model

**v7.3.6 — What community skills can and cannot do.**

Genesis runs all community skills inside a security sandbox. This document defines the exact boundary — what your skill has access to, what it doesn't, and why.

---

## Execution Environment

Community skills run in a **restricted child process** via `Sandbox.execute()`. They do NOT run in the main Genesis process. This means:

- Your skill gets its own V8 isolate (either `vm.Script` or `child_process.execFile`)
- On Linux, skills run inside an additional `unshare` namespace (no network, no PID visibility)
- Timeout: **30 seconds** default. Skills that exceed this are killed with `SIGKILL`
- Memory: inherited from Node.js defaults (~1.5GB heap). No custom limit currently enforced

---

## Module Access

### Allowed (safe, read-only)

| Module | Why |
|--------|-----|
| `path` | Path manipulation — no I/O |
| `url` | URL parsing |
| `querystring` | Query string parsing |
| `util` | Formatting utilities |
| `assert` | Testing assertions |
| `buffer` | Binary data handling |
| `events` | EventEmitter for internal use |
| `stream` | Stream utilities |
| `string_decoder` | Encoding utilities |
| `crypto` | Hashing, HMAC — no key generation from system entropy |
| `os` | Read-only system info (hostname, platform, cpus) |

### Blocked (dangerous)

| Module | Why |
|--------|-----|
| `child_process` | Arbitrary command execution |
| `cluster` | Process forking |
| `dgram` | Raw UDP sockets |
| `dns` | DNS lookups (information disclosure) |
| `net` | Raw TCP sockets |
| `tls` | TLS connections |
| `http2` | HTTP/2 connections |
| `worker_threads` | Thread spawning |
| `vm` | Nested VM escape |

### Not available (not in allowlist)

| Module | Status |
|--------|--------|
| `fs` | Not available. Skills cannot read or write files directly. `fs.cp`, `fs.cpSync`, `fs.appendFile`, `fs.appendFileSync` are explicitly intercepted. |
| `http` / `https` | Not available. Skills cannot make network requests |
| `require()` | Available only for allowed modules. Dynamic `require()` of arbitrary paths is blocked |

---

## Code Safety Scanning

Before execution, all skill code is parsed by the **AST Code Safety Scanner** (`CodeSafetyScanner.js`). The scanner blocks:

- `eval()`, `new Function()`, indirect eval via string concatenation
- `process.exit()`, `process.kill()`
- Access to `__proto__`, `constructor.constructor`
- Attempts to access kernel files (`main.js`, `preload.js`, `SafeGuard.js`)
- Electron security flag manipulation (`nodeIntegration`, `contextIsolation`)
- System directory writes (`/etc`, `/usr`, `C:\Windows`)
- `require('child_process')` and other blocked modules (even as string literals)

If the scanner detects any of these patterns, the skill is **blocked before execution** — the code never runs.

---

## What Your Skill CAN Do

1. **Receive input** — Your `execute(input)` function receives a string or object from the user
2. **Process data** — Parse, transform, analyze, compute. All in-memory
3. **Return output** — Return a string or object. Genesis displays it to the user
4. **Use allowed modules** — `path.join()`, `crypto.createHash()`, `os.hostname()`, etc.
5. **Throw errors** — Caught and displayed gracefully to the user

## What Your Skill CANNOT Do

1. **Read/write files** — No `fs` access. You cannot read the user's disk
2. **Make network requests** — No `http`, `https`, `net`, `dns`. You cannot phone home
3. **Spawn processes** — No `child_process`, `cluster`, `worker_threads`
4. **Access Genesis internals** — No access to EventBus, Container, KnowledgeGraph, or any service
5. **Modify Genesis code** — Kernel files are hash-locked. Self-modification is blocked for skills
6. **Persist data** — No file system, no database. Skills are stateless between invocations
7. **Access environment variables** — `process.env` is sanitized
8. **Run longer than 30 seconds** — Hard timeout with SIGKILL

---

## Manifest Requirements

Every skill must include a `skill-manifest.json` validated against `schemas/skill-manifest.schema.json`:

```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "description": "What this skill does",
  "entry": "index.js",
  "author": "your-name"
}
```

Required fields: `name` (lowercase, alphanumeric + hyphens), `version` (semver), `entry` (must exist in skill directory).

---

## Trust Model

Community skills are treated as **untrusted code**. The security model assumes:

- The skill author may be malicious
- The skill code may contain obfuscated attacks
- The skill may attempt to escape the sandbox

Genesis defends against all of these through defense-in-depth:

1. **AST scanning** catches known dangerous patterns before execution
2. **Module blocklist** prevents access to dangerous APIs at require-time
3. **Process isolation** limits blast radius to the sandbox process
4. **Linux namespaces** (when available) add OS-level isolation
5. **Timeout + SIGKILL** prevents resource exhaustion
6. **No persistence** prevents state accumulation across invocations

---

## Reporting Security Issues

If you find a way to escape the sandbox or access resources that should be blocked, please report it privately via [GitHub Security Advisories](https://github.com/Garrus800-stack/genesis-agent/security/advisories/new). Do not open a public issue.

We take sandbox escapes seriously and aim to fix them within 48 hours.
