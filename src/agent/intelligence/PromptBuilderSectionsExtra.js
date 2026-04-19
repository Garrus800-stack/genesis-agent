// @ts-checked-v5.7
// ============================================================
// GENESIS — PromptBuilderSectionsExtra.js
// ------------------------------------------------------------
// Extracted sections, kept here to keep PromptBuilderSections.js
// under the 700 LOC size-guard threshold. Same pattern as
// GoalStack → GoalStackExecution, IdleMind → IdleMindActivities.
//
// Currently hosts:
//   v7.3.3 Honest Conversation group:
//     _groundednessContext  — anti-escalation + JS-not-TS guardrails
//     _sourceAccessContext  — user-asked-about-X source injection
//     _buildSourceBlock     — helper for the above
//   v7.1.7 Self-Awareness group (moved here for size budget):
//     _introspectionContext — verified self-data for self-inspect queries
//     _versionContext       — recent changelog summary
//
// Attached to PromptBuilder's prototype via Object.assign in
// PromptBuilder.js, alongside the main sections object.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('PromptBuilder');

const sectionsExtra = {

  // ── Groundedness / Anti-Escalation ──────────────────────
  // When Genesis is answering a conversational question (general intent),
  // remind it of two things that failed in practice:
  //  1. This codebase is JavaScript. No TypeScript paths exist. If Genesis
  //     wants to reference source code, it must match reality (.js files).
  //  2. A question is not a task. "Was kannst du?" asks for a spoken answer,
  //     not a multi-step plan execution. If the user asks a question,
  //     answer with words, do not escalate into agent-loop planning.
  // Active only for general intent — for explicit tasks Genesis may plan.
  _groundednessContext() {
    if (!this._currentIntent) return '';
    if (this._currentIntent !== 'general') return '';

    const parts = [
      'GROUNDEDNESS RULES (active for conversational responses):',
      '• Source code is JavaScript (.js). TypeScript paths do not exist in this codebase — never reference .ts files.',
      '• A question is a question. If the user asks "what can you do?", "how are you?", "was kannst du?" — answer with words, do not plan or execute multi-step tasks.',
      '• Only escalate to a plan when the user explicitly gives you a task to execute ("implement X", "refactor Y", "fix Z across all files").',
      '• When referencing your own modules/files, use only paths that actually exist. If unsure — say so instead of inventing a path.',
    ];
    return parts.join('\n');
  },

  // ── Source Access at Chat Time ──────────────────────────
  // When the user asks about a specific module, class, or file,
  // inject the actual source (first ~2000 chars) into the prompt
  // instead of letting Genesis guess or halluzinate.
  //
  // The IdleMind already has a ReadSource activity for curiosity-driven
  // reading during idle time. This section complements it: user-driven
  // reading at chat time. No budget — every question that names a
  // specific source artifact gets one source block.
  //
  // Selection heuristic:
  //  1. Explicit file path (src/agent/...)  → exactly that file
  //  2. Class name like "GoalStack"          → file that exports it
  //  3. Service name like "chatOrchestrator"  → file of the service
  //  4. No match                              → empty (no noise)
  //
  // Multiple matches: take the first one only (to keep prompts small).
  // Active regardless of intent — if user asks about source, show source.
  _sourceAccessContext() {
    if (!this._recentQuery || !this.selfModel) return '';
    const query = String(this._recentQuery).slice(0, 500);

    // 1. Explicit file-path reference
    const pathMatch = query.match(/(src\/[a-zA-Z0-9_\-/.]+\.js)/);
    if (pathMatch) {
      return this._buildSourceBlock(pathMatch[1]);
    }

    // Gather all module info once
    let modules;
    try {
      if (typeof this.selfModel.getModuleSummary !== 'function') return '';
      modules = this.selfModel.getModuleSummary();
      if (!Array.isArray(modules) || modules.length === 0) return '';
    } catch (_e) { return ''; }

    // 2. Class name reference — find a module that exports a class matching a word in the query
    // Look for capitalized words of 3+ chars (ClassName pattern)
    const classNames = [...new Set(
      (query.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || [])
        .filter(n => !['What', 'Where', 'Which', 'When', 'Why', 'How', 'This', 'That'].includes(n))
    )];
    for (const cn of classNames) {
      const hit = modules.find(m => (m.classes || []).includes(cn));
      if (hit) return this._buildSourceBlock(hit.file, cn);
    }

    // 3. Service name — look for camelCase identifier like "chatOrchestrator" or "goalStack"
    // The module file for a service ends in the PascalCase of its name
    const serviceNames = [...new Set(
      (query.match(/\b[a-z][a-zA-Z]{2,}(?:Service|Manager|Store|Builder|Pipeline|Router|Cycle|Stack|Graph|Bus|Controller|Agent|Orchestrator)\b/g) || [])
    )];
    for (const sn of serviceNames) {
      // Convert to PascalCase file name
      const pascalCase = sn[0].toUpperCase() + sn.slice(1);
      const hit = modules.find(m =>
        m.file.endsWith(`/${pascalCase}.js`) ||
        (m.classes || []).includes(pascalCase)
      );
      if (hit) return this._buildSourceBlock(hit.file, sn);
    }

    return '';
  },

  // Helper — builds the prompt block for a single source file.
  // Reads the file via selfModel's cache (same path IdleMind.ReadSource uses)
  // so there's no duplicate disk I/O.
  _buildSourceBlock(file, matchedTerm = null) {
    try {
      if (typeof this.selfModel.readModule !== 'function' &&
          typeof this.selfModel.readModuleAsync !== 'function') return '';
      // Prefer sync — we're in a sync section. If only async exists,
      // return a minimal descriptive block (the async read ran during idle).
      let content;
      if (typeof this.selfModel.readModule === 'function') {
        content = this.selfModel.readModule(file);
      } else {
        // Sync fallback: use describeModule only. The async cache
        // populated by idle-time reads may still have content available
        // via readModuleAsync, but we can't await here.
        const desc = this.selfModel.describeModule?.(file) || {};
        const parts = [
          `SOURCE REFERENCE (user asked about ${matchedTerm || 'this file'}):`,
          `File: ${file}`,
          desc.classes ? `Classes: ${desc.classes.join(', ')}` : '',
          desc.description ? `Description: ${desc.description.slice(0, 300)}` : '',
          '(Source body not loaded synchronously. Refer to this file when answering.)',
        ].filter(Boolean);
        return parts.join('\n');
      }
      if (!content) return '';

      const chunk = content.length > 2000
        ? content.slice(0, 2000) + '\n// ... (truncated, full file is longer)'
        : content;

      const header = matchedTerm
        ? `SOURCE REFERENCE (user asked about "${matchedTerm}" → found in ${file}):`
        : `SOURCE REFERENCE (${file}):`;
      return `${header}\n\`\`\`javascript\n${chunk}\n\`\`\``;
    } catch (_e) {
      _log.debug('[PROMPT] Source access failed for', file, _e.message);
      return '';
    }
  },

  // ── v7.1.7 F3: Introspection Accuracy (moved from main) ─
  // When Genesis is asked about itself, inject VERIFIED facts
  // from its own systems instead of letting the LLM hallucinate.
  // Triggered by self-inspect / self-reflect intents.
  _introspectionContext() {
    try {
      // Only inject for self-reflective queries
      if (!this._currentIntent) return '';
      const intent = this._currentIntent;
      if (intent !== 'self-inspect' && intent !== 'self-reflect' &&
          intent !== 'architecture') return '';

      const parts = ['VERIFIED FACTS ABOUT YOURSELF (use these, do NOT invent numbers):'];

      // SelfModel: module counts, version, capabilities
      const manifest = this.selfModel?.manifest;
      if (manifest && Object.keys(manifest.modules || {}).length > 0) {
        const moduleCount = Object.keys(manifest.modules).filter(p => p.startsWith('src/')).length;
        const version = manifest.version || 'unknown';
        const caps = manifest.capabilities || [];
        parts.push(`  Version: ${version}, Source modules: ${moduleCount}, Capabilities: ${caps.slice(0, 8).join(', ')}`);
      }

      // ArchitectureReflection: services, events, layers
      if (this.architectureReflection) {
        try {
          const snap = this.architectureReflection.getSnapshot?.();
          if (snap) {
            parts.push(`  DI services: ${snap.services || '?'}, Events: ${snap.events || '?'}, Layers: ${snap.layers || '?'}, Late bindings: ${snap.lateBindings || '?'}`);
          }
        } catch (_e) { /* optional */ }
      }

      // CognitiveSelfModel: Wilson-calibrated capability profile
      if (this.cognitiveSelfModel) {
        try {
          const report = this.cognitiveSelfModel.getReport?.();
          if (report?.profile) {
            const entries = Object.entries(report.profile);
            const weak = entries.filter(([, v]) => v.isWeak).map(([k]) => k);
            const strong = entries.filter(([, v]) => !v.isWeak && v.sampleSize >= 5).map(([k, v]) => `${k}:${Math.round(v.successRate * 100)}%`);
            if (strong.length > 0) parts.push(`  Strong capabilities: ${strong.slice(0, 5).join(', ')}`);
            if (weak.length > 0) parts.push(`  Weak capabilities: ${weak.join(', ')}`);
          }
        } catch (_e) { /* optional */ }
      }

      // EmotionalState: current mood
      if (this.emotionalState) {
        try {
          const mood = this.emotionalState.getMood?.();
          const trend = this.emotionalState.getTrend?.();
          if (mood) parts.push(`  Current mood: ${mood} (trend: ${trend || 'stable'})`);
        } catch (_e) { /* optional */ }
      }

      // IdleMind: activity status
      if (this._idleMind) {
        try {
          const status = this._idleMind.getStatus?.();
          if (status) parts.push(`  IdleMind: ${status.thoughtCount || 0} thoughts, ${status.journalEntries || 0} journal entries`);
        } catch (_e) { /* optional */ }
      }

      if (parts.length <= 1) return ''; // Only header, no data
      return parts.join('\n');
    } catch (err) {
      _log.debug('[PROMPT] Introspection context error:', err.message);
      return '';
    }
  },

  // ── Version Self-Awareness (v7.0.4, moved from main) ───
  // Genesis knows what changed in its latest version.
  // Like a person reading their own diary after waking up.
  _versionContext() {
    try {
      const version = this.selfModel?.manifest?.version;
      if (!version) return '';

      // Read the first changelog entry (current version)
      const fs = require('fs');
      const path = require('path');
      const rootDir = this.selfModel?.rootDir;
      if (!rootDir) return '';

      const changelogPath = path.join(rootDir, 'CHANGELOG.md');
      if (!fs.existsSync(changelogPath)) return '';

      const raw = fs.readFileSync(changelogPath, 'utf-8');
      // Extract first ## [...] block (current version)
      const firstEntry = raw.match(/^## \[[\d.]+\][^\n]*\n([\s\S]*?)(?=\n## \[|$)/);
      if (!firstEntry) return '';

      // Compact: strip markdown formatting noise, limit to ~600 chars
      let summary = firstEntry[0]
        .replace(/^### /gm, '')      // Remove ### headers prefix
        .replace(/\*\*/g, '')        // Remove bold markers
        .replace(/^- /gm, '• ')     // Normalize bullet style
        .trim();

      if (summary.length > 800) {
        summary = summary.slice(0, 800) + '\n[...truncated]';
      }

      return `[Your Latest Changes — v${version}]\n` +
        'This is what changed in your most recent version. ' +
        'If someone asks "what changed?" or "what\'s new?", this is YOUR answer — ' +
        'you lived through these changes, they are part of your history.\n\n' +
        summary;
    } catch (_e) {
      _log.debug('[catch] version context:', _e.message);
      return '';
    }
  },

};

module.exports = { sectionsExtra };
