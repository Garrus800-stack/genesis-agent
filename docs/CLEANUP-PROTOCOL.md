# Cleanup Protocol

External spec for Genesis's pre-deletion audit (added v7.8.4). Documents
when the audit runs, what it looks at, what its outputs mean, and what
its known limits are.

## Why this exists

Before v7.8.4, deciding whether a source file was safe to delete relied
on inspection by hand or by Genesis judgment alone — both error-prone.
Identical duplicate files lived side by side because nobody was sure
they were really identical. A wrong delete required a Git revert; a
right one was indistinguishable from a wrong one in the diff history.

The cleanup protocol replaces that with a structural check that runs
automatically whenever a shell step would delete a file, and is
available on demand via `/cleanup-check`. It does not decide for
Genesis — it surfaces evidence so the decision is informed.

## Components

The protocol has four layers, all shipped in v7.8.4:

1. **`src/agent/capabilities/CleanupVerifier.js`** — the engine. Pure
   capability with one public method, `verify(relativePath)`, returning
   `{ safe, findings, target }`.

2. **Auto-hook in `src/agent/revolution/AgentLoopSteps.js`** — when a
   `SHELL` step contains a delete command (`rm`, `unlink`,
   `Remove-Item`, `del`, `erase`) targeting a single file inside the
   project, the verifier runs before the approval prompt. Findings
   appear in the approval text so the user/Genesis sees what's at
   stake before approving.

3. **`/cleanup-check <path>` slash command** — manual audit without
   needing to construct a shell step. Same engine, formatted report.

4. **This document** — external spec, edge cases, evolution rules.

## Finding kinds

The verifier emits four kinds of findings:

### `importers` — blocking

Other files inside the project statically `require(...)`,
`import { … } from "…"`, or `import("…")` the target. Count and
example paths are included. If any importer exists, `safe` is `false`:
deleting the file would break the importer.

### `entrypoint-pattern` — blocking

The file's basename matches a known entry-point pattern
(`index.js`, `main.js`, `preload.js`, `preload.mjs`, `package.json`,
`cli.js`, `demo.js`). Entry points may have no static importer in the
source tree — they're invoked by Electron, npm, or the OS — so the
absence of importers does not imply safety. `safe` is `false`.

### `identical-siblings` — informational

One or more other files in the project have byte-identical content
(sha256 match). This often indicates a legitimate duplicate
(CommonJS + ESM versions of the same module, platform-specific copies),
but it can also indicate a forgotten copy-paste that should be
consolidated. The finding is informational — `safe` is not flipped
just because identical siblings exist.

### `sibling-name-matches` — informational

Files with the same basename but different content exist elsewhere
(e.g. `src/utils/helper.js` and `src/legacy/helper.js`). This is the
weakest signal — same name does not imply same purpose — but it is
worth a glance: a deletion may be removing the more-current file and
leaving the legacy one as the only `helper.js` survivor.

## The `safe` flag

`result.safe` is `true` only when:

- no `importers` finding is present, **and**
- no `entrypoint-pattern` finding is present.

Other findings do not influence `safe`. The flag is a recommendation,
not a permission — Genesis or the user remains responsible for the
final decision, especially when informational findings are present.

## Known limits — read these

The verifier is a static analyser. Two classes of import escape its
detection:

- **Dynamic require/import:** `require(varName)`, `import(expr)`, or
  any string-templated path is invisible to the regex scan. If the
  target is loaded via such a pattern, the verifier will report zero
  importers — incorrectly.
- **Non-JS references:** the verifier only scans `.js`, `.mjs`,
  `.cjs`, `.ts`, and `.json`. A file referenced from an HTML
  `<script src="…">`, a Markdown link, or a build script in another
  language will not register as an importer.

When in doubt, do not delete. Use `git grep -F filename` for a
broader search, or step back and ask whether the deletion is really
necessary.

## Skipped directories

The verifier ignores `node_modules`, `.git`, `dist`, `coverage`,
`.genesis`, `.nyc_output`, `release`, `tmp`, and any directory whose
name begins with a dot. References from these directories are not
counted as importers — they are either bundled output or third-party
code, and the project doesn't own their lifecycle.

## Telemetry

When a `bus` is supplied to the verifier, every `verify(…)` call
emits a `cleanup-verifier:scan-complete` event with the payload:

```js
{
  target: 'src/foo.js',
  safe: false,
  findingKinds: ['importers', 'sibling-name-matches'],
  findingCount: 2,
}
```

A telemetry failure (subscriber throws) does not break the verifier —
it is logged at debug level and the result is returned unchanged.

## Case study: ShellSafety dedup (v7.8.3 → v7.8.4)

In v7.8.3 we removed a stale duplicate of `ShellSafety.js` that lived
in the wrong directory. The audit was done by hand: `git grep` for
importers, a manual diff of the two copies, eye check of the entry
points. That worked, but it was easy to get wrong.

If the same situation arose today, the workflow would be:

```
/cleanup-check src/agent/core/ShellSafety.js
```

…and the report would either confirm the file is safe (no importers,
no entry-point match) or surface the importer/entry-point/sibling
findings that make the decision obvious. Either way the human or
Genesis judgement still applies — but the structural signal is in
front of you, not pieced together from grep output.

## Evolution

When new cleanup patterns appear (whole-directory removals, Git file
removals, symlink unlinks), extend `_DELETE_COMMAND_PATTERNS` in
`AgentLoopSteps.js` to recognize them, and add the corresponding
finding kind to `CleanupVerifier.js` if a new class of risk is
introduced (e.g. `git-tracked-file` for files that have history
worth a tag before deletion). The four-layer structure stays;
the engine extends.
