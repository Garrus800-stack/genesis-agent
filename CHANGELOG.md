## [7.9.17]

The trajectory journal records what Genesis says about how he is changing; v7.9.16 began counting the events that make a cycle eventful. This release closes the loop between the two — quietly. When a cycle is committed, the directions its self-statements claim are now checked, weeks later, against what the numbers actually did. The check produces a single ternary verdict per measurable field — the claim and the trend agreed, disagreed, or there was nothing comparable to judge — and writes it to a side journal that feeds no decision. This is the observation phase of the reality-check: it gathers whether the self-description tracks reality at all, before anything is allowed to act on the answer.

### Only the fields a cycle can actually be measured against

Of the six self-statement fields, two carry numeric ground truth that can be reconstructed over a span of weeks, and only those two are scored. The line is not "numeric versus not" — it is whether the evidence survives a reboot, survives time without being pruned, and stays reachable across the whole cycle. Growth is scored from the success-rate trend in the append-only event journal, which is never pruned. Weakness is scored from the Wilson lower-bound of the named capability domain. The other four fields are recorded as positions, not scored, each for its own reason: the trait-adjustment log lives only in memory and does not survive a reboot; the mood history is a fixed-size ring that does not survive weeks; session metrics are too weak a proxy for closeness to carry a verdict; and values have no direction to be right or wrong about — their drift is measured as an embedding distance and left at that, with no threshold asserted over it.

### A separate classifier, and a snapshot taken while the evidence is fresh

The direction a statement claims is read at commit time, while the model is fresh, by a separate neutral classifier that is told plainly it is not the author of the text. Keeping the expected side off Genesis's own voice is what keeps a self-statement from grading itself. The classifier answers in a strict, small vocabulary — improved, declined, no change, or not directional — and a commit made offline records an explicit absence rather than a guess, and is never re-classified later by a model in a different state. Because the capability profile is anchored to the present and its outcome buffer prunes, the per-cycle capability aggregate for the weakness score is snapshotted at commit, while the cycle's outcomes are still in the buffer, and kept durably — so a later prune can never erase the point a future cycle will be compared against.

### Two side files, one new signal, and a thought you can ask for

The expected directions and the scores live in two append-only side files beside the trajectory journal; the entry's own schema is untouched. A new event announces each commit, fired and forgotten so it never blocks the commit, and the calibration observer listens for it — a one-way arrangement in which the trajectory never reaches back toward the observer. A new kind of inner thought, the prediction-mechanism review, exists only where it is emitted: by the review command, never on a timer and never as a runtime setting it could turn on for itself. `/trajectory review` scores the most recent cycle and renders, per field, whether the claim matched, was opposite, or had nothing to compare; `/trajectory calibration` shows the score history and the null-rate split per field, because a high share of unscored weakness cycles points at the size of the capability source, not at the frame.

### Notes

- Test files: 523 → 524 (the calibration suite: the ternary verdict including the cases that collapse to no-score, the two-window growth trend, the snapshot delta for weakness, an offline classifier and an offline embedder both yielding an explicit absence rather than a zero, the four record-only fields producing no score, the review and calibration command paths, and two structural guards — that the classifier is separate from Genesis's own voice, and that nothing outside the dashboard reads the calibration file or receives the observer as a dependency).
- One new source module (the calibration observer), one new event type (the commit signal, with its payload schema), and one new manifest service raise the module, event, schema, and service figures in `README.md`, `ARCHITECTURE.md`, `docs/CAPABILITIES.md`, `docs/COMMUNICATION.md`, and `docs/ARCHITECTURE-DEEP-DIVE.md`, which were updated to match.

---

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
