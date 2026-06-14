'use strict';
// v7.9.22 Item 11 — the autonomous-work patterns no longer over-match a conversational
// message: the qualifier must sit near the verb (bounded gap), the verb is "arbeite(n/st)"
// not the noun "arbeit", word boundaries reject inflected/embedded forms, and the English
// side needs the adverb. The test imports the shared arrays so it cannot drift from the
// producer.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
const { AGENT_GOAL_PATTERNS, AGENT_GOAL_FUZZY } = require(path.join(ROOT, 'src/agent/autonomy/AgentGoalPatterns'));
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }
const matches = (s) => AGENT_GOAL_PATTERNS.some((re) => re.test(s));

test('conversational / inflected / embedded messages do NOT match', () => {
  for (const s of [
    'wir arbeiten an autonomen Systemen',
    'das Dokument bearbeiten und alleine entscheiden',
    'framework operates independently',
    "let's work on autonomous systems",
    'danke fuer alles, den Rest mache ich allein',
  ]) {
    assert.ok(!matches(s), `must not match: "${s}"`);
  }
});
test('genuine autonomous-work requests still match', () => {
  for (const s of [
    'arbeite autonom an X',
    'arbeite bitte autonom an X',
    'work fully autonomously',
    'operate independently',
  ]) {
    assert.ok(matches(s), `must match: "${s}"`);
  }
});
test('the fuzzy keyword list drops the high-frequency casual words', () => {
  assert.ok(!AGENT_GOAL_FUZZY.includes('alleine'), 'alleine removed');
  assert.ok(!AGENT_GOAL_FUZZY.includes('alone'), 'alone removed');
  assert.ok(AGENT_GOAL_FUZZY.includes('autonom'), 'kept the strong keywords');
});
test('the producer imports the shared arrays (no drift)', () => {
  const boot = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreBoot.js'), 'utf8');
  assert.ok(/AGENT_GOAL_PATTERNS/.test(boot) && /AGENT_GOAL_FUZZY/.test(boot), 'producer uses the shared module');
});

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 Item 11 intent-overmatch');
process.exit(failed > 0 ? 1 : 0);
