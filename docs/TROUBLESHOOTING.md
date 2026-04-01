# Troubleshooting

Common issues and their solutions. If your problem isn't listed here, [open an issue](https://github.com/Garrus800-stack/genesis-agent/issues).

---

## Installation

### `npm install` fails with native module errors

**Symptom:** Errors mentioning `node-gyp`, `prebuild`, or compilation failures.

**Fix:** Genesis has only 5 production dependencies — none require native compilation. Check:
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

**Fixed in v4.10.0.** If you're on an older version, update. The periodic health check was overwriting the user's model selection. Now `detectAvailable()` preserves the active model.

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

**Cause:** Consciousness subsystem (Phase 13) runs background processing. On consumer hardware (Intel iGPU + Ollama), this can be noticeable.

**Fix:** Enable lite mode:
```
Settings → consciousness.extension.liteMode = true
```
This reduces polling frequency by ~75% and disables DreamEngine LLM calls.

### Memory usage grows over time

**Cause:** EventBus history, experience frames, and episodic memory accumulate during long sessions.

**Mitigations (all automatic):**
- EventBus uses a ring buffer (capped at 500 entries)
- ExperienceFrames use a circular buffer (capped at 200 frames)
- AdaptiveMemory applies intelligent forgetting
- StorageService LRU cache (capped at 200 entries, v4.12.7)
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

## Getting Help

1. Check the [docs/](docs/) directory for architecture details
2. Run `self-inspect` in the Genesis chat to see the agent's self-model
3. Open an [issue](https://github.com/Garrus800-stack/genesis-agent/issues) with:
   - Genesis version (`package.json`)
   - Node.js version (`node --version`)
   - OS and architecture
   - Console output (if applicable)
