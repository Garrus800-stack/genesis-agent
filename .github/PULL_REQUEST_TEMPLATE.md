## What

<!-- Brief description of what this PR does. -->

## Why

<!-- Motivation: bug fix, feature, refactor, etc. Link to issue if applicable. -->

## How

<!-- Key implementation decisions. What changed and why. -->

---

## CI Checklist

- [ ] `npm test` passes (3375+ tests, 0 failures)
- [ ] `npm run ci` passes (tests + fitness + event audit + validation + channels)
- [ ] `npx tsc -p tsconfig.ci.json --noEmit` — 0 errors (TSC clean)
- [ ] New events have payload schemas in `EventPayloadSchemas.js`
- [ ] New IPC channels added to both `preload.js` and `preload.mjs`
- [ ] CHANGELOG.md updated

## Security Checklist

> Genesis has 10 security layers for self-modification, but PRs bypass all of them.
> These checks replace what SafeGuard, CodeSafetyScanner, and ImmuneSystem would catch at runtime.

### Kernel & Hash-Locked Files
- [ ] No changes to `src/kernel/` (SafeGuard, bootstrap, vendored acorn)
- [ ] No changes to `src/agent/core/PreservationInvariants.js`
- [ ] No changes to `src/agent/core/Constants.js` safety-critical sections (HASH_LOCKED_FILES, PRESERVATION_RULES)
- [ ] No modifications to hash-lock validation logic or file integrity checks

### Code Safety Patterns
- [ ] No new `eval()`, `new Function()`, or `vm.runInNewContext()` outside Sandbox
- [ ] No `__proto__`, `constructor.prototype`, or prototype pollution patterns
- [ ] No dynamic `require()` with user-controlled paths
- [ ] No `child_process.exec()` with unsanitized input
- [ ] No `fs.writeFileSync()` targeting files outside `.genesis/` or working directory
- [ ] No new `process.env` reads without fallback (information disclosure risk)

### Architectural Integrity
- [ ] No cross-layer imports (e.g. ports/ importing from intelligence/)
- [ ] No new `@ts-nocheck` or `@ts-ignore` without justification comment
- [ ] No removal or weakening of existing test assertions
- [ ] No changes to coverage ratchet thresholds (81/76/80) or schema ratchet (100%)
- [ ] No changes to CI gate scripts that would reduce checks

### Prompt & Identity Security
- [ ] No changes to prompt section gating logic in `PromptBuilder.js`
- [ ] No changes to `DisclosurePolicy.js` trust levels or disclosure rules
- [ ] No exposure of internal architecture details in user-facing strings
- [ ] No changes to `IdentityHardening` or version self-awareness sections

### Dependency Safety
- [ ] No new production dependencies added (current: 3 — acorn, chokidar, tree-kill)
- [ ] No vendored file replacements without hash verification
- [ ] No postinstall scripts or lifecycle hooks in package.json

## Testing

<!-- How was this tested? Include relevant output. -->

```
npm test                    # paste result
npm run ci                  # paste result
npx tsc -p tsconfig.ci.json --noEmit  # paste result
```
