<!--
  Thanks for contributing to Genesis. Please fill this out so the change
  is easier to review. You can delete any section that doesn't apply, but
  please don't delete them all.
-->

## What this change does

<!-- One or two sentences on what the PR does. Not what's in the diff —
     what the reader will experience that's different. -->

## Why

<!-- What problem or need motivated this? Link to an issue if there is one. -->

Fixes #

## Approach

<!-- How did you solve it? Anything non-obvious that a reviewer should know?
     If the change spans multiple files, a one-sentence note per file
     helps. -->

## Testing

<!-- Check all that apply: -->

- [ ] `npm test` passes locally
- [ ] `npm run scan:schemas` shows zero mismatches
- [ ] `npm run audit:fitness` does not regress vs. the previous score
- [ ] New tests added for new behavior (or rationale below for why not)
- [ ] Manually verified on a live Genesis boot

<!-- Paste relevant output if anything is non-obvious: -->

```
[paste test/audit output if relevant]
```

## Architectural impact

<!-- Check all that apply: -->

- [ ] No new services added
- [ ] New service added — registered in the correct phase manifest
- [ ] No new events added
- [ ] New events added — registered in `EventTypes.js` AND `EventPayloadSchemas.js`
- [ ] No files added to shutdown list
- [ ] New stoppable service — added to `TO_STOP` in `AgentCoreHealth.js`
- [ ] No documentation changes needed
- [ ] `CHANGELOG.md` updated
- [ ] `README.md` badges/counts updated if service count changed
- [ ] `ARCHITECTURE.md` updated if a new layer/phase/pattern was introduced

## Safety

<!-- Did this touch any of the hash-locked critical files? Did it change
     injection-gate, safeguard, capability-guard, or self-modification
     pipeline behavior? If yes, explain what and why. -->

## Breaking changes

<!-- None expected / or describe what breaks and the migration path. -->
