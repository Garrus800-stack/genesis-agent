// v7.9.45 REVISIONS-MATRIX — Router-End-to-End über alle Fähigkeiten.
// Jede Zeile: Satz + Erwartung (Datei-Effekt / Antwort-Muster / Weg).
const fs=require('fs'),os=require('os'),path=require('path');
const R=require('path').resolve(__dirname,'..');
const {ChatOrchestrator}=require(R+'/src/agent/hexagonal/ChatOrchestrator.js');
const {IntentRouter}=require(R+'/src/agent/intelligence/IntentRouter.js');
const {CommandHandlers}=require(R+'/src/agent/hexagonal/CommandHandlers.js');
const {ToolRegistry}=require(R+'/src/agent/intelligence/ToolRegistry.js');
const {registerV737Tools}=require(R+'/src/agent/cognitive/tools/v737-memory-tools.js');
(async()=>{
const base=path.join(os.tmpdir(),'mx-'+Date.now());
const V=path.join(base,'MeinVault'); const ARCH=path.join(base,'Genesis Archive');
fs.mkdirSync(path.join(V,'Speicher'),{recursive:true}); fs.mkdirSync(path.join(ARCH,'inbox'),{recursive:true});
fs.writeFileSync(path.join(V,'Speicher','Farbe.md'),'Meine Lieblingsfarbe ist grün.\n');
fs.writeFileSync(path.join(ARCH,'inbox','x22.txt'),'INHALT-X22');
fs.writeFileSync(path.join(ARCH,'inbox','shot.png'),Buffer.from([137,80,78,71]));
let mc=0;
const model={chat:async()=>{mc++;return{content:'[MODELL]'}},complete:async()=>{mc++;return '[MODELL]'}};
const reg=new ToolRegistry({bus:{fire(){}},lang:{t:k=>k}});
registerV737Tools(reg,{modelBridge:{_genesisDir:path.join(base,'.g'),chat:async()=>({content:'BILD-STUB: beschrieben.'})},journalWriter:{write(){}},settings:{get:k=>k==='archive.path'?ARCH:(k==='vault.path'?V:undefined)}});
const mkOrch=(h)=>{const o=new ChatOrchestrator({lang:{t:k=>k,detect(){},current:'de'},bus:{fire(){}},intentRouter:new IntentRouter({bus:{fire(){}}}),model,context:{},tools:reg,circuitBreaker:{},promptBuilder:{build:async()=>({messages:[{role:'user',content:'x'}]})},uncertaintyGuard:{wrapResponse:r=>r},memory:{},unifiedMemory:{},storageDir:base,storage:{},gateStats:{},selfGate:{}});h.registerHandlers(o);o._handleMainResponseError=()=>({text:'[MODELL]'});return o;};
const mkH=()=>new CommandHandlers({lang:{t:k=>k,detect(){},current:'de'},settings:{get:k=>k==='vault.path'?V:(k==='archive.path'?ARCH:undefined),set(){}},fileProcessor:{rootDir:path.join(base,'proj')},genesisDir:path.join(base,'.g')});
let h=mkH(),orch=mkOrch(h);
const say=async(m)=>{mc=0;const o=await orch.handleChat(m);return String((o&&(o.text||o.response))||o||'');};
let pass=0,fail=0; const F=[];
const chk=(name,cond,detail)=>{if(cond){pass++;}else{fail++;F.push(name+(detail?' — '+detail:''));}};
const fresh=()=>{h=mkH();orch=mkOrch(h);};
let r;
// ── A LOOKUP (liest statt erinnert) ──
r=await say('Schau in meinen Zettelkasten: was ist meine Lieblingsfarbe?');
chk('A1 Doppelpunkt-Form liest',/grün/.test(r)&&/Farbe\.md/.test(r)&&mc===0,r.slice(0,50));
r=await say('schau in meinen kram und sage mir eine farbe');
chk('A2 und-sag-Form (Vault-Name egal)',/grün/.test(r)&&mc===0,r.slice(0,50));
r=await say('look in my vault: what is my favourite lieblingsfarbe?');
chk('A3 EN',/grün/.test(r),r.slice(0,40));
r=await say('mira en mi vault y dime un color');
chk('A4 ES routet + ehrlich',/(grün|nichts gefunden)/.test(r),r.slice(0,40));
r=await say('Schau in meinen Zettelkasten: wie heißt mein raumschiff?');
chk('A5 Nicht-Treffer ehrlich',/nichts gefunden/.test(r)&&/raumschiff/.test(r),r.slice(0,50));
// ── B CREATE-Faden (pending + Vorfahrt + Kontext) ──
fresh();
r=await say('Leg dir in deinem Genesis-Bereich im Vault eine erste Notiz an und verweise darin auf meine farbe-Notiz.');
chk('B1 Frage nennt Ziel',/Wie soll die Datei/.test(r)&&r.includes(path.join(V,'Genesis')),r.slice(0,60));
r=await say('warum eigentlich "D:\\a\\b.txt"');
chk('B2 Frage-Einschub: kein Öffnen, pending lebt',h._pendingFileRequest&&!/Ordner geöffnet/.test(r),r.slice(0,40));
r=await say('lies x22');
chk('B3 Befehl-Einschub: keine Geisterdatei, pending lebt',h._pendingFileRequest&&!(fs.existsSync(path.join(V,'Genesis'))&&fs.readdirSync(path.join(V,'Genesis')).some(f=>/lies/.test(f))),'');
r=await say('name alf');
chk('B4 name alf → Vault + [[Farbe]] + deterministisch',fs.existsSync(path.join(V,'Genesis','alf.md'))&&fs.readFileSync(path.join(V,'Genesis','alf.md'),'utf8')==='Verweis: [[Farbe]]'&&/Datei erstellt: /.test(r)&&mc===0,r.slice(0,50));
fresh();
await say('Leg dir in deinem Genesis-Bereich im Vault eine Notiz an.');
r=await say('fff');
chk('B5 nacktes Wort',fs.existsSync(path.join(V,'Genesis','fff.md'))&&/Datei erstellt: /.test(r),'');
fresh();
await say('Leg dir in deinem Genesis-Bereich im Vault eine Notiz an und verweise darin auf meine farbe-Notiz.');
r=await say('sie oll tting heißen');
chk('B6 Tippfehler-Satzform + ref',fs.existsSync(path.join(V,'Genesis','tting.md'))&&/\[\[Farbe\]\]/.test(fs.readFileSync(path.join(V,'Genesis','tting.md'),'utf8')),'');
fresh();
await say('make a first note in your genesis corner of the vault');
r=await say('call it neo');
chk('B7 EN-Faden',fs.existsSync(path.join(V,'Genesis','neo.md')),r.slice(0,40));
r=await say('du sagst du hast dort aber eine datei namens hans erstellt');
chk('B8 Beschwerde erzeugt nichts',!fs.existsSync(path.join(ARCH,'hans erstellt.txt'))&&!fs.existsSync(path.join(V,'Genesis','hans erstellt.txt')),'');
fresh();
r=await say('erstelle eine textdatei mit namen plan und inhalt morgen');
chk('B9 Alltag-Archiv unverändert',fs.existsSync(path.join(ARCH,'plan.txt'))&&fs.readFileSync(path.join(ARCH,'plan.txt'),'utf8')==='morgen','');
r=await say('erstelle ein dokument name x text hallo');
chk('B10 nacktes name/text → Archiv .txt',fs.existsSync(path.join(ARCH,'x.txt'))&&fs.readFileSync(path.join(ARCH,'x.txt'),'utf8')==='hallo','');
fresh();
await say('Leg dir in deinem Genesis-Bereich im Vault eine Notiz an.');
r=await say('erstelle eine textdatei mit namen plan2 und inhalt morgen');
chk('B11 Create-Satz nach offener Frage = neuer Auftrag',fs.existsSync(path.join(ARCH,'plan2.txt'))&&!(fs.existsSync(path.join(V,'Genesis'))&&fs.readdirSync(path.join(V,'Genesis')).some(f=>/erstelle/.test(f))),'');
// ── C EDIT (auf Zuruf, überall) ──
fresh();
r=await say('Ändere in meiner Notiz farbe grün zu blau.');
chk('C1 Feldsatz Vault-Edit',/✏️ 1×/.test(r)&&fs.readFileSync(path.join(V,'Speicher','Farbe.md'),'utf8').includes('blau'),r.slice(0,50));
r=await say('was steht in farbe');
r=await say('ändere blau zu grün');
chk('C2 lastDoc-Kette',/✏️ 1×/.test(r)&&fs.readFileSync(path.join(V,'Speicher','Farbe.md'),'utf8').includes('grün'),r.slice(0,50));
r=await say('ändere lila zu rosa in meiner Notiz farbe');
chk('C3 nicht-drin ehrlich',/steht nicht in/.test(r),r.slice(0,40));
r=await say('change grün to azul in my note farbe');
chk('C4 EN-Edit',/✏️ 1×/.test(r),r.slice(0,40));
r=await say('ändere x zu y in "C:\\Windows\\system32\\drivers\\etc\\hosts"');
chk('C5 Schutzpfad',/geschützt/.test(r),r.slice(0,40));
// ── D ORTE ──
r=await say('wo ist dein arbeitsbereich');
chk('D1 3-Orte-Karte',/Genesis Archive/.test(r)&&/Zuhause/.test(r)&&/Vault/.test(r)&&mc===0,r.slice(0,50));
r=await say('where is your workspace');
chk('D2 EN',/Genesis Archive/.test(r),'');
// ── E VAULT-SET ──
fresh();
const V2=path.join(base,'xytr'); fs.mkdirSync(V2,{recursive:true});
r=await say('dein vault liegt in "'+V2+'"');
chk('E1 dein-Form Handschlag',/verbunden/.test(r)&&r.includes(V2),r.slice(0,60));
r=await say('hier ist mein vault: '+V2);
chk('E2 hier-ist-Form',/verbunden/.test(r),'');
const V3=path.join(base,'eltern'); fs.mkdirSync(path.join(V3,'kind','.obsidian'),{recursive:true});
r=await say('mein vault liegt in "'+V3+'"');
chk('E4 Zwei-Wurzeln-Drift wird sofort gemeldet',/verbunden/.test(r)&&/\.obsidian/.test(r)&&r.includes(path.join(V3,'kind')),r.slice(0,70));
const P=path.join(base,'Eltern'); fs.mkdirSync(path.join(P,'Kind','.obsidian'),{recursive:true});
r=await say('mein vault liegt in "'+P+'"');
chk('E4 Drift-Hinweis: .obsidian im Kind wird genannt',/verbunden/.test(r)&&/Hinweis/.test(r)&&r.includes(path.join(P,'Kind')),r.slice(0,80));
r=await say('dein vault ist toll');
chk('E3 Fehltrigger',!/verbunden/.test(r),'');
// ── F LESEN (Archiv, Bild, PDF-Ehrlichkeit) ──
fresh();
r=await say('was steht in x22');
chk('F1 x22',/INHALT-X22/.test(r),r.slice(0,40));
r=await say('was ist auf dem shot.png zu sehen');
chk('F2 Bild deterministisch',/BILD-STUB/.test(r),r.slice(0,50));
fs.writeFileSync(path.join(ARCH,'inbox','doc1.pdf'),'%PDF-1.4');
r=await say('was steht in doc1.pdf');
chk('F3 PDF ohne Modul: ehrliche Ursache',/(npm install in|konnte nicht laden)/.test(r),r.slice(0,60));
// ── G LABOR (Route + Status; ohne Docker nur Weg+Meldung) ──
r=await say('schau ins labor');
chk('G1 Status-Weg',!/\[MODELL\]/.test(r)&&mc===0,r.slice(0,50));
r=await say('Führe im Labor aus: print(1)');
chk('G2 Lauf-Weg deterministisch',!/\[MODELL\]/.test(r)&&mc===0,r.slice(0,50));
r=await say('pruébalo en el laboratorio: x=1');
chk('G3 ES-Weg',!/\[MODELL\]/.test(r),'');
// ── H FEHLTRIGGER-Ränder ──
r=await say('öffne '+ARCH);
chk('H1 echtes Öffnen bleibt Route',!/\[MODELL\]/.test(r),r.slice(0,40));
r=await say('wo ist der bahnhof');
chk('H2 Alltagsfrage → Modell',/\[MODELL\]/.test(r),'');
r=await say('ich war gestern im labor der uni');
chk('H3 Labor-Erzählung → Modell',/\[MODELL\]/.test(r),'');
r=await say('Bänder zu kaufen wäre gut');
chk('H4 kein Phantom-Edit',/\[MODELL\]/.test(r),'');
r=await say('was ist deine lieblingsfarbe');
chk('H5 Frage an Genesis selbst → Modell',/\[MODELL\]/.test(r),'');
// ── V VORHALLE (v7.9.46): Klopf-Weg je Kreis über echtes HTTP + Dreifach-Leck-Negativ ──
await (async()=>{
  const http=require('http'),crypto=require('crypto');
  const vbase=path.join(os.tmpdir(),'vmx-'+Date.now()); fs.mkdirSync(path.join(vbase,'vorhalle'),{recursive:true});
  const hh=(s)=>crypto.createHash('sha256').update(s).digest('hex');
  fs.writeFileSync(path.join(vbase,'vorhalle','circles.json'),JSON.stringify({[hh('kO')]:{name:'Gast',circle:'outer'},[hh('kM')]:{name:'Neo',circle:'middle'}}));
  fs.writeFileSync(path.join(vbase,'vorhalle','stimme.json'),JSON.stringify({statusOuter:'Aktiv: {focus}.',statusMiddle:'Bei {focus}, {who}.',absentLine:'{who}, noch nicht gesehen.',closedLine:'Nicht erreichbar.'}));
  const {McpServer}=require('../src/agent/capabilities/McpServer.js');
  const {VestibuleGate}=require('../src/agent/capabilities/VestibuleGate.js');
  const {registerV7946Tools}=require('../src/agent/cognitive/tools/v7946-vestibule-tools.js');
  const vgate=new VestibuleGate({genesisDir:vbase});
  // v7.9.46 field-fix: echte ToolRegistry statt Attrappe — die Attrappe nahm
  // ein Objekt entgegen und verbarg, dass die Vorhallen-Werkzeuge gegen eine
  // nicht existierende Signatur registriert wurden.
  const {ToolRegistry}=require('../src/agent/intelligence/ToolRegistry.js');
  let vmc=0; const vreg=new ToolRegistry({});
  vreg.register('file-write',{description:'d',input:{path:'string',content:'string'}},async()=>{vmc+=100;return 'WROTE';});
  registerV7946Tools(vreg,{vestibuleGate:vgate,modelBridge:{_genesisDir:vbase,chat:async()=>{vmc++;return 'Zeile.';}},idleMindStatus:{getStatus:()=>({isIdle:true,idleSince:60000,recentActivities:[{activity:'reflect'}]})},goalStack:{getActive:()=>[]},dreamCycle:{active:false},bus:{fire(){}}});
  const srv=new McpServer({tools:vreg,bus:{fire(){},on(){}},bridgeTools:new Map(),security:{apiKey:'FULL'},vestibule:vgate});
  await srv.start(0); const vp=srv._serverPort;
  const vc=(key,method,params)=>new Promise((res)=>{const b=JSON.stringify({jsonrpc:'2.0',id:1,method,params});const q=http.request({port:vp,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b),Authorization:'Bearer '+key}},r=>{let d='';r.on('data',x=>d+=x);r.on('end',()=>res(d));});q.end(b);});
  let rr=JSON.parse(await vc('kM','tools/call',{name:'vestibule-status',arguments:{question:'hi'}}));
  chk('V1 Klopf-E2E middle: Antwort in seiner Stimme, 1 Modell-Call',vmc===1&&/Zeile|noch nicht/.test(JSON.stringify(rr)),JSON.stringify(rr).slice(0,60));
  vmc=0; rr=JSON.parse(await vc('FULL','tools/call',{name:'vestibule-status',arguments:{}}));
  chk('V2 Voll-Schlüssel: Roh-Snapshot ohne Modell-Call',vmc===0&&/focus/.test(JSON.stringify(rr)),'');
  vmc=0; const leak=await vc('kO','tools/call',{name:'file-write',arguments:{path:'x',content:'y'}});
  const lst=JSON.parse(await vc('kO','tools/list')).result.tools.map(t=>t.name);
  chk('V3 Dreifach-Leck-Negativ: outer weder call noch list noch write',vmc===0&&/Tool not found/.test(leak)&&lst.length===1&&lst[0]==='vestibule-status','');
  await srv.stop();
  // ── v7.9.46 r7: Boot-Weg mit LEERER externer Serverliste + Gate-Provider ──
  // Vor A0 stieg McpClient.boot() bei 0 externen Servern aus, BEVOR der
  // Auto-Start lief: "MCP-Server: An" wirkte nach jedem Neustart nicht. Und
  // das Gate wird erst in Phase 4 gesetzt — ein in Phase 3 gestarteter Server
  // trug es nie. Beides in einem Lauf.
  const {McpClient}=require('../src/agent/capabilities/McpClient.js');
  const vset={data:{mcp:{servers:[],serve:{enabled:true,port:0,apiKey:'FULL'}}},get(pp){let v=this.data;for(const k of pp.split('.')){if(v==null)return undefined;v=v[k];}return v;}};
  const vcli=new McpClient({settings:vset,toolRegistry:vreg,storageDir:vbase,bus:{fire(){},on(){}}});
  await vcli.boot();                       // Phase 3
  const bootPort=vcli._mcpServer&&vcli._mcpServer.port;
  vcli._vestibuleGate=vgate;               // Phase 4 — NACH dem Start
  const bc=(key,method,params)=>new Promise((res)=>{const b=JSON.stringify({jsonrpc:'2.0',id:1,method,params});const q=http.request({port:bootPort,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b),Authorization:'Bearer '+key}},r=>{let d='';r.on('data',x=>d+=x);r.on('end',()=>res(d));});q.end(b);});
  vmc=0; const bootOuter=await bc('kO','tools/call',{name:'vestibule-status',arguments:{question:'hi'}});
  // Ohne Gate liefe der outer-Schluessel gegen _checkAuth (apiKey 'FULL')
  // und bekaeme 401; ohne A0 gaebe es ueberhaupt keinen Port.
  chk('V4 Boot mit leerer Serverliste startet UND traegt das Gate (A0 + Provider)',!!bootPort&&/"result"/.test(bootOuter)&&!/Unauthorized|Tool not found/.test(bootOuter),String(bootPort)+' '+bootOuter.slice(0,80));
  // ── v7.9.46 r7: Schluesselwechsel wirkt ohne App-Neustart ──
  // _apiKey wird pro Request gelesen, _ensureServer frischt ihn auf: ein
  // zweiter startServer-Aufruf genuegt, der Socket bleibt bestehen.
  const oldKeyRes=await bc('FULL','ping',{});
  vset.data.mcp.serve.apiKey='ROTATED';
  await vcli.startServer();
  const staleRes=await bc('FULL','ping',{});
  const freshRes=await bc('ROTATED','ping',{});
  chk('V5 Schluesselwechsel ohne Neustart: alt faellt aus, neu greift sofort',/result/.test(oldKeyRes)&&/Unauthorized/.test(staleRes)&&/result/.test(freshRes),staleRes.slice(0,40)+' | '+freshRes.slice(0,40));
  await vcli._mcpServer.stop();
})();
console.log('MATRIX:',pass,'OK ·',fail,'FAIL');
for(const x of F)console.log('  ✗',x);
})();
