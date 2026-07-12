## [7.9.36]

Genesis may now reach out on his own when solid signs suggest his human is under strain — a relationship gesture, never a diagnosis, guarded by the strictest gates of any proactive kind. The heart is a two-source rule: a chat-derived signal is never sufficient on its own. A small monitor watches the session pattern in the trajectory journal (total hours across a seven-day window, or sessions starting late at night, with the start honestly derived from the recorded end time minus the duration) and, independently, the user model's decaying affect inference — patience and satisfaction both below their floors, while engagement is deliberately ignored because high engagement can mask strain. Only when both agree does one thought enter the normal inner-speech pipeline, carrying its origins and aggregate evidence in the thought's context references: window, rounded hours, night-session count. Never metrics in the message, never quotes anywhere.

The expression rides the existing pipeline and thereby inherits every guard for free — quiet hours, cooldowns, the mute command, scoring, and the suppression log. Two new guards join them. Gate 6.5 is a generic per-kind wallclock cap read from settings against the state store's existing per-kind timestamp: concern fires at most once per seven days, whatever the scores say, and the gate sits deliberately between "is this kind allowed at all" and the quality floors. And a decline is a first-class state: after a delivered concern message the monitor listens to the next day of chat, and a "not needed" silences the kind for thirty days through a small public seam on the expression service — with its own gate reason, so the log forever tells respect from rate limiting. The content itself is template-bound: warm, at most three sentences, exactly one question, a withdrawal clause so a wrong guess costs nothing; bitterness markers reject the draft outright and missing core markers reject it too, both preserved in the suppression log with a text preview. Drift is discarded, never softened.

One new module (the 185th service), two lines added to the gate state, one field added to the state store, and one contract suite with seventeen pins covering the two-source matrix with the derived-start night fixture, the aggregate-only evidence, the in-memory self-throttle, the cap and decline mechanics with their store roundtrip and order relations, the shape enforcement, and the untouched private kinds — 422 modules, 619 test files, 185 services.

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
