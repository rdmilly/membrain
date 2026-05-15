/**
 * MemBrain — Local Storage Layer (Item 3)
 * 
 * IndexedDB-backed persistent storage for conversations, facts, and settings.
 * Survives browser restarts (unlike chrome.storage.session).
 * 
 * Stores:
 * - conversations: Full conversation objects from ConversationParser
 * - facts: Extracted facts/preferences from conversations
 * - settings: User preferences, API keys, feature toggles
 * 
 * Schema version: 1
 */

const DB_NAME = 'memory-ext';
const DB_VERSION = 5; // v5: adds symbol_dictionary (v4) + kg_entities/kg_relations (v5)

const STORES = {
  CONVERSATIONS: 'conversations',
  FACTS: 'facts',
  SETTINGS: 'settings',
  SYNC_LOG: 'sync_log',
};

class MemoryStorage {
  constructor() {
    this._db = null;
    this._ready = this._init();
  }

  /**
   * Wait for DB to be ready before any operation.
   */
  async ready() {
    await this._ready;
    return this;
  }

  // ==================== CONVERSATIONS ====================

  /**
   * Save or update a conversation.
   * @param {Object} conversation - Conversation object from ConversationParser
   */
  async saveConversation(conversation) {
    await this._ready;
    const tx = this._db.transaction(STORES.CONVERSATIONS, 'readwrite');
    const store = tx.objectStore(STORES.CONVERSATIONS);
    
    // Add metadata for storage
    const record = {
      ...conversation,
      _savedAt: Date.now(),
      _version: DB_VERSION,
    };

    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve(record.id);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Save multiple conversations in a single transaction.
   */
  async saveConversations(conversations) {
    await this._ready;
    const tx = this._db.transaction(STORES.CONVERSATIONS, 'readwrite');
    const store = tx.objectStore(STORES.CONVERSATIONS);

    const results = [];
    for (const conv of conversations) {
      const record = { ...conv, _savedAt: Date.now(), _version: DB_VERSION };
      store.put(record);
      results.push(conv.id);
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(results);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get a conversation by its composite ID (platform:conversationId).
   */
  async getConversation(id) {
    await this._ready;
    const tx = this._db.transaction(STORES.CONVERSATIONS, 'readonly');
    const store = tx.objectStore(STORES.CONVERSATIONS);

    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get all conversations, optionally filtered.
   * @param {{ platform?: string, since?: number, limit?: number }} options
   */
  async getConversations(options = {}) {
    await this._ready;
    const tx = this._db.transaction(STORES.CONVERSATIONS, 'readonly');
    const store = tx.objectStore(STORES.CONVERSATIONS);

    return new Promise((resolve, reject) => {
      const results = [];
      let cursor;

      if (options.platform) {
        const index = store.index('platform');
        cursor = index.openCursor(IDBKeyRange.only(options.platform));
      } else if (options.since) {
        const index = store.index('updatedAt');
        cursor = index.openCursor(IDBKeyRange.lowerBound(options.since));
      } else {
        cursor = store.openCursor();
      }

      cursor.onsuccess = (event) => {
        const c = event.target.result;
        if (c) {
          if (options.since && c.value.updatedAt < options.since) {
            c.continue();
            return;
          }
          results.push(c.value);
          if (options.limit && results.length >= options.limit) {
            resolve(results.sort((a, b) => b.updatedAt - a.updatedAt));
            return;
          }
          c.continue();
        } else {
          resolve(results.sort((a, b) => b.updatedAt - a.updatedAt));
        }
      };
      cursor.onerror = () => reject(cursor.error);
    });
  }

  /**
   * Get conversations that haven't been synced to backend.
   */
  async getUnsyncedConversations() {
    const all = await this.getConversations();
    return all.filter(c => !c.syncedAt || c.updatedAt > c.syncedAt);
  }

  /**
   * Mark a conversation as synced.
   */
  async markSynced(id) {
    const conv = await this.getConversation(id);
    if (conv) {
      conv.syncedAt = Date.now();
      await this.saveConversation(conv);
    }
  }

  /**
   * Delete a conversation.
   */
  async deleteConversation(id) {
    await this._ready;
    const tx = this._db.transaction(STORES.CONVERSATIONS, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(STORES.CONVERSATIONS).delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get conversation count and stats.
   */
  async getConversationStats() {
    const all = await this.getConversations();
    const platforms = {};
    let totalTurns = 0;
    let totalTokens = 0;

    for (const conv of all) {
      platforms[conv.platform] = (platforms[conv.platform] || 0) + 1;
      totalTurns += conv.turnCount || 0;
      totalTokens += conv.tokenEstimate || 0;
    }

    return {
      conversations: all.length,
      platforms,
      totalTurns,
      totalTokens,
      unsynced: all.filter(c => !c.syncedAt || c.updatedAt > c.syncedAt).length,
      oldestAt: all.length ? Math.min(...all.map(c => c.startedAt)) : null,
      newestAt: all.length ? Math.max(...all.map(c => c.updatedAt)) : null,
    };
  }

  // ==================== FACTS ====================

  /**
   * Save an extracted fact.
   * @param {Object} fact - { id, content, category, source, confidence, timestamp }
   */
  async saveFact(fact) {
    await this._ready;
    const tx = this._db.transaction(STORES.FACTS, 'readwrite');
    const record = {
      ...fact,
      id: fact.id || `fact-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      _savedAt: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const req = tx.objectStore(STORES.FACTS).put(record);
      req.onsuccess = () => resolve(record.id);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get all facts, optionally filtered by category.
   */
  async getFacts(options = {}) {
    await this._ready;
    const tx = this._db.transaction(STORES.FACTS, 'readonly');
    const store = tx.objectStore(STORES.FACTS);

    return new Promise((resolve, reject) => {
      const results = [];
      let cursor;

      if (options.category) {
        const index = store.index('category');
        cursor = index.openCursor(IDBKeyRange.only(options.category));
      } else {
        cursor = store.openCursor();
      }

      cursor.onsuccess = (event) => {
        const c = event.target.result;
        if (c) {
          results.push(c.value);
          c.continue();
        } else {
          resolve(results.sort((a, b) => b.timestamp - a.timestamp));
        }
      };
      cursor.onerror = () => reject(cursor.error);
    });
  }

  /**
   * Search facts by keyword.
   */
  async searchFacts(query) {
    const all = await this.getFacts();
    const lower = query.toLowerCase();
    return all.filter(f => 
      f.content?.toLowerCase().includes(lower) ||
      f.category?.toLowerCase().includes(lower)
    );
  }

  /**
   * Delete a fact.
   */
  async deleteFact(id) {
    await this._ready;
    const tx = this._db.transaction(STORES.FACTS, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(STORES.FACTS).delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // ==================== SETTINGS ====================

  /**
   * Get a setting value.
   */
  async getSetting(key, defaultValue = null) {
    await this._ready;
    const tx = this._db.transaction(STORES.SETTINGS, 'readonly');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(STORES.SETTINGS).get(key);
      req.onsuccess = () => resolve(req.result?.value ?? defaultValue);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Set a setting value.
   */
  async setSetting(key, value) {
    await this._ready;
    const tx = this._db.transaction(STORES.SETTINGS, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(STORES.SETTINGS).put({ key, value, _updatedAt: Date.now() });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get all settings.
   */
  async getAllSettings() {
    await this._ready;
    const tx = this._db.transaction(STORES.SETTINGS, 'readonly');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(STORES.SETTINGS).getAll();
      req.onsuccess = () => {
        const settings = {};
        for (const r of req.result) {
          settings[r.key] = r.value;
        }
        resolve(settings);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ==================== SYNC LOG ====================

  /**
   * Log a sync event.
   */
  async logSync(entry) {
    await this._ready;
    const tx = this._db.transaction(STORES.SYNC_LOG, 'readwrite');
    const record = {
      ...entry,
      id: `sync-${Date.now()}`,
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const req = tx.objectStore(STORES.SYNC_LOG).put(record);
      req.onsuccess = () => resolve(record.id);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get recent sync log entries.
   */
  async getSyncLog(limit = 20) {
    await this._ready;
    const tx = this._db.transaction(STORES.SYNC_LOG, 'readonly');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(STORES.SYNC_LOG).getAll();
      req.onsuccess = () => {
        const sorted = req.result.sort((a, b) => b.timestamp - a.timestamp);
        resolve(sorted.slice(0, limit));
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ==================== EXPORT/IMPORT ====================

  /**
   * Export all data to JSON for backup.
   */
  async exportAll() {
    const conversations = await this.getConversations();
    const facts = await this.getFacts();
    const settings = await this.getAllSettings();
    const syncLog = await this.getSyncLog(100);

    return {
      version: DB_VERSION,
      exportedAt: new Date().toISOString(),
      data: {
        conversations,
        facts,
        settings,
        syncLog,
      },
    };
  }

  /**
   * Import data from JSON backup.
   */
  async importAll(exported) {
    if (!exported?.data) throw new Error('Invalid export format');

    const { conversations = [], facts = [], settings = {} } = exported.data;

    if (conversations.length) {
      await this.saveConversations(conversations);
    }

    for (const fact of facts) {
      await this.saveFact(fact);
    }

    for (const [key, value] of Object.entries(settings)) {
      await this.setSetting(key, value);
    }

    return {
      conversations: conversations.length,
      facts: facts.length,
      settings: Object.keys(settings).length,
    };
  }

  /**
   * Clear all data. Use with caution.
   */
  async clearAll() {
    await this._ready;
    const storeNames = [STORES.CONVERSATIONS, STORES.FACTS, STORES.SETTINGS, STORES.SYNC_LOG];
    const tx = this._db.transaction(storeNames, 'readwrite');
    
    for (const name of storeNames) {
      tx.objectStore(name).clear();
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  // ==================== PRIVATE ====================

  async _init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Conversations store
        if (!db.objectStoreNames.contains(STORES.CONVERSATIONS)) {
          const convStore = db.createObjectStore(STORES.CONVERSATIONS, { keyPath: 'id' });
          convStore.createIndex('platform', 'platform', { unique: false });
          convStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          convStore.createIndex('syncedAt', 'syncedAt', { unique: false });
          convStore.createIndex('conversationId', 'conversationId', { unique: false });
        }

        // Facts store
        if (!db.objectStoreNames.contains(STORES.FACTS)) {
          const factStore = db.createObjectStore(STORES.FACTS, { keyPath: 'id' });
          factStore.createIndex('category', 'category', { unique: false });
          factStore.createIndex('timestamp', 'timestamp', { unique: false });
          factStore.createIndex('source', 'source', { unique: false });
        }

        // Settings store
        if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
          db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
        }

        // Sync log store
        if (!db.objectStoreNames.contains(STORES.SYNC_LOG)) {
          const syncStore = db.createObjectStore(STORES.SYNC_LOG, { keyPath: 'id' });
          syncStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Mirror Index store (v3) — dual BM25+vector local RAG
        if (!db.objectStoreNames.contains('mirror_index')) {
          const mirrorStore = db.createObjectStore('mirror_index', { keyPath: 'id' });
          mirrorStore.createIndex('ts', 'ts', { unique: false });
          mirrorStore.createIndex('conversationId', 'conversationId', { unique: false });
        }

        // Symbol dictionary store (v4)
        if (!db.objectStoreNames.contains('symbol_dictionary')) {
          db.createObjectStore('symbol_dictionary', { keyPath: 'symbol' });
        }

        // Knowledge graph stores (v5)
        if (!db.objectStoreNames.contains('kg_entities')) {
          const entStore = db.createObjectStore('kg_entities', { keyPath: 'id' });
          entStore.createIndex('name', 'name', { unique: false });
          entStore.createIndex('type', 'type', { unique: false });
          entStore.createIndex('lastSeen', 'lastSeen', { unique: false });
        }
        if (!db.objectStoreNames.contains('kg_relations')) {
          const relStore = db.createObjectStore('kg_relations', { keyPath: 'id' });
          relStore.createIndex('from', 'from', { unique: false });
          relStore.createIndex('to', 'to', { unique: false });
          relStore.createIndex('rel', 'rel', { unique: false });
          relStore.createIndex('ts', 'ts', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this._db = event.target.result;
        console.debug(`[Memory] IndexedDB ready: ${DB_NAME} v${DB_VERSION}`);
        resolve(this._db);
      };

      request.onerror = (event) => {
        console.error('[Memory] IndexedDB open failed:', event.target.error);
        reject(event.target.error);
      };
    });
  }
}

// Singleton
const memoryStorage = new MemoryStorage();


// ES module export
export { MemoryStorage, memoryStorage, STORES };
