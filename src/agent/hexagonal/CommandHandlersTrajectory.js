// @ts-checked-v5.7
// ============================================================
// GENESIS — CommandHandlersTrajectory.js (v7.9.15)
//
// Thin chat handler for /trajectory. Owns no logic — parses the
// subcommand, calls SelfTrajectory, renders the result. Its own
// domain (identity-persistence), so a separate mixin rather than
// an addition to CommandHandlersGoals (goal-management).
//
// Prototype-Delegation from CommandHandlers.js via Object.assign.
// Strings are inline English, matching the recent koennen-family
// handlers (affect-trail, skills-pending) rather than lang.t.
//
// Subcommands:
//   /trajectory new                        — show draft (or generate one)
//   /trajectory new set <field>: <text>    — set a draft field
//   /trajectory new note genesis: <text>   — set the genesis note (in draft)
//   /trajectory new note garrus: <text>    — set the human note (in draft)
//   /trajectory new commit                 — commit the draft to the journal
//   /trajectory new discard                — drop the draft, no commit
//   /trajectory show [cycle_id]            — show latest / a specific entry
//   /trajectory list [--all]               — list cycles (latest 10 / all)
//   /trajectory note <cycle_id> <text>     — late note on a committed entry
//   /trajectory history [cycle_id]         — full edit history of an entry
//   /trajectory events                     — significant-event distribution (per type + per day)
//   /trajectory review                     — score the last cycle (silent calibration) + emit a review thought
//   /trajectory calibration                — score history + per-field null-rate distribution
//
// `note` appears twice on purpose: `new note <who>:` writes a note IN
// the draft during authoring; `note <cycle_id>` appends a LATE note to
// an already-committed entry. The help text disambiguates them. Not
// renamed to `new genesis-note:` because the notes are two more string
// fields, not a privileged type.
// ============================================================

'use strict';

// Split "key: value" on the FIRST colon only. The value may itself
// contain colons (reflective prose) and newlines (multi-paragraph) —
// the raw message reaches the handler intact, so [\s\S] / indexOf
// preserve both.
function splitFirstColon(s) {
  const idx = s.indexOf(':');
  if (idx === -1) return null;
  return { key: s.slice(0, idx).trim(), value: s.slice(idx + 1).trim() };
}

const commandHandlersTrajectory = {

  async trajectory(message) {
    if (!this.selfTrajectory) return 'SelfTrajectory not available.';

    // [ \t]* (not \s*) between tokens so a newline inside a value is
    // never consumed as a separator; [\s\S]* captures the multi-line rest.
    const m = (message || '').match(
      /(?:^|\s)\/(?:trajectory|trajektorie)\b[ \t]*(\w+)?[ \t]*([\s\S]*)$/i);
    const sub = (m && m[1] ? m[1] : '').toLowerCase();
    const rest = (m && m[2]) ? m[2] : '';

    if (!sub || sub === 'new')  return this._trajectoryNew(rest);
    if (sub === 'show')     return this._trajectoryShow(rest.trim());
    if (sub === 'list')     return this._trajectoryList(rest.trim());
    if (sub === 'note')     return this._trajectoryLateNote(rest);
    if (sub === 'history')  return this._trajectoryHistory(rest.trim());
    if (sub === 'events')   return this._trajectoryEvents();
    if (sub === 'review')   return this._trajectoryReview();
    if (sub === 'calibration' || sub === 'cal') return this._trajectoryCalibration();
    return 'Unknown subcommand. Use: new | show | list | note | history | events | review | calibration';
  },

  // ── /trajectory new + nested actions ──────────────────────

  async _trajectoryNew(rest) {
    const am = rest.match(/^(\w+)?[ \t]*([\s\S]*)$/);
    const action = (am && am[1] ? am[1] : '').toLowerCase();
    const actionRest = (am && am[2]) ? am[2] : '';

    if (!action)                return this._trajectoryNewBare();
    if (action === 'set')       return this._trajectoryNewSet(actionRest);
    if (action === 'note')      return this._trajectoryNewNote(actionRest);
    if (action === 'commit')    return this._trajectoryNewCommit();
    if (action === 'discard')   return this._trajectoryNewDiscard();
    return 'Usage: /trajectory new [set <field>: <text> | note <genesis|garrus>: <text> | commit | discard]';
  },

  // Bare /trajectory new — NEVER silently regenerates over an existing
  // draft (the draft holds real work). If a draft exists, show it plus
  // the available actions; that IS the "continue or restart" choice. To
  // start over, the human discards first. Only with no draft do we generate.
  async _trajectoryNewBare() {
    const existing = this.selfTrajectory.readDraft();
    if (existing) {
      return this._renderDraft(existing, 'A draft is already in progress (not regenerated).');
    }
    const draft = await this.selfTrajectory.generateDraft();
    const head = draft.first_entry
      ? 'First trajectory entry — draft created.'
      : 'Draft created.';
    return this._renderDraft(draft, head);
  },

  _trajectoryNewSet(actionRest) {
    const parts = splitFirstColon(actionRest);
    if (!parts || !parts.key) {
      return 'Usage: /trajectory new set <field>: <text>';
    }
    const r = this.selfTrajectory.setDraftField(parts.key, parts.value);
    if (!r.ok) {
      if (r.error === 'no-draft') return 'No draft. Start one with /trajectory new.';
      if (r.error === 'unknown-field') {
        return `Unknown field "${parts.key}". Valid fields: ${this.selfTrajectory.fieldNames.join(', ')}.`;
      }
      return `Could not set field: ${r.error}`;
    }
    return this._renderDraft(this.selfTrajectory.readDraft(), `Set ${r.field}.`);
  },

  _trajectoryNewNote(actionRest) {
    const parts = splitFirstColon(actionRest);
    if (!parts || !parts.key) {
      return 'Usage: /trajectory new note <genesis|garrus>: <text>';
    }
    const who = parts.key.toLowerCase();
    const r = this.selfTrajectory.setDraftNote(who, parts.value);
    if (!r.ok) {
      if (r.error === 'no-draft') return 'No draft. Start one with /trajectory new.';
      if (r.error === 'unknown-author') return 'Note author must be "genesis" or "garrus".';
      return `Could not set note: ${r.error}`;
    }
    return this._renderDraft(this.selfTrajectory.readDraft(), `Set ${who} note.`);
  },

  _trajectoryNewCommit() {
    const r = this.selfTrajectory.commit();
    if (!r.ok) {
      if (r.error === 'no-draft') return 'No draft to commit. Start one with /trajectory new.';
      if (r.error === 'empty-field') return `Cannot commit: field "${r.detail}" is empty. Use /trajectory new set ${r.detail}: <text>.`;
      if (r.error === 'stub-field') return `Cannot commit: field "${r.detail}" still holds the placeholder. Write it with /trajectory new set ${r.detail}: <text>.`;
      if (r.error === 'first-entry-note') return `Cannot commit the first entry without a non-empty ${r.detail}. Use /trajectory new note ${r.detail === 'genesis_note' ? 'genesis' : 'garrus'}: <text>.`;
      return `Cannot commit: ${r.error}`;
    }
    const e = r.entry;
    return `Committed ${e.cycle_id} (author: ${this._authorLabel(e.author)}). The journal is append-only — this entry is now permanent.`;
  },

  _trajectoryNewDiscard() {
    if (!this.selfTrajectory.hasDraft()) return 'No draft to discard.';
    this.selfTrajectory.deleteDraft();
    return 'Draft discarded. Start fresh with /trajectory new.';
  },

  // ── reads ─────────────────────────────────────────────────

  _trajectoryShow(arg) {
    const entry = arg
      ? this.selfTrajectory.readEntry(arg)
      : this.selfTrajectory.latestEntry();
    if (!entry) {
      return arg
        ? `No entry with cycle_id "${arg}". See /trajectory list.`
        : 'No trajectory entries yet. Start the first with /trajectory new.';
    }
    return this._renderEntry(entry);
  },

  _trajectoryList(arg) {
    const all = this.selfTrajectory.readEntries();
    if (all.length === 0) return 'No trajectory entries yet. Start the first with /trajectory new.';
    const showAll = /(^|\s)--all(\s|$)/i.test(arg);
    // newest first
    const ordered = all.slice().reverse();
    const shown = showAll ? ordered : ordered.slice(0, 10);
    const rows = shown.map(e => {
      const start = (e.wallclock_start || '').slice(0, 10);
      const end = (e.wallclock_end || '').slice(0, 10);
      const author = this._authorLabel(e.author);
      const first = e.first_entry ? '*first' : '';
      return `${e.cycle_id.padEnd(22)}${(start + ' → ' + end).padEnd(28)}${author.padEnd(12)}${first}`;
    });
    const header = `${'cycle_id'.padEnd(22)}${'start → end'.padEnd(28)}${'author'.padEnd(12)}`;
    const sep = '─'.repeat(70);
    const more = (!showAll && ordered.length > 10)
      ? `\n… ${ordered.length - 10} more — see /trajectory list --all`
      : '';
    return `**Trajectory** (${all.length} ${all.length === 1 ? 'cycle' : 'cycles'}):\n\n${header}\n${sep}\n${rows.join('\n')}${more}`;
  },

  _trajectoryHistory(arg) {
    const entry = arg
      ? this.selfTrajectory.readEntry(arg)
      : this.selfTrajectory.latestEntry();
    if (!entry) {
      return arg
        ? `No entry with cycle_id "${arg}". See /trajectory list.`
        : 'No trajectory entries yet.';
    }
    const edits = Array.isArray(entry.editing_history) ? entry.editing_history : [];
    if (edits.length === 0) return `${entry.cycle_id}: No edits yet.`;
    // ascending (oldest first) — history shows how it became what it is
    const lines = edits.map(ed => {
      const ts = (ed.ts || '').replace('T', ' ').slice(0, 16);
      const note = ed.note ? ` — ${ed.note}` : '';
      return `[${ts}] ${ed.author} · ${ed.field}: "${this._short(ed.from)}" → "${this._short(ed.to)}"${note}`;
    });
    return `**Edit history — ${entry.cycle_id}** (oldest first):\n\n${lines.join('\n')}`;
  },

  _trajectoryLateNote(rest) {
    const t = rest.trim();
    // first token = cycle_id, remainder = note text (may be multi-word/line)
    const m = t.match(/^(\S+)[ \t]+([\s\S]+)$/);
    if (!m) return 'Usage: /trajectory note <cycle_id> <text>';
    const cycleId = m[1];
    const text = m[2].trim();
    const r = this.selfTrajectory.addLateNote(cycleId, 'garrus', text);
    if (!r.ok) {
      if (r.error === 'cycle-not-found') return `No entry with cycle_id "${cycleId}". See /trajectory list.`;
      if (r.error === 'empty-journal') return 'No trajectory entries yet.';
      return `Could not add late note: ${r.error}`;
    }
    return `Late note added to ${cycleId}. The entry itself is unchanged.`;
  },

  // ── rendering helpers ─────────────────────────────────────

  _renderDraft(draft, head) {
    const fieldLines = this.selfTrajectory.fieldNames.map(k => `  ${k}: ${draft.fields[k] || '(empty)'}`).join('\n');
    const gN = draft.genesis_note ? draft.genesis_note : '(empty)';
    const hN = draft.garrus_note ? draft.garrus_note : '(empty)';
    const firstTag = draft.first_entry ? ' [first entry]' : '';
    return [
      `**Draft${firstTag}**${head ? ' — ' + head : ''}`,
      '',
      fieldLines,
      `  genesis_note: ${gN}`,
      `  garrus_note: ${hN}`,
      '',
      'Actions: /trajectory new set <field>: <text> · note <genesis|garrus>: <text> · commit · discard',
    ].join('\n');
  },

  // ── /trajectory events — significant-event distribution ───
  // Reads the passive EventCounter (late-bound on SelfTrajectory). Shows
  // the whole journal: total, per-type counts (busiest first), and the
  // per-day buckets. Readable from the moment the counter is live — not
  // gated on a committed entry — so the real per-day distribution is
  // visible during the (multi-day) first-entry authoring window.
  _trajectoryEvents() {
    const ec = this.selfTrajectory.eventCounter;
    if (!ec || typeof ec.summary !== 'function') {
      return 'Event counter not available.';
    }
    const s = ec.summary();
    if (!s.total) {
      return 'No significant events recorded yet. The counter observes goal ' +
        '(completed/failed/abandoned), lesson, emotional-watchdog, and session events.';
    }
    const byType = Object.entries(s.byType)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `  ${k.padEnd(24)} ${v}`).join('\n');
    const byDay = Object.entries(s.byDay)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([d, v]) => `  ${d}  ${v}`).join('\n');
    const dayCount = Object.keys(s.byDay).length;
    return [
      `**Significant events** — ${s.total} recorded across ${dayCount} day(s)`,
      '',
      'By type (busiest first):',
      byType,
      '',
      'By day:',
      byDay,
    ].join('\n');
  },

  // ── /trajectory review — score the last cycle (silent calibration) ────
  // Computes the ternary sign-scores for the two sign-fields of the most
  // recent committed cycle, appends a calibration line, optionally emits a
  // manual prediction-mechanism-review thought, and renders the result.
  _trajectoryReview() {
    const tc = this.trajectoryCalibration;
    if (!tc || typeof tc.reviewCycle !== 'function') {
      return 'Trajectory calibration not available.';
    }
    const r = tc.reviewCycle();
    if (!r.ok) {
      if (r.error === 'no-entries') return 'No committed cycle to review yet.';
      if (r.error === 'no-trajectory') return 'SelfTrajectory not available.';
      return `Could not review: ${r.error || 'unknown'}.`;
    }

    const fmt = (v) => (v === 1 ? 'matched (+1)' : v === -1 ? 'opposite (−1)' : '— (no score)');
    const lines = [
      `**Calibration review — ${r.cycle_id}** (silent; feeds no decision logic)`,
      '',
      `  wachstum   expected ${this._dir(r.expected.wachstum)} · actual ${this._dir(r.actual.wachstum)} → ${fmt(r.scores.wachstum)}`,
      `  schwaeche  expected ${this._dir(r.expected.schwaeche)} · actual ${this._dir(r.actual.schwaeche)} → ${fmt(r.scores.schwaeche)}`,
    ];
    if (typeof r.value_drift === 'number') {
      lines.push(`  value      position drift ${r.value_drift.toFixed(3)} (measured, no threshold)`);
    }
    lines.push('');
    lines.push('Traits, emotion, beziehung, value carry no sign-score (recorded as positions only).');

    // Emit the manual prediction-mechanism-review thought (no auto-trigger
    // anywhere else). innerSpeech absent → score still rendered, just no
    // thought surfaced. contextRefs anchor the concrete-ref sanity check.
    if (this.innerSpeech && typeof this.innerSpeech.emit === 'function') {
      const scored = Object.entries(r.scores)
        .filter(([, v]) => v === 1 || v === -1)
        .map(([f]) => f);
      const text = `Calibration review of cycle ${r.cycle_id}: ` +
        `wachstum ${fmt(r.scores.wachstum)}, schwaeche ${fmt(r.scores.schwaeche)}.`;
      try {
        this.innerSpeech.emit(text, 'prediction-mechanism-review', {
          sourceModule: 'CommandHandlersTrajectory',
          significance: 0.6,
          contextRefs: { cycleId: r.cycle_id, fields: scored.length ? scored : ['wachstum', 'schwaeche'] },
        });
      } catch (_e) { /* emit never blocks the command result */ }
    }

    return lines.join('\n');
  },

  // ── /trajectory calibration — score history + per-field null distribution
  // The dashboard view the observation phase actually needs: the
  // distribution over cycles, not a single score. The null rate is split
  // per field on purpose — a high null rate on schwaeche ALONE points at
  // the capability-buffer source, not at the ternary frame.
  _trajectoryCalibration() {
    const tc = this.trajectoryCalibration;
    if (!tc || typeof tc.getCalibrationHistory !== 'function') {
      return 'Trajectory calibration not available.';
    }
    const hist = tc.getCalibrationHistory();
    if (!hist.length) {
      return 'No calibration scores yet. Run /trajectory review after a cycle is committed.';
    }
    const dist = tc.getScoreDistribution();
    const fmt = (v) => (v === 1 ? '+1' : v === -1 ? '−1' : '·');

    const recent = hist.slice(-8).map(rec => {
      const sc = rec.scores || {};
      const vd = typeof rec.value_drift === 'number' ? ` value-drift ${rec.value_drift.toFixed(3)}` : '';
      return `  ${String(rec.cycle_id).padEnd(10)} wachstum ${fmt(sc.wachstum)}  schwaeche ${fmt(sc.schwaeche)}${vd}`;
    }).join('\n');

    const perField = Object.entries(dist.perField).map(([f, p]) =>
      `  ${f.padEnd(10)} matched ${p.matched}  opposite ${p.opposite}  null ${p.nulls}  (null-rate ${p.nullRate.toFixed(2)})`
    ).join('\n');

    // v7.9.19: refuse-run + cycle-age diagnostics. Read from SelfTrajectory
    // (the entry owner) via getDiagnostics(), shown alongside the calibration
    // tally. Pure display — the counting lives in the service; the handler
    // only formats and marks a run >= refusePatternMin. Two services, each
    // over its own data; this handler stays render-only.
    const diagLines = [];
    const st = this.selfTrajectory;
    if (st && typeof st.getDiagnostics === 'function') {
      const diag = st.getDiagnostics();
      const active = Object.entries(diag.refuseRuns).filter(([, n]) => n >= 1);
      const refuseBody = active.length
        ? active.map(([f, n]) =>
            `  ${f.padEnd(10)} refuse ×${n}${n >= diag.refusePatternMin ? ' (pattern)' : ''}`).join('\n')
        : '  (none)';
      diagLines.push('', 'Refuse runs (consecutive, from latest cycle):', refuseBody);
      if (diag.lastEntryAgeDays !== null) {
        diagLines.push('', `Last cycle committed ${diag.lastEntryAgeDays} day(s) ago.`);
      }
    }

    return [
      `**Calibration** — ${dist.cycles} scored cycle(s), silent observation`,
      '',
      'Recent (oldest first):',
      recent,
      '',
      'Per-field tally + null-rate:',
      perField,
      '',
      'A high null-rate on schwaeche alone points at the capability-source size, not the frame.',
      ...diagLines,
    ].join('\n');
  },

  /** Render a direction value for the review output. */
  _dir(v) {
    return v === 1 ? '↑' : v === -1 ? '↓' : v === 0 ? '→' : '∅';
  },

  _renderEntry(entry) {
    const start = (entry.wallclock_start || '').replace('T', ' ').slice(0, 16);
    const end = (entry.wallclock_end || '').replace('T', ' ').slice(0, 16);
    const fieldLines = this.selfTrajectory.fieldNames.map(k => `  ${k}: ${entry.fields[k]}`).join('\n');
    const out = [
      `**${entry.cycle_id}**${entry.first_entry ? ' (first entry)' : ''}`,
      `${start} → ${end} · author: ${this._authorLabel(entry.author)} · events: ${typeof entry.event_count === 'number' ? entry.event_count : '—'}`,
      '',
      fieldLines,
    ];
    if (entry.genesis_note) out.push('', `genesis_note: ${entry.genesis_note}`);
    if (entry.garrus_note) out.push(`garrus_note: ${entry.garrus_note}`);

    const edits = Array.isArray(entry.editing_history) ? entry.editing_history : [];
    if (edits.length > 0) {
      // descending (newest first) — show answers "what moved most recently"
      const desc = edits.slice().reverse();
      const shown = desc.slice(0, 5);
      const editLines = shown.map(ed => {
        const ts = (ed.ts || '').replace('T', ' ').slice(0, 16);
        return `  [${ts}] ${ed.author} · ${ed.field}: "${this._short(ed.from)}" → "${this._short(ed.to)}"`;
      });
      const more = edits.length > 5 ? `\n  … ${edits.length - 5} more — see /trajectory history ${entry.cycle_id}` : '';
      out.push('', `Edits (newest first):\n${editLines.join('\n')}${more}`);
    }

    const lateNotes = Array.isArray(entry.late_notes) ? entry.late_notes : [];
    if (lateNotes.length > 0) {
      const lnLines = lateNotes.map(n => {
        const ts = (n.ts || '').replace('T', ' ').slice(0, 16);
        return `  [${ts}] ${n.author}: ${n.text}`;
      });
      out.push('', `Late notes:\n${lnLines.join('\n')}`);
    }
    return out.join('\n');
  },

  _authorLabel(author) {
    const a = Array.isArray(author) ? author : [];
    return a.includes('garrus') ? 'g+garrus' : 'genesis';
  },

  _short(s) {
    const str = String(s == null ? '' : s).replace(/\n/g, ' ');
    return str.length > 60 ? str.slice(0, 57) + '…' : str;
  },
};

module.exports = { commandHandlersTrajectory };
