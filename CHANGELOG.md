## [7.9.32]

Three steps of an idle goal died in the first live run because every path they named was declared implausible — while every single path existed. The model had packed a comma-separated list into one file resource, and the plausibility filter judged the whole salad as a single path. The step-requirement producer now splits such lists into individual tokens, the filter judges list parts defensively (a token is plausible as soon as one part is — the literal trace line is pinned as a test fixture), and a goal that has already left the live stack no longer receives a contradictory "backing off" promise after its abandonment event.

Two self-assessment organs disagreed about the same tree: the optimization analyzer raised 140 complaints against modules the architectural fitness gate certifies as clean, because it judged by its own 500-line rule. It now judges by the house convention — the 700-line warning threshold of the fitness gate, cross-pinned by a contract so the two can never drift apart — and its dependency threshold moves to fifteen. Goal reports render graph-search results as a short label list instead of raw node JSON, and the dashboard verification stat now states what it measures: coverage, not a failure rate.

The rotating error/warn ring buffer formerly named crash.log carries its true name, flight-recorder.log, with a one-time migration of existing files and their rotation companion; the IPC channel is unchanged. And the fitness emitter scan recognizes the cautious optional-chaining fire form, closing a blind spot that spanned thirteen call sites in five modules.

One new contract suite adds sixteen pins across the five strands; no new source modules — 418 modules, 615 test files.

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
