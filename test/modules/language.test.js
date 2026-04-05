// ============================================================
// TEST — Language.js (v6.0.1)
// ============================================================

const { describe, test, run } = require('../harness');

// Language is a singleton — we need to require fresh each time
function freshLang() {
  const mod = require('../../src/agent/core/Language');
  const lang = mod.lang || mod;
  return lang;
}

describe('Language', () => {
  test('default language is en', () => {
    const lang = freshLang();
    if (lang.get() !== 'en') throw new Error(`Expected en, got ${lang.get()}`);
  });

  test('detect identifies German text', () => {
    const lang = freshLang();
    lang.detect('Erstelle eine REST API für mich bitte');
    lang.detect('Kannst du mir helfen?');
    lang.detect('Ich möchte das Projekt verbessern');
    // After multiple German messages, should switch
    const current = lang.get();
    if (current !== 'de') throw new Error(`Expected de after German input, got ${current}`);
  });

  test('detect identifies English text', () => {
    const lang = freshLang();
    lang.set('en');
    lang.detect('Please create a REST API for me');
    if (lang.get() !== 'en') throw new Error('Should stay en for English input');
  });

  test('set forces language', () => {
    const lang = freshLang();
    lang.set('de');
    if (lang.get() !== 'de') throw new Error('set() should force language');
    lang.set('en');
    if (lang.get() !== 'en') throw new Error('set() should force back');
  });

  test('t translates known keys', () => {
    const lang = freshLang();
    lang.set('en');
    const result = lang.t('ui.ready');
    if (!result || result === 'ui.ready') throw new Error('Should translate known key');
  });

  test('t returns key for unknown keys', () => {
    const lang = freshLang();
    const result = lang.t('nonexistent.key.xyz');
    if (result !== 'nonexistent.key.xyz') throw new Error('Should return key for unknown translations');
  });

  test('t interpolates variables', () => {
    const lang = freshLang();
    lang.set('en');
    // Find a key that uses interpolation
    const result = lang.t('mcp.connecting', { name: 'TestServer' });
    if (result.includes('{{name}}')) throw new Error('Should interpolate {{name}}');
    if (!result.includes('TestServer')) throw new Error('Should contain interpolated value');
  });

  test('detect ignores very short text', () => {
    const lang = freshLang();
    lang.set('en');
    lang.detect('hi');
    if (lang.get() !== 'en') throw new Error('Should not change for short text');
  });

  test('getUIStrings returns object with _lang', () => {
    const lang = freshLang();
    lang.set('en');
    const strings = lang.getUIStrings();
    if (typeof strings !== 'object') throw new Error('Should return object');
    if (strings._lang !== 'en') throw new Error('Should include _lang');
  });
});

if (require.main === module) run();
