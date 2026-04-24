// ============================================================
// GENESIS — SelfModelCapabilities.js (v7.4.1)
//
// Extracted from SelfModel.js to keep the main file under the
// 700-LOC threshold. Contains capability detection and helpers:
//   - _detectCapabilities — 4-signal derivation
//   - _classToCapId       — PascalCase → kebab-case
//   - _splitCamelCase     — CamelCase → word array
//   - _extractKeywordsFromHeader — header comment → keywords
//
// Prototype delegation from the bottom of SelfModel.js.
// External API unchanged.
// ============================================================

'use strict';

const selfModelCapabilities = {

  // v7.3.0: Capability Honesty — systematic derivation from four signals
  // (file path, class name, header comment, manifest tags) instead of a
  // hardcoded 9-element list. See CHANGELOG v7.3.0 for rationale.
  //
  // Produces two outputs:
  //   manifest.capabilities          → string[] (IDs only, backward compatible)
  //   manifest.capabilitiesDetailed  → object[] (full detail for richer consumers)
  _detectCapabilities() {
    const detailed = [];
    const seenIds = new Set();

    // Seed: always-present core capabilities (not tied to specific modules)
    const seeds = [
      { id: 'chat', category: 'core', description: 'Converse with the user', keywords: ['chat', 'talk', 'conversation', 'dialogue'] },
      { id: 'self-awareness', category: 'core', description: 'Reflect on own state', keywords: ['self', 'aware', 'introspect', 'reflect'] },
    ];
    for (const s of seeds) {
      detailed.push({ id: s.id, module: null, class: null, category: s.category, tags: [], description: s.description, keywords: s.keywords });
      seenIds.add(s.id);
    }

    // Build serviceName → tags lookup from injected manifest meta
    const metaByClass = new Map();
    if (this._manifestMeta) {
      for (const [svcName, svcMeta] of Object.entries(this._manifestMeta)) {
        const candidateClass = svcName.charAt(0).toUpperCase() + svcName.slice(1);
        metaByClass.set(candidateClass, svcMeta);
      }
    }

    // Iterate all source modules
    for (const [filePath, mod] of Object.entries(this.manifest.modules)) {
      // Normalize path separators for cross-platform (Windows uses \)
      const normalized = filePath.replace(/\\/g, '/');
      if (!normalized.startsWith('src/')) continue;
      if (!mod.classes || mod.classes.length === 0) continue;

      for (const className of mod.classes) {
        const id = this._classToCapId(className);
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        // Signal 1: path → category
        const pathParts = filePath.split(/[\\/]/);
        const agentIdx = pathParts.indexOf('agent');
        const category = (agentIdx >= 0 && pathParts[agentIdx + 1]) ? pathParts[agentIdx + 1] : 'misc';

        // Signal 2: class name → keyword seed
        const classKeywords = this._splitCamelCase(className).map(w => w.toLowerCase());

        // Signal 3: header comment → description + keywords
        const description = (mod.description || '').trim();
        const headerKeywords = this._extractKeywordsFromHeader(description);

        // Signal 4: manifest tags → curated semantic labels
        const meta = metaByClass.get(className);
        const manifestTags = meta ? [...(meta.tags || [])] : [];

        // Compose unified keyword set
        const keywords = new Set([
          id,
          ...classKeywords,
          ...headerKeywords,
          ...manifestTags.map(t => t.toLowerCase()),
          category.toLowerCase(),
        ]);
        const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'for', 'and', 'or', 'is', 'as', 'on', 'in', 'at', 'by', 'js', 'misc']);
        const cleanKeywords = [...keywords].filter(k => k && k.length >= 3 && !STOP.has(k));

        detailed.push({
          id,
          module: filePath.replace(/\\/g, '/'),
          class: className,
          category,
          tags: manifestTags,
          description: description.slice(0, 200),
          keywords: cleanKeywords.sort(),
        });
      }
    }

    this.manifest.capabilitiesDetailed = detailed;
    return detailed.map(c => c.id);
  },

  // v7.3.0: Convert "HomeostasisV2" → "homeostasis-v2", "IdleMind" → "idle-mind"
  _classToCapId(className) {
    return className
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
      .toLowerCase();
  },

  // v7.3.0: Split "CognitiveSelfModel" → ["Cognitive", "Self", "Model"]
  _splitCamelCase(s) {
    return s
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/)
      .filter(Boolean);
  },

  // v7.3.0: Parse header description for meaningful keywords.
  _extractKeywordsFromHeader(description) {
    if (!description) return [];
    const STOP_HEADER = new Set([
      'the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'is', 'as', 'on', 'in', 'at', 'by',
      'via', 'with', 'from', 'into', 'that', 'this', 'can', 'are', 'was', 'be', 'has', 'its',
      'it', 'all', 'any', 'not', 'but', 'also', 'when', 'then', 'if', 'how', 'what', 'who',
      'genesis', 'agent', 'module', 'class', 'file', 'code', 'line', 'see',
    ]);
    const words = description
      .toLowerCase()
      .replace(/[^\p{L}\s-]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOP_HEADER.has(w));
    const uniq = [...new Set(words)];
    return uniq.slice(0, 12);
  },
};

module.exports = { selfModelCapabilities };
