## What

<!-- Brief description of what this PR does. -->

## Why

<!-- Motivation: bug fix, feature, refactor, etc. Link to issue if applicable. -->

## How

<!-- Key implementation decisions. What changed and why. -->

## Checklist

- [ ] `npm test` passes
- [ ] `node scripts/validate-events.js` passes
- [ ] `node scripts/validate-channels.js` passes
- [ ] `node scripts/architectural-fitness.js --ci` passes (90/90)
- [ ] New events have payload schemas in `EventPayloadSchemas.js`
- [ ] New IPC channels added to both `preload.js` and `preload.mjs`
- [ ] CHANGELOG.md updated
- [ ] No new `@ts-nocheck` files introduced

## Testing

<!-- How was this tested? Include test output if relevant. -->
