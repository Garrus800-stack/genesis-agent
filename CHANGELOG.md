## [7.9.41]

Truth that prevails — the bridge's first span gets its repairs, the goal deaths get their cure, and the dream finally runs.

The repairs first. Daniel asks in the DU-form — "na, was hast du so gemacht?" — and the ask tier now knows every shape of that question (the old ich-form-only pattern never fired in the field). Three fact directives make the injected truth binding: the rules line, the Autonomy-Report head and the introspection head now state that questions about own activity are answered FROM the measured counters — never claim idleness while they show activity. The field proved the need: the exact numbers sat in the context while the model said "ich habe nichts gemacht". And the last step error is preserved where it actually exists — at the STEP-DIAG site in the pursuit loop — superseding the .40 archive-side pull, which was structurally empty (checkpoints only ever existed for successful steps).

The cure. Every successful CODE step died on `Unexpected token (1:5)` — acorn parsing the neutral sentence `Code written: …` (the 'w' at column 5): the verifier received the step's prose output because the success return never carried the code. It does now, and the engine prefers `result.code` over `result.output` — healing the whole alias family (CODE, REFACTOR, IMPLEMENT, FIX, UPDATE, PATCH) in one move. Every syntax failure now carries the first 80 characters of what was parsed, so this class of bug can never hide again. The earliest-possible boot trace writes to `.genesis/early-boot.log` with crash hooks, so a future crash #1 leaves its cause. The investigate-spawn learns manners: cross-goal dedupe (park on an existing open investigate goal instead of spawning a twin) and family registration, so the ideation's VARY rule finally sees it. And failures now reach the refiner and the decomposer — the ideation already knew them; the two downstream prompts were blind.

The dream. Genesis' own cadence replaces the old gate: never twice within 20 minutes; between 20 and 60 the v7.9.23 material gate holds; after 60 minutes with any material the dream is DUE and dominates the pick (score 10.0 — the field showed four idle hours with zero dreams). The DreamCycle's second clock is harmonised to the same 20 minutes, the karenz stays the idle gate, and the fruits need no new file: the awakening/ask block now lists up to five one-liners from the freshest Layer-2 (consolidated) episodes — the soul already persists them.

Contracts: `v7941-reparatur` (7), `v7941-diagnose` (7, two of them functional against the real engine) and `v7941-traum` (8) pin the behaviour; the `v7940-fundament` archive contract was deliberately superseded by the F3 site change and documents it.

Field run 19.07 (second pass, same version — the package was never published): an 18-minute pure-chat session exposed four mechanisms the first pass could not see. kimi's single stream carries adjacent doubles below the .39 thresholds — a seam healer (`dedupeSeams`, window 16-400, monotone-run protection) now runs at the chat egress before every assistant history entry AND inside the continuation loop, whose cloud/no-prefill round floor drops from 10 to 3. The injection gate classified bare project-root paths (CHANGELOG.md) as `file:user` and blocked Genesis from reading its own history — root documents and `docs/` are `file:internal` now, and internal is never scanned (user folders stay strict). Tool executions leave a compact `⛭ tool:` trace in the conversation history, so the model can never again "confess" a hallucination for work it really did. The announce-nudge gains a second ignition: a repeated announcement across turns fires it even when no tool ran yet — five turns of "Ich lese das Changelog" can never happen again. Crash tracing moves to the sentinel writer itself (with an exit-code line for hard deaths), and the goal-family list refuses adjacent duplicates.

Third pass, same day — said = done. The act core (`ChatActCore`) plans READ-ONLY tool steps deterministically from the user's demand ("schaue dir den CHANGELOG an", "was steht im README") or the model's own announcement ("Ich lese das Changelog.") — the SYSTEM executes; the model formulates. Wired before the announce-nudge (which stays as fallback for unmappable announcements), capped at two acts per turn, model-agnostic by construction. Missing tools already self-heal (ToolSynth's auto-synthesize on first call — the field log showed it live). Contract: `v7941r3-actcore` (9 tests against the literal field sentences).

Fourth pass — the silence belongs to the user. Garrus called it: fifteen minutes of silence would never be reached because Genesis keeps doing something in the conversation — and he was right by construction. The idle clock was reset by `agent:status` (Genesis' own loops) and `store:CHAT_MESSAGE` (Genesis' own replies): Genesis kept postponing its own silence. Now ONLY `user:message` resets it, and the think tick checks every 60 seconds instead of every five minutes — last user message + 5-minute threshold + at most one tick = the first autonomous thought arrives by roughly minute six, regardless of what Genesis itself does in between. Contract: `v7941r4-stille` (4 tests).

Fifth pass — boot responsiveness. The field boot froze the window ("no
response" on Windows) because everything shared the main thread: 12.9s of
service loading, then a synchronous 400-file snapshot right after the first
click became possible. Measured headless: the same code boots in 3.6s on a
fast disk — the mass was never worth 13 seconds. Four cuts, behavior otherwise
identical: (1) cheerio/puppeteer load lazily on first web use instead of
eagerly at manifest load (availability reported via require.resolve, without
loading); (2) the V8 compile cache is enabled at the top of main.js (bytecode
persists across starts; safe no-op where unsupported); (3) the boot snapshot
gets an async twin `createAsync` — same walk, same globally sorted order,
hash computed incrementally from the very bytes written (one read per file
instead of copy-then-rehash), 24-file batches with setImmediate breaths;
create() itself and every shutdown path stay synchronous (Shutdown Persist
Safety invariant); (4) breathing points in the container boot loops and after
each eager foundation resolve, so the main thread keeps handling input.
Contract: `v7941r5-uiboot` (10 tests).

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
