## [7.9.26]

The same long field run that drove v7.9.25 also recorded a stretch of more than two hours where the agent, having exhausted its session token budget, kept re-picking one goal every sixty seconds — and wrote "I gave up" to its own self-log on each of those attempts while still retrying them. The budget cap was a real wall, but nothing told the autonomy layer to stop walking into it, the inner narrative described an abandonment that never happened, the emotional state stayed flat at its baseline through hundreds of failures, and a continuation sequence that never completed left no trace of why. This release closes the loop at each point: the cap suspends pursuit until the budget returns, the self-statement waits for a goal's real terminal outcome, the continuation loop reports each round, and operational failures register in affect. Every change is against the runtime trace and at the root; none touches the kernel or the gate set.

### A reached budget cap suspends autonomous pursuit until it lifts

CostGuard's session and daily token caps are the durable budget wall — once a session cap is hit it holds until the process restarts — and CostGuard fired an `llm:cost-cap-reached` event when it engaged, but no component consumed it. The goal driver treated the resulting "budget exhausted" rejection as an ordinary rate-limit: a fixed sixty-second pause, then a re-pick of the same goal, which hit the same wall, for as long as the cap held. The driver now consumes the cap event and gates its pursuit scan on it, so a capped goal waits instead of looping. CostGuard now also fires the matching reset events — a manual reset when the session budget is cleared, an automatic one when the daily budget rolls over at midnight — which the driver already listened for; on either, the gate lifts and pursuit resumes, re-scanning even when no goals were left paused. The sixty-second path now handles only genuine transient rate-limits, which is all it was ever meant for.

### The "I gave up" self-statement waits for a goal's real outcome

The per-attempt failure reflection wrote a first-person "I gave up the goal …" line to the self-statement log on every failed pursuit attempt — and it ran at the pursuit site, before the goal driver decided whether to pause, retry, or abandon. A goal that was about to be retried, or merely paused on a budget cap, recorded a giving-up that did not occur. The self-statement and its InnerSpeech thought are now decoupled from the per-attempt reflection and hang off the goal's real lifecycle events: abandoned narrates "I gave up on", stalled narrates "I stalled on", and obsolete narrates "I marked … obsolete", each carrying the goal's own reason. The lesson write stays per-attempt — each failed try is worth learning from even when the goal is later retried rather than abandoned — and the failure classification and its event are unchanged.

### The continuation loop reports each round

A continuation sequence — the loop that asks a model to resume a truncated output — exposed its per-round progress, done-reason, and completeness verdict only inside its own scope; from outside, a sequence that ran its whole round budget without completing was a black box, which is exactly the case a cloud model can fall into on a long code-with-manifest output. Each round now emits an `llm:continuation-round` event carrying the model, the attempt number, the cumulative and per-round character growth, the round's done-reason, and the completeness verdict, so a sequence that never finishes is observable round by round. This release adds the observability only; it does not change how the loop decides to continue or stop, so a sequence that completes, exhausts its round budget, or hits the existing cloud round cap behaves exactly as before — now with a per-round trace.

### Operational failures register in the emotional state

The emotional reactivity map turned chat errors, model failovers, and circuit changes into shifts in affect, but a goal that was abandoned, stalled, or marked obsolete — and a continuation sequence that failed — registered nothing, which is why frustration sat flat at its baseline through a run full of failures. Those four terminal events now adjust the emotional state, with a milder shift for a budget cap, which is a constraint rather than a failure. The shifts are modest: the retry storm that would once have accumulated them is closed by the cap gate above, so these events arrive sparsely and decay back toward baseline between real failures — registering a run's difficulty without saturating.

### Notes

- Test files: 586 → 590 — one focused suite per change: the cost-cap gate suspending and resuming pursuit with the two CostGuard reset signals; the decoupled reflection writing the lesson but not the per-attempt self-statement, with terminal-outcome narration for abandoned, stalled, and obsolete; the per-round continuation telemetry, including a sequence that never completes staying observable round by round; and the four failure events raising frustration moderately without runaway.
- This release changes autonomous behaviour under a sustained budget cap and after goal failures. A capped session now pauses pursuit until the budget resets rather than re-picking a goal each minute; the self-log records a giving-up only when a goal is actually abandoned, stalled, or made obsolete; a continuation sequence reports each round and stops on a stall; and the emotional state moves on real operational failures. On a run that stays within budget and completes its goals, none of these paths change what was there before.

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
