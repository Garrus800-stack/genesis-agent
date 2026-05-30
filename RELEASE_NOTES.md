# Genesis Agent v7.9.18 — This release restores v7.9.16 and v7.9.17 to working order by fixing a fault that lived one layer below their code. On the field machine the shipped v7.9.17 looked broken — the trajectory calibration service failed to start, and the idle-thought counters reset to zero — but the v7.9.17 code was correct. A crash-recovery had silently reverted it: the recovery restored a pre-v7.9.16 source snapshot over the live deployment and left the newer files in place, producing a version-mixed tree where some files were current and some were old. The newer code that survived tried to talk to older code that no longer defined what it needed, and failed quietly. No log, test, or code review had shown the fault, because the fault was not in the code that was reviewed — it was in what crash-recovery left behind. The diagnosis came from comparing the real on-disk snapshots, not the shipped source.

This release restores v7.9.16 and v7.9.17 to working order by fixing a fault that lived one layer below their code. On the field machine the shipped v7.9.17 looked broken — the trajectory calibration service failed to start, and the idle-thought counters reset to zero — but the v7.9.17 code was correct. A crash-recovery had silently reverted it: the recovery restored a pre-v7.9.16 source snapshot over the live deployment and left the newer files in place, producing a version-mixed tree where some files were current and some were old. The newer code that survived tried to talk to older code that no longer defined what it needed, and failed quietly. No log, test, or code review had shown the fault, because the fault was not in the code that was reviewed — it was in what crash-recovery left behind. The diagnosis came from comparing the real on-disk snapshots, not the shipped source.

### The recovery system treated code like identity

Three roots, one class of mistake: the snapshot machinery stored copies of code inside the identity layer and restored them without checking what it was restoring. Source-code snapshots lived under `.genesis/`, the identity directory that is meant to travel with Genesis across a habitat swap — so a version upgrade carried the old habitat's frozen code forward into the new identity, where a later crash could copy it back over the new code. The restore step copied a snapshot's files blindly, with no check that the snapshot's code version matched the running one. And the "last known good" snapshot was written after every boot that did not crash — including a boot whose service start had already failed — so a degraded state was frozen as the thing to fall back to, and the damage defended itself against every subsequent boot.

### Snapshots are habitat, not identity

Code snapshots now live beside the code, at a habitat-local path that does not travel with `.genesis/` across an upgrade. On first boot after the change, a pre-existing `.genesis/snapshots/` is moved aside to a timestamped `.deprecated` folder rather than deleted, so a poisoned legacy store can never be read or restored again while staying available for inspection; the move runs before any restore can read it, and is a no-op when there is nothing to move. This is the same habitat-versus-identity separation the rest of the system already honours, applied one level deeper — a copy of code is still habitat, even when its job is to protect identity.

### Restore refuses a foreign version, and a degraded boot is never frozen

Each snapshot now records the code version it was taken from, and a restore that finds a version mismatch is skipped — loudly, but softly, so a foreign-version snapshot can never overwrite the live tree and never bricks the boot; Genesis simply continues on its current code. Service-start failures during boot are now collected rather than swallowed as a single warning, and the "last known good" snapshot is written only when that list is empty. A boot with a failed service start is no longer frozen as the recovery target, so Genesis can recover out of a contaminated state instead of preserving it — the single most important effect of this release, because it breaks the self-preservation of the damage.

### Crash-safe idle-stats

The idle-thought activity counters were written on a one-second debounce that was flushed synchronously only on a clean shutdown, so a crash without a clean exit could drop the most recent counts. They are now written synchronously on each increment — the write was already atomic, only the debounce window was exposed — so every counter survives an unclean crash. The zero-reset seen on the field machine came from the snapshot contamination reactivating an old counter-less version of the code, not from the debounce; the debounce was a separate, smaller gap that is now closed regardless.

### Notes

- Test files: 524 → 525 (the recovery-integrity suite: the habitat-local snapshot location, the legacy-folder migration including its idempotence and its no-op case, version-aware restore skipping a mismatch and proceeding on a match, last-known-good creation gated on a clean boot, the service-start failure tally, and the synchronous idle-stats round-trip). The headless boot test now also asserts zero service-start failures, the assertion that would have caught the original fault before release.
- No new source module, event type, payload schema, or service: the module, event, schema, and service figures are unchanged. The version-of-record advances to 7.9.18 in `package.json`, `README.md`, `docs/banner.svg`, and `docs/COMMUNICATION.md`; `docs/ONTOGENESIS.md` gains a section on why habitat artifacts do not belong in the identity layer.

---

---

**Full Changelog**: See [CHANGELOG.md](https://github.com/Garrus800-stack/genesis-agent/blob/main/CHANGELOG.md)

**Installation**:
```bash
git clone https://github.com/Garrus800-stack/genesis-agent.git
cd genesis-agent
npm install
npm start        # Electron desktop
node cli.js      # Headless CLI
```
