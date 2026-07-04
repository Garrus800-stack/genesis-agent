## [7.9.29]

This release closes two defects that surfaced in chat and completes a structural pass over the source tree. Asking Genesis to read, view, or show a named file fell through to the chat model, which on the host wrote a shell command that never ran, so the model saw no content, decided the file was missing, and looped — only a request to summarise reached the deterministic handler. Separately, a single request could return its answer two or three times, because the recovery that re-drives a stalled model was tripped by ordinary narration. Both are corrected against the field traces. Alongside, every source file is brought under the architectural size limit and the last upward layer dependency is removed, so the fitness check reads a full score; those are pure structural moves that change no behaviour.

### Reading a named file is deterministic

A request to read, view, or show a specific file — in German or English — now resolves and reads that file directly, the same bounded path that already served a summary request. Before, only the summary verb was recognised; the view and read verbs fell to the chat model, which produced a shell command that was returned verbatim instead of executed, and the model, receiving no content, concluded the file did not exist and retried. A question about whether a file was already read stays a conversational question and is answered from memory rather than treated as a fresh read, so Genesis does not claim to have read something it did not.

### One request, one answer

The recovery that re-drives a model which announces its next action without emitting the tool call was keyed on two of the most common narration verbs, so an ordinary reply that used them was re-driven up to three times and its output repeated. That recovery now fires only after a tool has actually run and the turn would otherwise stall, so a plain answer is produced once.

### Every source file under the size guard

Eleven source files that had grown past the seven-hundred-line architectural limit are each split along a clean seam into a companion module — the boot wiring, the model-call semaphore, emotional-state history, the verification back-ends, obstacle recovery, the idle-cycle activities, a cognitive-manifest half, the analysis and code-execution steps, the built-in tool definitions, settings load-and-clamp, and the lesson-capture helpers — with the original class or object composed from both parts at load time, so no call site and no behaviour changes. The OS-adapting shell helper moves from the capability layer into the phase-zero core that every layer may depend on, removing the one remaining upward dependency. With both in place the architectural-fitness check reports its full score.

### Counted figures stay aligned

A script recomputes the live source-module and test counts and the fitness score and writes them into the README badge and the architecture documents, so the numbers the doc-drift audits verify cannot fall out of step with the tree as files are added or split.

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
