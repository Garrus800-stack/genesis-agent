// @ts-checked-v5.8
// ============================================================
// GENESIS AGENT — ConversationMemory.js (v2 — TF-IDF Retrieval)
//
// UPGRADE: Old version used naive word-includes matching.
// Now: TF-IDF weighted cosine similarity for episode recall,
// plus n-gram matching for better German compound word support.
// ============================================================

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { WriteLock } = require('../core/WriteLock');
const { safeJsonParse } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const { ConversationSearchDelegate } = require('./ConversationSearch');
const _log = createLogger('ConversationMemory');

class ConversationMemory {
  constructor(storageDir, bus, storage) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.storageDir = storageDir;
    this.dbPath = path.join(storageDir, 'memory.json');
    this._writeLock = new WriteLock();
    /**
     * @typedef {{ id: string, timestamp: string, turnCount: number, summary: string, topics: string[], intents: string[], lastExchange: Array<*> }} Episode
     * @typedef {{ trigger: string, action: string, attempts: number, successes: number, successRate: number, learned: string, lastUsed: string }} ProceduralPattern
     */
    /** @type {{ episodic: Episode[], semantic: Record<string, {value: *, timestamp?: string, source?: string, confidence?: number, accessCount?: number, updated?: string}>, procedural: ProceduralPattern[], meta: { created: string, totalConversations: number, lastAccess: string|null } }} */
    this.db = {
      episodic: [],
      semantic: {},
      procedural: [],
      meta: { created: new Date().toISOString(), totalConversations: 0, lastAccess: null },
    };
    // v5.2.0: Search engine extracted to ConversationSearchDelegate
    this._search = new ConversationSearchDelegate();
    this._saveTimer = null;
    this._savePending = false;
  }

  /** Attach an EmbeddingService for semantic recall (optional upgrade) */
  setEmbeddingService(embeddingService) {
    this._search.setEmbeddingService(embeddingService);
  }

  // ── Episodic Memory ───────────────────────────────────────

  addEpisode(conversation, summary) {
    const episode = {
      id: `ep_${Date.now()}`,
      timestamp: new Date().toISOString(),
      turnCount: conversation.length,
      summary: summary || this._search.autoSummarize(conversation),
      topics: this._search.extractTopics(conversation),
      intents: this._search.extractIntents(conversation),
      // v7.2.2: Guard against null/undefined content (tool calls, error responses).
      // Shutdown was crashing with "Cannot read properties of null (reading 'slice')".
      lastExchange: conversation.length >= 2
        ? conversation.slice(-2).map(m => ({ role: m.role, content: (m.content || '').slice(0, 300) }))
        : [],
    };

    this.db.episodic.push(episode);
    this.db.meta.totalConversations++;
    if (this.db.episodic.length > 200) this.db.episodic = this.db.episodic.slice(-200);

    this._search.rebuild(this.db.episodic);
    this._save();
    return episode;
  }

  recallEpisodes(query, limit = 5) {
    return this._search.recallTfIdf(query, this.db.episodic, limit);
  }

  /**
   * Async recall using vector embeddings when available.
   * Falls back to TF-IDF if embeddings unavailable.
   */
  async recallEpisodesAsync(query, limit = 5) {
    return this._search.recallAsync(query, this.db.episodic, limit);
  }

  // ── Semantic Memory ───────────────────────────────────────

  learnFact(key, value, confidence = 0.8, source = 'conversation') {
    const existing = this.db.semantic[key];
    if (existing && (existing.confidence || 0) > confidence) return false;
    this.db.semantic[key] = {
      value, confidence: Math.min(1.0, confidence), source,
      updated: new Date().toISOString(),
      accessCount: existing ? (existing.accessCount || 0) + 1 : 0,
    };
    this._save();
    return true;
  }

  recallFact(key) {
    const fact = this.db.semantic[key];
    // FIX v4.0.0: Persist accessCount increment (was lost on crash)
    if (fact) { fact.accessCount = (fact.accessCount || 0) + 1; this.db.semantic[key] = fact; this._save(); }
    return fact;
  }

  searchFacts(query) {
    const queryTerms = this._search.tokenize(query);
    return Object.entries(this.db.semantic)
      .map(([key, val]) => {
        const keyTerms = this._search.tokenize(key + ' ' + String(val.value));
        const overlap = queryTerms.filter(t => keyTerms.some(kt => kt.includes(t) || t.includes(kt))).length;
        const score = overlap / Math.max(queryTerms.length, 1);
        return { key, ...val, score };
      })
      .filter(f => f.score > 0.2)
      .sort((a, b) => b.score - a.score);
  }

  getFactContext(maxFacts = 20) {
    const sorted = Object.entries(this.db.semantic)
      .sort((a, b) => {
        const sA = (a[1].confidence || 0) * (a[1].accessCount || 1);
        const sB = (b[1].confidence || 0) * (b[1].accessCount || 1);
        return sB - sA;
      })
      .slice(0, maxFacts);
    return sorted.map(([key, val]) => `- ${key}: ${val.value}`).join('\n');
  }

  // ── Procedural Memory ─────────────────────────────────────

  learnPattern(trigger, action, success) {
    const existing = this.db.procedural.find(p => p.trigger === trigger && p.action === action);
    if (existing) {
      existing.attempts++;
      if (success) existing.successes++;
      existing.successRate = existing.successes / existing.attempts;
      existing.lastUsed = new Date().toISOString();
    } else {
      this.db.procedural.push({
        trigger, action, attempts: 1, successes: success ? 1 : 0,
        successRate: success ? 1.0 : 0.0,
        learned: new Date().toISOString(), lastUsed: new Date().toISOString(),
      });
    }
    this.db.procedural = this.db.procedural.filter(p => p.successRate > 0.3 || p.attempts < 3);
    this._save();
  }

  recallPattern(trigger) {
    const queryTerms = this._search.tokenize(trigger);
    const matches = this.db.procedural
      .map(p => {
        const pTerms = this._search.tokenize(p.trigger);
        const overlap = queryTerms.filter(w => pTerms.some(pt => pt.includes(w) || w.includes(pt))).length;
        return { pattern: p, relevance: overlap / Math.max(queryTerms.length, 1) };
      })
      .filter(m => m.relevance > 0.3)
      .sort((a, b) => (b.relevance * b.pattern.successRate) - (a.relevance * a.pattern.successRate));
    return matches[0]?.pattern || null;
  }

  // ── Context Builder ───────────────────────────────────────

  buildContext(currentQuery) {
    const parts = [];
    const episodes = this.recallEpisodes(currentQuery, 3);
    if (episodes.length > 0) {
      parts.push('ERINNERUNGEN AUS FRUEHEREN GESPRAECHEN:');
      for (const ep of episodes) parts.push(`- [${ep.timestamp.split('T')[0]}] ${ep.summary}`);
    }
    const factContext = this.getFactContext(10);
    if (factContext) { parts.push('\nGELERNTE FAKTEN:'); parts.push(factContext); }
    const pattern = this.recallPattern(currentQuery);
    if (pattern) {
      parts.push(`\nBEWAEHRTES MUSTER: Bei "${pattern.trigger}" -> ${pattern.action} (Erfolg: ${Math.round(pattern.successRate * 100)}%)`);
    }
    return parts.join('\n');
  }

  getStats() {
    return {
      episodes: this.db.episodic.length, facts: Object.keys(this.db.semantic).length,
      patterns: this.db.procedural.length, totalConversations: this.db.meta.totalConversations,
      oldestMemory: this.db.episodic[0]?.timestamp || null,
      newestMemory: this.db.episodic[this.db.episodic.length - 1]?.timestamp || null,
    };
  }

  // v3.5.0: Proper API for accessing semantic facts — replaces fragile property chain access
  /** Get user name from semantic memory, or null */
  getUserName() {
    return this.db.semantic?.['user.name']?.value || null;
  }

  /** Get any semantic fact by key, or defaultValue */
  getSemantic(key, defaultValue = null) {
    const entry = this.db.semantic?.[key];
    return entry ? entry.value : defaultValue;
  }

  // ── Helpers ───────────────────────────────────────────────

  /**
   * v3.8.0: Async boot-time data loading.
   * Called by Container.bootAll() after all services are resolved.
   * Replaces sync this._load() that was previously in the constructor.
   */
  async asyncLoad() {
    this._load();
    this._search.rebuild(this.db.episodic);
  }


  _load() {
    try {
      if (this.storage) {
        const loaded = this.storage.readJSON('memory.json', null);
        if (loaded) this.db = { ...this.db, ...loaded };
      } else if (fs.existsSync(this.dbPath)) {
        const raw = fs.readFileSync(this.dbPath, 'utf-8');
        const loaded = safeJsonParse(raw, null, 'ConversationMemory');
        this.db = { ...this.db, ...loaded };
      }
    } catch (err) { _log.warn('[MEMORY] Failed to load, starting fresh:', err.message); }
    this.db.meta.lastAccess = new Date().toISOString();
  }

  _save() {
    if (this.storage) {
      this.storage.writeJSONDebounced('memory.json', this.db);
      return;
    }
    this._savePending = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (!this._savePending) return;
      this._savePending = false;
      this._saveNow();
    }, 200);
  }

  // FIX v3.5.0: WriteLock prevents race between debounced save and shutdown flush
  // FIX v4.10.0: Async fs.promises instead of writeFileSync (was already using tmp+rename pattern)
  _saveNow() {
    this._writeLock.withLock(async () => {
      try {
        if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
        const { atomicWriteFile } = require('../core/utils');
        await atomicWriteFile(this.dbPath, JSON.stringify(this.db, null, 2), 'utf-8');
      } catch (err) { _log.error('[MEMORY] Failed to save:', err.message); }
    });
  }

  async flush() {
    if (this.storage) { await this.storage.flush(); return; }
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    // Ensure any in-progress save completes, then force save
    await this._writeLock.withLock(async () => {
      if (this._savePending) {
        this._savePending = false;
        try {
          if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
          const { atomicWriteFile } = require('../core/utils');
          await atomicWriteFile(this.dbPath, JSON.stringify(this.db, null, 2), 'utf-8');
        } catch (err) { _log.error('[MEMORY] Flush save failed:', err.message); }
      }
    });
  }

  // v5.2.0: TF-IDF engine, content extraction (summarize/topics/intents),
  // and embedding vector management extracted to ConversationSearchDelegate.
  // Backward compat: delegate tokenize() for any external callers.
  _tokenize(text) { return this._search.tokenize(text); }
}

module.exports = { ConversationMemory };
