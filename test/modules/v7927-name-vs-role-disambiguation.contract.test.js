// ============================================================
// v7.9.27 — name vs. role disambiguation in fact extraction.
//
// "ich bin X" / "i am X" were the only user.role patterns and every match
// went to user.role. So "ich bin Daniel" stored user.role = "Daniel", and
// getUserName() — which reads user.name — returned null: the agent never
// learned the user's name. Self-reference matches are now classified. A
// name routes to user.name, a role/state ("Entwickler", "müde") to
// user.role, and the two slots never cross.
// ============================================================

'use strict';

const path = require('path');
const { describe, test, run, assert, assertEqual } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const { LearningService } = require(path.join(ROOT, 'src/agent/hexagonal/LearningService'));

function fakeMemory(seed = {}) {
  const semantic = {};
  for (const [k, v] of Object.entries(seed)) semantic[k] = { value: v };
  return {
    semantic,
    learnFact(key, value) { semantic[key] = { value }; return true; },
    getUserName() { return semantic['user.name']?.value || null; },
  };
}

function makeLS(memory) {
  const bus = { emit() {}, fire() {}, on() { return () => {}; } };
  return new LearningService({ bus, memory });
}

describe('v7.9.27 — name vs. role disambiguation', () => {
  test('a self-introduction stores the name in user.name, not user.role', () => {
    const mem = fakeMemory();
    makeLS(mem)._extractFacts('Hallo Genesis, ich bin Daniel.');
    assertEqual(mem.semantic['user.name']?.value, 'Daniel');
    assert(!mem.semantic['user.role'], 'name must not land in user.role');
  });

  test('getUserName() now finds the introduced name', () => {
    const mem = fakeMemory();
    makeLS(mem)._extractFacts('ich bin Daniel');
    assertEqual(mem.getUserName(), 'Daniel');
  });

  test('a profession is still stored as user.role', () => {
    const mem = fakeMemory();
    makeLS(mem)._extractFacts('ich bin Entwickler');
    assertEqual(mem.semantic['user.role']?.value, 'Entwickler');
    assert(!mem.semantic['user.name'], 'a role must not become the name');
  });

  test('a transient state is not mistaken for a name', () => {
    const mem = fakeMemory();
    makeLS(mem)._extractFacts('ich bin müde');
    assert(!mem.semantic['user.name'], 'a state must not become the name');
    assertEqual(mem.semantic['user.role']?.value, 'müde');
  });

  test('filler after "ich bin" is skipped (v7.2.8 guard preserved)', () => {
    const mem = fakeMemory();
    makeLS(mem)._extractFacts('ich bin oft');
    assert(!mem.semantic['user.name'] && !mem.semantic['user.role'], 'no fact from filler');
  });

  test('once the name is known, a role still records without clobbering it', () => {
    const mem = fakeMemory({ 'user.name': 'Daniel' });
    makeLS(mem)._extractFacts('ich bin Entwickler');
    assertEqual(mem.semantic['user.name']?.value, 'Daniel', 'established name is preserved');
    assertEqual(mem.semantic['user.role']?.value, 'Entwickler');
  });

  test('repeating the known name causes no churn', () => {
    const mem = fakeMemory({ 'user.name': 'Daniel' });
    makeLS(mem)._extractFacts('ich bin Daniel');
    assertEqual(mem.semantic['user.name']?.value, 'Daniel');
    assert(!mem.semantic['user.role'], 'the name is not duplicated into user.role');
  });

  test('English self-reference routes the same way', () => {
    const memName = fakeMemory();
    makeLS(memName)._extractFacts("i'm Sarah");
    assertEqual(memName.semantic['user.name']?.value, 'Sarah');

    const memRole = fakeMemory();
    makeLS(memRole)._extractFacts('i am tired');
    assert(!memRole.semantic['user.name'], 'state not stored as name');
    assertEqual(memRole.semantic['user.role']?.value, 'tired');
  });
});

if (require.main === module) run();
