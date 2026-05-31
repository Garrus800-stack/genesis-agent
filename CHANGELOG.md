## [7.9.19]

This release carries five independent strands. The first makes two things about the self-trajectory journal visible and writes down a principle that has quietly held since the journal began — it is read-only and observational, the diagnosis phase before anything acts on that data. The second is a behaviour fix in the idle-time planner: a long-dead failed goal no longer blocks a whole line of thinking. The third is a second planner fix: a plan no longer reaches for a peer agent that is not there. The fourth fixes the self-repair loop, which had been rewriting a valid file to satisfy a false syntax alarm. The fifth keeps an inspection goal from generating code or writing files it should never touch. The release therefore observes (the trajectory strand) and corrects behaviour (the four remaining strands) — taken as a whole it is not behaviour-neutral.

### Refuse runs and cycle age, in the calibration view

The `/trajectory calibration` view now shows two read-only observations drawn from the committed entries themselves. For each of the six self-statement fields it reports the current run of deliberate `refuse` values — counted from the latest cycle backwards and reset by the first real answer — and marks a run of three or more as a pattern. It also shows how many whole days have passed since the last cycle was committed. Both are counts and arithmetic over the journal; neither aggregates over a score distribution, and the age line reports its number and asserts nothing about it — there is no ceiling and no threshold. The reading is strictly observational: it emits nothing, writes nothing, and never forces a cycle to close. What a refuse run *means* — avoidance, protection, a fair stance, fatigue — is left open on purpose.

### Where the diagnosis lives

The counting lives on the journal's owner, not on the scorer. Both observations read the raw entries, so they are a method on the trajectory service itself; the calibration service, which reads its own scored side-files, is left untouched. The chat view asks each service for its own figures and renders them side by side, holding no logic of its own.

### Expectations do not belong in the runtime prompt

A property that has held since the trajectory journal began — and accrued through the cycle counter and the silent calibration — is now stated and enforced: the expectations Genesis records about himself never enter the runtime prompt that drives his ordinary behaviour. They live in side journals read only in the look-back contexts that compose or review a cycle. Feeding an expectation into the live prompt would turn it into an instruction, and produce performance of the trait rather than observation of whether it is becoming true — the script-effect the whole journal exists to avoid. `docs/ONTOGENESIS.md` now carries this as its own reasoned section, and a contract test fails if any prompt-building module ever begins reading the trajectory, calibration, or directions files. The prose explains why; the test makes it hard to erode unnoticed.

### A stale failure no longer blocks a planning theme

When Genesis plans an activity in idle time, he checks the idea against goals that recently failed, so he does not spend a cycle re-proposing something that just did not work. Two flaws made that check overreach. It had no sense of time — a goal that failed weeks ago counted exactly as much as one that failed an hour ago — and the goal stack only forgets a terminal goal when it overflows its capacity, which a small stack never does. The overlap test was also coarse: two shared words between a multi-word title and an old failure were enough to suppress the new plan. Together they let a single weeks-old failure quietly veto an entire theme for as long as it sat on the stack.

The check now ages out. A failed, stalled, or obsolete goal counts as a recent failure only while it is fresh, and the same aged list feeds both the planner's prompt hint and the skip decision, so neither is shown a failure that no longer reflects what Genesis can do now. The skip is also narrower: it triggers only when the overlap clears both an absolute floor and a share of the new plan's own words, so two words in common no longer block an otherwise-different idea, while a genuine re-run of something that just failed is still skipped. The relevance window and the overlap share are named constants; the field case that motivated the fix is pinned as a test.

### A plan no longer reaches for a peer that is not there

The primary planner offered every plan the option to delegate a step to a peer agent, whether or not any peer was reachable. On a single node with no peers — the ordinary case for one central installation — an idle-time goal could be handed a delegation step it could never satisfy; it would pursue for minutes and then fail when the step asked for a peer that did not exist. Genesis named the gap himself: the shortfall was not foreseeable at planning time.

It is now. Delegation is offered only when the delegation machinery is wired *and* a peer is actually reachable — the same condition the step executor checks, so the planning decision and the execution decision can no longer disagree. The fallback planner already filtered its step menu this way through a shared catalog; the primary planner now uses the same signal. The full vocabulary of step types is still declared, unchanged — what changes is which of them a given plan is invited to use. As a backstop, if a delegation step is produced anyway when no peer can serve it, it is rewritten to local analysis before the plan runs — the same fallback the executor already performed, moved to plan time so the goal completes instead of stalling on a resource it was never going to have.

### Self-repair no longer rewrites a file that was never broken

Genesis's self-diagnosis syntax-checks every module, and when one fails it hands the file to the model to repair and writes the result back. But the check parsed each file with a raw script parser, not the way Node actually loads a module — so a valid module with a top-level `return` (a common early-skip guard) was read as an "illegal return statement," and an ES module's `import` as unparseable. The loop then "repaired" a file that had nothing wrong with it, overwriting working code to satisfy a false alarm.

The check now parses the way Node's loader actually loads a module: a leading shebang is stripped, then the body is wrapped in the CommonJS module wrapper. A top-level `return` is legal and a `#!`-prefixed file — every command-line or test entry point — parses cleanly, while a genuine syntax error still throws inside the wrapper, so real detection is unchanged. ES modules, which the CommonJS check cannot parse, are skipped. A valid file is no longer mistaken for a broken one, and self-repair no longer touches code that was never broken.

### A read-only goal no longer reaches for a write it should never make

Genesis's idle-time goals are read-only by construction — the activity that proposes them constrains every title to an inspection or verification verb, with code-modification verbs refused by their absence. But the primary planner offered code-generation and file-write step types regardless of that intent (just as it offered peer delegation before the previous strand fixed that), so an "Inspect …" goal could be decomposed into steps that generate code or write files — and in the field one was, producing hallucinated paths and a wasted pursuit before a retry, steered back to analysis, completed cleanly.

The planner is now read-only-aware. A goal recognised as read-only no longer has code-generation or code-execution step types offered to it, and any code-generation, file-write, or self-modification step that slips through is rewritten to analysis at plan time. Shell stays available — read-only shell (listing, reading, running tests) is how an inspection goal does its work, and the successful field pursuit relied on it. The read-only verb list now lives in one shared module the planner and the activity both read, so the two cannot drift. The static step-type vocabulary the planner shows the model is left intact.

### Notes

- Test files: 525 → 531 (a diagnostics suite covering refuse run-length, ceiling-free cycle age, and the observational invariant; a contract suite pinning that only the three owning services reference the trajectory data files, no prompt-builder among them; a suite pinning the planner's aging window and overlap thresholds against the field case that motivated them; a suite pinning that delegation is planned only when a peer is reachable and that a stray delegation step is rewritten to local analysis, with the static step-type vocabulary left intact; a suite pinning that the self-diagnosis syntax check parses the way Node loads a module — a leading shebang is stripped, a top-level return stays valid, a genuine error is still caught, ES modules are skipped; and a suite pinning that a read-only goal drops code-generation and code-execution step types while keeping shell, and that a code/write/self-modify step is rewritten to analysis while shell, tests and search are left untouched).
- One new source module (the shared read-only-intent vocabulary, 384 → 385); no new event type, payload schema, or service. The behaviour fixes otherwise live in existing modules — the idle-time plan activity, the agent-loop and formal planners, the sandbox and reflector, and the central step-type catalog. The version-of-record advances to 7.9.19 in `package.json`, `README.md`, `docs/banner.svg`, and `docs/COMMUNICATION.md`.

---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
