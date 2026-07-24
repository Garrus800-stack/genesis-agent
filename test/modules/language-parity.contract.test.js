#!/usr/bin/env node
// GENESIS — v7.9.45 field law: WHAT WORKS IN GERMAN WORKS IN ENGLISH — AND IN
// FRENCH AND SPANISH. The partner's rule, spoken a thousand times, pinned
// once and forever: every deterministic spoken road routes IDENTICALLY in
// all four locales. A new intent that speaks only one language breaks this
// suite before it ever reaches the field.
'use strict';
const { describe, test, assert, run } = require('../harness');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const defs = require(path.join(ROOT, 'src/agent/intelligence/IntentPatterns.js')).INTENT_DEFINITIONS;
const hit = (t) => { for (const d of defs) { if (d[1].some((r) => r.test(t))) return d[0]; } return null; };

const MATRIX = [
  ['lab-run', 'F\u00fchre im Labor diesen Code aus: x', 'run this in the lab: x', 'ex\u00e9cute \u00e7a dans le labo: x', 'ejecuta esto en el laboratorio: x'],
  ['read-file', 'was steht in x22', 'what does x22 say', 'que dit x22', 'qu\u00e9 dice x22'],
  ['read-file', 'lies inbox/x22.pdf', 'read inbox/x22.pdf', 'lis inbox/x22.pdf', 'lee inbox/x22.pdf'],
  ['read-file', 'zeig mir readme.md', 'show me readme.md', 'montre-moi readme.md', 'mu\u00e9strame readme.md'],
  ['read-file', 'was ist der inhalt von readme.md', 'what is the content of readme.md', 'quel est le contenu de readme.md', 'cu\u00e1l es el contenido de readme.md'],
  ['summarize-file', 'fasse readme.md zusammen', 'summarize readme.md', 'r\u00e9sume readme.md', 'resume readme.md'],
  ['open-path', '\u00f6ffne den ordner D:/Tools', 'open the folder D:/Tools', 'ouvre le dossier D:/Tools', 'abre la carpeta D:/Tools'],
  ['create-file', 'erstelle eine datei notiz.md', 'create a file notes.md', 'cr\u00e9e un fichier note.md', 'crea un archivo nota.md'],
  ['vault-lookup', 'schau in meinen zettelkasten: was ist x', 'look in my vault: what is x', 'regarde dans mon vault: x', 'mira en mi vault: x'],
  ['where-is', 'wo ist dein arbeitsbereich', 'where is your workspace', 'où est ton espace', 'dónde está tu espacio'],
  ['edit-file', 'ändere blau zu grün in meiner Notiz farbe', 'change blau to grün in my note farbe', 'remplace bleu par vert dans ma note farbe', 'cambia azul por verde en mi nota farbe'],
  ['read-file', 'was ist auf dem shot.png zu sehen', "what's on the shot.png", 'que voit-on sur shot.png', 'qué se ve en shot.png'],
  ['vault-set', 'Mein vault liegt in D:\\X', 'my vault is at D:\\X', 'mon vault est dans /x', 'mi vault está en /x'],
  ['list-folder', 'liste die dateien in docs auf', 'list the files in docs', 'liste les fichiers dans docs', 'lista los archivos en docs'],
];

describe('v7945 — four-language parity (the partner\u2019s law)', () => {
  for (const [expect, de, en, fr, es] of MATRIX) {
    test(`${expect}: DE = EN = FR = ES`, () => {
      const r = { de: hit(de), en: hit(en), fr: hit(fr), es: hit(es) };
      for (const [loc, got] of Object.entries(r)) {
        assert(got === expect, `${loc} "${loc === 'de' ? de : loc === 'en' ? en : loc === 'fr' ? fr : es}" \u2192 ${got} (expected ${expect})`);
      }
    });
  }

  test('no false triggers: everyday sentences stay off these roads', () => {
    assert(hit('resume the download') === null, 'EN "resume" (continue) must not summarize');
    assert(hit('open the door for me') === null, 'no folder word, no open-path');
    assert(hit('f\u00fchre diesen code aus: x') !== 'lab-run', 'everyday code never enters the lab uninvited');
    assert(hit('kaffee und milch holen') === null, 'the answer-form pattern stays narrow');
  });
});
run();
