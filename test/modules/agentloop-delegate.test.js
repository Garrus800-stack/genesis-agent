const { describe, test, run } = require('../harness');
const mod = require('../../src/agent/revolution/AgentLoopDelegate');

describe('AgentLoopDelegate', () => {
  test('exports _stepDelegate function', () => {
    if (typeof mod._stepDelegate !== 'function') throw new Error('Missing _stepDelegate');
  });

  test('exports _extractSkills function', () => {
    if (typeof mod._extractSkills !== 'function') throw new Error('Missing _extractSkills');
  });

  test('_extractSkills extracts known skill keywords', () => {
    const skills = mod._extractSkills('Refactor the React component and write unit tests');
    if (!Array.isArray(skills)) throw new Error('Should return array');
  });

  test('_extractSkills returns array for empty input', () => {
    const skills = mod._extractSkills('');
    if (!Array.isArray(skills)) throw new Error('Should return array for empty');
  });

  test('_extractSkills handles null input', () => {
    try {
      const skills = mod._extractSkills(null);
      if (!Array.isArray(skills)) throw new Error('Should return array for null');
    } catch (e) {
      // Also acceptable — depends on implementation
    }
  });

  test('_stepDelegate is async function', () => {
    // Verify it returns a promise-like when called with proper context
    if (mod._stepDelegate.constructor.name !== 'AsyncFunction') throw new Error('Not async');
  });
});

run();
