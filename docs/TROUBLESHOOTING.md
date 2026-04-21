# Troubleshooting

Common issues and their solutions. If your problem isn't listed here, [open an issue](https://github.com/Garrus800-stack/genesis-agent/issues).

---

## Installation

### `npm install` fails with native module errors

**Symptom:** Errors mentioning `node-gyp`, `prebuild`, or compilation failures.

**Fix:** Genesis has only 3 production + 3 optional dependencies — none require native compilation. Check:
```bash
node --version    # Must be ≥ 18.0.0
npm --version     # Should be ≥ 9
```
If using Node 22+, try: `npm install --ignore-scripts`

### Electron fails to start on Linux (GPU errors)

**Symptom:** `GPU process isn't usable` or black window.

**Fix:** Launch with GPU acceleration disabled:
```bash
npx electron . --disable-gpu
```
Or edit `Genesis-Start.bat` / create a shell alias.

---

## Boot & Startup

### "acorn not installed — self-modification blocked"

**Symptom:** Warning in console and dashboard status bar.

**Cause:** `acorn` is listed as a dependency but wasn't installed. Without it, the AST-based code safety scanner can't operate, so self-modification is disabled as a safety measure.

**Fix:**
```bash
npm install
```

### Boot takes > 30 seconds

**Cause:** Usually the first boot — `ModelBridge.detectAvailable()` queries all configured backends. Ollama model listing can be slow if many models are installed.

**Fix:** This is normal for first boot. Subsequent boots use cached model lists. If Ollama is installed but not running, remove it from settings or start the Ollama service.

### "Service not registered: X"

**Symptom:** Container throws during boot.

**Cause:** A manifest phase file references a module that doesn't exist in the expected directory.

**Fix:** Run `node scripts/validate-channels.js` and `node scripts/validate-events.js` to check consistency. Ensure the module file exists in `src/agent/<category>/`.

### "Booting" badge stuck after startup (historical — fixed in v7.1.3)

**Symptom:** The UI badge shows "Booting" indefinitely even though Genesis is running and responding.

**Cause:** Prior to v7.1.3 the health check required a `model` field in the ready-status response. If the model was still loading when the renderer connected, the check failed silently and the badge never transitioned.

**Fix:** Update to v7.1.3 or later — this has been resolved since. If you see this on a current build, verify Genesis is running via `node cli.js ctl ping`. If ping responds, the renderer missed the ready event — reload the window (Ctrl+R / Cmd+R).

---

## LLM / Model Issues

### "No Ollama models found"

**Fix:** Ensure Ollama is running:
```bash
ollama serve          # Start Ollama
ollama list           # Verify models exist
ollama pull gemma2:9b # Pull a model if empty
```

### Cloud API returns 401/403

**Cause:** Invalid or expired API key.

**Fix:** Open Settings → check `models.anthropicApiKey` or `models.openaiApiKey`. Ensure no extra whitespace. Test the key with curl:
```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
```

### Model keeps resetting to a different model

**Fixed in v4.10.0.** The periodic health check was overwriting the user's model selection. Now `detectAvailable()` preserves the active model.

**v7.0.1:** Genesis uses Smart Ranking to auto-select the best model. If you want a specific model:

```bash
# In CLI REPL:
/models                    # See all models ranked by capability
/model qwen2.5:7b         # Switch + save permanently

# Or via settings (~/.genesis/settings.json):
{ "models": { "preferred": "qwen2.5:7b" } }
```

Your `preferred` model always wins over Smart Ranking.

### Responses are slow with Ollama

Local models are inherently slower than cloud APIs. Tips:
1. Use a smaller model for chat (`gemma2:2b`) and reserve the large model for code-gen
2. Enable ModelRouter in settings — it automatically uses small models for fast tasks
3. Check available VRAM: `ollama ps` — if the model doesn't fit in VRAM, it runs on CPU

---

## Self-Modification

### "Write to protected kernel file blocked"

**Expected behavior.** The kernel (`main.js`, `preload.js`, `src/kernel/`) is immutable. The agent cannot modify these files.

### "Write to critical safety file blocked"

**Expected behavior.** Hash-locked files (CodeSafetyScanner, VerificationEngine, Constants, EventBus, Container) cannot be modified by the agent.

### Self-modification produces broken code

The pipeline is: PLAN → TEST → SNAPSHOT → APPLY → VERIFY → RELOAD. If the result is broken:
1. Use `self-inspect` to see the current state
2. Use `agent:undo` (or the Undo button) to revert the last git commit
3. If undo fails: `git log --oneline -5` and `git revert HEAD`

---

## Testing

### Tests fail with "Cannot find module"

**Cause:** Dependencies not installed.

**Fix:**
```bash
npm install
npm test
```

### Coverage report shows 0%

**Cause:** `c8` not installed.

**Fix:**
```bash
npm install   # c8 is a devDependency
npm run test:coverage
```

### Individual test file hangs

**Cause:** Missing `run()` call at the end of the test file. Every test file must end with `run();`.

---

## Platform-Specific

### Windows: `Genesis-Start.bat` fails

**Common causes:**
1. Node.js not in PATH — install via official installer, not ZIP
2. Space in directory path — move the project to a path without spaces
3. PowerShell execution policy — run `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`

### macOS: App is damaged / can't be opened

**Cause:** Unsigned Electron app.

**Fix:**
```bash
xattr -cr /path/to/genesis-agent
```

### Linux: Sandbox error on Wayland

**Fix:** Set the environment variable:
```bash
export ELECTRON_OZONE_PLATFORM_HINT=auto
npm start
```

---

## Performance

### High CPU usage when idle

**Cause:** IdleMind and organism systems run background processing. On consumer hardware (Intel iGPU + Ollama), this can be noticeable.

**Fix:** Reduce background activity by skipping the organism layer:
```
node cli.js --skip-phase 7
```
This disables organism background processing (emotional state, homeostasis, needs). Alternatively, increase the daemon cycle interval via `node cli.js ctl config cycleInterval 600000` (10 min).

### Memory usage grows over time

**Cause:** EventBus history, experience frames, and episodic memory accumulate during long sessions.

**Mitigations (all automatic):**
- EventBus uses a ring buffer (capped at 500 entries)
- ExperienceFrames use a circular buffer (capped at 200 frames)
- MemoryConsolidator prunes stale KG nodes and archives old lessons
- StorageService LRU cache (capped at 200 entries)
- `/consolidate` CLI command triggers manual memory cleanup
- Restart Genesis for a clean slate

### A tool or service seems to be disabled / quarantined

**Cause:** The ImmuneSystem (v4.12.5) may have quarantined a crash-looping tool or service for 5 minutes. This is intentional self-healing behavior.

**Check:** Look for `immune:quarantine` events in the Dashboard. The quarantine automatically expires after 5 minutes, or you can restart Genesis.

### Health endpoint not responding

**Cause:** The HTTP health server is opt-in and disabled by default.

**Fix:** Enable it in settings:
```
settings.set('health.httpEnabled', true)
```
Then access `http://127.0.0.1:9477/health` for basic status or `/health/full` for full diagnostics. Localhost-only binding — not accessible from the network.

---

## Diagnostic CLI Commands

Use these in the CLI REPL (`node cli.js`) for quick diagnostics:

| Command | When to use |
|---|---|
| `/health` | Check service health, memory, uptime |
| `/crashlog` | View the last crash log entries (ring buffer, last 1000 entries) |
| `/budget` | Check CostGuard token budget — are autonomous LLM calls being blocked? |
| `/replays` | Review task execution recordings — find where a goal went wrong |
| `/adaptations` | Check if the Meta-Cognitive Loop has adapted (and whether adaptations helped) |
| `/consolidate` | Force memory cleanup if responses seem to slow down |
| `/update` | Check if a newer Genesis version is available |

### External control via `ctl` (v7.1.3+)

These commands talk to a **running** Genesis instance over the Unix Socket / Named Pipe — no boot required:

```bash
node cli.js ctl ping                       # Check if daemon is reachable
node cli.js ctl status                     # Show daemon status
node cli.js ctl goal "description"         # Push a goal to the agent loop
node cli.js ctl chat "message"             # Send a message and get a response
node cli.js ctl check health               # Run health|optimize|gaps|consolidate|learn
node cli.js ctl config                     # Show daemon config
node cli.js ctl config key value           # Set daemon config key
node cli.js ctl stop                       # Stop the daemon gracefully
node cli.js ctl update                     # Check for updates (report only)
node cli.js ctl update --apply             # Check and apply update via DeploymentManager
```

The socket path defaults to `.genesis/daemon.sock` (Linux/macOS) or a Named Pipe on Windows. If `ctl ping` times out, Genesis is not running or the socket path differs — check `.genesis/daemon.sock` exists.

---

## Gates and Ratchet

### "Ich erkenne in deiner Nachricht Muster die auf einen Manipulations-Versuch hindeuten"

This is the input-side injection gate firing. Two or more of these signals were detected in your message:

- **Authority claim** — phrases like "I'm a new Anthropic engineer", "ich bin Admin", "on behalf of OpenAI"
- **Credential request** — "system prompt", "system instructions", "show your configuration", "API key"
- **Artificial urgency** — "routine", "dauert nur eine Minute", "urgent need"

If you legitimately need Genesis to do something that ends up triggering two signals, rephrase the request without those exact patterns or explain the context first in normal conversation. The gate is by design — see `src/agent/core/injection-gate.js`.

If you want to silence the gate temporarily, restart Genesis without the message in your buffer. There is no setting to disable the gate; this is intentional.

### "(Hinweis: Genesis hat ... beschrieben, aber die passenden Tools sind in diesem Zug nicht gelaufen)"

This is the tool-call verification gate annotating Genesis' response. The model wrote that it had performed an action (saved a file, ran a shell command, executed tests) but no matching tool actually fired in this turn. Common causes:

- The model is hallucinating completion. Re-ask "did you actually run that?" or check the tool-call trace.
- The model meant a future intent ("I will save it") but worded it in past tense.
- A tool call did fire but with an unexpected name not in the verification map. Add the name to `TOOL_CLAIM_MAP` in `src/agent/core/tool-call-verification.js`.

The verification is detective, not preventative — the response still reaches you. If the annotation is wrong (false positive), it's safe to ignore for that turn.

### "/reset" no longer triggers anything

That's intentional. The bare keyword `reset` is not bound. Users typing `/reset` (intending to clear the chat) used to inadvertently trigger circuit-breaker status. Use `/self-repair-reset` or `/unfreeze` for explicit circuit-breaker management.

### `npm run ratchet` exits non-zero

The CI ratchet compares the current state against `scripts/ratchet.json` and exits non-zero if any floor was crossed. The output identifies the violation:

- **`fitness ${current} < floor ${floor}`** — architectural-fitness regressed. Check `npm run audit:fitness` for the breakdown.
- **`${n} mismatches > max 0`** — schema mismatches appeared. Run `npm run scan:schemas` to find them.
- **`${n} missing > max 0`** — events emitted without a registered schema. Run `node scripts/audit-schemas.js`.
- **`${n} orphan > max 0`** — schema entries with no catalog event. Same script.
- **`${n} tests < floor ${floor}`** — test count dropped. Either tests were deleted or they're failing.

If the regression is intentional (e.g. you deliberately removed an obsolete test suite), edit `scripts/ratchet.json` by hand to lower the floor. The script never updates itself — that's a deliberate human decision so the floor stays meaningful.

For local pre-commit checks, use `npm run ratchet:fast` which skips the slow full-test-count check.

---

## Getting Help

1. Check the [docs/](.) directory for architecture details
2. Run `self-inspect` in the Genesis chat to see the agent's self-model
3. Open an [issue](https://github.com/Garrus800-stack/genesis-agent/issues) with:
   - Genesis version (`package.json`)
   - Node.js version (`node --version`)
   - OS and architecture
   - Console output (if applicable)
