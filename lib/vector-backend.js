/**
 * MemBrain — Vector Backend Abstraction (Item 9 + Tier System)
 *
 * Provides a unified interface for vector search, regardless of whether
 * the user is on the free (local) or paid (cloud) tier.
 *
 * ┌─────────────────────────────────────────────────────┐
 * │  VectorBackendFactory.get()                         │
 * │    ↓                                                │
 * │  tier === 'local'  →  LocalVectorBackend            │
 * │    - transformers.js all-MiniLM-L6-v2 (384d)        │
 * │    - IndexedDB storage                              │
 * │    - Runs 100% in-browser, no server calls          │
 * │                                                     │
 * │  tier === 'cloud'  →  CloudVectorBackend            │
 * │    - Cortex API (superior embedding model)          │
 * │    - Qdrant per-user collection on VPS              │
 * │    - Better accuracy, multi-device sync             │
 * └─────────────────────────────────────────────────────┘
 *
 * Upgrade flow (free → paid):
 *   1. User subscribes, gets API token
 *   2. VectorBackendFactory.migrate(token) is called
 *   3. Local fact texts exported (NOT vectors)
 *   4. POSTed to Cortex /api/v1/vector/migrate
 *   5. Cortex re-embeds with superior model, stores in user's Qdrant namespace
 *   6. storageMode flipped to 'cloud' in settings
 *   7. Local embeddings kept as cold backup (or cleared per user pref)
 *
 * Why we migrate texts, not vectors:
 *   Local model = all-MiniLM-L6-v2, 384d
 *   Cloud model = superior model (e.g. OpenAI text-embedding-3-small, 1536d)
 *   Vector spaces are incompatible — re-embedding from source text is the only
 *   correct approach. Source text is ~1KB vs vector ~1.5KB, so it's smaller too.
 */

import { vectorStore } from './vector-store.js';
import { embedder, MODEL_ID } from './embedder.js';
import { memoryStorage } from './storage.js';

// ==================== LOCAL BACKEND ====================

class LocalVectorBackend {
  /**
   * Embed a fact and store the vector.
   * Called when a new fact is saved (EVENTS.FACT_SAVED bus event).
   *
   * @param {{ id: string, content: string }} fact
   * @returns {Promise<boolean>} true if embedded successfully
   */
  async embedAndStore(fact) {
    try {
      if (!embedder.isAvailable() && embedder.isAvailable() !== null) {
        // Known unavailable — skip silently
        return false;
      }

      const vector = await embedder.embed(fact.content);
      if (!vector) return false;

      await vectorStore.upsert(fact.id, fact.content, vector, MODEL_ID);
      console.debug(`[LocalVector] Embedded fact ${fact.id} (${vector.length}d)`);
      return true;
    } catch (e) {
      console.error('[LocalVector] embedAndStore failed:', e);
      return false;
    }
  }

  /**
   * Semantic search: embed a query and find the most relevant facts.
   *
   * @param {string} query - The user's outgoing message (or any query text)
   * @param {{ topK?: number, threshold?: number }} options
   * @returns {Promise<Array<{ factId: string, score: number, text: string }>>}
   */
  async search(query, options = {}) {
    try {
      if (!embedder.isReady()) {
        return []; // Model not loaded yet — fall through to keyword matching
      }

      const queryVector = await embedder.embed(query);
      if (!queryVector) return [];

      const results = await vectorStore.searchByVector(
        queryVector,
        options.topK || 8,
        options.threshold ?? 0.35,
      );

      return results;
    } catch (e) {
      console.error('[LocalVector] search failed:', e);
      return [];
    }
  }

  /**
   * Delete embedding for a fact (called when a fact is deleted).
   */
  async delete(factId) {
    return vectorStore.deleteByFactId(factId);
  }

  /**
   * Get stats about the local vector store.
   */
  async getStats() {
    const storeStats = await vectorStore.getStats();
    const embedStats = embedder.getStats();
    return {
      tier: 'local',
      vectorStore: storeStats,
      embedder: embedStats,
    };
  }

  /**
   * Export all fact texts for cloud migration.
   * Returns just the text — vectors are model-specific and are re-generated on the cloud.
   */
  async exportForMigration() {
    return vectorStore.exportTextsForMigration();
  }

  /**
   * Warm up the embedding model.
   * Call at extension startup so the first search isn't slow.
   */
  async warmUp() {
    return embedder.warmUp();
  }
}

// ==================== CLOUD BACKEND ====================

class CloudVectorBackend {
  constructor(apiToken, cortexUrl) {
    this._token = apiToken;
    this._url = cortexUrl || 'https://helix.millyweb.com';
  }

  /**
   * Send a fact to the Cortex cloud for embedding + storage.
   * Cortex handles the embedding model — we just send the text.
   *
   * @param {{ id: string, content: string }} fact
   */
  async embedAndStore(fact) {
    try {
      const res = await fetch(`${this._url}/api/v1/vector/upsert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._token}`,
        },
        body: JSON.stringify({
          factId: fact.id,
          text: fact.content,
          category: fact.category,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (e) {
      console.error('[CloudVector] embedAndStore failed:', e);
      return false;
    }
  }

  /**
   * Semantic search via Cortex API.
   * Cortex embeds the query with the superior model and searches Qdrant.
   *
   * @param {string} query
   * @param {{ topK?: number, threshold?: number }} options
   */
  async search(query, options = {}) {
    try {
      const res = await fetch(`${this._url}/api/v1/vector/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._token}`,
        },
        body: JSON.stringify({
          query,
          topK: options.topK || 8,
          threshold: options.threshold ?? 0.35,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.results || [];
    } catch (e) {
      console.error('[CloudVector] search failed:', e);
      return [];
    }
  }

  async delete(factId) {
    try {
      const res = await fetch(`${this._url}/api/v1/vector/delete`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._token}`,
        },
        body: JSON.stringify({ factId }),
      });
      return res.ok;
    } catch { return false; }
  }

  async getStats() {
    return { tier: 'cloud', token: this._token ? '***' : 'none', url: this._url };
  }

  async exportForMigration() {
    return []; // Nothing to export — data is already in the cloud
  }

  async warmUp() {
    // No warm-up needed for cloud backend
  }
}

// ==================== FACTORY + MIGRATION ====================

class VectorBackendFactory {
  /**
   * Get the appropriate backend for the user's current tier.
   * Reads storageMode from IndexedDB settings.
   *
   * @returns {Promise<LocalVectorBackend | CloudVectorBackend>}
   */
  static async get() {
    const tier = await memoryStorage.getSetting('storageMode', 'local');

    if (tier === 'cloud') {
      const token = await memoryStorage.getSetting('cloudApiToken');
      const url = await memoryStorage.getSetting('cortexUrl');
      if (token) {
        return new CloudVectorBackend(token, url);
      }
      // Token missing — fall back to local
      console.warn('[VectorBackend] Cloud tier set but no token found, falling back to local');
    }

    return new LocalVectorBackend();
  }

  /**
   * Migrate local vector data to the cloud backend.
   *
   * Flow:
   *   1. Export fact texts from local vector store
   *   2. POST to Cortex /api/v1/vector/migrate
   *   3. Cortex re-embeds all facts with superior model
   *   4. On success: flip storageMode to 'cloud', save token
   *   5. Optionally clear local embeddings (user preference)
   *
   * @param {string} cloudApiToken - The user's paid-tier API token
   * @param {{ cortexUrl?: string, clearLocal?: boolean }} options
   * @returns {Promise<{ success: boolean, migrated: number, error?: string }>}
   */
  static async migrate(cloudApiToken, options = {}) {
    const cortexUrl = options.cortexUrl || 'https://helix.millyweb.com';
    const clearLocal = options.clearLocal !== false; // default: clear after migrate

    try {
      // Step 1: Export local fact texts
      const localBackend = new LocalVectorBackend();
      const texts = await localBackend.exportForMigration();

      // Also get facts from the facts store for richer context
      const facts = await memoryStorage.getFacts();

      console.debug(`[VectorBackend] Migrating ${texts.length} embeddings + ${facts.length} facts to cloud`);

      // Step 2: POST to Cortex migration endpoint
      const res = await fetch(`${cortexUrl}/api/v1/vector/migrate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cloudApiToken}`,
        },
        body: JSON.stringify({
          // Send fact texts from the vector store (these are the embedded texts)
          embeddings: texts,
          // Also send the full facts for richer metadata
          facts: facts.map(f => ({
            id: f.id,
            content: f.content,
            category: f.category,
            confidence: f.confidence,
            timestamp: f.timestamp,
          })),
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Migration API error ${res.status}: ${errorText}`);
      }

      const result = await res.json();

      // Step 3: Save cloud settings
      await memoryStorage.setSetting('storageMode', 'cloud');
      await memoryStorage.setSetting('cloudApiToken', cloudApiToken);
      await memoryStorage.setSetting('cortexUrl', cortexUrl);
      await memoryStorage.setSetting('migrationCompletedAt', Date.now());

      // Step 4: Optionally clear local embeddings (not the facts — those stay!)
      if (clearLocal) {
        await vectorStore.clearAll();
        console.debug('[VectorBackend] Local embeddings cleared after migration');
      }

      console.debug(`[VectorBackend] Migration complete: ${result.migrated || texts.length} facts`);

      return {
        success: true,
        migrated: result.migrated || texts.length,
        localCleared: clearLocal,
      };
    } catch (e) {
      console.error('[VectorBackend] Migration failed:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Revert from cloud to local tier.
   * Does NOT delete cloud data — that requires an API call from the options page.
   */
  static async downgradeToLocal() {
    await memoryStorage.setSetting('storageMode', 'local');
    // Don't clear the cloud token — user might upgrade again
    console.debug('[VectorBackend] Downgraded to local tier');
  }
}

// ==================== SINGLETON (lazy, refreshed on tier change) ====================

// Active backend instance — refreshed when tier changes
let _activeBackend = null;

/**
 * Get (or create) the active vector backend.
 * Call this wherever you need vector search — it handles tier selection automatically.
 *
 * @returns {Promise<LocalVectorBackend | CloudVectorBackend>}
 */
async function getVectorBackend() {
  if (!_activeBackend) {
    _activeBackend = await VectorBackendFactory.get();
  }
  return _activeBackend;
}

/**
 * Force refresh of the active backend (e.g., after tier upgrade).
 */
function resetVectorBackend() {
  _activeBackend = null;
}

export {
  LocalVectorBackend,
  CloudVectorBackend,
  VectorBackendFactory,
  getVectorBackend,
  resetVectorBackend,
};
