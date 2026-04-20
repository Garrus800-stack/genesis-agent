# Genesis — Quick Start Guide

Get Genesis running in under 2 minutes and see what it can do.

## 1. Install & Start

```bash
git clone https://github.com/Garrus800-stack/genesis-agent.git
cd genesis-agent
npm install
npm start
```

Genesis boots in ~2 seconds. You'll see a chat window — that's your interface.

**Model selection — Genesis picks the best model automatically:**

Genesis uses Smart Ranking (35 tiers, score 0–100) to auto-select the best available model from your Ollama installation. No manual configuration needed.

```bash
# If you have Ollama running with models:
ollama pull qwen2.5:7b           # Score: 80 — good for most tasks
ollama pull deepseek-coder:6.7b  # Score: 92 — excellent for code
ollama serve                     # Genesis auto-detects and picks the best
```

**Change the model anytime:**

```bash
# In the Genesis CLI (node cli.js):
/models                          # Show all models ranked by capability
/model qwen2.5:7b                # Switch + permanently save

# Via CLI flag:
node cli.js --backend ollama:kimi-k2.5:cloud

# Via settings file (~/.genesis/settings.json):
{ "models": { "preferred": "kimi-k2.5:cloud" } }
```

**Cloud APIs (optional, for best results):**

Open Settings → paste your **Anthropic API key** or **OpenAI API key**. Cloud models (Claude, GPT-4o) score 95–100 and are auto-preferred over local models.

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
npm start                        # Full mode (default) — all 12 phases, ~155 services
npm start -- --minimal           # Minimal — core + intelligence + planning (~90 services)
npm start -- --cognitive         # Cognitive — all 12 phases (~155 services, identical to default)
```

| Profile | Services | Use case |
|---|---|---|
| `--full` | ~155 | All 12 phases active (identical to `--cognitive` as of v7.0.0) |
| `--cognitive` | ~155 | Default — all 12 phases. Phase 13 (Consciousness) removed in v7.0.0, replaced by lightweight AwarenessPort. |
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

All settings are in the Settings panel (gear icon in the UI):

**Models:** API keys, preferred model, role assignments (chat, code, analysis, planning)

**Autonomy:** Trust level (0–3), max steps per goal, idle thinking interval

You can also change the trust level directly from the chat — no settings panel needed. Just type:

| What you type | Result |
|---|---|
| `trust level` or `vertrauensstufe` | Show current level + table of what each level allows |
| `trust level 2` or `trust autonomous` | Set to AUTONOMOUS — Genesis auto-approves safe + medium actions |
| `autonomie freigeben` | German equivalent — raises trust by one step |
| `trust level 3` or `trust full` | Set to FULL AUTONOMY — includes shell + self-modification |
| `trust level 1` or `einschränken` | Back down to ASSISTED (default) |

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

The slash is required — free-text phrases like "remember this" or "zeig mir deine Erinnerungen" intentionally do NOT trigger memory actions. This was a deliberate v7.3.3 change so normal conversation doesn't collide with memory commands.

**Trust & Autonomy** — how much Genesis can do without asking you first.

| What you type | Effect |
|---|---|
| `trust level` or `vertrauensstufe` | Show current level and a table of what each level allows. |
| `trust level 2` / `trust autonomous` / `autonomie freigeben` | Raise to AUTONOMOUS (auto-approves safe + medium actions). |
| `trust level 3` / `trust full` | Raise to FULL AUTONOMY (includes shell + self-modification). |
| `trust level 1` / `einschränken` | Back down to ASSISTED (the default). |
| `hoch` / `grant` / `erhöh` | Raise by one step. |
| `runter` / `lower` / `weniger` | Lower by one step. |

Level persists in `.genesis/settings.json` and survives restarts.

**Self-Inspection** — let Genesis read his own code or state.

| What you type | Effect |
|---|---|
| `self-inspect` | Summary of services, uptime, health, available tools. |
| `zeig mir <file>.js` or `show me ChatOrchestrator` | Genesis reads the named file or service and talks about it. |

**Goals** — Genesis's own goal stack (separate from tasks).

| What you type | Effect |
|---|---|
| `welche Ziele hast du?` / `what are your goals?` | List active goals. |
| `füge Ziel hinzu: <description>` / `add goal: <description>` | Push a new goal onto the stack. |

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
