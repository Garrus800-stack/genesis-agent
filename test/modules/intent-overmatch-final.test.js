// Test: IntentRouter overmatch final sweep (v7.3.5 commit 6)
// Extends commit 2's slash-audit to the remaining handlers that were matching
// too aggressively on keyword fragments in free text.
const { describe, test, run } = require('../harness');
const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter');
const router = new IntentRouter({ model: null });
function classify(msg) { return router.classify(msg).type; }

describe('daemon: no more catch-all /autonom/i', () => {
  test('/daemon routes', () => {
    if (classify('/daemon') !== 'daemon') throw new Error('slash should route');
  });

  test('explicit "start daemon" works', () => {
    if (classify('start the daemon') !== 'daemon') throw new Error('imperative should work');
  });

  test('"wie autonom bist du?" falls through to general', () => {
    const got = classify('wie autonom bist du?');
    if (got === 'daemon') throw new Error('conversational autonomy question routed to daemon: ' + got);
  });

  test('"ist der hintergrund aktiv?" falls through', () => {
    const got = classify('ist der hintergrund noch aktiv?');
    if (got === 'daemon') throw new Error('hintergrund word routed to daemon: ' + got);
  });

  test('"your autonomy is fascinating" falls through', () => {
    const got = classify('your autonomy is fascinating');
    if (got === 'daemon') throw new Error('should not hit daemon: ' + got);
  });
});

describe('clone: imperative-only', () => {
  test('/clone routes', () => {
    if (classify('/clone') !== 'clone') throw new Error('slash should route');
  });

  test('"klone dich" routes', () => {
    if (classify('klone dich') !== 'clone') throw new Error('imperative should work');
  });

  test('"create a clone" routes', () => {
    if (classify('create a clone') !== 'clone') throw new Error('imperative should work');
  });

  test('"klonen der Stimme ist ein thema" falls through', () => {
    const got = classify('klonen der Stimme ist ein interessantes Thema');
    if (got === 'clone') throw new Error('free-text klon should not route: ' + got);
  });

  test('"eine kopie davon wäre nett" falls through', () => {
    const got = classify('eine kopie davon wäre nett');
    if (got === 'clone') throw new Error('kopie keyword was removed: ' + got);
  });
});

describe('analyze-code: imperative-only', () => {
  test('/analyze-code routes', () => {
    if (classify('/analyze-code') !== 'analyze-code') throw new Error('slash should route');
  });

  test('"analysiere den code" routes', () => {
    if (classify('analysiere den code') !== 'analyze-code') throw new Error('imperative should work');
  });

  test('"ich analysiere gerade" falls through', () => {
    const got = classify('ich analysiere gerade meinen code manuell');
    // Self-reference not a command
    if (got === 'analyze-code') throw new Error('self-reference should not route: ' + got);
  });

  test('"hast du eine review für mich?" falls through', () => {
    const got = classify('hast du eine review für mich?');
    if (got === 'analyze-code') throw new Error('review question should not route: ' + got);
  });

  test('"bewerte bitte meinen vorschlag" falls through', () => {
    const got = classify('bewerte bitte meinen vorschlag zu der Strategie');
    if (got === 'analyze-code') throw new Error('bewerten without "code" should not route: ' + got);
  });
});

describe('peer: narrowed', () => {
  test('/peer routes', () => {
    if (classify('/peer') !== 'peer') throw new Error('slash should route');
  });

  test('"scan peer network" routes', () => {
    if (classify('scan the peer network') !== 'peer') throw new Error('imperative should work');
  });

  test('"peer review this code" falls through (not a peer-network command)', () => {
    const got = classify('peer review this code please');
    if (got === 'peer') throw new Error('peer-review is not peer-network: ' + got);
  });

  test('"andere agenten sind fremdes terrain" falls through', () => {
    const got = classify('andere agenten sind fremdes terrain für mich');
    if (got === 'peer') throw new Error('free-text should not route: ' + got);
  });
});

describe('create-skill: no overbroad faehigkeit', () => {
  test('/create-skill routes', () => {
    if (classify('/create-skill') !== 'create-skill') throw new Error('slash should route');
  });

  test('"create a new skill" routes', () => {
    if (classify('create a new skill for this') !== 'create-skill') throw new Error('imperative should work');
  });

  test('"ich habe die Fähigkeit zu Y" falls through', () => {
    const got = classify('ich habe die Fähigkeit zu dieser Aufgabe');
    if (got === 'create-skill') throw new Error('noun use of Fähigkeit should not route: ' + got);
  });

  test('"die Erweiterung ist fragwürdig" falls through', () => {
    const got = classify('die Erweiterung von Feature X ist fragwürdig');
    if (got === 'create-skill') throw new Error('Erweiterung in discussion should not route: ' + got);
  });
});

run();
