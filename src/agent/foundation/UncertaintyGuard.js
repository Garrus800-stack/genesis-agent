// @ts-checked-v5.6
// ============================================================
// GENESIS — UncertaintyGuard.js
// Honest uncertainty detection. Genesis can now say
// "Ich bin mir nicht sicher" when it's appropriate.
//
// Detects: hedging language, vague answers, hallucination
// risk, knowledge gaps, contradictions with known facts.
// ============================================================

const { NullBus } = require('../core/EventBus');

class UncertaintyGuard {
  constructor({ bus,  memory, knowledgeGraph }) {
    this.bus = bus || NullBus;
    this.memory = memory;
    this.kg = knowledgeGraph;

    // Hedging phrases that indicate the LLM is uncertain
    this.hedgingPatterns = [
      /ich glaube/i, /ich denke/i, /wahrscheinlich/i, /vermutlich/i,
      /moeglicherweise/i, /vielleicht/i, /es koennte sein/i,
      /ich bin nicht sicher/i, /soweit ich weiss/i, /ungefaehr/i,
      /i think/i, /probably/i, /maybe/i, /might be/i, /not sure/i,
      /i believe/i, /as far as i know/i, /approximately/i,
      /possibly/i, /it seems/i, /perhaps/i,
    ];

    // Patterns that suggest high confidence
    this.confidentPatterns = [
      /definitiv/i, /sicher/i, /auf jeden fall/i, /genau/i,
      /das ist korrekt/i, /nachweislich/i, /dokumentiert/i,
      /definitely/i, /certainly/i, /documented/i, /confirmed/i,
    ];

    // Risky topics where hallucination is common
    this.riskyTopics = [
      /version\s*\d/i, /api\s*(key|endpoint|url)/i,
      /aktuell/i, /neueste/i, /current/i, /latest/i,
      /preis/i, /price/i, /datum/i, /date.*202/i,
      /statistik/i, /statistics/i, /prozent/i, /percent/i,
    ];
  }

  /**
   * Analyze a response for uncertainty signals
   * @param {string} response - The LLM's response
   * @param {string} question - The original question
   * @returns {{ confidence: number, flags: string[], suggestion: string|null }}
   */
  analyze(response, question) {
    const flags = [];
    let confidence = 0.7; // Default: reasonably confident

    // 1. Check for hedging language
    const hedgeCount = this.hedgingPatterns.filter(p => p.test(response)).length;
    if (hedgeCount >= 2) {
      confidence -= 0.2;
      flags.push('hedging');
    } else if (hedgeCount === 1) {
      confidence -= 0.1;
    }

    // 2. Check for over-confidence
    const confidentCount = this.confidentPatterns.filter(p => p.test(response)).length;
    if (confidentCount > 0) {
      // High confidence claims without evidence are suspicious
      if (response.length < 100 && confidentCount > 1) {
        flags.push('overconfident');
        confidence -= 0.1;
      }
    }

    // 3. Check if topic is risky for hallucination
    const riskyMatch = this.riskyTopics.filter(p => p.test(question) || p.test(response));
    if (riskyMatch.length > 0) {
      flags.push('hallucination-risk');
      confidence -= 0.15;
    }

    // 4. Check against known facts
    if (this.memory) {
      const contradictions = this._checkContradictions(response);
      if (contradictions.length > 0) {
        flags.push('contradicts-memory');
        confidence -= 0.25;
      }
    }

    // 5. Very short or very long responses for complex questions
    if (question.length > 100 && response.length < 50) {
      flags.push('too-brief');
      confidence -= 0.1;
    }

    // 6. Response contains code but question wasn't about code
    if (/```/.test(response) && !/code|script|programm|funktion|function/i.test(question)) {
      // Not necessarily bad, but worth noting
      flags.push('unsolicited-code');
    }

    // Clamp confidence
    confidence = Math.max(0.1, Math.min(1.0, confidence));

    // Generate suggestion if uncertainty is high
    let suggestion = null;
    if (confidence < 0.5) {
      suggestion = this._buildDisclaimer(flags);
    }

    return { confidence: Math.round(confidence * 100) / 100, flags, suggestion };
  }

  /**
   * Wrap a response with uncertainty markers if needed
   */
  wrapResponse(response, question) {
    const { confidence, flags, suggestion } = this.analyze(response, question);

    if (confidence >= 0.7) return response; // Confident enough

    if (suggestion && confidence < 0.5) {
      return response + '\n\n---\n' + suggestion;
    }

    if (flags.includes('hallucination-risk')) {
      return response + '\n\n*Hinweis: Diese Antwort koennte veraltete Informationen enthalten. Pruefe aktuelle Dokumentation.*';
    }

    return response;
  }

  _checkContradictions(response) {
    if (!this.memory?.db?.semantic) return [];
    const contradictions = [];

    for (const [key, fact] of Object.entries(this.memory.db.semantic)) {
      if (fact.confidence > 0.8) {
        // Simple check: if response mentions the key topic but says something different
        const keywords = (key.split('.').pop() || key).split('_');
        const inResponse = keywords.some(k => response.toLowerCase().includes(k.toLowerCase()));
        if (inResponse && !response.includes(fact.value)) {
          contradictions.push({ key, stored: fact.value });
        }
      }
    }

    return contradictions;
  }

  _buildDisclaimer(flags) {
    const parts = ['*I am not confident about this answer.*'];

    if (flags.includes('hallucination-risk')) {
      parts.push('The question involves current data that I may not know correctly.');
    }
    if (flags.includes('contradicts-memory')) {
      parts.push('The answer may contradict information I learned previously.');
    }
    if (flags.includes('hedging')) {
      parts.push('I am using uncertain phrasing, which suggests knowledge gaps.');
    }

    return parts.join(' ');
  }
}

module.exports = { UncertaintyGuard };
