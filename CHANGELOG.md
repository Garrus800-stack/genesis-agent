## [7.9.50] — 2026-07-30

**A rebuild is a merge, not a fresh start.** When the expressions channel was withdrawn from v7.9.48, the release was rebuilt from a clean v7.9.47 copy. Three things in the discarded build had nothing to do with that channel, and they went with it anyway. Nobody noticed, because everything that remained was green.

**The settings-coverage gate was gone.** It checks each documented setting in both directions: the key must exist in the live default tree, and the documented default must equal the live one. The second half is the one that matters — existence alone cannot catch a wrong assignment, since a mis-assigned but existing key passes while the statement is false. Restored, wired into both chains, and on its first run it found the same nine drifted rows it had found before, because those had come back with the rebuild. Two of them are the promotion rule that was removed from his self-image two releases ago: it stood in two places, one was corrected and the other was not, and the correction of the second is what disappeared. Two more documented a key prefix that does not exist.

**The side-effect guard was gone.** Eleven intents that write, run or install are downgraded to plain conversation when they arrive from a guess — from the learned classifier or from the model — while the deterministic path at full confidence stays untouched. It was measured then and the measurement still holds: the field incident that prompted it came from the model's own tool choice, not from the router, so this is defence in depth and is described as such. It is back, with both guessed returns wrapped, and the router is unchanged at 696 lines.

**And a contract pin was gone** — the one that holds `public.jsonl` at its real path. The correction survived the rebuild because it was made a second time; the pin that keeps it correct did not, and a corrected path without a pin is a path waiting to drift again. That pin came from a v7.9.47 revision that was superseded on disk but never merged forward, which is a second instance of the same mistake: the release was built from an uploaded package rather than from the last state.

**Three files were split, and the method came from the mistake that made the first one necessary.** `ArchitectureGraph.js` stood at exactly 700 lines — the guard allows 700 and fails above it, so the next entry could not be added at all, the same wall `IntentPatterns` hit before v7.9.47. `ModelBridge.js` and `ChatOrchestratorHelpers.js` stood at 698, the latter being the most-changed large file in the tree. They are now 526, 564 and 553.

**Every block was resolved for all its free identifiers before it was cut, not searched for the ones that seemed likely.** That is what the v7.9.48 split did — it looked for five expected names, missed `_log`, and every streamed answer ended in a reference error while every gate stayed green. Two of these three blocks needed exactly that name; the tool found it before the cut rather than the field finding it after.

**The renderer found a third, after the package was already built.** The viewport mixin was written inside `if (typeof module !== 'undefined')`. Node has `module`, so every test stayed green and the class was whole in all of them; the renderer does not, so the block was skipped, the mixin never ran, and the graph came up with *"_addZoomToolbar is not a function"*. A mixin belongs to the class, not to the export — it stands outside that guard now. What makes the case worth writing down is that the audit before it had warned about exactly this shape, in the same file, and the warning was then walked into. The pin that holds it does not check one line: it loads every UI script in a context with `window` and without `module`, in the order `index.html` gives, and requires the class to be complete; and it requires that no UI file hides anything but its export behind that guard.

**And it found two things a name search never would have.** The viewport block read three static class getters — `ArchitectureGraph.ZOOM_MIN` and its siblings — which resolve in the renderer, where the class is a global, and not in a Node test. They ask `this.constructor` now. And `ArchitectureGraph.js` is loaded by a `<script>` tag, so a mixin pulled in with `require()` would have broken in the browser: the new file publishes a global, `index.html` loads it first, and the mixin accepts either. A fourth split, of `AgentLoopPursuit.js`, was built and then withdrawn: 698 lines against the guard is tight but not at the wall, the file has the most source pins in the tree and only two methods, so the cost was highest where the need was smallest.

**All three were found by comparison, not by memory.** Every file of the discarded build was diffed against the shipped tree and every difference classified — and the result is worth recording: apart from these three, everything the shipped tree does differently is newer. The unclassified-action fallback, the vestibule paragraph's target array, the promise in the MetaLearning header, the shell patterns, the code-scanner rules — all of those read older in the discarded build. Only three pieces travelled the wrong way.

## Older releases

For prior version history, see the archive files:

- [**CHANGELOG-v7.md**](docs/CHANGELOG-v7.md) — all v7.x.x releases (131 entries)
- [**CHANGELOG-v6.md**](docs/CHANGELOG-v6.md) — all v6.x.x releases (12 entries)
- [**CHANGELOG-v5.md**](docs/CHANGELOG-v5.md) — all v5.x.x releases (17 entries)
- [**CHANGELOG-archive.md**](docs/CHANGELOG-archive.md) — v0.x.x – v4.x.x (29 entries)

This index file (`CHANGELOG.md`) keeps only the newest release inline so
the file stays readable. The major-version archives carry the full
history.
