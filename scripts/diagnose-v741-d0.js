#!/usr/bin/env node
// ============================================================
// GENESIS v7.4.1 — D.0 Diagnose
//
// Zweck: Herausfinden, ob Fall 2 vom Windows-Test
// ("Ich kann das nachprüfen" → Genesis fragt nach Memory-ID)
// durch LocalClassifier-Drift oder LLM-Fallback-Halluzination
// verursacht wurde.
//
// Ausführen auf Windows im Genesis-Verzeichnis:
//   node scripts/diagnose-v741-d0.js
//
// Liest:
//   .genesis/local-classifier.json   — gelernte Samples
//   .genesis/events.jsonl            — Event-Log
//
// Schreibt keine Dateien. Gibt Empfehlung aus:
//   Szenario A: LocalClassifier-Drift  →  D.1 = Gating + Purge
//   Szenario B: LLM-Tool-Call          →  bereits in E abgedeckt
//   Szenario C: keins von beidem       →  neu planen
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const GENESIS_DIR = path.resolve(process.cwd(), '.genesis');
const LC_FILE = path.join(GENESIS_DIR, 'local-classifier.json');
const EVENTS_FILE = path.join(GENESIS_DIR, 'events.jsonl');

function section(title) {
  console.log('');
  console.log('─'.repeat(60));
  console.log('  ' + title);
  console.log('─'.repeat(60));
}

function checkLocalClassifier() {
  section('LocalClassifier — gelernte Samples');

  if (!fs.existsSync(LC_FILE)) {
    console.log('  (Datei existiert nicht — LocalClassifier hat noch nie gelernt)');
    return { drift: false, samples: [] };
  }

  let j;
  try {
    j = JSON.parse(fs.readFileSync(LC_FILE, 'utf8'));
  } catch (e) {
    console.log('  FEHLER beim Parsen:', e.message);
    return { drift: false, samples: [] };
  }

  const samples = j.samples || j._samples || [];
  console.log(`  Gesamt-Samples: ${samples.length}`);

  // v7.4.1 Reviewer-Fix: Feld heißt 'intent', nicht 'label'
  const nonGeneral = samples.filter(s => s.intent && s.intent !== 'general');
  console.log(`  Non-general samples: ${nonGeneral.length}`);

  if (nonGeneral.length === 0) {
    console.log('  → Keine Drift-Anzeichen in gelernten Samples.');
    return { drift: false, samples };
  }

  console.log('');
  console.log('  Erste 20 non-general Samples:');
  nonGeneral.slice(0, 20).forEach(s => {
    const text = (s.text || '').slice(0, 80);
    console.log(`    [${s.intent.padEnd(20)}] ${text}`);
  });

  // Drift-Heuristik: wenn deklarative Sätze (mit "ich" am Anfang, oder
  // Konjunktion "ob"/"falls"/"weil") als slash-only intents gelabelt sind,
  // ist das verdächtig.
  const SLASH_ONLY = new Set([
    'memory-veto', 'memory-mark', 'memory-list', 'execute-file',
    'execute-code', 'self-inspect', 'self-modify', 'self-reflect',
    'self-repair', 'trust-control', 'clone', 'daemon',
  ]);
  const suspicious = nonGeneral.filter(s => {
    const t = (s.text || '').toLowerCase().trim();
    const isDeclarative = /^ich\s/.test(t)
      || /\b(ob|falls|weil|wenn)\b/.test(t);
    return isDeclarative && SLASH_ONLY.has(s.intent);
  });

  console.log('');
  console.log(`  Verdächtige Einträge (deklarativ + slash-only intent): ${suspicious.length}`);
  if (suspicious.length > 0) {
    suspicious.slice(0, 10).forEach(s =>
      console.log(`    [DRIFT] [${s.intent}] ${(s.text || '').slice(0, 80)}`));
  }

  return { drift: suspicious.length > 0, samples, suspicious };
}

function checkEventLog() {
  section('Event-Log — letzte 30 relevante Einträge');

  if (!fs.existsSync(EVENTS_FILE)) {
    console.log('  (events.jsonl existiert nicht)');
    return { toolCalls: [], classifications: [] };
  }

  // events.jsonl kann groß werden — nur letzten Block lesen
  const content = fs.readFileSync(EVENTS_FILE, 'utf8');
  const lines = content.split('\n').filter(Boolean);

  const relevant = [];
  const interestingEvents = new Set([
    'intent:classified',
    'tool:called',
    'llm:fallback',
    'intent:cascade-decision',
  ]);

  // Gehe rückwärts, sammle bis 30 relevante Events
  for (let i = lines.length - 1; i >= 0 && relevant.length < 30; i--) {
    try {
      const evt = JSON.parse(lines[i]);
      if (interestingEvents.has(evt.event) || interestingEvents.has(evt.name)) {
        relevant.unshift(evt);
      }
    } catch (_) { /* ignore malformed lines */ }
  }

  if (relevant.length === 0) {
    console.log('  Keine der relevanten Events gefunden.');
    console.log('  (Geprüft: intent:classified, tool:called, llm:fallback, intent:cascade-decision)');
    return { toolCalls: [], classifications: [] };
  }

  console.log(`  Gefunden: ${relevant.length} relevante Events`);
  console.log('');

  const toolCalls = relevant.filter(e => (e.event || e.name) === 'tool:called');
  const cascades = relevant.filter(e => (e.event || e.name) === 'intent:cascade-decision');
  const fallbacks = relevant.filter(e => (e.event || e.name) === 'llm:fallback');
  const classifieds = relevant.filter(e => (e.event || e.name) === 'intent:classified');

  console.log(`    tool:called:             ${toolCalls.length}`);
  console.log(`    intent:cascade-decision: ${cascades.length}`);
  console.log(`    llm:fallback:            ${fallbacks.length}`);
  console.log(`    intent:classified:       ${classifieds.length}`);

  // Tool-Calls auf File-Reader sind der Smoking Gun für Szenario B
  const fileReads = toolCalls.filter(e => {
    const payload = e.payload || e.data || {};
    const tool = payload.tool || payload.name || '';
    return /read_file|open-path|open_file|cat_file/i.test(tool);
  });

  if (fileReads.length > 0) {
    console.log('');
    console.log(`  [SCENARIO B INDICATOR] ${fileReads.length} File-Read Tool-Calls im Log:`);
    fileReads.slice(0, 5).forEach(e => {
      const payload = e.payload || e.data || {};
      console.log(`    tool=${payload.tool || payload.name} args=${JSON.stringify(payload.args || {}).slice(0, 60)}`);
    });
  }

  return { toolCalls, classifications: classifieds, fileReads };
}

function recommendation(drift, fileReadsCount) {
  section('EMPFEHLUNG');

  if (drift) {
    console.log('  → SZENARIO A: LocalClassifier-Drift bestätigt.');
    console.log('');
    console.log('    D.1 implementieren:');
    console.log('      1. Gating in LocalClassifier.learn() — deklarative Sätze');
    console.log('         (Subjekt "ich" + Konjunktion "ob/falls/weil") NICHT als');
    console.log('         Training-Sample für slash-only Intents akzeptieren.');
    console.log('      2. Einmaliger Purge der kontaminierten Samples in');
    console.log('         .genesis/local-classifier.json.');
  } else if (fileReadsCount > 0) {
    console.log('  → SZENARIO B: LLM-Tool-Call-Halluzination.');
    console.log('');
    console.log('    Bereits in Baustein E abgedeckt (Anti-Tool-Call-Direktive');
    console.log('    im Runtime-State-Block). D.1 kann leer bleiben.');
    console.log('    Windows-Verifikation zeigt dann ob E reicht.');
  } else {
    console.log('  → SZENARIO C: Weder Drift noch Tool-Call im Log gefunden.');
    console.log('');
    console.log('    Mögliche Gründe:');
    console.log('      - Log wurde seit dem Bug nicht mehr gefüllt');
    console.log('      - Paraphrasierter Quote im ursprünglichen Report');
    console.log('      - Anderer unbekannter Pfad');
    console.log('');
    console.log('    Empfehlung: D.1 erst planen nachdem der Bug erneut');
    console.log('    auftritt und frisch ins Log geschrieben wird.');
  }

  console.log('');
}

function main() {
  console.log('');
  console.log('═'.repeat(60));
  console.log('  Genesis v7.4.1 — D.0 Diagnose');
  console.log('  Genesis-Verzeichnis: ' + GENESIS_DIR);
  console.log('═'.repeat(60));

  const { drift } = checkLocalClassifier();
  const { fileReads } = checkEventLog();
  const fileReadsCount = (fileReads || []).length;

  recommendation(drift, fileReadsCount);
}

main();
