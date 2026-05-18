## [7.9.2]

**Root-cause fix for the goal-reject loop, plus dashboard splitter and graph-hover improvements.**

The v7.9.1 cooldown turned out to be a workaround for a deeper bug. The actual root cause: `GoalDriverFailurePolicy` and `StalledGoalWatchdog` called `goalStack.setStatus()` / `goalStack.updateGoal()` — methods that do not exist on the real goalStack. Both typeof-checks always returned false, the try-block silently did nothing, status stayed `'active'`, and the scan re-picked the goal forever. The WARN message "failed 4× (stalled)" was logged before the (failing) status mutation, so the log line lied. v7.9.2 switches to the real API — `markStalled` and `markObsolete` — and the loop disappears because the status filter in `_listPursueable` actually has something to filter. The v7.9.1 cooldown is removed because it is no longer needed.

### Root-cause fix — markStalled / markObsolete

- **GoalDriverFailurePolicy.js** — both stalled paths (user-rejection branch and `_failureCap` branch) now call the real `goalStack.markStalled(id, reason)` and, in the hallucination-pattern branch, `goalStack.markObsolete(id, reason)`. The defunct `setStatus`/`updateGoal` fallback chain is removed. The manual `bus.fire('goal:stalled')` calls are also removed because `markStalled` fires the event itself — previously this would have produced double events if the real API had ever worked.
- **StalledGoalWatchdog.js** — same fix. Plus the watchdog-specific extra fields in the event payload (`stalledMinutes`, `blockedAt`) are gone since no external consumer used them; the standard `goal:stalled` payload from `markStalled` carries everything needed.
- **GoalDriver.js** — the v7.9.1 `_goalRejectedCooldown` map and the corresponding filter in `_listPursueable` are removed. With the real `markStalled` call setting `status='stalled'` synchronously in-memory, the existing `status === 'active'` filter is enough. Cooldown is not needed and would have created an inconsistency with `resumeGoal` (which doesn't fire a paired event to clear the cooldown).
- **Test mocks updated** — `v779-bug2-stalled-watchdog` and `v745-fix` test mocks were exposing `setStatus`/`updateGoal` themselves, which is exactly what hid the production bug. Both updated to expose the real API (`markStalled`/`markObsolete`) so tests reflect what production actually has.

### Dashboard splitter — drag-to-resize

The dashboard panel can now be resized by dragging. file-tree, goals, and editor panels are unchanged.

- **index.html** — new `<div class="splitter" data-splitter="dashboard-filetree" data-prev="dashboard-panel" data-next="file-tree-panel">` directly before the file-tree panel. The dashboard is injected as the first child of `#main-layout` by `dashboard.js`, so post-injection the DOM order is dashboard → splitter → file-tree → … and the existing visibility logic (`_updateSplitterVisibility`) shows the splitter when the dashboard is open and any panel further right is also visible.
- **splitter.js** — `dashboard` added to `PANEL_KEY_TO_ID`, `DEFAULTS` (280px), and `MIN_WIDTHS` (240px). No new exports needed.
- **DashboardStyles.js** — `#dashboard-panel` switched from `width:280px; max-width:340px` to `flex:0 0 var(--panel-width-dashboard, 280px)`. The max-width cap is removed so the splitter can actually grow the panel.
- **dashboard.js** — `toggle()` now fires `panel:visibility-changed` so the splitter appears and disappears in sync with the dashboard. Previously the dashboard toggle was the only panel toggle that did not emit this event.
- **v786-sidebar-splitter contract tests** — assertions for 3 splitters / 3 keys updated to 4, plus a new test for the dashboard↔file-tree splitter presence.

### Architecture-graph hover — see what's connected

Hovering over a node in the dashboard's Architecture Graph now shows the **names** of connected modules, not just the count.

- **ArchitectureGraph.js** — tooltip extended with an "↗ Out:" and "↙ In:" line listing the actual connected module names. Up to 8 per direction, then `+N more`. The lookup is a cached `nodeId → name` map built lazily on first hover.
- **Click-to-pin** — clicking a node now pins the tooltip via a new `_tooltipPinned` state. The tooltip stays visible on mouseleave until you click the same node again to unpin or click another node to switch the pin. Pin status is shown in the tooltip itself ("Click again to unpin").
- **Smart positioning** — the tooltip measures itself after rendering and flips to the left if it would overflow the container on the right, or below the node if there's no room above. Last-resort clamps prevent it from leaving the container entirely.
- **Tooltip width** raised from 250px to 320px to fit the name list, with `line-height:1.4` for multi-line content.
- **Toggle bug fixed in passing** — `_selectNode` previously had a quirk where every third+ click on the same node would re-trigger the deselect path. The new pin-aware flow reads `_selected` before mutating, so the toggle is deterministic.

### Doc reconciliation

- README.md, ARCHITECTURE-DEEP-DIVE.md, CAPABILITIES.md, COMMUNICATION.md test counts updated from 7794 to 7799.
- `scripts/audit-doc-drift.js` `TESTS_WIN_BASELINE` and `TESTS_WIN` updated.
- banner.svg version + test count bumped.

### Numbers

7799 tests pass (Win baseline), 7798 (Linux). 130/130 fitness. 7 new contract tests under `v792 contract:` prefix in `test/modules/v792-livefixes.contract.test.js`. 2 v791 cooldown tests removed (the cooldown they tested is gone). v779-bug2-stalled-watchdog and v745-fix mocks updated to real goalStack API.

---

## Archive

Previous releases live in dedicated archive files:

- `CHANGELOG-v7.md` — v7.x.x releases (current major)
- `docs/CHANGELOG-v6.md` — v6.x.x releases
- `docs/CHANGELOG-v5.md` — v5.x.x releases
- `docs/CHANGELOG-archive.md` — pre-v5 releases
