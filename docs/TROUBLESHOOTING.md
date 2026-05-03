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

### Linux: "Preload bridge failed to initialize" / stuck at BOOTING

**Symptom:** On Linux, the Genesis window opens, sidebar renders, but the status pill stays yellow at `BOOTING…` and a red toast appears: `Cannot read properties of undefined (reading 'on')`. After ~5 seconds the UI replaces itself with `⚠ Preload bridge failed to initialize`.

**Cause:** Electron's sandboxed renderer cannot load ESM preload scripts (`preload.mjs`) on Linux with Electron 33–39. The exact error visible in DevTools (Ctrl+Shift+I → Console) is:
```
Unable to load preload script: preload.mjs
SyntaxError: Cannot use import statement outside a module
at runPreloadScript
```
This is the same failure mode previously documented for Windows in v4.13.1. The renderer never receives `window.genesis`, so every `.on(...)` call fails.

**Fix (v7.5.3 and later):** Genesis now skips Tier 1 (ESM) on Linux automatically and uses Tier 2 (Bundled CJS, `dist/preload.js`). After upgrading, the boot log should read:
```
[KERNEL] Preload: Bundled CJS (dist/preload.js) — sandbox:true
```
If it still says `ESM (.mjs) — sandbox:true`, your `dist/preload.js` was not built. Run:
```bash
npm run build:bundle
```
or reinstall dependencies (`npm install` triggers the bundle as a postinstall step).

If you want to force CJS manually for any reason — for example, to test a custom Electron build — rename or delete `preload.mjs`:
```bash
mv preload.mjs preload.mjs.disabled
npm start
```
Tier 2 is selected because Tier 1 no longer finds an `.mjs` file. Same security guarantees (`sandbox:true`).

### Linux: `ollama serve` says "address already in use"

**Symptom:**
```
Error: listen tcp 127.0.0.1:11434: bind: address already in use
```

**Cause:** This is **not an error**. The Ollama installer registers a systemd service that auto-starts on boot and binds `127.0.0.1:11434`. Running `ollama serve` manually tries to bind the same port — which is already held by the service.

On Windows, Ollama runs as a tray application and you can see/stop it. On Linux, you typically don't see anything because the service is silent.

**Check whether the service is running:**
```bash
systemctl status ollama
# or
ss -tulpn | grep 11434
```

**If you just want to use Ollama from Genesis:** Do nothing. The service is already serving on 11434 and Genesis will find it. Verify with:
```bash
curl http://127.0.0.1:11434/api/tags
ollama list
```

**If you want to run Ollama manually** (for custom flags, a different port, or debugging logs in your terminal):
```bash
sudo systemctl stop ollama
ollama serve              # port is now free
```
After your session, optionally restart the service:
```bash
sudo systemctl start ollama
```

**If you never want the service** and prefer to start Ollama manually each session:
```bash
sudo systemctl disable ollama
sudo systemctl stop ollama
```
You can re-enable it any time with `sudo systemctl enable --now ollama`.

### Linux: 40 tests show "node: bad option: --test-force-exit"

**Symptom:** `npm test` reports many failures like:
```
v737-active-refs-port... ❌ Error: node: bad option: --test-force-exit
```

**Cause:** `--test-force-exit` is a Node 22 option. Your system has Node 20 or older.

**Fix:** Install Node 22 — see [QUICK-START.md](QUICK-START.md#debian--ubuntu--mint) for both NodeSource and nvm options.

After Node 22, expect 5868–5870 passed and 0–1 failed (the one allowed failure is `linux-sandbox unshare`, see next entry).

### Linux: "linux-sandbox unshare" test fails

**Symptom:**
```
linux-sandbox... ❌ 9 passed, 1 failed
  ❌ linux: wrapCommand applies available namespaces: Expected "unshare", got "node"
```

**Cause:** The test expects the system's `unshare` utility to be available with full namespace capabilities. On a standard user account without `CAP_SYS_ADMIN`, certain namespace types (PID, network) cannot be created — the helper detects this and falls back, but the test asserts the unrestricted form.

This is a **test environment limitation**, not a Genesis code bug. Genesis uses whatever isolation level is available; sandboxed code execution still works.

**Fix:** None needed. If you want to verify `unshare` is generally available:
```bash
which unshare       # should be /usr/bin/unshare
unshare -U echo ok  # user namespace test, should print "ok"
```

This single failure is allowed by the v7.5.3 ratchet on Linux.

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

**Cause:** Invalid or expired API key, or — for Ollama-cloud models — an expired or missing subscription.

**Fix:** Open Settings → check `models.anthropicApiKey` or `models.openaiApiKey`. Ensure no extra whitespace. Test the key with curl:
```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
```

**v7.5.6 behavior:** When a model fails with 403 (or 401, or rate-limit/timeout), Genesis marks the model unavailable in `.genesis/model-unavailable.json` with a TTL (1h for auth, 5min for rate-limit, 10min for timeout), then falls back to the next model in `models.fallbackChain`.

**v7.5.7 refinement:** Ollama Cloud's Pro-gated 403s (response body contains `"subscription"` or `"upgrade for access"`) are now classified as `subscription-required` with a **24h TTL** rather than the generic `auth` 1h TTL. Reason: a Pro-gate is not resolved by waiting an hour. Either you subscribe, or you switch model. Retrying every hour just spams the endpoint.

If your subscription comes back online before the TTL expires (e.g. you renewed), use:
```
/model-reset qwen3-coder-next:cloud   # clear specific model
/model-reset                          # clear all marked models
```

### Ollama Cloud model returns 403 "this model requires a subscription"

**Cause:** Ollama gated the model behind a paid Pro tier (`$20/month` since Sept 2025). Live-affected models reported by the community: `kimi-k2.5:cloud`, `kimi-k2.6:cloud`, `qwen3-coder-next:cloud`, `glm-5.1:cloud`. Other cloud models (e.g. `gemma:cloud`) may still work without Pro depending on Ollama's current free-tier policy.

**Three options:**

1. **Switch to the local variant** — most cloud models have a non-cloud counterpart that runs on your hardware. `qwen3-coder-next:cloud` → `qwen3-coder-next:q4_K_M`. No Pro needed, no rate limit, no 403. Open Settings, change Preferred Model.
2. **Configure a fallback chain** — Settings → Fallback Chain. Add 2–4 local models in priority order. When a cloud-403 hits, Genesis will mark the cloud model unavailable for 24h and continue on the next chain entry without interruption.
3. **Subscribe to Ollama Pro** — only worth it if you specifically need the cloud model's GPU acceleration and accept the recurring cost. Ollama accepts credit/debit cards only; no PayPal, no SEPA, no prepaid vouchers.

**Boot warning (v7.5.7):** If your preferred model is a cloud model AND no fallback chain is configured, Genesis emits `[MODEL] Preferred is a cloud model (...) and no fallbackChain is configured` at boot and fires the `model:cloud-without-fallback` event. The warning surfaces the risk at one decision-point rather than as a mid-session surprise after several 403s.

### Configuring the Fallback Chain (v7.5.7)

The fallback-chain UI was rebuilt in v7.5.7. The previous `<select multiple size="3">` with "Hold Ctrl to select multiple" was unintuitive and frequently misread (markiert ≠ ausgewählt) — the most direct consequence was that users who thought they had configured a chain actually had an empty chain, and the v7.5.6 model-unavailability marker had nothing to fall back to.

The new UI is in **Settings → Fallback Chain**:

- **Available Models** (left list) — every detected model with a `[+ Add]` button. Cloud-suffixed models carry a `☁` marker so you can see at a glance which require a subscription.
- **Your Chain** (right list) — your selected fallbacks in execution order. Each entry has `[↑] [↓]` to reorder and `[×]` to remove.
- An empty chain shows "No fallback models — Genesis will fail if primary breaks." in red.

The chain is persisted to `models.fallbackChain` in `.genesis/settings.json`. You can edit that file directly if you prefer; the UI is just a builder for it.

### Right-click in chat does nothing / can't paste with the mouse (pre-v7.5.7)

**Fixed in v7.5.7.** Electron apps default to NO context-menu — pre-fix Genesis chat had only Ctrl+C / Ctrl+V, which is unintuitive on Windows. v7.5.7 installs a `webContents.on('context-menu', ...)` handler in main.js that builds the menu per-click:

- Editable fields (chat input, settings text-fields): Ausschneiden / Kopieren / Einfügen / Alles auswählen
- Non-editable text with selection: Kopieren + Alles auswählen
- Empty area: Alles auswählen only

If right-click still does nothing after upgrading, you're either still on a build before the fix or the renderer hasn't reloaded. Restart the app.

### Settings modal too narrow / model names truncated (pre-v7.5.7)

**Fixed in v7.5.7.** The settings modal now uses a wider `.modal-wide` CSS class (720px) so model names like `mannix/deepseek-coder-v2-lite-instruct:fp16` are readable in the fallback-chain lists. If a name is still truncated (very long names + narrow window), hovering over it reveals the full name as a tooltip — the cursor changes to a `?` (help cursor) over names that have a tooltip.

### Genesis stops trying my preferred model after one failure

**This is the v7.5.6 availability-marker working as designed.** If `/self-inspect` shows the marker:
- For sticky errors (auth, rate-limit, timeout) the model stays marked until the TTL expires
- The TTL is appropriate for the error: a 403 isn't going to fix itself in 30 seconds
- `/model-reset <name>` clears it manually

Connection errors and other transient failures (e.g. ollama not yet warmed up) do **not** mark — those typically resolve on the next call without intervention.

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
1. Use a **medium** model (qwen2.5:7b, llama3.1:8b) for general chat — DO NOT drop below 7B parameters or Genesis loses persona/coherence (see "Genesis answers gibberish" below)
2. Enable ModelRouter in settings — it can route specific tasks (translation, classification) to smaller models while keeping chat on the main model
3. Check available VRAM: `ollama ps` — if the model doesn't fit in VRAM, it runs on CPU (much slower)
4. For best speed: cloud API (Anthropic, OpenAI) instead of local Ollama

### Genesis answers gibberish, hallucinated words, or wrong language

**Symptoms:**
- Hallucinated words like "fehlentzündungen", "toiciations", invented compound nouns
- Persona confusion: Genesis says "du bist Genesis..." instead of "ich bin Genesis..." (mixes up first and second person)
- Sentence repetition loops at the end of responses
- Generic "I am an AI assistant" answers ignoring the system prompt

**Cause:** The model is too small or uses an unsupported reasoning format.

**Fix:** Switch to a model with at least 7B parameters / ~5 GB:
```bash
ollama pull qwen2.5:7b      # solid default for German + English
ollama pull llama3.1:8b     # good alternative
ollama pull mistral-nemo:12b  # excellent for German
```

Then pin it so auto-routing doesn't switch back:
```bash
# In CLI REPL:
/model qwen2.5:7b
```

**Models that do NOT work** for Genesis chat (will produce the symptoms above):
- Anything under ~5 GB: `tinyllama`, `phi-mini`, `gemma2:2b`, `qwen2.5:3b`

**Reasoning models** (DeepSeek-R1, QwQ, nemotron-3-nano) — used to fail because the `<think>...</think>` blocks ended up in chat. **As of v7.5.6** the thinking-block filter strips these blocks from chat output, from the tool-call audit, and from tool-loop synthesis. Reasoning models now work — and the reasoning is preserved as `model:thinking-trace` events visible in the dashboard's Reasoning panel.

If you still see `<think>...</think>` in the chat after upgrading to v7.5.6:
1. Restart Genesis after the upgrade — the filter runs at the ChatOrchestrator level and is wired at boot
2. Check `/self-inspect` — confirms which model and which orchestrator path is active
3. Look at the dashboard Reasoning panel — if traces appear there, the filter is running and you're seeing a different `<think>...</think>` source (e.g. embedded in a tool result)

If you previously set a small model in settings, clear it: open `~/.genesis/settings.json` and remove the `models.preferred` line, then restart Genesis.

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

### Genesis says he did something but I see "ich kann das nicht direkt verifizieren"

This is the v7.5.5 SelfStatementLog confabulation detector firing. Genesis made a structural self-claim ("I see 11 active goals", "Ich überwache 3 Module") but the runtime-state block in his prompt was empty for that fact — there's no verified data backing the claim.

**Why it happens:** The LLM sometimes generates plausible-sounding self-descriptions even when the actual data isn't in the prompt. Pre-v7.5.5 this would silently pass through. Now Genesis flags it.

**What to do:**
- If the claim is false: ask "wirklich? zeig es mir" — Genesis will retry with a tool call instead of relying on memory.
- If the claim is true but the runtime-state block didn't have it (e.g. the data is in a different memory layer): no action needed, this is a known false-positive shape.
- Check `/recall strukturell` to see all recent structural self-claims and which ones were flagged.

### `<think>...</think>` blocks visible in chat

If you see this on **v7.5.6 or later**, that's a bug — the reasoning-block filter should strip them. File an issue with:
- The model name (DeepSeek-R1, QwQ, nemotron-3-nano, etc.)
- The exact chat output including the visible tags
- Whether `model:thinking-trace` events appear in the dashboard's Reasoning panel (if yes, the filter is running for some paths but not the one you triggered)

**Pre-v7.5.6:** This was a known limitation of reasoning models. The fix shipped in v7.5.6.

### `npm run ratchet` exits non-zero

The CI ratchet compares the current state against `scripts/ratchet.json` and exits non-zero if any floor was crossed. The output identifies the violation:

- **`fitness ${current} < floor ${floor}`** — architectural-fitness regressed. Check `npm run audit:fitness` for the breakdown.
- **`${n} mismatches > max 0`** — schema mismatches appeared. Run `npm run scan:schemas` to find them.
- **`${n} missing > max 0`** — events emitted without a registered schema. Run `node scripts/audit-schemas.js`.
- **`${n} orphan > max 0`** — schema entries with no catalog event. Same script.
- **`${n} tests < floor ${floor}`** — test count dropped. Either tests were deleted or they're failing.

If the regression is intentional (e.g. you deliberately removed an obsolete test suite), edit `scripts/ratchet.json` by hand to lower the floor. The script never updates itself — that's a deliberate human decision so the floor stays meaningful.

For local pre-commit checks, use `npm run ratchet:fast` which skips the slow full-test-count check.

### `npm run audit:slash` shows findings (v7.5.7)

The slash-discipline audit categorizes every intent in `IntentPatterns.js` as pure-slash-only / fuzzy+slash-mix / fuzzy-only and cross-checks against `SECURITY_REQUIRED_SLASH`. A finding means: an intent has a fuzzy (free-text) pattern AND is not in the security set AND is not in the script's `FUZZY_BY_DESIGN` whitelist.

What to do per finding:

- If the intent triggers a sensitive action (writes, code-exec, OS-side-effect) → add it to `SECURITY_REQUIRED_SLASH` in `IntentPatterns.js`. The guard then rewrites it to `general` unless the message contains a `/`.
- If the intent is intentionally fuzzy by design (conversational UX) → add it to `FUZZY_BY_DESIGN` in `audit-slash-discipline.js` with a one-line rationale.

Don't suppress findings without picking one of those two paths.

### `npm run audit:contracts` shows unprotected candidates (v7.5.7)

The contract-candidate audit finds tests in security-relevant files (gate, injection, sandbox, etc.) whose names look like security-guards (block, reject, deny, must, never, fail-closed, …) but lack a `<x> contract: ` prefix.

What to do per candidate: decide whether the test's accidental removal would weaken Genesis. If yes, rename it with a contract prefix (e.g. `injection-gate contract: …`) and add the prefix to the `contracts` array in `scripts/stale-refs.json` with a `minCount`. `npm run check:stale` then verifies it on every release.

Marking is conservative — a candidate is just a suggestion, not a directive. Many test names look security-shaped but are exercising failure paths or edge cases that aren't load-bearing for the safety boundary.

---

## Getting Help

1. Check the [docs/](.) directory for architecture details
2. Run `self-inspect` in the Genesis chat to see the agent's self-model
3. Open an [issue](https://github.com/Garrus800-stack/genesis-agent/issues) with:
   - Genesis version (`package.json`)
   - Node.js version (`node --version`)
   - OS and architecture
   - Console output (if applicable)
