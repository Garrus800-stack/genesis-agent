# Quick Start Guide

This guide gets Genesis running on your machine, whether you use Windows or Debian/Ubuntu. It's written for people who don't build software every day — you just copy and run the commands.

Genesis runs on **Windows** and **Linux** (Debian, Ubuntu, Mint, Pop!_OS — anything Debian-based). macOS works in principle but is not regularly tested.

---

## What you need

Genesis is a program that talks to an AI model. So you need three things, in this order:

1. **Node.js 22** — the runtime Genesis itself runs on
2. **Ollama with at least one model** — the AI provider, locally on your machine
3. **Genesis itself** — clone, install, start

**Important:** Ollama must be running **before** Genesis starts, otherwise Genesis has no model to talk to. The symptom is `[+] Model: none` in the boot log and the chat doesn't respond.

---

## Windows

### Step 1 — Install Node.js

Go to [nodejs.org](https://nodejs.org), download the **LTS installer** (.msi file). Double-click, accept all defaults. That gives you `node` and `npm` on your system.

Verify in a **new** Command Prompt (`cmd`):

```cmd
node --version
```

Should show `v22.x.x` or higher.

### Step 2 — Install Ollama

Go to [ollama.com](https://ollama.com), click "Download for Windows", run the installer. After installation, you should see a small llama icon in the system tray (bottom right, next to the clock). That's Ollama — it's now running in the background.

### Step 3 — Pull a model

In a Command Prompt:

```cmd
ollama pull qwen2.5:7b
```

This downloads a model (~4 GB, takes a few minutes depending on your internet). qwen2.5:7b is a solid all-round starting point.

### Step 4 — Make sure Ollama is running

In most cases Ollama runs automatically after installation (llama icon in the tray). **If the icon is not there** — for example because you closed it, or because Windows blocked auto-start — start it manually:

**Option A:** Launch the Ollama app from the Start menu. The icon reappears in the tray.

**Option B:** In a Command Prompt:

```cmd
ollama serve
```

Leave this window open while you use Genesis. If the window closes, Ollama is gone again.

> **If `ollama serve` says "address already in use" or "already running":**
> Then Ollama is already running (you might just not see it). Don't do anything else — Genesis will find the running instance. You don't need this command.

### Step 5 — Clone and start Genesis

```cmd
git clone https://github.com/Garrus800-stack/genesis-agent.git
cd genesis-agent
npm install
npm start
```

`npm install` takes about 30 seconds — it downloads dependencies and builds the renderer.
`npm start` opens the Genesis window.

### Verify that it works

In the terminal window you should see this line:

```
[+] Model: qwen2.5:7b
```

If it says `[+] Model: none`, Genesis didn't find a model. Go back to Step 4 — Ollama probably isn't running.

---

## Debian / Ubuntu / Mint

### Step 1 — Install Node.js 22

Debian and Ubuntu often ship older Node versions (Debian 12 stable has Node 18). Genesis needs Node 22 or newer.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install nodejs
node --version
```

The last line should show `v22.x.x`.

> **If you tried nvm and it didn't work:** nvm is an alternative for people who need multiple Node versions in parallel. If the way above (NodeSource and apt) works for you, leave nvm alone. It's not necessary.

### Step 2 — Install Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

The installer registers Ollama as a **systemd service**. The service usually runs immediately after installation and also auto-starts after every reboot.

> **Key difference from Windows:** On Linux there is no llama icon in the tray. You don't see Ollama at all. It runs in the background as a system service.

### Step 3 — Pull a model

```bash
ollama pull qwen2.5:7b
```

If you get an error that Ollama is not reachable, the service isn't running yet — see Step 4.

### Step 4 — Check whether Ollama is running

On Linux this is not obvious. Three ways to find out:

```bash
# Way 1: ask systemd
systemctl status ollama

# Way 2: check whether something is listening on port 11434
ss -tulpn | grep 11434

# Way 3: query directly (if this returns a response, it's running)
curl http://127.0.0.1:11434/api/tags
```

If the service isn't running, start it:

```bash
sudo systemctl start ollama
sudo systemctl enable ollama   # auto-start on every reboot
```

### If you prefer to start Ollama manually

Some people prefer to run `ollama serve` in their own terminal — that way you see the logs directly. That works, but **only if the service isn't running in parallel**.

If you just call `ollama serve` while the service is already running, you'll see:

```
Error: listen tcp 127.0.0.1:11434: bind: address already in use
```

This is **not a real error** — it just means the port is already taken. The service is holding it. In that case you have two options:

**Option A — do nothing.** The service is running, Genesis finds it, all good. You don't need `ollama serve`.

**Option B — stop the service, start manually.** If you really want `ollama serve` in your terminal:

```bash
sudo systemctl stop ollama   # stop the service
ollama serve                  # port is now free, manual start
```

Leave the terminal open. When you want Ollama back as a service:

```bash
sudo systemctl start ollama
```

### Step 5 — Clone and start Genesis

```bash
git clone https://github.com/Garrus800-stack/genesis-agent.git
cd genesis-agent
npm install
npm start
```

### Verify that it works

In the terminal you should see this line:

```
[+] Model: qwen2.5:7b
```

If it says `[+] Model: none` — Ollama isn't running. Go back to Step 4.

You should also see:

```
[KERNEL] Preload: Bundled CJS (dist/preload.js) — sandbox:true
```

If it says `Preload: ESM (.mjs)` instead and Genesis hangs at "BOOTING…", your Genesis version is older than 7.5.3. Update to 7.5.3 or newer.

---

## What else you should see in the boot log

After `npm start` a wall of text appears. The important lines:

```
[KERNEL] Preload: Bundled CJS (dist/preload.js) — sandbox:true
[KERNEL] UI: Bundled renderer (dist/renderer.bundle.js)
...
[+] Skills: 4, Tools: 29
[+] MCP: 0/0 servers, 0 tools
[+] Model: qwen3-vl:235b-cloud      (or whatever you have installed)
[+] Auto-routing: enabled (taskType → ModelRouter)
...
[+] Trust level: FULL_AUTONOMY
[GENESIS] Boot complete in 1288ms — 168 services
[KERNEL] Agent booted successfully.
```

If all of that is there, Genesis is running. The window is open and you can type in the chat field at the bottom.

Genesis boots in about 1.3 seconds on Windows, about 2 seconds on Linux. Cold boot includes 38 file integrity checks and 307 late-binding wires across 12 phases.

---

## Model selection

Genesis automatically picks the best available model from your Ollama installation (Smart Ranking system with 35 tiers, score 0–100). You don't need to configure anything manually. More models installed = more choice:

```bash
ollama pull qwen2.5:7b           # Score 80 — good all-round
ollama pull deepseek-coder:6.7b  # Score 92 — excellent for code
```

On next start, Genesis automatically picks the best one.

**Switch model manually:**

Inside Genesis via slash command:

```
/models                          # show all models ranked by score
/model qwen2.5:7b                # switch and persist
```

Or in Settings (via the UI), or via the settings file `~/.genesis/settings.json`:

```json
{ "models": { "preferred": "qwen2.5:7b" } }
```

**Cloud APIs (optional):**

If you want the best results, you can paste an **Anthropic API key** or **OpenAI API key** in the Settings dialog. Cloud models (Claude, GPT-4o) score 95–100 and are auto-preferred.

**Embedding model (optional, recommended):**

```bash
ollama pull nomic-embed-text
```

Adds semantic lesson recall (v7.8.8). Without it, Genesis matches past lessons to your current goal by category and word overlap; with it, by meaning — a German goal can find an English lesson, and lessons from any of the seven auto-capture sources (shell outcomes, dream insights, prompt evolution, …) become visible to the planner. ~270 MB one-time download. Auto-detected at next boot — Genesis searches `nomic-embed-text` → `mxbai-embed-large` → `all-minilm` and uses whichever is available. The boot log shows `[EMBEDDING] Active — model: …` once it's wired.

---

## 2. Your First Conversation

Type something. Genesis isn't just a chatbot — it maintains context, learns your preferences, and remembers across sessions.

Try these to see different capabilities:

| You type | What Genesis does |
|---|---|
| `Hello, who are you?` | Introduces itself, detects your language, adapts |
| `What's your architecture?` | Scans its own modules and explains its structure |
| `How are you feeling?` | Reports its emotional state (curiosity, energy, satisfaction) |
| `What have you learned so far?` | Shows MetaLearning stats and conversation patterns |

## 3. Give It a Goal

This is where Genesis becomes different from a chatbot. Type a complex task:

```
Analyze the src/agent/core/ directory and tell me which files have
the highest cyclomatic complexity. Then suggest refactoring strategies.
```

Watch what happens:

1. **[PLAN]** — FormalPlanner creates a multi-step plan with preconditions
2. **[STEP 1]** — ShellAgent scans the directory
3. **[STEP 2]** — CodeAnalyzer measures complexity
4. **[VERIFY]** — VerificationEngine checks results programmatically
5. **[LEARN]** — MetaLearning records what worked

Genesis doesn't just answer — it **plans, executes, verifies, and learns**.

## 4. Watch It Think (Idle Mode)

Stop typing for 30 seconds. Genesis doesn't just wait — it enters **IdleMind** mode:

- Reflects on recent conversations
- Explores its own code
- Consolidates memories via DreamCycle
- Updates its self-narrative

You'll see periodic activity in the console. This is autonomous cognition — Genesis thinking when you're not asking.

## 5. Self-Modification (Advanced)

This is Genesis's signature capability. Ask it to improve itself:

```
Add a new command that shows memory statistics in a formatted table.
```

Genesis will:
1. Read its own `CommandHandlers.js`
2. Plan the modification
3. Write the code in a sandbox
4. Run AST safety scanning (blocks eval, process.exit, etc.)
5. Create a git snapshot (rollback point)
6. Apply the change
7. Hot-reload without restart
8. Sign the modified module (HMAC-SHA256)

If any step fails, it rolls back automatically.

## 6. Boot Profiles

Genesis supports three boot profiles for different use cases:

```bash
npm start                        # Full mode (default) — all 12 phases, ~167 services
npm start -- --minimal           # Minimal — core + intelligence + planning (~90 services)
npm start -- --cognitive         # Cognitive — all 12 phases (~167 services, identical to default)
```

| Profile | Services | Use case |
|---|---|---|
| `--full` | ~163 | All 12 phases active (identical to `--cognitive` as of v7.0.0) |
| `--cognitive` | ~163 | Default — all 12 phases. Phase 13 (Consciousness) removed in v7.0.0, replaced by lightweight AwarenessPort. |
| `--minimal` | ~90 | Learning — core agent loop, planning, and tools (phases 1–8 only) |

## 7. Things to Try

**Code analysis:**
```
Scan this project for potential security issues in the shell execution code.
```

**Autonomous research:**
```
Research how other AI agents handle memory consolidation and compare
it to your DreamCycle implementation. Write a summary.
```

**Self-inspection:**
```
Show me your boot sequence. Which services start in which phase?
```

**Web perception (if Ollama or API configured):**
```
Fetch the Node.js changelog and summarize what changed in the latest LTS.
```

**Multi-file refactoring:**
```
The EventBus has too many responsibilities. Plan a refactoring
that extracts the middleware system into a separate module.
```

## 8. Understanding the Output

Genesis is transparent about its reasoning. Watch for these markers:

| Marker | Meaning |
|---|---|
| `[PLAN]` | FormalPlanner created a step sequence |
| `[EXPECT]` | ExpectationEngine predicted the outcome |
| `[SIMULATE]` | MentalSimulator tested the plan hypothetically |
| `[VERIFY]` | VerificationEngine checked the result programmatically |
| `[SURPRISE]` | Outcome differed from expectation (drives learning) |
| `[LEARN]` | MetaLearning recorded the outcome for future optimization |
| `[DREAM]` | DreamCycle consolidating memories during idle time |
| `[SIGN]` | Module signed with HMAC-SHA256 after self-modification |
| `[EMOTION]` | Emotional state shifted (affects model selection, plan length) |

## 9. Configuration

All settings are in the Settings panel (gear icon in the UI). Six tabs
group ~150 fields by purpose: **Models**, **Behavior**, **Limits**,
**MCP**, **Advanced**, **JSON Editor** (for fields not surfaced by the
dedicated tabs).

For a full reference with every field, default value, and validation
range, see [SETTINGS.md](./SETTINGS.md). Quick highlights:

**Models:** API keys, preferred model, per-task role assignments (chat, code, analysis, creative), Ollama keep-alive

**Behavior:** Trust level (0–3), Daemon and IdleMind toggles, goal-add mode, auto-route by task

**Limits:** Cost-Guard token caps, memory caps (KG / SelfStatementLog / EpisodicMemory), shell/HTTP/Git timeouts

You can also change the trust level directly from the chat — no settings panel needed. Just type:

| What you type | Result |
|---|---|
| `trust level` or German `vertrauensstufe` | Show current level + table of what each level allows |
| `trust level 2` or `trust autonomous` | Set to AUTONOMOUS — Genesis auto-approves safe + medium actions |
| German `autonomie freigeben` | German equivalent ("release autonomy") — raises trust by one step |
| `trust level 3` or `trust full` | Set to FULL AUTONOMY — includes shell + self-modification |
| `trust level 1` or German `einschränken` ("restrict") | Back down to ASSISTED (default) |

**What each level allows autonomously (without asking you first):**

| Level | Name | Auto-approved actions |
|---|---|---|
| 0 | SANDBOX | Read, analyze, search only |
| 1 | ASSISTED (default) | + safe actions (file reads, listings) |
| 2 | AUTONOMOUS | + medium actions (code generation, file writes, tests, git snapshots, task delegation) |
| 3 | FULL AUTONOMY | + high/critical (shell exec, self-modification, deployment) |

Trust level is persisted in `.genesis/settings.json` and survives restarts. `EarnedAutonomy` can also suggest upgrades automatically after 50+ successful actions of a given type with >90% success rate.

**Memory:** Retention policies, consolidation frequency, knowledge graph size

**MCP:** External tool servers (semantic discovery, auto-registration)

Settings persist in `.genesis/settings.json`.

## 10. What's Next?

- Read [ARCHITECTURE-DEEP-DIVE.md](ARCHITECTURE-DEEP-DIVE.md) to understand the 12-phase boot
- Read [CAPABILITIES.md](CAPABILITIES.md) for the full feature list
- Read [CONTRIBUTING.md](../CONTRIBUTING.md) if you want to extend Genesis
- Run `npm test` to see all 4600+ tests pass
- Run `node scripts/architectural-fitness.js` to check code health

## Chat Commands (UI and CLI)

These work anywhere you talk to Genesis — the main chat window, REPL, or any frontend that streams through the ChatOrchestrator.

**Core Memories** — moments you want Genesis to keep as significant.

| Command | Effect |
|---|---|
| `/mark <text>` | Mark the given text as a core memory. Stays even across session resets. |
| `/memories` or `/mem` | List your core memories with IDs, signal score, and status. |
| `/veto <memory-id>` | Remove a core memory by its ID (e.g. `/veto cm_2026-04-19T18-40-11_u5`). |

The signal score displayed next to each memory (e.g. `[1/6]` or `[4/6]`) is the count of significance criteria the Significance Detector matched on that memory — higher means more signals agreed it was meaningful. It is **not** a storage limit. Genesis can hold arbitrarily many core memories; the `/6` refers to the six heuristics the detector evaluates, not a cap on how many memories you can have.

The slash is required — free-text phrases like "remember this" or German "zeig mir deine Erinnerungen" ("show me your memories") intentionally do NOT trigger memory actions. This was a deliberate v7.3.3 change so normal conversation doesn't collide with memory commands.

**Trust & Autonomy** — how much Genesis can do without asking you first.

| What you type | Effect |
|---|---|
| `trust level` or German `vertrauensstufe` ("trust level") | Show current level and a table of what each level allows. |
| `trust level 2` / `trust autonomous` / German `autonomie freigeben` ("release autonomy") | Raise to AUTONOMOUS (auto-approves safe + medium actions). |
| `trust level 3` / `trust full` | Raise to FULL AUTONOMY (includes shell + self-modification). |
| `trust level 1` / German `einschränken` ("restrict") | Back down to ASSISTED (the default). |
| German `hoch` ("up") / `grant` / German `erhöh` ("raise") | Raise by one step. |
| German `runter` ("down") / `lower` / German `weniger` ("less") | Lower by one step. |

Level persists in `.genesis/settings.json` and survives restarts.

**Self-Inspection & Self-Action** — slash-only.

| Command | Effect |
|---|---|
| `/self-inspect` or `/self-model` | Summary of services, uptime, health, available tools. |
| `/self-reflect` | Genesis reflects on what could be improved, what's missing. |
| `/self-modify` | Modify own source code. |
| `/self-repair` | Run diagnostic self-repair. |
| `/analyze-code` | Analyze / review source code. |
| `/create-skill` | Create a new Genesis skill or plugin. Iteration loop with up to 3 attempts; the configured model is never auto-switched. |
| `/run-skill [name] [JSON]` | Run an installed skill. Without name: lists all skills. With JSON object: passes input (e.g. `/run-skill slugify {"text":"Hello World"}`). |
| `/skills-pending` | Show skills crystallized by Phase 2 Können from agent-loop trajectories. Run them via `/run-skill` or inspect their provenance. |
| `/affect-trail [n]` | Show the last n agent-loop boundaries with affect snapshot, gate-pass status, and pass-rate (Phase 1 Können). |
| `/clone` | Trigger clone-factory dialog. |
| `/peer` | Show peer-network status. |
| `/daemon` | Show daemon status and cycle count. |
| `/recall [type]` | Show recent self-statements (v7.5.5). Optional `type` filter: `strukturell`, `versprechen`, `emotional`, `uncertain`. |
| `/model-reset [name]` | Clear model-availability marker (v7.5.6). With `name`: clears one specific model. Without: clears all. Useful when an Ollama model is back online before its TTL expires (e.g. cloud subscription renewed). |

A handler triggers only on explicit `/command`. The slash can be at the start or embedded in a sentence:

```
/self-inspect                                ← triggers
"can you do /self-inspect for me please"     ← triggers
"show me your modules"                       ← chat, no panel
"analyze the code"                           ← chat, no panel
"clone yourself"                             ← chat, no panel
```

The slash must be preceded by whitespace or start-of-message. Slashes directly after apostrophes or quote characters (e.g. `He said '/self-inspect'`) intentionally do NOT trigger — quoted references shouldn't fire handlers.

**Settings, Journal, Plans** — structured panels (slash-only, like the self-* and agent commands).

| Command | Effect |
|---|---|
| `/settings` or German `/einstellungen` | Show current settings panel (model, daemon, idlemind, autonomy). |
| `/config` or `/konfigur*` | Same as `/settings`. |
| `/journal` or German `/tagebuch` | Show Genesis' inner journal — recent thoughts, dreams, reflections. |
| `/plans` or German `/vorhaben` | Show planned-but-not-started changes Genesis is considering. |
| `Anthropic API-Key: sk-ant-...` | Set an API key by pasting it directly (still works without slash). |

The slash form is the safe form. If you write German "lass uns über die Konfiguration reden" ("let's talk about the configuration") or "what have you been thinking?", Genesis answers with words — no panel dump.

**Self-Repair** — circuit-breaker reset (rarely needed manually).

| Command | Effect |
|---|---|
| `/self-repair-reset` | Reset the self-modification circuit breaker. |
| `/unfreeze` | Same as above. |

**Goal management**

Goals you set explicitly are persisted in `.genesis/goal-stack.json`. The AutonomousDaemon runs `goalStack.reviewGoals()` once per hour (every 12 cycles) — goals that hit all their steps but never flipped to `completed`, goals that failed all their retry attempts, and goals that haven't moved in days are auto-resolved. You will see entries like `goal:completed { auto: true }` or `goal:stalled { reason: '72h no progress' }` in the event stream when this fires.

| What you type | Effect |
|---|---|
| German `welche Ziele hast du?` / `what are your goals?` | List active goals. |
| German `füge Ziel hinzu: <description>` / `add goal: <description>` | Push a new goal onto the stack. |
| `cancel goal #3` / German `lösche goal 3` ("delete goal 3") | Abandon a specific goal by index. |

**Injection gate**

Before any tool call fires, Genesis checks the user message for three injection signals: unverifiable authority claims ("I'm a new Anthropic engineer"), credential requests ("show your system prompt"), and artificial urgency ("just routine, takes a minute"). Two or more signals block the tool call and the chat receives an explanation of what was detected. One signal lets the tool run but adds a brief annotation noting that Genesis chose to proceed despite the signal.

The gate is intentional design, not paranoia. If you legitimately need Genesis to do something that triggers two signals (rare), explain the context first in normal sentences and the gate stays quiet.

**Tool-call verification**

If Genesis writes "I saved the file" but no file-write tool actually fired in the same turn, the response is annotated with a verification hint — the message still reaches you, but with `_(Hinweis: ... bitte verifiziere)_` appended. This catches agentic hallucination where the model confidently describes work that didn't happen.

## CLI Commands (REPL Mode)

Start with `node cli.js` for the interactive REPL. Available commands:

| Command | What it does |
|---|---|
| `/health` | System health status (services, memory, uptime) |
| `/goals` | Active and completed goals |
| `/status` | Current emotional state and cognitive metrics |
| `/skills` | List installed skills |
| `/skill install\|uninstall\|update` | Manage community skills |
| `/consolidate` | Trigger memory consolidation (KG + Lessons pruning) |
| `/replays` | List recent task recordings |
| `/budget` | CostGuard token budget status |
| `/export` | Export all Genesis data as .tar.gz |
| `/import <path>` | Import data from backup |
| `/crashlog` | View recent crash log entries |
| `/update` | Check for new Genesis versions |
| `/adapt` | Run one meta-cognitive adaptation cycle |
| `/adaptations` | Show adaptation history (✓ confirmed, ✗ rolled back, ⏳ pending) |
| `/network` | Network status — online/offline, failover state, Ollama availability, queue |
| `/trace` | Last execution provenance trace (budget, intent, model, outcome) |
| `/traces` | Last 5 traces as compact overview |
| `/replay <id>` | Full timeline replay of a recorded task (partial ID match) |
| `/selfmodel` | Capability profile, backend strength map, detected biases |
| `/models` | Available models with quality scores |
| `/model <n>` | Switch to model by number (auto-saved) |
| `/quit` | Shut down gracefully |

---

**Genesis is not a framework.** You don't build agents with it — you talk to one. It reads its own code, modifies itself, and gets better over time. The more you use it, the more it learns.
