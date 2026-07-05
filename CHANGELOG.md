## [7.9.31]

Until now, a skill Genesis forged — whether the autonomous daemon built it to close a capability gap or the chat command asked for it — was written straight into the live registry and loaded as a tool in the same breath, while the Können pipeline that rehearses, scores, and promotes crystallised skills ran beside it, unused by anything the forge produced. This release threads all skill acquisition into that one pipeline: everything forged now lands as a maturing candidate that must earn promotion the same way a crystallised skill does, nothing synthesized runs autonomously before a human-initiated or human-approved first execution, and the wishlist that drives autonomous building moves out of the code into settings.

### Every forged skill matures before it serves

Both forge callers — the daemon's capability-gap builder and the create-skill chat command — persist their product as a pending candidate in the Können directory instead of installing it live. The candidate manifest mirrors the crystalliser's shape exactly, including the crystallisation timestamp all seven promotion and rehearsal consumers key on, and adds two intake fields: the origin that routes gating decisions, and a generation counter. The acquisition context stays a first-person sentence of lived history — quoted verbatim by the skill lister and, on promotion, recorded as a core memory — so routing never leaks into biography. The intake fires a candidate-created event and answers honestly: the skill exists, is usable at once through a named run, and matures with every use. When no maturation directory is configured, the forge refuses rather than falling back to a live install.

### A gap counts a maturing candidate as covered

The daemon's desired-capability catalog leaves the source code: it is now read from settings and ships empty, so without a curated wishlist only user requests drive autonomous skill building. Coverage uses a new predicate that counts a loaded skill or a maturing candidate — pending, rehearsing, or promoted — so a gap closes the moment its candidate exists and does not re-fire every cycle while it rehearses. A quarantined or discarded candidate does not cover: its gap re-opens, and the rebuild runs as the next generation — the failed generation's directory is archived rather than deleted, the effectiveness statistics reset so the new attempt starts unburdened, and the build lockout keeps pacing repeated failures. A name that already belongs to a loaded tool or a maturing candidate answers without re-forging, checked before the model iteration starts so a collision costs no inference.

### Nothing synthesized runs autonomously before a first human touch

The rehearsal activity now gates its pick by origin and history. A daemon-built candidate needs an explicit grant before its first autonomous run at any trust level below Full Autonomy; at Full Autonomy it rehearses without asking. A denial blocks autonomous rehearsal for good, for any candidate of any origin. A candidate built on chat request never asks — its premiere belongs to the human who ordered it, and until that first named run the activity leaves it alone. Crystallised candidates keep their pre-existing, ungated rehearsal behaviour. The decisions are written with the skills-pending command, which gained approve and deny sub-actions, and the lister now shows each candidate's origin and, where a decision is pending, says exactly what to type.

### A named run matures the candidate

Running a maturing candidate by name executes it straight from the Können directory — sandboxed always; a generated skill cannot opt out by declaring itself trusted — and counts as a rehearsal through the one shared vocabulary the autonomous activity uses, so a human-driven run and an autonomous rehearsal advance the same counters, record the same distinct-input hashes, and flip the same pending-to-rehearsing state. The reply carries the result and the maturation standing. A quarantined or discarded candidate does not run this way; the name falls through to the ordinary not-found suggestion.

### Promotion registers the skill live

A promoted skill used to become a tool only at the next boot, leaving a window in which tool synthesis could rebuild it as a parallel copy. A listener on the promotion event now reloads the Können sources and refreshes the tool registry the moment promotion fires, so the name resolves as a real tool immediately.

### Housekeeping

The daemon's skill-created event is retired across all seven sites — bus catalog, store catalog, store-bus map, both payload schemas, the pipeline's store append, and the wire listener — replaced by the intake's candidate-created event carrying name, origin, and generation. The listener-lifecycle audit no longer crashes on an inline prototype-mixin binding; it resolves the required path directly and never feeds a non-identifier into a pattern build. A stale suite header that still described the origin requirement as deferred is corrected. One new source module carries the intake mixin and the shared rehearsal vocabulary; a new twenty-five-test contract suite pins the intake, coverage, collision, gating, approval, and event-retirement behaviour; the test baseline moves to 9053 on Windows and 9052 on Linux across 614 test files and 418 modules.

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
