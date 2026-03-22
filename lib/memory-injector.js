/**
 * MemBrain — Memory Injector (Item 5)
 * 
 * Intercepts outgoing user messages and appends relevant memories
 * as a context block before the message reaches the AI platform.
 * 
 * Sources:
 * 1. Local facts from IndexedDB (keyword matching)
 * 2. Active nudges from last backend sync
 * 
 * Injection format:
 * <memory_context>
 * - User works at MW Development (confidence: high)
 * - User prefers systematic approaches (confidence: medium)
 * </memory_context>
 */

const INJECTOR_CONFIG = {
  MAX_FACTS_TO_INJECT: 8,
  MAX_TOKENS_BUDGET: 500,
  MIN_CONFIDENCE: 'low', // low, medium, high
  RELEVANCE_THRESHOLD: 0.3,
  CATEGORIES_ALWAYS_INCLUDE: ['preference', 'personal', 'work'],
};

const CONFIDENCE_WEIGHTS = { high: 1.0, medium: 0.7, low: 0.4 };

class MemoryInjector {
  constructor(storage) {
    this._storage = storage;
    this._enabled = true;
    this._lastInjection = null;
    this._injectionCount = 0;
    this._cachedFacts = null;
    this._cacheExpiry = 0;
  }

  /**
   * Initialize injector settings from storage.
   */
  async configure() {
    const enabled = await this._storage.getSetting('injectorEnabled');
    this._enabled = enabled !== false; // Default: on
  }

  isEnabled() { return this._enabled; }

  async setEnabled(enabled) {
    this._enabled = enabled;
    await this._storage.setSetting('injectorEnabled', enabled);
  }

  /**
   * Given a user message, find relevant facts and build injection block.
   * @param {string} userMessage - The outgoing user message text
   * @param {string} platform - The AI platform (claude, chatgpt, etc)
   * @returns {{ inject: boolean, block: string, facts: Array, tokenEstimate: number }}
   */
  async buildInjection(userMessage, platform) {
    if (!this._enabled || !userMessage) {
      return { inject: false, block: '', facts: [], tokenEstimate: 0 };
    }

    try {
      // Get facts (cached for 30 seconds to reduce DB reads)
      const facts = await this._getFacts();
      if (!facts.length) {
        return { inject: false, block: '', facts: [], tokenEstimate: 0 };
      }

      // Score facts by relevance to the message
      const scored = this._scoreFacts(facts, userMessage);

      // Filter and sort
      const relevant = scored
        .filter(f => f.score >= INJECTOR_CONFIG.RELEVANCE_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, INJECTOR_CONFIG.MAX_FACTS_TO_INJECT);

      if (!relevant.length) {
        return { inject: false, block: '', facts: [], tokenEstimate: 0 };
      }

      // Build injection block
      const block = this._formatBlock(relevant);
      const tokenEstimate = Math.ceil(block.length / 4);

      // Check budget
      if (tokenEstimate > INJECTOR_CONFIG.MAX_TOKENS_BUDGET) {
        // Trim to budget
        const trimmed = relevant.slice(0, Math.max(3, relevant.length - 2));
        const trimmedBlock = this._formatBlock(trimmed);
        return {
          inject: true,
          block: trimmedBlock,
          facts: trimmed.map(f => f.fact),
          tokenEstimate: Math.ceil(trimmedBlock.length / 4),
        };
      }

      this._lastInjection = {
        timestamp: Date.now(),
        factCount: relevant.length,
        tokenEstimate,
        platform,
        messagePreview: userMessage.substring(0, 50),
      };
      this._injectionCount++;

      return {
        inject: true,
        block,
        facts: relevant.map(f => f.fact),
        tokenEstimate,
      };

    } catch (e) {
      console.error('[Memory] Injection build failed:', e);
      return { inject: false, block: '', facts: [], tokenEstimate: 0, error: e.message };
    }
  }

  /**
   * Get injection stats.
   */
  getStats() {
    return {
      enabled: this._enabled,
      injectionCount: this._injectionCount,
      lastInjection: this._lastInjection,
    };
  }

  // ==================== PRIVATE ====================

  async _getFacts() {
    const now = Date.now();
    if (this._cachedFacts && now < this._cacheExpiry) {
      return this._cachedFacts;
    }

    const facts = await this._storage.getFacts();
    this._cachedFacts = facts;
    this._cacheExpiry = now + 30000; // 30s cache
    return facts;
  }

  _scoreFacts(facts, message) {
    const msgWords = this._tokenize(message);
    const msgSet = new Set(msgWords);

    return facts.map(fact => {
      let score = 0;

      // Keyword overlap
      const factWords = this._tokenize(fact.content);
      const overlap = factWords.filter(w => msgSet.has(w)).length;
      if (factWords.length > 0) {
        score += (overlap / factWords.length) * 0.6;
      }

      // Category boost: always-include categories get a base score
      if (INJECTOR_CONFIG.CATEGORIES_ALWAYS_INCLUDE.includes(fact.category)) {
        score += 0.15;
      }

      // Confidence weight
      score *= CONFIDENCE_WEIGHTS[fact.confidence] || 0.5;

      // Recency boost: facts < 24h old get slight boost
      const ageHours = (Date.now() - (fact.timestamp || 0)) / 3600000;
      if (ageHours < 24) score += 0.1;
      if (ageHours < 1) score += 0.05;

      return { fact, score };
    });
  }

  _formatBlock(scoredFacts) {
    const lines = scoredFacts.map(f => {
      const conf = f.fact.confidence ? ` (${f.fact.confidence})` : '';
      return `- ${f.fact.content}${conf}`;
    });

    return `<memory_context>\n${lines.join('\n')}\n</memory_context>`;
  }

  _tokenize(text) {
    if (!text) return [];
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
  }
}


export { MemoryInjector, INJECTOR_CONFIG };
