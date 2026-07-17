## [7.9.39]

Genesis stops repeating itself — the stream now carries the truth from both ends.

Two roots, one symptom: an awakening where a single finished paragraph was streamed fifty times into one bubble. First, the cloud backends were deaf at the end of the stream. OpenAI and Anthropic both received the server's finish signal — `finish_reason`, `stop_reason`, `[DONE]` — and threw it away without ever calling `onDone`, so every cloud answer reached the rest of the system as `doneReason: null`. Every downstream layer then had to guess whether the answer was complete, which is the same blind spot that rewrote the awakening greeting a second time back in v7.9.37. Both backends now forward the real reason, mapping `max_tokens` to the shared `length` vocabulary, exactly as the Ollama backend has since v7.8.9 — callers that pass no `onDone` see identical behaviour.

Second, the streaming core had three timeouts and no memory. It accumulated chunks with only time-based watchdogs, so a model that fell into an internal repetition loop — streaming the same block on time, forever — tripped no timer, and the copies piled up until a hard cap cut them off. A tail-repetition brake now watches the accumulated text: three or more immediate copies of a block of at least forty characters end the stream with a dedicated `stop-repetition` reason, trimmed back to a single copy. The thresholds leave legitimate text alone — two-copy echoes, short refrains, repeated code lines all stay untouched — and the truncation detector treats `stop-repetition` as complete, never as a cut, so the continuation loop cannot revive the repetition one level up. Because every path from model token to bubble runs through this one core, the brake protects direct chat, nudges, continuations, synthesis, and idle alike. A contract suite pins both roots against a real silent backend and the negative cases, and pins 16 behaviours.

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
