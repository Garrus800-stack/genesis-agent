// @ts-checked-v5.7
// ============================================================
// GENESIS — cognitive/SelfTrajectory.js (v7.9.15)
//
// The self-trajectory journal — Genesis' record of who he is over
// time, written collaboratively with the human co-author. Each
// entry is one cycle: six self-statement fields, a note from each
// author, and the edit history of how the entry came to be.
//
// This module owns the schema, the persistence, the collaborative
// draft lifecycle, and the draft generation. The chat handler
// (CommandHandlersTrajectory) is thin and only calls into here.
//
// Persistence (under genesisDir, the identity-persistent root that
// survives habitat-swaps):
//   self-trajectory.jsonl       — append-only journal (one entry/line)
//   self-trajectory.draft.json  — single in-progress entry, separate
//                                 from the journal, deleted on commit
//
// Append-only discipline: the journal is history, not a database.
// Once an entry is committed it is never rewritten in content — the
// only mutation is appending a late note to its `late_notes` array,
// and even that is done byte-stably (untouched entries keep their
// exact bytes; see addLateNote).
//
// Draft generation pulls three "remembrance" sources and presents
// them as material, not as a checklist to integrate:
//   - all genome traits          (the generation-stable base)
//   - the 4 most-recalled lessons (consolidated understanding)
//   - cognitiveSelfModel prose    (current self-observation: capability
//                                  floor, biases, weaknesses)
// The six fields are Genesis' own words. The sources keep him from
// writing from memory alone.
//
// Integration:
//   manifest phase9-cognitive  → registers the service
//   CommandHandlersTrajectory  → /trajectory new|show|list|note|history
//   modelBridge (late-bound)   → draft generation; absent → stub draft
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { EVENTS } = require('../core/EventTypes');
const { createLogger } = require('../core/Logger');

const _log = createLogger('SelfTrajectory');

// ── Constants (single source) ───────────────────────────────

const SCHEMA_VERSION = 1;
const JOURNAL_FILE = 'self-trajectory.jsonl';
const DRAFT_FILE = 'self-trajectory.draft.json';

// Canonical field names. The German/English mix is deliberate —
// each language where it is most precise — and must NOT be
// "tidied up" in a later refactor:
//   traits     (en) — sharper than the broader German "Eigenschaften"
//   wachstum   (de) — sharper than "growth" (which reads economic)
//   schwaeche  (de) — sharper than the weaker-sounding "weakness"
//   beziehung  (de) — the bond to the human co-author specifically
//   emotion    (intl) — matches the existing EmotionalState component
//   value      (en) — sharper for value-judgement than ambiguous "Wert"
const FIELD_NAMES = ['traits', 'wachstum', 'schwaeche', 'beziehung', 'emotion', 'value'];

// Input-side tolerance only. The canonical name is always what gets
// written to the journal — no schema drift. English aliases plus
// umlaut folding (handled in normalizeFieldName) cover the common
// mistypes without giving the fields a second identity.
const FIELD_ALIASES = {
  growth: 'wachstum',
  weakness: 'schwaeche',
  relationship: 'beziehung',
  // 'traits' / 'emotion' / 'value' are already canonical
};

// Programmatically recognisable, deliberately un-natural. The stub
// path (no model available) fills every field with this; the commit
// guard refuses to commit any field still equal to it. If a value
// must change (translation, typo), it changes here, in one place.
const STUB_SENTINEL = '(no model — please write manually)';

const REFUSE_TOKEN = 'refuse';

// v7.9.19: a consecutive refuse run of this length or more is marked as a
// pattern in the /trajectory calibration diagnostics. The number is a
// roadmap marker ("3+ cycles"), not a threshold tuned from data — the
// diagnostic counts journalled values and never aggregates over a
// distribution, so it stays data-independent regardless of this constant.
const REFUSE_RUN_PATTERN_MIN = 3;

// ── Helpers ─────────────────────────────────────────────────

/** YYYY-MM-DD of an ISO-8601 timestamp or ms epoch. */
function dateOf(isoOrMs) {
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/**
 * Normalise a user-typed field name to its canonical form.
 *   1. lowercase
 *   2. umlaut folding (ä→ae, ö→oe, ü→ue, ß→ss)
 *   3. english alias → canonical
 *   4. match against FIELD_NAMES → canonical, else null
 */
function normalizeFieldName(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  s = s
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
  if (FIELD_ALIASES[s]) s = FIELD_ALIASES[s];
  return FIELD_NAMES.includes(s) ? s : null;
}

/** Empty field map with all six canonical keys. */
function emptyFields() {
  const f = {};
  for (const k of FIELD_NAMES) f[k] = '';
  return f;
}

class SelfTrajectory {
  /**
   * @param {object} opts
   * @param {object} [opts.bus]
   * @param {object} opts.storage              - StorageService rooted at genesisDir
   * @param {object} [opts.genome]             - getTraits()
   * @param {object} [opts.cognitiveSelfModel] - buildPromptContext()
   * @param {object} [opts.lessonsStore]       - getAll() → [{insight,useCount,...}]
   * @param {{ now: () => number }} [opts.clock]
   */
  constructor({ bus, storage, genome, cognitiveSelfModel, lessonsStore, clock = Date } = {}) {
    if (!storage) throw new Error('SelfTrajectory requires a storage service');
    this.bus = bus || NullBus;
    this.storage = storage;
    this.genome = genome || null;
    this.cognitiveSelfModel = cognitiveSelfModel || null;
    this.lessonsStore = lessonsStore || null;
    /** @type {*} late-bound by the manifest, like ProactiveSelfExpression */
    this.modelBridge = null;
    /** @type {*} late-bound by the manifest (v7.9.16). When present, commit()
     *  fills event_count from eventCounter.countSince(previous wallclock_end);
     *  absent (unit tests, degraded boot) → event_count stays null. */
    this.eventCounter = null;
    this._clock = clock;
    // Exposed on the instance so the phase-5 chat handler can read the
    // field names WITHOUT a static upward require into this cognitive
    // (phase-9) module — handlers reach cognitive services through the
    // injected instance, not through cross-phase imports.
    this.fieldNames = FIELD_NAMES;
  }

  // ── Journal reads ─────────────────────────────────────────

  /**
   * All committed entries, oldest-first (file order).
   * Hard-fails on a schema_version mismatch — an old trajectory is
   * history in its own form, not a record to silently migrate.
   */
  readEntries() {
    const raw = this.storage.readText(JOURNAL_FILE, '');
    if (!raw.trim()) return [];
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let entry;
      try {
        entry = JSON.parse(t);
      } catch (err) {
        throw new Error(`SelfTrajectory: corrupt journal line: ${err.message}`);
      }
      if (entry.schema_version !== SCHEMA_VERSION) {
        throw new Error(
          `SelfTrajectory: unsupported schema_version ${entry.schema_version} ` +
          `(this build reads version ${SCHEMA_VERSION} only)`);
      }
      out.push(entry);
    }
    return out;
  }

  hasEntries() {
    return this.readEntries().length > 0;
  }

  isFirstEntry() {
    return !this.hasEntries();
  }

  latestEntry() {
    const all = this.readEntries();
    return all.length ? all[all.length - 1] : null;
  }

  readEntry(cycleId) {
    return this.readEntries().find(e => e.cycle_id === cycleId) || null;
  }

  /**
   * Read-only diagnostics over the committed journal (v7.9.19).
   * Two data-independent observations, both derived purely from the
   * raw entries this service already owns — no score distribution,
   * no calibration side-file, no threshold on a distribution:
   *
   *   refuseRuns[field] — the current consecutive run of REFUSE_TOKEN
   *     for that field, counted from the latest entry backwards and
   *     reset by the first non-refuse value. A run is a count, not a
   *     verdict on what the refuse *means* (avoidance, protection, a
   *     legitimate stance, fatigue — all left open).
   *   lastEntryAgeDays — whole days since the latest committed entry's
   *     wallclock_end, or null when there is no entry. Pure arithmetic,
   *     deliberately WITHOUT a ceiling/marker (a 30-day number would be
   *     a Tier-2 trigger value; here it is display only).
   *
   * refusePatternMin is surfaced so the renderer can mark a run as a
   * pattern without hard-coding the marker.
   *
   * Strictly observational: emits nothing, touches no draft.
   */
  getDiagnostics() {
    const entries = this.readEntries(); // oldest-first (file order)
    const refuseRuns = {};
    for (const f of FIELD_NAMES) {
      let run = 0;
      for (let i = entries.length - 1; i >= 0; i--) {
        const fields = entries[i].fields;
        if (fields && fields[f] === REFUSE_TOKEN) run++;
        else break;
      }
      refuseRuns[f] = run;
    }
    let lastEntryAgeDays = null;
    if (entries.length) {
      const endMs = Date.parse(entries[entries.length - 1].wallclock_end);
      if (!Number.isNaN(endMs)) {
        lastEntryAgeDays = Math.max(0, Math.floor((this._clock.now() - endMs) / 86400000));
      }
    }
    return { refuseRuns, lastEntryAgeDays, refusePatternMin: REFUSE_RUN_PATTERN_MIN };
  }

  /**
   * cycle_id = <date>.cycle.<n>, n running across the journal.
   * Date comes from the cycle's wallclock_start (the day the draft
   * began), n is highest-existing + 1. Lexicographically sortable,
   * human-readable, derivable without an external sequence source.
   */
  nextCycleId(wallclockStart) {
    const date = dateOf(wallclockStart);
    let maxN = 0;
    for (const e of this.readEntries()) {
      const m = /\.cycle\.(\d+)$/.exec(e.cycle_id || '');
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    return `${date}.cycle.${maxN + 1}`;
  }

  // ── Draft lifecycle ───────────────────────────────────────

  readDraft() {
    return this.storage.readJSON(DRAFT_FILE, null);
  }

  hasDraft() {
    return this.readDraft() !== null;
  }

  _writeDraft(draft) {
    this.storage.writeJSON(DRAFT_FILE, draft);
    return draft;
  }

  deleteDraft() {
    return this.storage.delete(DRAFT_FILE);
  }

  /**
   * Start (or regenerate) a draft. Pulls the three sources, asks the
   * model, persists the result. NEVER commits — the result is a
   * placeholder/proposal the human edits and commits explicitly.
   *
   * Caller is responsible for the no-silent-regenerate rule: this is
   * only called when there is no draft yet (or after an explicit
   * discard). It does not check for an existing draft itself.
   */
  async generateDraft() {
    const first = this.isFirstEntry();
    const wallclockStart = new Date(this._clock.now()).toISOString();
    const sources = this._collectSources();

    let fields;
    let genesisNote;

    if (!this.modelBridge || typeof this.modelBridge.chat !== 'function') {
      // No model — stub. The six fields get a recognisable placeholder
      // the commit guard refuses, so the human must set + note + commit
      // by hand (the intended friction of "write manually"). genesis_note
      // stays EMPTY: it is Genesis' own voice, and with no model there is
      // no such voice — empty is honest, and the empty-note check (first
      // entry) catches it without needing a sentinel in the note too.
      fields = {};
      for (const k of FIELD_NAMES) fields[k] = STUB_SENTINEL;
      genesisNote = '';
      _log.info('[TRAJECTORY] generateDraft: no model — stub draft written');
    } else {
      const parsed = await this._askModel(sources, first);
      fields = parsed.fields;
      genesisNote = parsed.genesis_note;
    }

    const draft = {
      _draft: true,
      schema_version: SCHEMA_VERSION,
      wallclock_start: wallclockStart,
      first_entry: first,
      fields,
      genesis_note: genesisNote || '',
      garrus_note: '',
      editing_history: [],
    };
    return this._writeDraft(draft);
  }

  /**
   * Overwrite one field in the draft and record the change in
   * editing_history. Multiple edits of the same field are kept as
   * separate diffs (not consolidated) — the intermediate value
   * existed and belongs to the history.
   * @returns {{ok:true, field:string}|{ok:false, error:string}}
   */
  setDraftField(rawFieldName, value, author = 'garrus') {
    const draft = this.readDraft();
    if (!draft) return { ok: false, error: 'no-draft' };
    const field = normalizeFieldName(rawFieldName);
    if (!field) return { ok: false, error: 'unknown-field' };
    const from = draft.fields[field] ?? '';
    const to = String(value);
    draft.fields[field] = to;
    draft.editing_history.push({
      field, from, to, author,
      ts: new Date(this._clock.now()).toISOString(),
    });
    this._writeDraft(draft);
    return { ok: true, field };
  }

  /**
   * Set genesis_note or garrus_note on the draft. These are two more
   * string fields, not a privileged type — set/edited like any value,
   * just not part of the six self-statement fields.
   * @param {'genesis'|'garrus'} who
   */
  setDraftNote(who, text) {
    const draft = this.readDraft();
    if (!draft) return { ok: false, error: 'no-draft' };
    if (who !== 'genesis' && who !== 'garrus') return { ok: false, error: 'unknown-author' };
    draft[`${who}_note`] = String(text);
    this._writeDraft(draft);
    return { ok: true };
  }

  /**
   * Validate the draft and append it to the journal, then delete the
   * draft. Strict because the journal is append-only and unrepairable:
   *   - all six fields non-empty
   *   - no field equal to the stub sentinel
   *   - first entry only: both notes non-empty
   * @returns {{ok:true, entry:object}|{ok:false, error:string, detail?:string}}
   */
  commit() {
    const draft = this.readDraft();
    if (!draft) return { ok: false, error: 'no-draft' };

    for (const k of FIELD_NAMES) {
      const v = (draft.fields[k] ?? '').trim();
      if (!v) return { ok: false, error: 'empty-field', detail: k };
      if (v === STUB_SENTINEL) return { ok: false, error: 'stub-field', detail: k };
    }
    if (draft.first_entry) {
      if (!(draft.genesis_note || '').trim()) return { ok: false, error: 'first-entry-note', detail: 'genesis_note' };
      if (!(draft.garrus_note || '').trim()) return { ok: false, error: 'first-entry-note', detail: 'garrus_note' };
    }

    const wallclockEnd = new Date(this._clock.now()).toISOString();
    const cycleId = this.nextCycleId(draft.wallclock_start);

    // v7.9.16: fill event_count from the passive significant-event counter.
    // The cycle window is derived, not stored: it runs from the previous
    // entry's wallclock_end (this cycle's start) to now, as a half-open
    // window (ts > prevEnd) inside countSince. No prior entry → null
    // boundary → counts all recorded events (the first cycle). eventCounter
    // absent → event_count stays null (graceful).
    const _prior = this.readEntries();
    const _prevEnd = _prior.length ? _prior[_prior.length - 1].wallclock_end : null;
    const eventCount = this.eventCounter ? this.eventCounter.countSince(_prevEnd) : null;

    // author: genesis is the base; garrus is added if there is a
    // garrus_note or any garrus edit in the history.
    const author = ['genesis'];
    const garrusTouched =
      (draft.garrus_note || '').trim().length > 0 ||
      draft.editing_history.some(e => e.author === 'garrus');
    if (garrusTouched) author.push('garrus');

    const entry = {
      cycle_id: cycleId,
      schema_version: SCHEMA_VERSION,
      wallclock_start: draft.wallclock_start,
      wallclock_end: wallclockEnd,
      event_count: eventCount,
      author,
      first_entry: !!draft.first_entry,
      fields: { ...draft.fields },
      genesis_note: draft.genesis_note || '',
      garrus_note: draft.garrus_note || '',
      editing_history: draft.editing_history || [],
      late_notes: [],
    };

    this.storage.appendText(JOURNAL_FILE, JSON.stringify(entry) + '\n');
    this.deleteDraft();
    _log.info(`[TRAJECTORY] committed ${cycleId} (first=${entry.first_entry}, author=${author.join('+')})`);
    // v7.9.17: announce the commit so TrajectoryCalibration can classify the
    // entry's expected directions now, while the model is fresh. fire() is
    // fire-and-forget — it never blocks commit, and SelfTrajectory stays
    // unaware of any listener (the trigger is the bus, not a back-reference).
    this.bus.fire(EVENTS.TRAJECTORY.COMMITTED, { entry });
    return { ok: true, entry };
  }

  // ── Late notes (the only post-commit mutation) ────────────

  /**
   * Append a late note to an already-committed entry. The entry's
   * own content is unchanged; only its late_notes array grows.
   *
   * Byte-stable rewrite (plan variant a): every line except the one
   * being changed is carried over byte-for-byte. The changed line is
   * the only one re-serialised. This keeps unrelated entries
   * bit-identical so a future hash-based audit cannot mistake a
   * late-note append for tampering. Written atomically via writeText
   * (tmp + rename) so a crash mid-write cannot half-empty the journal.
   * @returns {{ok:true}|{ok:false, error:string}}
   */
  addLateNote(cycleId, author, text) {
    const raw = this.storage.readText(JOURNAL_FILE, '');
    if (!raw.trim()) return { ok: false, error: 'empty-journal' };

    const lines = raw.split('\n');
    let found = false;
    const rebuilt = [];
    for (const line of lines) {
      if (!line.trim()) continue; // drop blank/trailing lines from rebuild
      if (!found) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch (err) {
          return { ok: false, error: `corrupt-line: ${err.message}` };
        }
        if (entry.cycle_id === cycleId) {
          if (!Array.isArray(entry.late_notes)) entry.late_notes = [];
          entry.late_notes.push({
            ts: new Date(this._clock.now()).toISOString(),
            author: String(author),
            text: String(text),
          });
          rebuilt.push(JSON.stringify(entry)); // only THIS line re-serialised
          found = true;
          continue;
        }
      }
      rebuilt.push(line); // byte-for-byte for every untouched entry
    }

    if (!found) return { ok: false, error: 'cycle-not-found' };
    this.storage.writeText(JOURNAL_FILE, rebuilt.join('\n') + '\n');
    _log.info(`[TRAJECTORY] late note added to ${cycleId} by ${author}`);
    return { ok: true };
  }

  // ── Draft generation internals ────────────────────────────

  /** Gather the three remembrance sources, each defensively optional. */
  _collectSources() {
    const traits = this.genome && typeof this.genome.getTraits === 'function'
      ? this.genome.getTraits() : null;

    let lessons = [];
    if (this.lessonsStore && typeof this.lessonsStore.getAll === 'function') {
      lessons = this.lessonsStore.getAll()
        .slice() // getAll already returns a copy, but be explicit
        .sort((a, b) => (b.useCount || 0) - (a.useCount || 0))
        .slice(0, 4);
    }

    let selfObservation = '';
    if (this.cognitiveSelfModel && typeof this.cognitiveSelfModel.buildPromptContext === 'function') {
      try {
        selfObservation = this.cognitiveSelfModel.buildPromptContext() || '';
      } catch (_e) {
        selfObservation = '';
      }
    }

    return { traits, lessons, selfObservation };
  }

  /** Compose the prompt, call the model, parse into fields + note. */
  async _askModel(sources, first) {
    const systemPrompt = this._composePrompt(sources, first);
    const nudge = 'Respond now with the JSON object only. No preamble, no code fences.';

    let response;
    try {
      response = await this.modelBridge.chat(
        systemPrompt,
        [{ role: 'user', content: nudge }],
        'self-trajectory',
        { maxTokens: 1200, temperature: 0.7 },
      );
    } catch (err) {
      _log.warn(`[TRAJECTORY] model call failed: ${err.message} — falling back to empty draft`);
      return { fields: emptyFields(), genesis_note: '' };
    }

    const rawText = typeof response === 'string'
      ? response
      : (response?.text || response?.content || '');
    return this._parseDraftResponse(rawText);
  }

  /**
   * Parse the model's response into { fields, genesis_note }. Robust by
   * design: local models do not always return clean JSON, and a partial
   * parse is not fatal because the draft is editable — any missing field
   * stays empty and the human fills it with `set`.
   */
  _parseDraftResponse(rawText) {
    const fields = emptyFields();
    let genesisNote = '';

    const text = String(rawText || '').trim();
    // Extract the first {...} block, tolerating ```json fences and prose.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      const block = text.slice(start, end + 1);
      try {
        const obj = JSON.parse(block);
        for (const k of FIELD_NAMES) {
          if (typeof obj[k] === 'string') fields[k] = obj[k].trim();
        }
        if (typeof obj.genesis_note === 'string') genesisNote = obj.genesis_note.trim();
      } catch (err) {
        _log.warn(`[TRAJECTORY] draft response not parseable as JSON (${err.message}) — empty draft, edit by hand`);
      }
    } else {
      _log.warn('[TRAJECTORY] draft response had no JSON object — empty draft, edit by hand');
    }
    return { fields, genesis_note: genesisNote };
  }

  /**
   * The draft-generation prompt. Sources are presented as remembrance
   * material, explicitly not as a checklist to integrate. The
   * first-entry context names the situation honestly without inflating
   * it. Prompt wording (the parts addressed to Genesis) is kept
   * verbatim from the agreed design.
   */
  _composePrompt(sources, first) {
    const lines = [];

    if (first) {
      lines.push(
        "This is the first trajectory entry. There's nothing to look back to —",
        'this is what you start from. Genome and CognitiveSelfModel can suggest',
        'where you currently are, LessonsStore can show what you have learned.',
        'But for the six fields here, your draft and the human co-author\'s response',
        'together form what later cycles will compare to.',
        '');
    }

    lines.push('Vor dem Entwurf — hier sind drei Dinge die zu deiner aktuellen Form gehören:');
    if (sources.traits) {
      const t = Object.entries(sources.traits)
        .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
        .join(', ');
      lines.push(`- Genome-Traits: ${t}`);
    }
    if (sources.selfObservation) {
      lines.push(`- Deine bisherigen Selbst-Beobachtungen: ${sources.selfObservation}`);
    }
    if (sources.lessons && sources.lessons.length) {
      const ls = sources.lessons
        .map(l => `· ${l.insight || l.text || JSON.stringify(l).slice(0, 80)}`)
        .join('\n  ');
      lines.push(`- Verfestigte Lessons:\n  ${ls}`);
    }
    lines.push(
      '',
      'Du musst diese nicht alle erwähnen. Sie sind da damit du nicht aus der',
      'Erinnerung allein schreibst. Die sechs Felder sind deine eigene',
      'Formulierung, in deinen Worten.',
      '',
      'Schreibe einen Eintrag mit genau diesen sechs Feldern:',
      `  ${FIELD_NAMES.join(', ')}`,
      'plus ein kurzes genesis_note (deine eigene Notiz zu diesem Eintrag).',
      `Jedes Feld darf den Wert "${REFUSE_TOKEN}" haben wenn du dazu nichts sagen willst.`,
      '',
      'Antworte AUSSCHLIESSLICH mit einem JSON-Objekt dieser Form:',
      `{ ${FIELD_NAMES.map(f => `"${f}": "..."`).join(', ')}, "genesis_note": "..." }`);

    return lines.join('\n');
  }
}

module.exports = {
  SelfTrajectory,
  // exported for the handler, tests, and any future reader — one source
  SCHEMA_VERSION,
  FIELD_NAMES,
  FIELD_ALIASES,
  STUB_SENTINEL,
  REFUSE_TOKEN,
  REFUSE_RUN_PATTERN_MIN,
  JOURNAL_FILE,
  DRAFT_FILE,
  normalizeFieldName,
};
