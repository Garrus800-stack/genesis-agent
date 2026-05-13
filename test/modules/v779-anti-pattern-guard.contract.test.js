#!/usr/bin/env node
// v7.7.9 Phase 2 — anti-pattern guard contract
//
// PSE has a structural commitment: it does NOT condition on user
// reactions, does NOT optimize for engagement, does NOT learn from
// the user's behaviour what to say next. (Cheng et al. 2025: systems
// that optimize for user-satisfaction reduce prosocial behaviour and
// increase dependency.)
//
// This file enforces the commitment at file-content level. A regression
// here means the build fails — no PR can sneak an engagement metric
// into Scoring.js or import IdleMind/AdaptiveStrategy directly into
// the PSE main class.

'use strict';

const fs = require('fs');
const path = require('path');
const { describe, test, assert, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const SCORING_PATH = 'src/agent/cognitive/proactiveSelfExpression/Scoring.js';
const PSE_PATH     = 'src/agent/cognitive/ProactiveSelfExpression.js';
const SANITY_PATH  = 'src/agent/cognitive/proactiveSelfExpression/ContentSanity.js';

// ── Forbidden words in the Scoring path ────────────────────
//
// These are the engagement-optimizer vocabulary. Any of them appearing
// as identifiers, comments, or strings would indicate Scoring is
// drifting toward a user-reaction signal.
const FORBIDDEN_IN_SCORING = [
  /\breplied\b/i,
  /\breaction\b/i,
  /\bengagement\b/i,
  /\bretention\b/i,
  /\bdwell[_-]?time\b/i,
  /\bsession[_-]?length\b/i,
  /\bclick[_-]?through\b/i,
  /\buser[_-]?satisfaction\b/i,
  /\buser[_-]?happiness\b/i,
  /\bopen[_-]?rate\b/i,
];

describe('PSE — anti-pattern guard (file-content level)', () => {
  test('Scoring.js contains no engagement-metric vocabulary', () => {
    const src = READ(SCORING_PATH);
    // Strip the explanatory comment block at the top — it intentionally
    // names the forbidden vocabulary so the policy is documented in
    // place. We still want to enforce the rule on the *implementation*.
    // The header comment is the block from start of file up to and
    // including the closing `// ===...` line.
    const headerEndIdx = src.indexOf('// ===', src.indexOf('// ===') + 1);
    const body = headerEndIdx > 0 ? src.slice(headerEndIdx) : src;

    for (const pattern of FORBIDDEN_IN_SCORING) {
      assert(!pattern.test(body),
        `Scoring.js body contains forbidden engagement-metric vocabulary matching ${pattern}. PSE must never condition on user reactions.`);
    }
  });

  test('ProactiveSelfExpression.js does not import IdleMind or AdaptiveStrategy directly', () => {
    const src = READ(PSE_PATH);
    // require('...IdleMind') or require('...AdaptiveStrategy') would mean
    // PSE is reaching into upstream modules to read user-pattern signals.
    // That couples PSE to upstream behaviour — wrong direction. PSE
    // subscribes to InnerSpeech and consumes the bus. It does not pull
    // user-pattern state from cognitive helpers.
    assert(!/require\([^)]*IdleMind[^)]*\)/i.test(src),
      'PSE must not require IdleMind directly — it subscribes via InnerSpeech.');
    assert(!/require\([^)]*AdaptiveStrategy[^)]*\)/i.test(src),
      'PSE must not require AdaptiveStrategy directly — it would pull user-reaction-derived signals.');
  });

  test('PSE main class declares its anti-sycophancy commitment in the file header', () => {
    const src = READ(PSE_PATH);
    // The file header must explicitly state the boundary so that any
    // future maintainer reads it before editing.
    assert(/no engagement metrics/i.test(src) || /not condition on user reactions/i.test(src),
      'PSE file must declare its anti-sycophancy commitment in the header comment.');
  });

  test('ContentSanity has banned-phrase categories for farewell-hooks, fake-emotion, guilt-manipulation', () => {
    const src = READ(SANITY_PATH);
    assert(/['"]farewell-hooks['"]/.test(src),  'farewell-hooks category missing from ContentSanity');
    assert(/['"]fake-emotion['"]/.test(src),    'fake-emotion category missing from ContentSanity');
    assert(/['"]guilt-manipulation['"]/.test(src), 'guilt-manipulation category missing from ContentSanity');
    assert(/['"]engagement-bait['"]/.test(src), 'engagement-bait category missing from ContentSanity');
  });

  test('ContentSanity rejects (does not rewrite) on banned-phrase match', () => {
    const src = READ(SANITY_PATH);
    // No retry, no rewrite: the policy is reject-only. The forbidden
    // tokens would only matter as actual *code* — calls to retry()
    // logic, regenerate functions, etc. So we strip the header comment
    // first (the policy comment intentionally names what's forbidden).
    const headerEndIdx = src.indexOf('// ===', src.indexOf('// ===') + 1);
    const body = headerEndIdx > 0 ? src.slice(headerEndIdx) : src;
    // Now check for callable retry/regenerate patterns in body.
    assert(!/\.retry\s*\(|\bregenerate\s*\(|\bparaphrase\s*\(|\brewriteText\s*\(/i.test(body),
      'ContentSanity must not retry/rewrite — sanity is reject-only.');
  });
});

run();
