## [7.8.6]

**ModelBridge refactor + sidebar splitter + backlog cleanup.**

Two focused items plus a small backlog tidy.

### Item 1 — ModelBridge `_prepareCallContext` split + `_dispatch` merge

`_prepareCallContext` decomposed into four single-responsibility
helpers (`_resolveTemperature`, `_resolveRouting`,
`_resolveBackendTarget`, `_resolvePriority`) extracted into a new
`ModelBridgeContext.js` mixin (same pattern as
`ModelBridgeFailover.js` v7.6.5, `ModelBridgeAvailability.js`
v7.5.6, `ModelBridgeDiscovery.js`). The orchestrator now reads as
four named calls instead of one 56-LOC monolithic block.

`_dispatchChat` and `_dispatchStream` merged into a single
`_dispatch({ mode, ... })` method. The legacy `_dispatchChat` and
`_dispatchStream` survive as thin wrappers so the positional
signature stays callsite-compatible.

`TASK_TYPE_ROUTING_MAP` moved with the routing helper into
`ModelBridgeContext.js` (single owner).

`ModelBridge.js` shrinks from **697 to 643 LOC** (well under the
700 File-Size-Guard warn threshold). Output bag of
`_prepareCallContext` pinned by a 5-case regression-snapshot.

Contract prefix: `modelbridge-v786 contract:` (42 tests).

### Item 2 — Sidebar splitter (drag-to-resize panels)

Three resizeable splitters between the four main-layout panels:
file-tree ↔ goals, goals ↔ editor, editor ↔ chat. Drag with mouse
or touch, focus and use arrow-keys for 10px steps, or double-click
to reset a single panel. Window resize re-clamps widths so the
chat-panel keeps its 400px minimum.

**Smart visibility.** A splitter is shown whenever its data-prev
panel is visible AND any later panel in the row is also visible.
Hidden intermediate panels are skipped — the splitter visually
attaches to whichever next-visible panel actually follows. This
means a user who toggles off `goals` and `editor` can still resize
`file-tree`: the splitter appears between file-tree and chat. The
naive "both adjacent neighbours visible" rule would orphan splitters
between hidden panels and silently disable resize.

**Visual handle.** The splitter is 7px wide (generous click-target)
with a transparent default background so it doesn't compete with
the panel's border-right. A 2×32px grip line (`::before` pseudo,
`var(--border)` colour) sits in the middle to indicate the area is
interactive. On hover, focus, or while dragging, the background
switches to a subtle blue accent tint and the grip line grows to
56px in `var(--accent)` — so the resize affordance is unmistakable.

Panel widths are persisted in `ui.panelWidths` settings (debounced
batch-save) and restored on next boot. Defaults: file-tree 220px,
goals 280px, editor 600px. The chat-panel is the flex remainder
and has no stored width.

`window.togglePanel` extended to dispatch a `panel:visibility-changed`
DOM event so splitters recompute when a panel is toggled. Guarded
against test environments whose minimal DOM shim lacks
`window.dispatchEvent` / `CustomEvent` — the event is observability,
never primary behaviour, so the guard never crashes the toggle path.

Reset is available three ways: double-click a splitter, the
**Reset panel widths** button in Settings → Behavior tab, or by
deleting `ui.panelWidths` from the settings JSON.

Contract prefix: `sidebar-splitter contract:` (22 tests).

### Backlog tidy

Three items struck from `AUDIT-BACKLOG.md` as already done or
overtaken by reality:

- **ColonyOrchestrator worker-pool-cap bug** — fixed in v7.7.9
  Phase 1c.
- **F8 / D1+D2 — Slash-Discipline coverage extension (4 of 12
  intents)** — overtaken: `SECURITY_REQUIRED_SLASH` now holds 13
  intents, all enforced by `enforceSlashDiscipline`. Duplicate entry
  in two sections both removed.
- **Duplicate `effective-model contract:` + `effective-model-ui
  contract:` entries** in `scripts/stale-refs.json` deduplicated.

The non-self-fixable `monaco-editor's bundled DOMPurify` note stays
as documentation (upstream-dependency), but it's no longer counted
as an open backlog item when listing what's pending.

---


## Older releases

For prior version history, see the archive files:

- [**CHANGELOG-v7.md**](CHANGELOG-v7.md) — all v7.x.x releases (79 entries)
- [**CHANGELOG-v6.md**](CHANGELOG-v6.md) — all v6.x.x releases (12 entries)
- [**CHANGELOG-v5.md**](CHANGELOG-v5.md) — all v5.x.x releases (17 entries)
- [**CHANGELOG-archive.md**](CHANGELOG-archive.md) — v0.x.x – v4.x.x (29 entries)

This index file (`CHANGELOG.md`) keeps only the newest release inline so
the file stays readable. The major-version archives carry the full
history.
