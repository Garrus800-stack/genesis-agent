## [7.9.49] — 2026-07-30

**The release before this one shipped a split, and the split left a name behind.** `handleStream` moved into its own file and took the five module-scope names a search had looked for — `dedupeSeams`, two stream filters, `buildSelfMessageEntry`, `path`. It did not take `_log`, because nobody searched for it. Syntax stayed valid, the module loaded, all 24 gates went green and 9534 tests passed; the first sentence Genesis spoke in the field ended with **"Fehler: _log is not defined"**, and every sentence after it too. A name-based check cannot find the name nobody thought of.

**So the check now resolves instead of searching.** `audit-free-identifiers` parses every module and requires that each identifier it reads resolves — to a declaration, a require, a parameter or a JavaScript builtin, and in the renderer additionally to a top-level name from another UI file, because those load as script tags. It runs in both chains.

**On its first run it found four more of the same kind, and three had been silently broken for a long time.** `THRESHOLDS` was used by the awareness gate in the self-modification pipeline and never imported; the reference sat inside a `try`, so the `ReferenceError` was swallowed and **the gate never blocked a single self-modification**. `PromptBuilderSectionsAwareness` pushed the vestibule paragraph to `lines` in a block that builds `parts` — the sentences added in v7.9.46 so Genesis would know about his own membrane never reached his prompt. `AgentLoopStepsCode` used `path` while only requiring it inline inside a different function, and used `sourceForPrompt` without importing it at all.

**A 402 was never learned, so it was paid for on every message.** The failover classifier knows `subscription`, `upgrade`, `quota exceeded` and `weekly limit` — and Ollama's actual sentence contains none of them: *"this model uses extra usage only (not included plan usage) and your extra usage balance is empty"*. No reason matched, so the model was never marked unavailable, and every single message paid a failed round trip before falling back. It classifies on the **status code** now, because 402 means Payment Required whatever words follow it; the sentence can be rephrased, the code cannot. The model is held for 24 hours like any other subscription gate. That is the same build pattern this release series is about, one layer further out.

**And a 402 is now answered with a measurement rather than a guess.** A field run showed `ollama run kimi-k2.7-code:cloud` answering normally while Genesis received HTTP 402 for the same model on the same daemon, with plan usage at 0.5 percent. The only difference between the two requests is what Genesis adds: `options.num_ctx` (up to 65536) and `options.num_predict`. `num_ctx` was introduced in v7.9.37 for a local problem — Ollama defaults to 8192 and truncated the head of large prompts — and a cloud endpoint manages its own window. That is a plausible cause and it is not a proven one, so nothing about the request shape was changed on the strength of it. Instead, a 402 triggers exactly one retry without those two knobs, and both outcomes are logged by name: which shape was refused, which was accepted. The field answers the question. A request that succeeds never enters this path, only a 402 does, the retry carries no knobs of its own so it cannot loop, and it is refused outright if a single character has already reached the user.

**The field ran that measurement before this release shipped.** The retry fired four times and the success line never followed once: dropping the two knobs changes nothing for this 402, and the refusal is about the model, not the request. So the retry is now skipped for exactly that answer — and kept for a 402 worded differently, where a knob may still be the cause. One measured case closes one door; it does not close the others.

## Older releases

For prior version history, see the archive files:

- [**CHANGELOG-v7.md**](docs/CHANGELOG-v7.md) — all v7.x.x releases (130 entries)
- [**CHANGELOG-v6.md**](docs/CHANGELOG-v6.md) — all v6.x.x releases (12 entries)
- [**CHANGELOG-v5.md**](docs/CHANGELOG-v5.md) — all v5.x.x releases (17 entries)
- [**CHANGELOG-archive.md**](docs/CHANGELOG-archive.md) — v0.x.x – v4.x.x (29 entries)

This index file (`CHANGELOG.md`) keeps only the newest release inline so
the file stays readable. The major-version archives carry the full
history.
