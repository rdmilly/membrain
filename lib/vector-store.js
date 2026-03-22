/**
 * MemBrain — Vector Store (Item 9)
 * IndexedDB storage for embeddings + cosine similarity search.
 *
 * Model-agnostic: stores raw Float32Array vectors alongside the fact ID and text.
 * The Embedder (embedder.js) is responsible for generating the vectors.
 *
 * Schema (DB: 'memory-ext', upgraded to version 2):
 *   embeddings store: { id, factId, vector: Float32Array, text, modelId, dim, createdAt }
 *
 * Usage:
 *   import { vectorStore } from './vector-store.js';
 *   await vectorStore.ready();
 *
 *   // Store
 *   await vectorStore.upsert(factId, text, float32Array, 'all-MiniLM-L6-v2');
 *
 *   // Search
 *   const results = await vectorStore.search(queryVector, { topK: 5, threshold: 0.4 });
 *   // → [{ factId, score, text }, ...]
 *
 *   // Cleanup
 *   await vectorStore.deleteByFactId(factId);
 */

const DB_NAME = 'memory-ext';
const DB_VERSION = 2; // Upgrading from v1 (adds embeddings store)
const EMBEDDINGS_STORE = 'embeddings';

class VectorStore {
  constructor() {
    this._db = null;
    this._ready = this._init();
  }

  async ready() {
    await this._ready;
    return this;
  }

  // ==================== WRITE ====================

  /**
   * Store or update an embedding for a fact.
   * @param {string} factId - ID of the fact in the facts store
   * @param {string} text - The fact text (stored for debugging / re-embed)
   * @param {Float32Array} vector - The embedding vector
   * @param {string} modelId - Model identifier (e.g. 'all-MiniLM-L6-v2')
   */
  async upsert(factId, text, vector, modelId = 'unknown') {
    await this._ready;
    const tx = this._db.transaction(EMBEDDINGS_STORE, 'readwrite');
    const store = tx.objectStore(EMBEDDINGS_STORE);

    const record = {
      id: `emb-${factId}`,
      factId,
      text,
      vector: Array.from(vector), // IDB can't store Float32Array directly — convert to plain array
      modelId,
      dim: vector.length,
      createdAt: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve(record.id);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Delete an embedding by fact ID.
   */
  async deleteByFactId(factId) {
    await this._ready;
    const tx = this._db.transaction(EMBEDDINGS_STORE, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(EMBEDDINGS_STORE).delete(`emb-${factId}`);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get an embedding record by fact ID.
   * @returns {{ id, factId, text, vector: number[], modelId, dim, createdAt } | null}
   */
  async getByFactId(factId) {
    await this._ready;
    const tx = this._db.transaction(EMBEDDINGS_STORE, 'readonly');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(EMBEDDINGS_STORE).get(`emb-${factId}`);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get all stored embeddings.
   * @returns {Array<{ factId, vector: number[], text, modelId }>}
   */
  async getAll() {
    await this._ready;
    const tx = this._db.transaction(EMBEDDINGS_STORE, 'readonly');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(EMBEDDINGS_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get IDs of all facts that have embeddings stored.
   * @returns {string[]}
   */
  async getEmbeddedFactIds() {
    const all = await this.getAll();
    return all.map(r => r.factId);
  }

  /**
   * Clear all embeddings (e.g., when switching models or upgrading tier).
   */
  async clearAll() {
    await this._ready;
    const tx = this._db.transaction(EMBEDDINGS_STORE, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(EMBEDDINGS_STORE).clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // ==================== SEARCH ====================

  /**
   * Find the most similar embeddings to a query vector using cosine similarity.
   *
   * @param {Float32Array | number[]} queryVector - Embedding of the search query
   * @param {{ topK?: number, threshold?: number, modelId?: string }} options
   * @returns {Array<{ factId: string, score: number, text: string }>} Sorted by score desc
   */
  async search(queryVector, options = {}) {
    const { topK = 5, threshold = 0.3, modelId = null } = options;

    const all = await this.getAll();
    if (!all.length) return [];

    const query = Array.isArray(queryVector) ? queryVector : Array.from(queryVector);

    const scored = all
      .filter(r => !modelId || r.modelId === modelId) // Only compare same-model vectors
      .map(r => ({
        factId: r.factId,
        text: r.text,
        score: cosineSimilarity(query, r.vector),
      }))
      .filter(r => r.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored;
  }

  /**
   * Find similar embeddings using a pre-computed query vector.
   * Convenience wrapper for the common case.
   *
   * @param {string} queryText - Text to search for (will be embedded by caller)
   * @param {Float32Array} queryVector - Pre-computed embedding of queryText
   * @param {number} topK
   * @returns {Array<{ factId, score, text }>}
   */
  async searchByVector(queryVector, topK = 5, threshold = 0.3) {
    return this.search(queryVector, { topK, threshold });
  }

  // ==================== STATS ====================

  /**
   * Get storage statistics.
   * @returns {{ count: number, modelBreakdown: Object, oldestAt: number | null }}
   */
  async getStats() {
    const all = await this.getAll();
    const models = {};
    for (const r of all) {
      models[r.modelId] = (models[r.modelId] || 0) + 1;
    }
    return {
      count: all.length,
      modelBreakdown: models,
      estimatedSizeKB: Math.round(all.reduce((sum, r) => sum + r.dim * 4, 0) / 1024),
      oldestAt: all.length ? Math.min(...all.map(r => r.createdAt)) : null,
      newestAt: all.length ? Math.max(...all.map(r => r.createdAt)) : null,
    };
  }

  // ==================== EXPORT / IMPORT (for migration) ====================

  /**
   * Export all embedding texts (NOT vectors) for cloud migration.
   * Vectors are model-specific and can't be transferred — only the source text matters.
   *
   * @returns {Array<{ factId: string, text: string, createdAt: number }>}
   */
  async exportTextsForMigration() {
    const all = await this.getAll();
    return all.map(r => ({ factId: r.factId, text: r.text, createdAt: r.createdAt }));
  }

  // ==================== PRIVATE ====================

  async _init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;

        // Version 2: Add embeddings store
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains(EMBEDDINGS_STORE)) {
            const embStore = db.createObjectStore(EMBEDDINGS_STORE, { keyPath: 'id' });
            embStore.createIndex('factId', 'factId', { unique: true });
            embStore.createIndex('modelId', 'modelId', { unique: false });
            embStore.createIndex('createdAt', 'createdAt', { unique: false });
            console.debug('[VectorStore] Created embeddings store (DB v2)');
          }
        }
      };

      request.onsuccess = (event) => {
        this._db = event.target.result;
        console.debug('[VectorStore] IDB ready (v2)');
        resolve(this._db);
      };

      request.onerror = (event) => {
        console.error('[VectorStore] IDB open failed:', event.target.error);
        reject(event.target.error);
      };
    });
  }
}

// ==================== MATH ====================

/**
 * Cosine similarity between two equal-length vectors.
 * Returns a value in [-1, 1] where 1 = identical, 0 = orthogonal, -1 = opposite.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Normalize a vector to unit length (useful for pre-normalizing stored vectors
 * to speed up dot-product-only similarity).
 *
 * @param {number[]} v
 * @returns {number[]}
 */
function normalizeVector(v) {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) return v;
  return v.map(x => x / norm);
}

// ==================== SINGLETON ====================

const vectorStore = new VectorStore();

export { VectorStore, vectorStore, cosineSimilarity, normalizeVector };
