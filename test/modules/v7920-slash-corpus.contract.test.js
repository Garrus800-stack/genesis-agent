'use strict';
// v7.9.20 (S1) — slash-discipline corpus. Two directions:
//  (a) ordinary conversation must NOT be classified as a slash-only intent
//      (no false "use a slash command" bounce), incl. German inflection that
//      embeds English command tokens (Ablauf→"lauf", Tests→"test", möchtest→"test");
//  (b) genuine shell/install/open requests (no slash) MUST land on the slash-only
//      intent so the hint fires — in BOTH German and English (EN parity).
const path = require('path');
const assert = require('assert');
const { IntentRouter } = require(path.join(__dirname, '..', '..', 'src/agent/intelligence/IntentRouter'));

const SLASH_ONLY = new Set(['shell-task', 'shell-run', 'install-software', 'open-software']);
const r = new IntentRouter({});

// (a) MUST NOT bounce — ordinary conversation
const CONVERSATION = [
  'Erzähl mir vom Ablauf des Tests',
  'Ich möchte den Verlauf der Tests sehen',
  'Was möchtest du als Nächstes bauen?',
  'setze mich bitte auf die Liste',
  'öffne dich mir gegenüber ein bisschen',
  'der Ablauf war reibungslos',
  'ich richte mich ganz nach dir',
  'wie war der Verlauf gestern?',
  'tell me about the test results please',
  'I was thinking about the build process',
  'open up to me about how you feel',
  'lass uns über den Build reden',
];

// (b) MUST be slash-only — genuine requests (no slash → hint)
const REQUESTS = [
  'installiere firefox',
  'install the dependencies',
  'führe die tests aus',
  'starte den build',
  'öffne den browser',
  'open notepad.exe',
  'run the lint script',
  'npm install express',
  'git status',
  'öffne den editor',
  'lade firefox runter',
  'build the project',
];

let passed = 0, failed = 0;
function check(label, cond) { if (cond) { passed++; } else { console.log('    \u274c ' + label); failed++; } }

let falseBounces = 0;
for (const s of CONVERSATION) {
  const t = r.classify(s).type;
  const ok = !SLASH_ONLY.has(t);
  if (!ok) { falseBounces++; console.log('    \u274c false bounce ['+t+']: ' + s); }
}
check('(a) zero false bounces on conversation ('+falseBounces+'/'+CONVERSATION.length+')', falseBounces === 0);

let missed = 0;
for (const s of REQUESTS) {
  const t = r.classify(s).type;
  const ok = SLASH_ONLY.has(t);
  if (!ok) { missed++; console.log('    \u274c missed real request ['+t+']: ' + s); }
}
check('(b) zero missed real requests ('+missed+'/'+REQUESTS.length+')', missed === 0);

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.20 slash corpus');
process.exit(failed > 0 ? 1 : 0);
