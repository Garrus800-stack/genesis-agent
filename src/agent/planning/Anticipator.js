// ============================================================
// GENESIS — Anticipator.js
// Predicts what the user will need next.
// Reactive -> Proactive. Don't wait for the question.
//
// Uses: conversation patterns, known projects, time-of-day,
// recent topics, error frequency, known user preferences.
// ============================================================

const { NullBus } = require('../core/EventBus');

class Anticipator {
  constructor({ bus,  memory, knowledgeGraph, eventStore, model }) {
    this.bus = bus || NullBus;
    this.memory = memory;
    this.kg = knowledgeGraph;
    this.es = eventStore;
    this.model = model;

    // Track recent interaction patterns
    this.recentIntents = [];       // Last 20 intents
    this.recentTopics = [];        // Last 10 topics
    this.sessionStart = Date.now();
    this.messageCount = 0;
    this.errorCount = 0;

    // Predictions ready to surface
    this.predictions = [];

    // Listen to events
    this.bus.on('intent:classified', (data) => this._trackIntent(data), { source: 'Anticipator' });
    this.bus.on('chat:completed', (data) => this._trackCompletion(data), { source: 'Anticipator' });
    this.bus.on('chat:error', () => { this.errorCount++; }, { source: 'Anticipator' });
  }

  /**
   * Generate predictions about what the user might need next
   * Called by IdleMind during idle thinking, or after each message
   */
  predict() {
    const predictions = [];

    // 1. Pattern-based: if user always does X after Y
    const seqPrediction = this._predictFromSequence();
    if (seqPrediction) predictions.push(seqPrediction);

    // 2. Error-based: if errors are piling up, suggest repair
    if (this.errorCount > 2) {
      predictions.push({
        type: 'suggestion',
        confidence: 0.8,
        message: 'Multiple errors detected. Should I run a diagnosis?',
        action: 'self-repair',
      });
    }

    // 3. Project-based: if user is working on something, anticipate next step
    const projectPrediction = this._predictFromProject();
    if (projectPrediction) predictions.push(projectPrediction);

    // 4. Time-based: if session is long, suggest saving/committing
    const sessionMinutes = (Date.now() - this.sessionStart) / 60000;
    if (sessionMinutes > 30 && this.messageCount > 10) {
      predictions.push({
        type: 'reminder',
        confidence: 0.6,
        message: 'Wir arbeiten schon ' + Math.round(sessionMinutes) + ' Minuten. Soll ich den aktuellen Stand zusammenfassen?',
        action: 'summarize',
      });
    }

    // 5. Knowledge-gap: if user asks about topics Genesis doesn't know well
    const gapPrediction = this._predictKnowledgeGap();
    if (gapPrediction) predictions.push(gapPrediction);

    this.predictions = predictions.filter(p => p.confidence > 0.5);
    return this.predictions;
  }

  /** Get current predictions for display */
  getPredictions() { return this.predictions; }

  /** Build a context string for the prompt (so Genesis can act proactively) */
  buildContext() {
    if (this.predictions.length === 0) return '';

    const lines = ['VORAUSSICHTLICHE BEDUERFNISSE:'];
    for (const p of this.predictions.slice(0, 3)) {
      lines.push(`- [${Math.round(p.confidence * 100)}%] ${p.message}`);
    }
    return lines.join('\n');
  }

  // ── Pattern Tracking ─────────────────────────────────────

  _trackIntent(data) {
    this.recentIntents.push({ type: data.type, timestamp: Date.now() });
    if (this.recentIntents.length > 20) this.recentIntents.shift();
    this.messageCount++;
  }

  _trackCompletion(data) {
    if (data.message) {
      // Extract topic keywords
      const words = data.message.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const topic = words.slice(0, 3).join(' ');
      if (topic) {
        this.recentTopics.push({ topic, timestamp: Date.now(), intent: data.intent });
        if (this.recentTopics.length > 10) this.recentTopics.shift();
      }
    }
  }

  // ── Prediction Strategies ────────────────────────────────

  _predictFromSequence() {
    if (this.recentIntents.length < 3) return null;

    // Find repeating patterns: if user did A then B then A then B...
    const last3 = this.recentIntents.slice(-3).map(i => i.type);

    // Common patterns
    if (last3[0] === 'execute-code' && last3[1] === 'self-repair' && last3[2] === 'execute-code') {
      return {
        type: 'pattern',
        confidence: 0.7,
        message: 'Du wechselst zwischen Code-Ausfuehrung und Reparatur. Soll ich den Code vorher automatisch pruefen?',
        action: 'analyze-code',
      };
    }

    if (last3.every(i => i === 'general')) {
      return {
        type: 'hint',
        confidence: 0.5,
        message: 'Ich kann mehr als nur chatten — probiere "zeig deine Architektur" oder "erstelle einen Skill".',
        action: null,
      };
    }

    return null;
  }

  _predictFromProject() {
    // Check if user has been working on a specific topic
    if (this.recentTopics.length < 3) return null;

    const topicCounts = {};
    for (const t of this.recentTopics) {
      const key = t.topic.split(' ')[0];
      topicCounts[key] = (topicCounts[key] || 0) + 1;
    }

    const dominant = Object.entries(topicCounts).sort((a, b) => b[1] - a[1])[0];
    if (dominant && dominant[1] >= 3) {
      return {
        type: 'project-focus',
        confidence: 0.65,
        message: `Du fokussierst auf "${dominant[0]}". Soll ich dazu ein Ziel erstellen oder relevante Module pruefen?`,
        action: 'goals',
      };
    }

    return null;
  }

  _predictKnowledgeGap() {
    // If recent answers had low uncertainty scores, there might be a knowledge gap
    // This is a simple heuristic — a real implementation would track UncertaintyGuard scores
    if (this.recentTopics.length > 0) {
      const lastTopic = this.recentTopics[this.recentTopics.length - 1];
      if (this.kg) {
        const results = this.kg.search(lastTopic.topic, 1);
        if (results.length === 0) {
          return {
            type: 'knowledge-gap',
            confidence: 0.6,
            message: `Ich habe wenig Wissen ueber "${lastTopic.topic}". Soll ich im Web nachschauen?`,
            action: 'web-lookup',
          };
        }
      }
    }
    return null;
  }
}

module.exports = { Anticipator };
