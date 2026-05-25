// ============================================================
// v7.9.9 (B): extended-greeting detection contract tests.
//
// Pins the IntentRouter behaviour that a narrative introduction
// starting with a greeting (identity statement or relational
// framing, no action verb, < 1000 chars) classifies as general
// chat, not as a goal. Catches "Hallo Genesis, ich bin Daniel..."
// patterns that pre-v7.9.9 became 15-step code-modification plans.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const { describe, test, run, assert } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const ROUTER_PATH = path.join(ROOT, 'src/agent/intelligence/IntentRouter.js');

const { IntentRouter } = require(ROUTER_PATH);

function makeRouter() {
  return new IntentRouter({
    routes: [],
    bus: { fire: () => {}, on: () => {} },
  });
}

describe('v799-extended-greeting (v7.9.9 B)', () => {

  // ── Source-grep contract ───────────────────────────────────

  test('SRC-01: extended-greeting branch present in IntentRouter source', () => {
    const src = fs.readFileSync(ROUTER_PATH, 'utf8');
    assert(/conversational-extended-greeting/.test(src),
      'v7.9.9 (B): IntentRouter must contain conversational-extended-greeting stage');
    assert(/v7\.9\.9 \(B\)/.test(src),
      'v7.9.9 (B): explicit version marker comment must be present');
  });

  test('SRC-02: pure-greeting regex still has end-anchor', () => {
    const src = fs.readFileSync(ROUTER_PATH, 'utf8');
    // The original line-151 regex with [\s!?.]*$ end-anchor must remain
    // so single-word greetings keep their fast path.
    assert(/\/\^\(hi\|hallo\|moin\|hey\|servus\|guten[^\/]+\)\[\\s!\?\.\]\*\$/.test(src),
      'pure-greeting end-anchored regex must remain unchanged');
  });

  // ── Positive cases (the patterns that should NOT plan) ───

  test('POS-01: "Hallo Genesis, ich bin Daniel..." → general', async () => {
    const r = makeRouter();
    const msg = 'Hallo Genesis, ich bin Daniel. Ich muss dir einen kleinen Status Bericht geben, du bist ja gerade erst erwacht.';
    const result = await r.classifyAsync(msg);
    assert(result.type === 'general',
      `expected general, got ${result.type} (stage: ${result.stage || result.match})`);
    assert(result.stage === 'conversational-extended-greeting',
      `expected stage=conversational-extended-greeting, got ${result.stage}`);
  });

  test('POS-02: "Hi Genesis, du bist ein autonomer Agent" → general', async () => {
    const r = makeRouter();
    const result = await r.classifyAsync('Hi Genesis, du bist ein autonomer Agent und triffst eigene Entscheidungen.');
    assert(result.type === 'general' && result.stage === 'conversational-extended-greeting',
      `expected extended-greeting, got type=${result.type} stage=${result.stage}`);
  });

  test('POS-03: "Hi Genesis, I am Sarah" → general (English narrative)', async () => {
    const r = makeRouter();
    const result = await r.classifyAsync('Hi Genesis, I am Sarah. We have been working on this project for months.');
    assert(result.type === 'general' && result.stage === 'conversational-extended-greeting',
      `English narrative greeting must classify as extended-greeting, got ${result.stage}`);
  });

  test('POS-04: "Hey, wir arbeiten gerade an dem Projekt" → general (relational framing)', async () => {
    const r = makeRouter();
    const result = await r.classifyAsync('Hey, wir arbeiten gerade an dem Genesis Projekt zusammen.');
    assert(result.type === 'general' && result.stage === 'conversational-extended-greeting',
      `relational framing must classify extended-greeting, got ${result.stage}`);
  });

  // ── Negative cases (still goals despite greeting prefix) ──

  test('NEG-01: "Hallo Genesis, kannst du X fixen" → NOT extended-greeting (action verb)', async () => {
    const r = makeRouter();
    const result = await r.classifyAsync('Hallo Genesis, kannst du den EventBus fixen?');
    assert(result.stage !== 'conversational-extended-greeting',
      'message with action verb "fixen" must not classify as extended-greeting');
  });

  test('NEG-02: "Hi, please refactor the EventBus" → NOT extended-greeting', async () => {
    const r = makeRouter();
    const result = await r.classifyAsync('Hi, please refactor the EventBus module.');
    assert(result.stage !== 'conversational-extended-greeting',
      'message with "refactor" verb must not classify as extended-greeting');
  });

  test('NEG-03: "Hallo, implement a new feature" → NOT extended-greeting', async () => {
    const r = makeRouter();
    const result = await r.classifyAsync('Hallo, implement a new logging feature.');
    assert(result.stage !== 'conversational-extended-greeting',
      'message with "implement" verb must not classify as extended-greeting');
  });

  test('NEG-04: no greeting prefix → falls through', async () => {
    const r = makeRouter();
    const result = await r.classifyAsync('Ich bin Daniel und arbeite an Genesis.');
    assert(result.stage !== 'conversational-extended-greeting',
      'identity statement without greeting prefix must not match');
  });

  // ── Edge cases ─────────────────────────────────────────────

  test('EDGE-01: single-word "Hallo" hits pure-greeting fast path', async () => {
    const r = makeRouter();
    const result = await r.classifyAsync('Hallo');
    assert(result.stage === 'conversational-greeting',
      `single-word greeting must hit the pure-greeting path, got stage=${result.stage}`);
  });

  test('EDGE-02: message > 1000 chars with greeting falls through (length cap)', async () => {
    const r = makeRouter();
    const long = 'Hallo Genesis, ich bin Daniel. ' + 'x'.repeat(1050);
    const result = await r.classifyAsync(long);
    assert(result.stage !== 'conversational-extended-greeting',
      'messages over 1000 chars must not be treated as extended-greeting');
  });

  test('EDGE-03: greeting without identity or relational framing → falls through', async () => {
    const r = makeRouter();
    // Greeting + meta-curiosity ("wie geht") is its own existing branch, so use a neutral question.
    const result = await r.classifyAsync('Hallo Genesis, kannst du das hier finden?');
    assert(result.stage !== 'conversational-extended-greeting',
      'extended-greeting requires identity OR relational framing');
  });

});

run().catch(err => { console.error(err); process.exit(1); });
