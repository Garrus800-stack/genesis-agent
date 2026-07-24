'use strict';
// v7.9.28 field-fix #3 — deterministic folder listing, file reading, file
// creation.
//
// The field (kimi-k2.7-code:cloud) showed the LLM chat-path could not reliably
// list a folder ("wieviele datein sind im ordner" → a shell tool echoed only
// the command), read a file by name on the OneDrive desktop ("was steht im
// Textdokument (neu) (6) auf dem desktop" → path syntax error), read the
// last-opened file ("was steht da drin" → the model called `cat`, absent on
// Windows), or create a file ("erstelle ein text dokument …" → shell-task
// slash gate). These are now deterministic command handlers that touch the
// filesystem straight through fs — no LLM, no shell, no path quoting — and
// resolve names on Desktop/Documents/... searching both the plain and the
// OneDrive-redirected base. Summaries ("fasse X zusammen") stay on the LLM path.
const os = require('os');
const fs = require('fs');
const path = require('path');

// Fake home BEFORE requiring the handler so _resolveLocationName sees it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-f3home-'));
const realHomedir = os.homedir;
os.homedir = () => home;

const { commandHandlersFileView: _HF } = require(path.join(__dirname, '..', '..', 'src/agent/hexagonal/CommandHandlersFileView'));
const { commandHandlersCreate: _HC } = require(path.join(__dirname, '..', '..', 'src/agent/hexagonal/CommandHandlersCreate')); // v7.9.45: createFile moved (module 438)
const H = { ..._HF, ..._HC };
const { IntentRouter } = require(path.join(__dirname, '..', '..', 'src/agent/intelligence/IntentRouter'));
const { setLastDoc, clearLastDoc, getLastDoc } = require(path.join(__dirname, '..', '..', 'src/agent/hexagonal/LastDocStore'));

// OneDrive-redirected desktop layout (as on the field Windows machine).
const odDesk = path.join(home, 'OneDrive', 'Desktop');
fs.mkdirSync(odDesk, { recursive: true });
fs.writeFileSync(path.join(odDesk, 'Textdokument (neu) (6).txt'), 'Das ist der Testinhalt.\nZeile zwei.');
fs.writeFileSync(path.join(odDesk, 'Bericht.txt'), 'Berichtstext');
const nordner = path.join(odDesk, 'Neuer Ordner (8)');
fs.mkdirSync(nordner);
fs.writeFileSync(path.join(nordner, 'a.txt'), 'x');
fs.writeFileSync(path.join(nordner, 'b.md'), 'y');
fs.mkdirSync(path.join(nordner, 'sub'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-f3root-'));
const ctx = Object.assign(Object.create(H), { fp: { rootDir: root } });

let passed = 0, failed = 0;
function ok(label, cond) { if (cond) passed++; else { failed++; console.log('    \u274c ' + label); } }

const router = new IntentRouter({});
function routes(message, expected) {
  ok(`route "${message}" → ${expected}`, router.classify(message).type === expected);
}

(async () => {
  // ---- routing: the exact field inputs land on deterministic handlers ----
  routes('wieviele datein sind im ordner', 'list-folder');
  routes('wieviele dateien sind im ordner', 'list-folder');
  routes('welche dateien', 'list-folder');
  routes('welche datein sind enthalten', 'list-folder');
  routes('was ist da drin', 'list-folder');
  routes('liste den inhalt', 'list-folder');
  routes('was steht im Textdokument (neu) (6) auf dem desktop', 'read-file');
  routes('was steht in package.json', 'read-file');
  routes('was steht da drin', 'read-file');
  routes('lies die datei readme', 'read-file');
  routes('erstelle ein text dokument mit namen x und inhalt test in genesis ordner', 'create-file');
  routes('erstelle mir eine datei namens todo', 'create-file');
  routes('schreibe eine textdatei mit namen log', 'create-file');
  // summaries and opens must NOT be captured by the new intents
  routes('fasse ONTOGENESIS.md zusammen', 'summarize-file'); // v7.9.28 r2: now deterministic
  routes('öffne firefox', 'open-path');
  routes('öffne auf dem desktop Batocera', 'open-path');
  routes('zeig mir den inhalt von foo/bar', 'open-path');
  routes('erstelle einen klon von dir', 'general');
  routes('welche version', 'general');

  // ---- _resolveLocationName: OneDrive base + extension-insensitive match ----
  ok('resolve "Textdokument (neu) (6)" → .txt on OneDrive desktop',
    H._resolveLocationName('was steht im Textdokument (neu) (6) auf dem desktop') === path.join(odDesk, 'Textdokument (neu) (6).txt'));
  ok('resolve "Bericht" → Bericht.txt',
    H._resolveLocationName('lies Bericht auf dem desktop') === path.join(odDesk, 'Bericht.txt'));
  ok('resolve folder "Neuer Ordner (8)"',
    H._resolveLocationName('öffne Neuer Ordner (8) auf dem desktop') === nordner);
  ok('resolve listing "wieviele dateien sind im Neuer Ordner (8) auf dem desktop"',
    H._resolveLocationName('wieviele dateien sind im Neuer Ordner (8) auf dem desktop') === nordner);
  ok('resolve without location → null',
    H._resolveLocationName('was steht in package.json') === null);

  // ---- readFile ----
  clearLastDoc(); setLastDoc(path.join(odDesk, 'Textdokument (neu) (6).txt'), 'file');
  let r = await H.readFile.call(ctx, 'was steht da drin');
  ok('readFile anaphora reads last-opened file', /Testinhalt/.test(r) && /Zeile zwei/.test(r));

  clearLastDoc();
  r = await H.readFile.call(ctx, 'was steht im Textdokument (neu) (6) auf dem desktop');
  ok('readFile named+location reads desktop file', /Testinhalt/.test(r));

  clearLastDoc();
  r = await H.readFile.call(ctx, '"' + path.join(odDesk, 'Bericht.txt') + '"');
  ok('readFile quoted absolute path', /Berichtstext/.test(r));

  clearLastDoc(); setLastDoc(nordner, 'folder');
  r = await H.readFile.call(ctx, 'was steht da drin');
  ok('readFile on a folder → listing hint', /Ordner/.test(r) && /liste sie auf|wieviele/.test(r));

  fs.writeFileSync(path.join(odDesk, 'leer.txt'), '');
  clearLastDoc(); setLastDoc(path.join(odDesk, 'leer.txt'), 'file');
  r = await H.readFile.call(ctx, 'was steht da drin');
  ok('readFile empty file note', /leer/.test(r));

  fs.writeFileSync(path.join(odDesk, 'gross.txt'), 'A'.repeat(9000));
  clearLastDoc(); setLastDoc(path.join(odDesk, 'gross.txt'), 'file');
  r = await H.readFile.call(ctx, 'was steht da drin');
  ok('readFile large file truncated + summary hint', /gekürzt/.test(r) && /fasse gross.txt zusammen/.test(r));

  clearLastDoc(); setLastDoc(path.join(home, '.ssh', 'id_rsa'), 'file');
  r = await H.readFile.call(ctx, 'was steht da drin');
  ok('readFile blocks .ssh/id_rsa (secret guard)', /geschützt/.test(r));

  // ---- listFolder ----
  clearLastDoc(); setLastDoc(nordner, 'folder');
  r = await H.listFolder.call(ctx, 'welche datein sind im ordner');
  ok('listFolder anaphora lists last-opened folder (2 files, 1 subdir)',
    /Dateien \(2\)/.test(r) && /Unterordner \(1\)/.test(r) && /a\.txt/.test(r));

  clearLastDoc();
  r = await H.listFolder.call(ctx, 'welche dateien sind im Neuer Ordner (8) auf dem desktop');
  ok('listFolder named+location', /Dateien \(2\)/.test(r));

  clearLastDoc();
  r = await H.listFolder.call(ctx, 'liste den inhalt "' + nordner + '"');
  ok('listFolder quoted path', /Dateien \(2\)/.test(r));

  clearLastDoc();
  r = await H.listFolder.call(ctx, 'wieviele dateien sind im ordner');
  ok('listFolder without a folder → prompt', /Welchen Ordner/.test(r));

  // ---- createFile (safe, guarded, no overwrite) ----
  r = await H.createFile.call(ctx, 'erstelle ein text dokument mit namen x und inhalt test in genesis ordner');
  ok('createFile writes x.txt in project root with content',
    /Datei erstellt/.test(r) && fs.existsSync(path.join(root, 'x.txt')) && fs.readFileSync(path.join(root, 'x.txt'), 'utf8') === 'test');
  ok('createFile sets last-doc to the new file',
    getLastDoc() && getLastDoc().path === path.join(root, 'x.txt'));

  r = await H.createFile.call(ctx, 'erstelle eine textdatei mit namen notiz und inhalt hallo welt auf dem desktop');
  ok('createFile writes to OneDrive desktop with multi-word content',
    fs.existsSync(path.join(odDesk, 'notiz.txt')) && fs.readFileSync(path.join(odDesk, 'notiz.txt'), 'utf8') === 'hallo welt');

  r = await H.createFile.call(ctx, 'erstelle ein text dokument mit namen x und inhalt test in genesis ordner');
  ok('createFile refuses to overwrite an existing file', /existiert bereits/.test(r));

  r = await H.createFile.call(ctx, 'erstelle mir eine datei namens todo');
  ok('createFile defaults to .txt and project root', fs.existsSync(path.join(root, 'todo.txt')));

  r = await H.createFile.call(ctx, 'erstelle eine datei');
  ok('createFile without a name asks for one', /heißen/.test(r));

  // cleanup
  os.homedir = realHomedir;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.28 field-fix #3 file view/create');
  process.exit(failed > 0 ? 1 : 0);
})();
