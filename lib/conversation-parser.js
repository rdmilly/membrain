/**
 * MemBrain — Conversation Parser (Item 2)
 * 
 * Groups individual captured turns into unified conversation objects.
 * Handles:
 * - Grouping by conversationId + platform
 * - Turn deduplication and ordering
 * - Platform-specific response normalization
 * - Conversation boundary detection
 * - Delta computation (new turns since last sync)
 * 
 * Output format:
 * {
 *   id: 'claude:abc123',
 *   platform: 'claude',
 *   conversationId: 'abc123',
 *   title: 'First user message...',
 *   turns: [{ role, content, timestamp, captureType }],
 *   startedAt: 1708...,
 *   updatedAt: 1708...,
 *   turnCount: 5,
 *   tokenEstimate: 1200,
 * }
 */

class ConversationParser {
  constructor() {
    // In-memory conversation index: key -> conversation
    this._conversations = new Map();
    // Track turn IDs we've already processed (dedup)
    this._processedTurnIds = new Set();
  }

  /**
   * Process a batch of raw captured turns into conversation objects.
   * @param {Array} rawTurns - Array of turns from chrome.storage.session
   * @returns {{ conversations: Map, newTurns: number, updatedConversations: string[] }}
   */
  ingestTurns(rawTurns) {
    if (!rawTurns?.length) return { conversations: this._conversations, newTurns: 0, updatedConversations: [] };

    let newTurns = 0;
    const updatedConvIds = new Set();

    for (const turn of rawTurns) {
      // Skip already-processed turns
      if (this._processedTurnIds.has(turn.id)) continue;
      this._processedTurnIds.add(turn.id);

      // Skip empty content
      if (!turn.content?.trim()) continue;

      const convKey = this._conversationKey(turn.platform, turn.conversationId);
      
      if (!this._conversations.has(convKey)) {
        this._conversations.set(convKey, this._createConversation(turn));
      }

      const conv = this._conversations.get(convKey);
      const normalizedTurn = this._normalizeTurn(turn);

      // Dedup: check for duplicate content in recent turns
      if (!this._isDuplicateTurn(conv, normalizedTurn)) {
        conv.turns.push(normalizedTurn);
        conv.updatedAt = Math.max(conv.updatedAt, normalizedTurn.timestamp);
        conv.turnCount = conv.turns.length;
        conv.tokenEstimate = this._estimateTokens(conv);
        newTurns++;
        updatedConvIds.add(convKey);
      }
    }

    // Sort turns within each updated conversation
    for (const convId of updatedConvIds) {
      const conv = this._conversations.get(convId);
      conv.turns.sort((a, b) => a.timestamp - b.timestamp);
      // Update title from first user message
      const firstUser = conv.turns.find(t => t.role === 'user');
      if (firstUser) {
        conv.title = this._truncate(firstUser.content, 120);
      }
    }

    return {
      conversations: this._conversations,
      newTurns,
      updatedConversations: [...updatedConvIds],
    };
  }

  /**
   * Get a conversation by its composite key.
   */
  getConversation(platform, conversationId) {
    return this._conversations.get(this._conversationKey(platform, conversationId));
  }

  /**
   * Get all conversations as an array, sorted by most recently updated.
   */
  getAllConversations() {
    return [...this._conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Get conversations updated since a given timestamp.
   */
  getConversationsSince(timestamp) {
    return this.getAllConversations()
      .filter(c => c.updatedAt > timestamp);
  }

  /**
   * Export a conversation in the unified format for backend sync.
   */
  exportForSync(convKey) {
    const conv = this._conversations.get(convKey);
    if (!conv) return null;

    return {
      id: conv.id,
      platform: conv.platform,
      conversationId: conv.conversationId,
      title: conv.title,
      turns: conv.turns.map(t => ({
        role: t.role,
        content: t.content,
        timestamp: t.timestamp,
      })),
      startedAt: conv.startedAt,
      updatedAt: conv.updatedAt,
      turnCount: conv.turnCount,
      tokenEstimate: conv.tokenEstimate,
    };
  }

  /**
   * Load existing conversations (e.g., from IndexedDB on startup).
   */
  loadConversations(conversations) {
    for (const conv of conversations) {
      const key = this._conversationKey(conv.platform, conv.conversationId);
      this._conversations.set(key, conv);
      // Mark all existing turn IDs as processed
      for (const turn of (conv.turns || [])) {
        if (turn.id) this._processedTurnIds.add(turn.id);
      }
    }
  }

  /**
   * Clear all data.
   */
  clear() {
    this._conversations.clear();
    this._processedTurnIds.clear();
  }

  // ==================== PRIVATE ====================

  _conversationKey(platform, conversationId) {
    // If no conversationId, use a session-based fallback
    const id = conversationId || `unknown-${Date.now()}`;
    return `${platform}:${id}`;
  }

  _createConversation(turn) {
    return {
      id: this._conversationKey(turn.platform, turn.conversationId),
      platform: turn.platform,
      conversationId: turn.conversationId || `unknown-${Date.now()}`,
      title: '',
      turns: [],
      startedAt: turn.timestamp || Date.now(),
      updatedAt: turn.timestamp || Date.now(),
      turnCount: 0,
      tokenEstimate: 0,
      syncedAt: null,  // null = never synced to backend
    };
  }

  _normalizeTurn(turn) {
    return {
      id: turn.id,
      role: this._normalizeRole(turn.role),
      content: this._normalizeContent(turn.content, turn.platform),
      timestamp: turn.timestamp || Date.now(),
      captureType: turn.captureType || 'unknown',
    };
  }

  _normalizeRole(role) {
    if (!role) return 'assistant';
    const lower = role.toLowerCase();
    if (lower === 'human' || lower === 'user') return 'user';
    if (lower === 'assistant' || lower === 'bot' || lower === 'model') return 'assistant';
    if (lower === 'system') return 'system';
    return 'assistant';
  }

  _normalizeContent(content, platform) {
    if (!content) return '';
    if (typeof content !== 'string') {
      try {
        // Handle structured content (e.g., Claude's content blocks)
        if (Array.isArray(content)) {
          return content
            .map(block => {
              if (typeof block === 'string') return block;
              if (block.text) return block.text;
              if (block.type === 'text') return block.text || '';
              return '';
            })
            .filter(Boolean)
            .join('\n');
        }
        return JSON.stringify(content);
      } catch {
        return String(content);
      }
    }
    return content.trim();
  }

  _isDuplicateTurn(conv, newTurn) {
    // Check last 5 turns for duplicate content
    const recent = conv.turns.slice(-5);
    return recent.some(t => 
      t.role === newTurn.role && 
      t.content === newTurn.content &&
      Math.abs(t.timestamp - newTurn.timestamp) < 5000 // Within 5 seconds
    );
  }

  _estimateTokens(conv) {
    // Rough estimate: ~4 chars per token
    let totalChars = 0;
    for (const turn of conv.turns) {
      totalChars += (turn.content?.length || 0);
    }
    return Math.ceil(totalChars / 4);
  }

  _truncate(str, maxLen) {
    if (!str) return '';
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + '...';
  }
}


// ES module export
export { ConversationParser };
