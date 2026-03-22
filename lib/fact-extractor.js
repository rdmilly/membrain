/**
 * MemBrain — Fact Extractor (Item 4)
 * 
 * Uses LLM (via user's API key) to extract structured facts,
 * preferences, and decisions from conversation turns.
 * 
 * Supports: Anthropic (Haiku), OpenAI (GPT-4o-mini)
 * Deduplicates against existing facts in IndexedDB.
 * 
 * Output: Array of facts { id, content, category, source, confidence, timestamp }
 */

const EXTRACTION_PROMPT = `You are a fact extraction system. Given a conversation between a user and an AI assistant, extract key facts, preferences, decisions, and important information about the user.

Rules:
- Extract ONLY facts about the USER (not the assistant)
- Each fact should be a single, clear statement
- Categories: personal, preference, decision, project, technical, location, relationship, work, goal
- Confidence: high (explicitly stated), medium (strongly implied), low (loosely inferred)
- Skip pleasantries, small talk, and generic questions
- Skip facts that are only relevant within the conversation context
- Focus on durable facts that would be useful in future conversations

Respond with ONLY a JSON array. No markdown, no explanation. Example:
[{"content":"User works at Acme Corp as a senior engineer","category":"work","confidence":"high"},{"content":"User prefers Python over JavaScript","category":"preference","confidence":"medium"}]

If no extractable facts, respond with: []`;

const DEDUP_SIMILARITY_THRESHOLD = 0.85; // Simple word overlap threshold

class FactExtractor {
  constructor(storage) {
    this._storage = storage; // MemoryStorage instance
    this._apiKey = null;
    this._provider = null; // 'anthropic' or 'openai'
    this._model = null;
    this._extractionCount = 0;
    this._lastExtraction = null;
  }

  /**
   * Configure the extractor with API credentials.
   */
  async configure() {
    this._apiKey = await this._storage.getSetting('apiKey');
    this._provider = await this._storage.getSetting('apiProvider') || 'anthropic';
    this._model = await this._storage.getSetting('apiModel') || this._defaultModel();
    return this.isConfigured();
  }

  isConfigured() {
    return !!(this._apiKey && this._provider);
  }

  _defaultModel() {
    if (this._provider === 'openai') return 'gpt-4o-mini';
    if (this._provider === 'openrouter') return 'anthropic/claude-haiku-4-5-20251001';
    return 'claude-haiku-4-5-20251001';
  }

  /**
   * Extract facts from a conversation.
   * @param {Object} conversation - Conversation object with turns array
   * @returns {{ facts: Array, newFacts: Array, duplicates: number, error?: string }}
   */
  async extract(conversation) {
    if (!this.isConfigured()) {
      await this.configure();
      if (!this.isConfigured()) {
        return { facts: [], newFacts: [], duplicates: 0, error: 'API key not configured' };
      }
    }

    if (!conversation?.turns?.length) {
      return { facts: [], newFacts: [], duplicates: 0 };
    }

    try {
      // Build conversation text for extraction
      const convText = this._buildConversationText(conversation);
      
      // Skip very short conversations
      if (convText.length < 100) {
        return { facts: [], newFacts: [], duplicates: 0, skipped: 'too_short' };
      }

      // Call LLM
      const rawFacts = await this._callLLM(convText);
      
      if (!rawFacts?.length) {
        return { facts: [], newFacts: [], duplicates: 0 };
      }

      // Dedup against existing facts
      const existingFacts = await this._storage.getFacts();
      const { newFacts, duplicates } = this._dedup(rawFacts, existingFacts);

      // Save new facts
      const savedFacts = [];
      for (const fact of newFacts) {
        const enriched = {
          ...fact,
          id: `fact-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          source: {
            platform: conversation.platform,
            conversationId: conversation.conversationId,
            extractedAt: Date.now(),
          },
          timestamp: Date.now(),
        };
        await this._storage.saveFact(enriched);
        savedFacts.push(enriched);
      }

      this._extractionCount++;
      this._lastExtraction = Date.now();

      // Mark conversation as extracted
      conversation.lastExtractedAt = Date.now();
      conversation.factCount = (conversation.factCount || 0) + savedFacts.length;
      await this._storage.saveConversation(conversation);

      return {
        facts: rawFacts,
        newFacts: savedFacts,
        duplicates,
        model: this._model,
      };

    } catch (e) {
      console.error('[Memory] Extraction failed:', e);
      return { facts: [], newFacts: [], duplicates: 0, error: e.message };
    }
  }

  /**
   * Extract facts from all unextracted conversations.
   * @param {{ maxConversations?: number, minTurns?: number }} options
   */
  async extractAll(options = {}) {
    const maxConv = options.maxConversations || 5;
    const minTurns = options.minTurns || 3;

    const conversations = await this._storage.getConversations();
    const toExtract = conversations
      .filter(c => {
        // Skip already extracted (unless new turns added)
        if (c.lastExtractedAt && c.updatedAt <= c.lastExtractedAt) return false;
        // Skip tiny conversations
        if ((c.turnCount || 0) < minTurns) return false;
        return true;
      })
      .slice(0, maxConv);

    const results = [];
    for (const conv of toExtract) {
      const result = await this.extract(conv);
      results.push({ conversationId: conv.id, ...result });
      // Small delay between API calls
      await new Promise(r => setTimeout(r, 500));
    }

    return {
      conversationsProcessed: results.length,
      totalNewFacts: results.reduce((sum, r) => sum + (r.newFacts?.length || 0), 0),
      totalDuplicates: results.reduce((sum, r) => sum + (r.duplicates || 0), 0),
      results,
    };
  }

  /**
   * Get extraction stats.
   */
  getStats() {
    return {
      configured: this.isConfigured(),
      provider: this._provider,
      model: this._model,
      extractionCount: this._extractionCount,
      lastExtraction: this._lastExtraction,
    };
  }

  // ==================== PRIVATE ====================

  _buildConversationText(conversation) {
    const turns = (conversation.turns || []).slice(-20); // Last 20 turns max
    return turns
      .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${(t.content || '').substring(0, 2000)}`)
      .join('\n\n');
  }

  async _callLLM(conversationText) {
    const truncated = conversationText.substring(0, 8000); // Token budget control

    let response;
    if (this._provider === 'anthropic') {
      response = await this._callAnthropic(truncated);
    } else if (this._provider === 'openai') {
      response = await this._callOpenAI(truncated);
    } else if (this._provider === 'openrouter') {
      response = await this._callOpenRouter(truncated);
    } else {
      throw new Error(`Unknown provider: ${this._provider}`);
    }

    return this._parseResponse(response);
  }

  async _callAnthropic(text) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this._apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: this._model,
        max_tokens: 1024,
        system: EXTRACTION_PROMPT,
        messages: [{
          role: 'user',
          content: `Extract facts from this conversation:\n\n${text}`,
        }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.content?.[0]?.text || '[]';
  }

  async _callOpenAI(text) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this._apiKey}`,
      },
      body: JSON.stringify({
        model: this._model,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: EXTRACTION_PROMPT },
          { role: 'user', content: `Extract facts from this conversation:\n\n${text}` },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '[]';
  }

  async _callOpenRouter(text) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this._apiKey}`,
        'HTTP-Referer': 'https://memory.millyweb.com',
        'X-Title': 'Millyweb MemBrain',
      },
      body: JSON.stringify({
        model: this._model,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: EXTRACTION_PROMPT },
          { role: 'user', content: `Extract facts from this conversation:

${text}` },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenRouter API ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '[]';
  }

  _parseResponse(text) {
    if (!text) return [];
    
    // Strip markdown fences if present
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];

      // Validate each fact
      return parsed
        .filter(f => f.content && typeof f.content === 'string' && f.content.length > 5)
        .map(f => ({
          content: f.content.trim(),
          category: f.category || 'general',
          confidence: ['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'medium',
        }));
    } catch {
      console.warn('[Memory] Failed to parse extraction response:', cleaned.substring(0, 200));
      return [];
    }
  }

  _dedup(newFacts, existingFacts) {
    const results = { newFacts: [], duplicates: 0 };
    const existingContents = existingFacts.map(f => f.content?.toLowerCase() || '');

    for (const fact of newFacts) {
      const factLower = fact.content.toLowerCase();
      const isDup = existingContents.some(existing => {
        return this._similarity(factLower, existing) >= DEDUP_SIMILARITY_THRESHOLD;
      });

      if (isDup) {
        results.duplicates++;
      } else {
        results.newFacts.push(fact);
        existingContents.push(factLower); // Prevent intra-batch duplicates
      }
    }

    return results;
  }

  _similarity(a, b) {
    if (a === b) return 1;
    const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let overlap = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) overlap++;
    }
    return overlap / Math.max(wordsA.size, wordsB.size);
  }
}


export { FactExtractor };
