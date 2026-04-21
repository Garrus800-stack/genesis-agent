// Test: tool-call verification gate (v7.3.5 commit 7)
// Detects when Genesis claims action in prose but no tool call actually fired.
const { describe, test, run } = require('../harness');
const {
  verifyToolClaims,
  detectHallucinatedClaims,
  hasGeneralActionClaim,
  formatVerificationNote,
} = require('../../src/agent/core/tool-call-verification');

describe('detectHallucinatedClaims — category mismatches', () => {
  test('claiming file-write without file-write tool is flagged', () => {
    const response = 'Ich habe die Datei als error-handler.js gespeichert.';
    const flags = detectHallucinatedClaims(response, []);
    if (flags.length === 0) throw new Error('should flag file-write claim');
    if (flags[0].category !== 'file-write') throw new Error('should identify file-write category');
  });

  test('claiming file-write WITH file-write tool is NOT flagged', () => {
    const response = 'Ich habe die Datei als error-handler.js gespeichert.';
    const flags = detectHallucinatedClaims(response, [{ name: 'file-write' }]);
    if (flags.length !== 0) throw new Error('tool fired, should not flag: ' + JSON.stringify(flags));
  });

  test('claiming shell execution without shell tool is flagged', () => {
    const response = 'Ich habe npm test ausgeführt und alles ist grün.';
    const flags = detectHallucinatedClaims(response, []);
    if (flags.length === 0) throw new Error('should flag shell claim');
    if (flags[0].category !== 'shell') throw new Error('should identify shell category');
  });

  test('claiming shell WITH shell tool is NOT flagged', () => {
    const response = 'Ich habe npm test ausgeführt und alles ist grün.';
    const flags = detectHallucinatedClaims(response, [{ name: 'shell' }]);
    if (flags.length !== 0) throw new Error('tool fired, should not flag');
  });

  test('English: claiming file save without tool is flagged', () => {
    const response = 'I saved the file to config.json successfully.';
    const flags = detectHallucinatedClaims(response, []);
    if (flags.length === 0) throw new Error('English claim should be detected');
  });

  test('test claims without sandbox tool are flagged', () => {
    const response = 'Die Tests sind alle gelaufen und grün.';
    const flags = detectHallucinatedClaims(response, []);
    if (flags.length === 0) throw new Error('test claim should be flagged');
  });
});

describe('hasGeneralActionClaim', () => {
  test('detects German concrete past-tense action', () => {
    const { hasActionClaim } = hasGeneralActionClaim('Ich habe den Plan angelegt und gestartet.');
    if (!hasActionClaim) throw new Error('should detect');
  });

  test('detects English concrete past-tense action', () => {
    const { hasActionClaim } = hasGeneralActionClaim('I created the file for you.');
    if (!hasActionClaim) throw new Error('should detect');
  });

  test('does NOT detect capability statements', () => {
    const { hasActionClaim } = hasGeneralActionClaim('Ich kann die Datei für dich erstellen.');
    if (hasActionClaim) throw new Error('"ich kann" is capability not action');
  });

  test('does NOT detect future intent', () => {
    const { hasActionClaim } = hasGeneralActionClaim('Ich werde die Tests durchführen.');
    if (hasActionClaim) throw new Error('future intent is not a completed action');
  });

  test('does NOT detect questions', () => {
    const { hasActionClaim } = hasGeneralActionClaim('Soll ich die Datei speichern?');
    if (hasActionClaim) throw new Error('question is not a claim');
  });

  test('does NOT detect empty or null', () => {
    if (hasGeneralActionClaim('').hasActionClaim) throw new Error('empty');
    if (hasGeneralActionClaim(null).hasActionClaim) throw new Error('null');
  });
});

describe('verifyToolClaims — full pipeline', () => {
  test('normal conversation with no claims → verified', () => {
    const result = verifyToolClaims('Interessante Frage. Lass uns das anschauen.', []);
    if (result.verdict !== 'verified') throw new Error('expected verified, got ' + result.verdict);
  });

  test('action claim + matching tool → verified', () => {
    const result = verifyToolClaims(
      'Ich habe die Datei error.js gespeichert.',
      [{ name: 'file-write' }]
    );
    if (result.verdict !== 'verified') throw new Error('matched tool should verify');
  });

  test('action claim + no matching tool → suspicious', () => {
    const result = verifyToolClaims(
      'Ich habe npm test ausgeführt und die Tests laufen grün.',
      [{ name: 'file-read' }]  // different tool — not in shell category
    );
    if (result.verdict !== 'suspicious') throw new Error('expected suspicious, got ' + result.verdict);
    if (result.flags.length === 0) throw new Error('should have flags');
  });

  test('general claim + no tools at all → unverified', () => {
    const result = verifyToolClaims('Ich habe den Plan angelegt und gestartet.', []);
    if (result.verdict !== 'unverified') throw new Error('expected unverified, got ' + result.verdict);
  });

  test('capability statement + no tools → verified (no claim)', () => {
    const result = verifyToolClaims('Ich kann die Datei für dich erstellen.', []);
    if (result.verdict !== 'verified') throw new Error('capability ≠ claim');
  });
});

describe('formatVerificationNote', () => {
  test('empty for verified', () => {
    const note = formatVerificationNote({ verdict: 'verified', flags: [] });
    if (note !== '') throw new Error('verified should emit nothing');
  });

  test('brief annotation for suspicious', () => {
    const note = formatVerificationNote({
      verdict: 'suspicious',
      flags: [{ category: 'shell', match: 'npm test', expectedTools: ['shell'] }],
    });
    if (!note.includes('shell')) throw new Error('should mention category');
    if (note.length > 250) throw new Error('too long');
  });

  test('brief annotation for unverified', () => {
    const note = formatVerificationNote({
      verdict: 'unverified',
      flags: [{ category: 'general', match: 'Ich habe X gemacht', expectedTools: [] }],
    });
    if (!note.includes('verifizi')) throw new Error('should ask to verify');
  });
});

run();
