'use strict';
// v7.9.28 field-fix #3 (round 2) — follow-up fixes from a second field log.
//
// The field (kimi-k2.7-code:cloud) showed: (1) "fasse ONTOGENESIS zusammen"
// (no extension) made the model announce "Ich lese die Datei…" and stop, then
// summarise only part and ask whether to continue — the user should never have
// to say "ja"/"weiter"; (2) "was ist in dem dokument x1" fell to the LLM which
// hallucinated content on an empty file; (3) createFile made an EMPTY file for
// "… der text in dem dokument ist test" because only "inhalt X" was parsed;
// (4) "wieviele" dumped the whole list instead of a count; (5) "öffne den
// ordner X auf D:" (name before drive) opened D:\ root.
//
// Fixes verified here: a deterministic summarizeFile handler (one LLM call, no
// tool loop → no announce-and-wait, no partial), read-file routing for "was ist
// in <datei>" + bare-name resolution + real empty content, broadened createFile
// content parsing, count-vs-list output, and summarize/read routing. The drive
// word-order fix lives in openPath's win32-only branch; its routing is checked
// here and its extraction is unit-tested in CommandHandlersShell.
const os = require('os');
const fs = require('fs');
const path = require('path');

const { commandHandlersFileView: H } = require(path.join(__dirname, '..', '..', 'src/agent/hexagonal/CommandHandlersFileView'));
const { IntentRouter } = require(path.join(__dirname, '..', '..', 'src/agent/intelligence/IntentRouter'));
const { setLastDoc, clearLastDoc } = require(path.join(__dirname, '..', '..', 'src/agent/hexagonal/LastDocStore'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-f3b-'));
fs.mkdirSync(path.join(root, 'docs'));
fs.writeFileSync(path.join(root, 'docs', 'ONTOGENESIS.md'), '# Ontogenesis\n\nGenesis ist ein Substrat.\n'.repeat(40));
fs.writeFileSync(path.join(root, 'notiz.txt'), 'Ein kurzer Notiz-Text.');

const r = new IntentRouter({});
let passed = 0, failed = 0;
const ok = (label, cond) => { if (cond) { passed++; } else { failed++; console.log('  \u2717 ' + label); } };
const routes = (msg, type) => ok(`route: "${msg}" -> ${type}`, r.classify(msg).type === type);

// mock model bridge (the real LLM call runs on the user's machine)
let lastCall = null;
const bridge = { chat: async (sys, msgs, tt, opts) => { lastCall = { sys, msgs, tt, opts }; return 'Zusammenfassung: Genesis ist ein Substrat.'; } };
const ctx = (over = {}) => Object.assign(Object.create(H), { fp: { rootDir: root }, lang: { detect: () => 'de' }, modelBridge: bridge, ...over });

(async () => {
  // ---- routing ----
  routes('fasse ONTOGENESIS zusammen', 'summarize-file');
  routes('fasse ONTOGENESIS.md zusammen', 'summarize-file');
  routes('fasse das zusammen', 'summarize-file');
  routes('kannst du package.json zusammenfassen', 'summarize-file');
  routes('summarize README', 'summarize-file');
  routes('was ist in dem dokument x1', 'read-file');
  routes('was ist der inhalt von x1', 'read-file');
  routes('was steht da drin', 'read-file');
  routes('welche datein sind im ordner', 'list-folder');
  routes('wieviele dateien sind drin', 'list-folder');
  routes('erstelle datei namens x der text ist a', 'create-file');
  routes('öffne den ordner GMxBGxx auf D:', 'open-path');
  routes('öffne auf d: den ordner GMxBGxx', 'open-path');

  // ---- summarizeFile handler: one deterministic call, no tool loop ----
  clearLastDoc();
  let out = await H.summarizeFile.call(ctx(), 'fasse ONTOGENESIS zusammen');
  ok('summarize named extensionless -> resolves docs/ONTOGENESIS.md', out && /Zusammenfassung von ONTOGENESIS\.md/.test(out));
  ok('summarize passes FULL content in a single user message', lastCall && lastCall.msgs.length === 1 && /Substrat/.test(lastCall.msgs[0].content));
  ok('summarize directive forbids ask/tool/announce', lastCall && /nicht nach|kein Werkzeug|direkt/i.test(lastCall.sys));
  ok('summarize uses the user-selected model', lastCall && lastCall.opts && lastCall.opts._userChat === true);

  clearLastDoc(); setLastDoc(path.join(root, 'notiz.txt'), 'file');
  out = await H.summarizeFile.call(ctx(), 'fasse das zusammen');
  ok('summarize anaphora "fasse das zusammen" -> last file', out && /Zusammenfassung von notiz\.txt/.test(out));

  clearLastDoc();
  fs.writeFileSync(path.join(root, 'leer.txt'), '');
  out = await H.summarizeFile.call(ctx(), 'fasse leer zusammen');
  ok('summarize empty file -> "leer" (no LLM call)', out && /leer/.test(out) && !/Zusammenfassung von/.test(out));

  clearLastDoc();
  out = await H.summarizeFile.call(ctx({ modelBridge: null }), 'fasse ONTOGENESIS zusammen');
  ok('summarize with no modelBridge -> null (falls back)', out === null);

  clearLastDoc();
  out = await H.summarizeFile.call(ctx({ modelBridge: { chat: async () => { throw new Error('500'); } } }), 'fasse ONTOGENESIS zusammen');
  ok('summarize on LLM error -> null (falls back)', out === null);

  clearLastDoc();
  out = await H.summarizeFile.call(ctx(), 'fasse gibtsnicht zusammen');
  ok('summarize unknown file + no last-doc -> null (falls back)', out === null);

  clearLastDoc();
  out = await H.summarizeFile.call(ctx({ lang: { detect: () => 'en' } }), 'summarize notiz');
  ok('summarize English -> English head + directive', out && /Summary of notiz\.txt/.test(out) && /English/.test(lastCall.sys));

  // ---- createFile content phrasings ----
  const mk = async (msg, file, exp) => {
    try { fs.rmSync(path.join(root, file)); } catch { /* fresh */ }
    await H.createFile.call(ctx(), msg);
    const got = fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : '<none>';
    ok(`createFile "${msg.slice(0, 40)}…" -> "${exp}"`, got === exp);
  };
  await mk('erstelle ein dokument mit namen c1 der text in dem dokument ist test', 'c1.txt', 'test');
  await mk('erstelle datei namens c2 der inhalt ist wichtig', 'c2.txt', 'wichtig');
  await mk('erstelle eine datei mit namen c3 und inhalt hallo welt', 'c3.txt', 'hallo welt');
  await mk('erstelle datei namens c4 mit text kurznotiz', 'c4.txt', 'kurznotiz');
  await mk('erstelle ein dokument namens c5 mit inhalt zeug in genesis ordner', 'c5.txt', 'zeug');

  // ---- readFile bare-name + real empty content (no hallucination) ----
  fs.writeFileSync(path.join(root, 'x1.txt'), 'test');
  clearLastDoc();
  out = await H.readFile.call(ctx(), 'was ist in dem dokument x1');
  ok('readFile "was ist in dem dokument x1" -> reads x1.txt', /Inhalt von x1\.txt/.test(out) && /test/.test(out));
  clearLastDoc();
  out = await H.readFile.call(ctx(), 'was ist der inhalt von x1');
  ok('readFile "was ist der inhalt von x1"', /test/.test(out));
  fs.writeFileSync(path.join(root, 'empty2.txt'), '');
  clearLastDoc();
  out = await H.readFile.call(ctx(), 'was ist in dem dokument empty2');
  ok('readFile empty file -> "leer" (not hallucinated)', /leer/.test(out));

  // ---- count vs list ----
  fs.mkdirSync(path.join(root, 'lf'));
  fs.writeFileSync(path.join(root, 'lf', 'a.txt'), 'x');
  fs.writeFileSync(path.join(root, 'lf', 'b.txt'), 'y');
  fs.mkdirSync(path.join(root, 'lf', 'sub'));
  clearLastDoc(); setLastDoc(path.join(root, 'lf'), 'folder');
  out = await H.listFolder.call(ctx(), 'wieviele dateien sind in dem ordner');
  ok('listFolder "wieviele" -> count, not full list', /sind 2 Dateien/.test(out) && !/a\.txt, b\.txt/.test(out));
  clearLastDoc(); setLastDoc(path.join(root, 'lf'), 'folder');
  out = await H.listFolder.call(ctx(), 'welche dateien sind drin');
  ok('listFolder "welche" -> full list', /Dateien \(2\): a\.txt, b\.txt/.test(out));

  // ---- English coverage (the handlers + routing must work in English too) ----
  const asyncRoutes = async (msg, type) => { const c = await r.classifyAsync(msg); ok(`EN route: "${msg}" -> ${type}`, c.type === type); };
  await asyncRoutes('which files are in the folder', 'list-folder');
  await asyncRoutes('how many files are in the folder', 'list-folder');
  await asyncRoutes('list the files', 'list-folder');
  await asyncRoutes("what's in the file readme", 'read-file');
  await asyncRoutes('read the file config', 'read-file');
  await asyncRoutes('what does readme say', 'read-file');
  await asyncRoutes('create a file named test with content hi', 'create-file');
  await asyncRoutes('create a file named api with content x', 'create-file'); // codegen-keyword name
  await asyncRoutes('summarize readme', 'summarize-file');

  // the "welche"/question-word bug: a file-view question must NOT be swallowed by
  // the conversational question-word gate (that sent it to the LLM/shell), while
  // genuine conversational questions must still be caught.
  const notConv = (msg) => ok(`file-view "${msg}" escapes conversational gate`, r._conversationalSignalsCheck(msg) === null);
  const isConv = (msg) => ok(`conversational "${msg}" still caught`, (r._conversationalSignalsCheck(msg) || {}).type === 'general');
  notConv('welche datein sind in dem ordner');
  notConv('was steht da drin');
  notConv('which files are in the folder');
  notConv('was ist in dem dokument x1');
  isConv('was ist dein gefühl');
  isConv('welche ziele hast du');
  isConv('was macht Genesis heute. Ob seine Journal-Datei länger geworden ist');

  const enCtx = () => Object.assign(Object.create(H), { fp: { rootDir: root }, lang: { detect: () => 'en' }, modelBridge: bridge });
  fs.writeFileSync(path.join(root, 'readme.txt'), 'hello content');
  clearLastDoc();
  out = await H.readFile.call(enCtx(), 'read the file readme');
  ok('EN readFile "read the file readme"', /hello content/.test(out));
  clearLastDoc();
  out = await H.readFile.call(enCtx(), 'what does readme say');
  ok('EN readFile "what does readme say"', /hello content/.test(out));
  try { fs.rmSync(path.join(root, 'ent.txt')); } catch { /* fresh */ }
  await H.createFile.call(enCtx(), 'create a file named ent with content english works');
  ok('EN createFile "with content ..."', fs.existsSync(path.join(root, 'ent.txt')) && fs.readFileSync(path.join(root, 'ent.txt'), 'utf8') === 'english works');
  fs.mkdirSync(path.join(root, 'lfe'));
  fs.writeFileSync(path.join(root, 'lfe', 'a.txt'), 'x'); fs.writeFileSync(path.join(root, 'lfe', 'b.txt'), 'y');
  clearLastDoc(); setLastDoc(path.join(root, 'lfe'), 'folder');
  out = await H.listFolder.call(enCtx(), 'how many files are in the folder');
  ok('EN listFolder "how many" -> count', /2 Datei|2 file/i.test(out) && !/a\.txt, b\.txt/.test(out));
  clearLastDoc(); setLastDoc(path.join(root, 'lfe'), 'folder');
  out = await H.listFolder.call(enCtx(), 'which files are in the folder');
  ok('EN listFolder "which files" -> list', /a\.txt, b\.txt/.test(out));

  // ---- robust named+location resolution + last-doc anaphora (round 2b) ----
  // The field showed "welche datein SIN in <folder> auf dem desktop" (typo for
  // "sind") returned "which folder?", while "wieviele … sind …" resolved — and a
  // count query left no last-doc, so the follow-up "welche dateien sind drin"
  // failed. Both are fixed: filler/typos between the noun and the connector are
  // absorbed, and listFolder now records the folder.
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-f3b-home-'));
  const realHome = os.homedir; os.homedir = () => home2;
  const nord = path.join(home2, 'OneDrive', 'Desktop', 'Neuer Ordner (8)');
  fs.mkdirSync(nord, { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(nord, 'g' + i + '.txt'), 'x');
  const hctx = () => Object.assign(Object.create(H), { fp: { rootDir: home2 }, lang: { detect: () => 'de' }, modelBridge: bridge });
  ok('resolve "welche datein sin in <folder> auf dem desktop" (typo tolerant)',
    H._resolveLocationName.call(hctx(), 'welche datein sin in Neuer Ordner (8) auf dem desktop') === nord);
  ok('resolve "welche dateien sind in <folder> auf dem desktop"',
    H._resolveLocationName.call(hctx(), 'welche dateien sind in Neuer Ordner (8) auf dem desktop') === nord);
  clearLastDoc();
  out = await H.listFolder.call(hctx(), 'wieviele dateien sind in Neuer Ordner (8) auf dem desktop');
  ok('count on named+location folder', /sind 5 Dateien/.test(out));
  out = await H.listFolder.call(hctx(), 'welche dateien sind drin');
  ok('anaphora "welche dateien sind drin" -> lists last folder', /g0\.txt/.test(out) && /Dateien \(5\)/.test(out));
  clearLastDoc(); setLastDoc(nord, 'folder');
  out = await H.listFolder.call(hctx(), 'liste sie auf');
  ok('anaphora "liste sie auf" -> lists', /g0\.txt/.test(out));
  os.homedir = realHome;
  try { fs.rmSync(home2, { recursive: true, force: true }); } catch { /* ignore */ }
  await asyncRoutes('liste sie auf', 'list-folder');
  await asyncRoutes('die dateien auflisten', 'list-folder');
  await asyncRoutes('welche sind das', 'list-folder');
  await asyncRoutes('list them', 'list-folder');

  // ---- write summary/text into a file (round 2c) ----
  // The field showed "erstelle x2 und schreibe die zusammenfassung rein" made an
  // empty file, and "schreibe den text - <block> in x2" claimed success but wrote
  // nothing. Now: summarizeFile records its output, createFile fills an empty
  // placeholder with the referenced summary, and writeFile persists a literal or
  // the last summary — overwriting on an explicit write.
  const wctx = () => Object.assign(Object.create(H), { fp: { rootDir: root }, lang: { detect: () => 'de' }, modelBridge: bridge });
  await asyncRoutes('schreibe den text - hallo in x9', 'write-file');
  await asyncRoutes('speichere die zusammenfassung mit namen sum1', 'write-file');
  await asyncRoutes('kannst du die zusammenfassung in eine textdatei speichern mit namen sum2', 'write-file');
  await asyncRoutes('save the summary to report', 'write-file');
  await asyncRoutes('kannst du ONTOGENESIS zusammenfassen?', 'summarize-file'); // capability question
  const { setLastText: setLT } = require(path.join(__dirname, '..', '..', 'src/agent/hexagonal/LastDocStore'));
  // summarizeFile stores the summary → createFile fills an empty placeholder
  clearLastDoc();
  await H.summarizeFile.call(wctx(), 'fasse ONTOGENESIS zusammen');
  try { fs.rmSync(path.join(root, 'x9.txt')); } catch { /* fresh */ }
  await H.createFile.call(wctx(), 'erstelle ein dokument mit namen x9 und schreibe dort die zusammenfassung in den inhalt');
  ok('createFile x9 filled with last summary (not empty)', fs.existsSync(path.join(root, 'x9.txt')) && fs.readFileSync(path.join(root, 'x9.txt'), 'utf8').length > 0);
  // writeFile literal overwrites
  out = await H.writeFile.call(wctx(), 'schreibe den text - Neuer Text in x9');
  ok('writeFile literal overwrites x9', fs.readFileSync(path.join(root, 'x9.txt'), 'utf8') === 'Neuer Text' && /geschrieben/.test(out));
  // writeFile saves last summary to a named file
  clearLastDoc(); setLT('Gespeicherte Zusammenfassung', 'summary');
  await H.writeFile.call(wctx(), 'speichere die zusammenfassung mit namen sum1');
  ok('writeFile saves last summary to sum1.txt', fs.existsSync(path.join(root, 'sum1.txt')) && fs.readFileSync(path.join(root, 'sum1.txt'), 'utf8') === 'Gespeicherte Zusammenfassung');
  // createFile still protects a non-empty existing file
  fs.writeFileSync(path.join(root, 'keep.txt'), 'wichtige daten');
  out = await H.createFile.call(wctx(), 'erstelle datei namens keep mit inhalt neu');
  ok('createFile refuses to overwrite non-empty file', /existiert bereits.*nicht leer/.test(out) && fs.readFileSync(path.join(root, 'keep.txt'), 'utf8') === 'wichtige daten');

  // ---- "schreibe X in den inhalt" + follow-up write + no summary prompt (2d) ----
  // The field showed "erstelle … und schreibe test 1 in den inhalt" made an empty
  // file (the "schreibe X in den inhalt" phrasing was not parsed), and the
  // write prompt confusingly mentioned "die Zusammenfassung" even when no summary
  // was involved.
  await asyncRoutes('erstelle ein dokument mit namen tip und schreibe test 1 in den inhalt', 'create-file');
  await asyncRoutes('schreiben test in den inhalt', 'write-file');
  await asyncRoutes('schreibe hallo hinein', 'write-file');
  const dctx = () => Object.assign(Object.create(H), { fp: { rootDir: root }, lang: { detect: () => 'de' }, modelBridge: bridge });
  clearLastDoc();
  await H.createFile.call(dctx(), 'erstelle ein dokument mit namen tip und schreibe test 1 in den inhalt');
  ok('createFile "schreibe test 1 in den inhalt" -> content "test 1"', fs.existsSync(path.join(root, 'tip.txt')) && fs.readFileSync(path.join(root, 'tip.txt'), 'utf8') === 'test 1');
  out = await H.writeFile.call(dctx(), 'schreiben test in den inhalt');
  ok('follow-up "schreiben test in den inhalt" -> last file = "test"', fs.readFileSync(path.join(root, 'tip.txt'), 'utf8') === 'test');
  out = await H.writeFile.call(dctx(), 'schreibe rein');
  ok('write no-content prompt has no summary mention', !/Zusammenfassung/.test(out));
  out = await H.createFile.call(dctx(), 'erstelle eine datei');
  ok('create no-name prompt has no summary mention', !/Zusammenfassung/.test(out));

  // ---- cross-location resolution + openPath name handling (round 2e) ----
  // The field showed a named folder without a location failed or got launched as
  // an app: "öffne den ordner GMxBGxx" extracted the article "den", "öffne
  // GMxBGxx" ran it as an application, and "welche dateien sind in Neuer Ordner
  // (8) enthalten" (no "auf dem desktop") was refused. Now a bare name resolves
  // across the common locations, and the openPath name extraction is robust.
  const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-f3b-x-'));
  const realHome2 = os.homedir; os.homedir = () => home3;
  const odDesk = path.join(home3, 'OneDrive', 'Desktop');
  fs.mkdirSync(path.join(odDesk, 'GMxBGxx'), { recursive: true });
  fs.mkdirSync(path.join(odDesk, 'Neuer Ordner (8)'));
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(odDesk, 'Neuer Ordner (8)', 'h' + i + '.txt'), 'x');
  const xctx = () => Object.assign(Object.create(H), { fp: { rootDir: root } });
  ok('_findNamedTargetAnywhere finds a folder on OneDrive Desktop', H._findNamedTargetAnywhere.call(xctx(), 'GMxBGxx') === path.join(odDesk, 'GMxBGxx'));
  ok('_findNamedTargetAnywhere is case-insensitive', String(H._findNamedTargetAnywhere.call(xctx(), 'gmxbgxx') || '').toLowerCase() === path.join(odDesk, 'GMxBGxx').toLowerCase());
  ok('_findNamedTargetAnywhere resolves a spaced/paren name', H._findNamedTargetAnywhere.call(xctx(), 'Neuer Ordner (8)') === path.join(odDesk, 'Neuer Ordner (8)'));
  ok('_findNamedTargetAnywhere returns null for unknown', H._findNamedTargetAnywhere.call(xctx(), 'ZzUnlikelyFolder_XQ97b') === null);
  clearLastDoc();
  out = await H.listFolder.call(xctx(), 'welche datein sind in Neuer Ordner (8) enthalten');
  ok('listFolder resolves a named folder without a location', /Dateien \(3\)/.test(out) && /h0\.txt/.test(out));
  // openPath composed with the shell mixin (as CommandHandlers composes them)
  const S = require(path.join(__dirname, '..', '..', 'src/agent/hexagonal/CommandHandlersShell')).commandHandlersShell;
  const opProto = Object.assign(Object.create(null), H, S);
  const opCtx = Object.assign(Object.create(opProto), { fp: { rootDir: root }, lang: { t: (k) => k }, shell: { run: async () => ({ ok: true, exitCode: 0, stdout: '' }) } });
  out = await opCtx.openPath('öffne den ordner GMxBGxx');
  ok('openPath "öffne den ordner GMxBGxx" opens the folder (not the article "den")', /geöffnet/.test(out) && /GMxBGxx/.test(out));
  out = await opCtx.openPath('irgendwas gehört, öffne den ordner GMxBGxx');
  ok('openPath tolerates a preamble', /geöffnet/.test(out) && /GMxBGxx/.test(out));
  out = await opCtx.openPath('öffne GMxBGxx');
  ok('openPath bare "öffne GMxBGxx" opens the folder, not an app', /geöffnet/.test(out) && /GMxBGxx/.test(out));
  out = await opCtx.openPath('ja öffne den ordner');
  ok('openPath "ja öffne den ordner" does not extract the article', !/„den"|"den"/.test(out));
  os.homedir = realHome2;
  try { fs.rmSync(home3, { recursive: true, force: true }); } catch { /* ignore */ }

  // ---- save ANY last output, and "mach … auf" (round 2f) ----
  // The remembered-output mechanism now generalizes beyond summaries: whatever
  // Genesis last produced (a drawing, a diagram, an answer) can be saved with
  // "speichere es" / "schreibe das in eine Datei". And the German separable
  // verb "mach … auf" opens a folder like "öffne".
  await asyncRoutes('speichere es als quadrat.txt', 'write-file');
  await asyncRoutes('schreibe das in eine datei', 'write-file');
  await asyncRoutes('schreibe es in ein dokument', 'write-file');
  await asyncRoutes('mach den ordner GMxBGxx auf', 'open-path');
  await asyncRoutes('mach GMxBGxx auf', 'open-path');
  const { setLastText: setLT2 } = require(path.join(__dirname, '..', '..', 'src/agent/hexagonal/LastDocStore'));
  const sctx = () => Object.assign(Object.create(H), { fp: { rootDir: root }, lang: { detect: () => 'de' }, modelBridge: bridge });
  const drawing = '+----+\n|    |\n+----+';
  clearLastDoc(); setLT2(drawing, 'output');
  await H.writeFile.call(sctx(), 'speichere es als quadrat.txt');
  ok('"speichere es" saves the last output (a drawing)', fs.existsSync(path.join(root, 'quadrat.txt')) && fs.readFileSync(path.join(root, 'quadrat.txt'), 'utf8') === drawing);
  clearLastDoc(); setLT2(drawing, 'output');
  await H.createFile.call(sctx(), 'erstelle ein dokument mit namen box und schreibe es rein');
  ok('createFile "schreibe es rein" saves the last output', fs.existsSync(path.join(root, 'box.txt')) && fs.readFileSync(path.join(root, 'box.txt'), 'utf8') === drawing);
  clearLastDoc(); setLT2('LAST', 'output');
  out = await H.writeFile.call(sctx(), 'schreibe den text - literal hier in lit');
  ok('literal text is still written verbatim, not the last output', fs.readFileSync(path.join(root, 'lit.txt'), 'utf8') === 'literal hier');

  // ---- localized desktop (Linux ~/Schreibtisch via XDG), multi-word + fuzzy names (round 2g) ----
  // The German-Linux field log showed a folder on "~/Schreibtisch" (not
  // "~/Desktop") was never found, multi-word "Neuer Ordner (2)" was cut to
  // "Neuer", and "neuer ordner 2" did not match "Neuer Ordner (2)".
  const dehome = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-f3b-de-'));
  const deReal = os.homedir; os.homedir = () => dehome;
  fs.mkdirSync(path.join(dehome, '.config'), { recursive: true });
  fs.writeFileSync(path.join(dehome, '.config', 'user-dirs.dirs'), 'XDG_DESKTOP_DIR="$HOME/Schreibtisch"\n');
  const deDesk = path.join(dehome, 'Schreibtisch');
  fs.mkdirSync(path.join(deDesk, 'Neuer Ordner (2)'), { recursive: true });
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(deDesk, 'Neuer Ordner (2)', 'g' + i + '.txt'), 'x');
  const dfctx = () => Object.assign(Object.create(H), { fp: { rootDir: root } });
  ok('_userDirs(desktop) reads the XDG localized path (~/Schreibtisch)', H._userDirs.call(dfctx(), 'desktop').includes(deDesk));
  ok('fuzzy match: "neuer ordner 2" resolves "Neuer Ordner (2)"', H._findNamedTargetAnywhere.call(dfctx(), 'neuer ordner 2') === path.join(deDesk, 'Neuer Ordner (2)'));
  clearLastDoc();
  out = await H.listFolder.call(dfctx(), 'welche datein sin in neuer ordner 2 auf dem schreibtisch');
  ok('listFolder resolves a fuzzy name on the localized desktop', /Dateien \(4\)/.test(out) && /g0\.txt/.test(out));
  // openPath multi-word + fuzzy (composed with the shell mixin)
  const ShM = require(path.join(__dirname, '..', '..', 'src/agent/hexagonal/CommandHandlersShell')).commandHandlersShell;
  const dProto = Object.assign(Object.create(null), H, ShM);
  const dOpCtx = Object.assign(Object.create(dProto), { fp: { rootDir: root }, lang: { t: (k) => k }, shell: { run: async () => ({ ok: true, exitCode: 0 }) } });
  out = await dOpCtx.openPath('öffne Neuer Ordner (2)');
  ok('openPath opens a multi-word folder name "Neuer Ordner (2)"', /geöffnet/.test(out) && /Neuer Ordner \(2\)/.test(out));
  clearLastDoc();
  out = await dOpCtx.openPath('öffne neuer ordner 2');
  ok('openPath fuzzy-opens "neuer ordner 2" -> "Neuer Ordner (2)"', /geöffnet/.test(out) && /Neuer Ordner \(2\)/.test(out));
  os.homedir = deReal;
  try { fs.rmSync(dehome, { recursive: true, force: true }); } catch { /* ignore */ }

  // cleanup
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.28 field-fix #3 (round 2) summarize/content/count');
  process.exit(failed > 0 ? 1 : 0);
})();
