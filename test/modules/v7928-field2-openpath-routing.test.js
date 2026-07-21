'use strict';
// v7.9.28 field-fix #2 — deterministic open-path routing.
//
// The second field run (Windows + OneDrive, deepseek-v3.2:cloud) showed that
// app launches, drive-scoped opens, and location-scoped opens all fell through
// to the fuzzy/LLM fallback, which was slow and inconsistent:
//   - "öffne firefox" bounced to the slash-only open-software intent ("/open").
//   - "öffne google chrome" hit the LLM, routed to open-path, then hung.
//   - "öffne in d: <ordner>" was mis-classified by the LLM as a file-search and
//     listed the project root instead of opening the folder on D:.
//   - "öffne auf dem desktop Batocera" only worked name-before-location.
//
// All of these must now be classified by REGEX as open-path so no LLM round
// trip is needed and openPath's own branches resolve the target.
const path = require('path');
const { IntentRouter } = require(path.join(__dirname, '..', '..', 'src/agent/intelligence/IntentRouter'));
const r = new IntentRouter({});

let passed = 0, failed = 0;
function eq(label, got, want) {
  if (got === want) { passed++; }
  else { failed++; console.log('    \u274c ' + label + ' \u2192 got ' + got + ', want ' + want); }
}

// (A) app launches → open-path (not the slash-only open-software)
for (const m of ['öffne firefox', 'öffne chrome', 'öffne google chrome',
                 'öffne mozilla firefox', 'open notepad.exe', 'öffne den editor',
                 'starte firefox', 'launch chrome']) {
  eq('app: ' + m, r.classify(m).type, 'open-path');
}

// (D) drive-scoped opens → open-path
for (const m of ['öffne in d: <ordner>', 'öffne auf d den ordner <ordner>',
                 'öffne d:', 'öffne in c projekte']) {
  eq('drive: ' + m, r.classify(m).type, 'open-path');
}

// (B) location-scoped opens → open-path, BOTH word orders
for (const m of ['öffne auf dem desktop Batocera', 'öffne Batocera auf dem desktop',
                 'öffne genesis-ordner auf dem desktop', 'öffne auf dem desktop den ordner Batocera']) {
  eq('loc: ' + m, r.classify(m).type, 'open-path');
}

// the explicit /open slash still reaches the robust open-software launcher
eq('/open firefox', r.classify('/open firefox').type, 'open-software');

// (guard) ordinary conversation must NOT bounce to open-path
for (const m of ['öffne dich mir gegenüber ein bisschen', 'open up to me about how you feel',
                 'starte den build', 'run the lint script', 'build the project']) {
  const t = r.classify(m).type;
  if (t === 'open-path') { failed++; console.log('    \u274c conversation bounced to open-path [' + t + ']: ' + m); }
  else { passed++; }
}

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.28 field-fix #2 open-path routing');
process.exit(failed > 0 ? 1 : 0);
