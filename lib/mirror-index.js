/**
 * MemBrain — Mirror Index v1.0.0
 *
 * Dual BM25 + Vector search index stored entirely in IndexedDB.
 * No server, no API key, no internet required.
 *
 * Architecture:
 *   - BM25 inverted index  → keyword recall (exact terms, names, entities)
 *   - Vector index          → semantic recall (meaning, synonyms, context)
 *   - RRF fusion            → merge both result sets (same as Helix server-side)
 *
 * Design:
 *   - Indexes every conversation turn on TURN_CAPTURED (real-time)
 *   - Vectors computed async via embedder.js (non-blocking)
 *   - BM25 index updates synchronously (instant)
 *   - Both stored in IndexedDB store 'mirror_index'
 *   - Max 2000 documents (sliding window, oldest evicted)
 *
 * Usage:
 *   import { mirrorIndex } from './mirror-index.js';
 *   await mirrorIndex.add({ id, text, role, platform, conversationId, ts });
 *   const results = await mirrorIndex.search('user query', { topK: 8 });
 *   // → [{ id, text, score, role, conversationId, ts, method }]
 */

// Embedder: optional, loaded lazily. May fail in SW context due to import() restriction.
// BM25 works without it; vectors enhance results when available.
let _embedder = null;
async function getEmbedder() {
  if (_embedder) return _embedder;
  try {
    const mod = await import('./embedder.js');
    _embedder = mod.embedder;
  } catch (e) {
    // Silent fail - BM25 only mode
  }
  return _embedder;
}

// ==================== CONSTANTS ====================

const DB_NAME    = 'memory-ext';
const DB_VERSION = 3; // bumped to create mirror_index store
const STORE_NAME = 'mirror_index'; // new store
const META_KEY   = '__bm25_meta';
const MAX_DOCS   = 2000;           // rolling window limit
const BM25_K1    = 1.5;
const BM25_B     = 0.75;
const RRF_K      = 60;             // RRF constant
const ASYNC_EMBED_DELAY = 500;     // ms before starting vector embed

// ==================== TOKENIZER ====================
// Pure JS, no library. Handles English text well.

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','are','was','were','be','been','being','have','has',
  'had','do','does','did','will','would','could','should','may','might',
  'shall','can','this','that','these','those','i','you','he','she','we',
  'they','it','my','your','his','her','our','their','its','me','him','us',
  'them','what','which','who','when','where','how','why','not','no','so',
  'if','as','up','out','about','into','than','then','too','very','just',
  'also','more','some','all','any','each','most','other','such','same',
  'get','got','make','made','go','going','know','think','see','look',
  'want','use','need','like','time','way','even','here','there'
]);

function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

// ==================== BM25 STATE ====================
// Stored in memory, persisted to IndexedDB on change.
// { df: {term: count}, N: total_docs, avgdl: avg_doc_length }

let _bm25Meta = { df: {}, N: 0, avgdl: 0 };
let _db = null;
let _ready = null;

// ==================== IDB HELPERS ====================

async function getDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    // Open at same version as storage.js — it owns schema creation
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (e) => {
      // storage.js handles all schema — this is just a fallback guard
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('ts', 'ts');
        store.createIndex('conversationId', 'conversationId');
      }
    };
  });
}

async function idbGet(store, key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, value) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(store, key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(store) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbCount(store) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetOldestKeys(store, n) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const index = tx.objectStore(store).index('ts');
    const keys = [];
    const req = index.openCursor(null, 'next');
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (c && keys.length < n) {
        keys.push(c.primaryKey);
        c.continue();
      } else {
        resolve(keys);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// ==================== BM25 META ====================

async function loadMeta() {
  try {
    const db = await getDB();
    const stored = await new Promise((res, rej) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(META_KEY);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    if (stored?.df) _bm25Meta = stored;
  } catch (e) {
    console.debug('[MirrorIndex] No meta found, starting fresh');
  }
}

async function saveMeta() {
  try {
    const db = await getDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put({ id: META_KEY, ..._bm25Meta });
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  } catch (e) {
    console.warn('[MirrorIndex] Meta save failed:', e.message);
  }
}

// ==================== COSINE SIMILARITY ====================

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

// ==================== RRF FUSION ====================
// Reciprocal Rank Fusion — same algorithm Helix uses server-side

function rrfFuse(bm25Results, vectorResults) {
  const scores = {};

  bm25Results.forEach((r, rank) => {
    scores[r.id] = (scores[r.id] || 0) + 1 / (RRF_K + rank + 1);
  });
  vectorResults.forEach((r, rank) => {
    scores[r.id] = (scores[r.id] || 0) + 1 / (RRF_K + rank + 1);
  });

  // Merge doc data from both result sets
  const docMap = {};
  [...bm25Results, ...vectorResults].forEach(r => { docMap[r.id] = r; });

  return Object.entries(scores)
    .sort(([,a],[,b]) => b - a)
    .map(([id, score]) => ({ ...docMap[id], score, method: 'hybrid' }));
}

// ==================== PUBLIC API ====================

class MirrorIndex {
  constructor() {
    this._stats = { indexed: 0, searches: 0, bm25Hits: 0, vectorHits: 0 };
    this._embedQueue = []; // async embed backlog
    this._embedRunning = false;
  }

  async init() {
    if (_ready) return _ready;
    _ready = loadMeta();
    return _ready;
  }

  /**
   * Add a document to the index.
   * BM25 updated synchronously, vector queued async.
   *
   * @param {{ id: string, text: string, role: string, platform: string,
   *            conversationId: string, ts: number }} doc
   */
  async add(doc) {
    if (!doc?.text?.trim() || !doc?.id) return;
    if (doc.text.length < 10) return;
    if (doc.id === META_KEY) return;

    try {
      await this.init();

      const tokens = tokenize(doc.text);
      if (tokens.length === 0) return;

      // ── Evict oldest if over limit ──────────────────────────────────────
      const count = await idbCount(STORE_NAME);
      if (count >= MAX_DOCS + 10) { // +10 buffer
        const toDelete = await idbGetOldestKeys(STORE_NAME, count - MAX_DOCS);
        for (const key of toDelete) {
          if (key === META_KEY) continue;
          // Remove from BM25 df (approximate — we don't store per-doc term lists)
          await idbDelete(STORE_NAME, key);
        }
      }

      // ── Build term frequency map ────────────────────────────────────────
      const tf = {};
      for (const t of tokens) {
        tf[t] = (tf[t] || 0) + 1;
      }

      // ── Update document frequency ───────────────────────────────────────
      const uniqueTerms = Object.keys(tf);
      for (const term of uniqueTerms) {
        _bm25Meta.df[term] = (_bm25Meta.df[term] || 0) + 1;
      }

      // ── Update corpus stats ─────────────────────────────────────────────
      _bm25Meta.N++;
      const prevAvg = _bm25Meta.avgdl || 0;
      _bm25Meta.avgdl = prevAvg + (tokens.length - prevAvg) / _bm25Meta.N;

      // ── Store document (no vector yet) ──────────────────────────────────
      const entry = {
        id: doc.id,
        text: doc.text.slice(0, 2000), // cap per doc
        role: doc.role || 'unknown',
        platform: doc.platform || 'claude',
        conversationId: doc.conversationId || '',
        ts: doc.ts || Date.now(),
        tf,
        dl: tokens.length,
        vector: null, // filled async
      };
      await idbPut(STORE_NAME, entry);

      // ── Save BM25 meta (debounced via queue) ────────────────────────────
      await saveMeta();

      this._stats.indexed++;

      // ── Queue async vector embed ────────────────────────────────────────
      this._embedQueue.push(doc.id);
      this._runEmbedQueue();

    } catch (e) {
      console.warn('[MirrorIndex] add() failed:', e.message);
    }
  }

  /**
   * Search the index using BM25 + vector fusion.
   *
   * @param {string} query
   * @param {{ topK?: number, minScore?: number }} opts
   * @returns {Promise<Array>}
   */
  async search(query, opts = {}) {
    const topK = opts.topK || 8;
    if (!query?.trim()) return [];

    try {
      await this.init();
      this._stats.searches++;

      // Run BM25 and vector search in parallel
      const [bm25Results, vectorResults] = await Promise.all([
        this._bm25Search(query, topK * 2),
        this._vectorSearch(query, topK * 2),
      ]);

      this._stats.bm25Hits += bm25Results.length;
      this._stats.vectorHits += vectorResults.length;

      // Fuse results
      const fused = rrfFuse(bm25Results, vectorResults);
      return fused.slice(0, topK);

    } catch (e) {
      console.warn('[MirrorIndex] search() failed:', e.message);
      return [];
    }
  }

  /**
   * Get recent turns from a specific conversation (for session context).
   */
  async getConversationContext(conversationId, limit = 10) {
    if (!conversationId) return [];
    try {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const index = tx.objectStore(STORE_NAME).index('conversationId');
        const results = [];
        const req = index.openCursor(IDBKeyRange.only(conversationId), 'prev');
        req.onsuccess = (e) => {
          const c = e.target.result;
          if (c && results.length < limit) {
            if (c.value.id !== META_KEY) results.push(c.value);
            c.continue();
          } else {
            resolve(results.reverse()); // chronological order
          }
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return [];
    }
  }

  /**
   * Get most recent N documents (for pre-warm when no query).
   */
  async getRecent(n = 6) {
    try {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const index = tx.objectStore(STORE_NAME).index('ts');
        const results = [];
        const req = index.openCursor(null, 'prev');
        req.onsuccess = (e) => {
          const c = e.target.result;
          if (c && results.length < n) {
            if (c.value.id !== META_KEY && c.value.text) {
              results.push({ ...c.value, score: 1.0, method: 'recent' });
            }
            c.continue();
          } else {
            resolve(results);
          }
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) { return []; }
  }

  /**
   * Remove entries containing injected context blocks (cleanup after recursive nesting bug).
   */
  async purgeContaining(marker) {
    try {
      const db = await getDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      await new Promise((res, rej) => {
        const req = store.openCursor();
        req.onsuccess = (e) => {
          const c = e.target.result;
          if (c) {
            if (c.value.id !== '__bm25_meta' && (c.value.text || '').includes(marker)) {
              c.delete();
            }
            c.continue();
          } else { res(); }
        };
        req.onerror = () => rej(req.error);
      });
    } catch (e) { console.warn('[MirrorIndex] purge failed:', e.message); }
  }

  getStats() {
    return { ...this._stats, bm25Docs: _bm25Meta.N, avgdl: Math.round(_bm25Meta.avgdl) };
  }

  // ==================== PRIVATE: BM25 ====================

  async _bm25Search(query, topK) {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    const { N, avgdl, df } = _bm25Meta;
    if (N === 0) return [];

    // Get all docs
    const docs = await idbGetAll(STORE_NAME);
    const scores = [];

    for (const doc of docs) {
      if (doc.id === META_KEY || !doc.tf) continue;

      let score = 0;
      const dl = doc.dl || 1;

      for (const term of queryTerms) {
        const tfVal = doc.tf[term] || 0;
        if (tfVal === 0) continue;

        const dfVal = df[term] || 1;
        const idf = Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1);
        const tfNorm = (tfVal * (BM25_K1 + 1)) /
          (tfVal + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl));

        score += idf * tfNorm;
      }

      if (score > 0) {
        scores.push({
          id: doc.id,
          text: doc.text,
          role: doc.role,
          conversationId: doc.conversationId,
          ts: doc.ts,
          score,
          method: 'bm25',
        });
      }
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  // ==================== PRIVATE: VECTOR ====================

  async _vectorSearch(query, topK) {
    const emb = await getEmbedder(); if (!emb) return [];
    const queryVec = await emb.embed(query);
    if (!queryVec) return []; // embedder not ready yet

    const docs = await idbGetAll(STORE_NAME);
    const scores = [];

    for (const doc of docs) {
      if (doc.id === META_KEY || !doc.vector) continue;

      const sim = cosine(queryVec, doc.vector);
      if (sim > 0.2) { // threshold
        scores.push({
          id: doc.id,
          text: doc.text,
          role: doc.role,
          conversationId: doc.conversationId,
          ts: doc.ts,
          score: sim,
          method: 'vector',
        });
      }
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  // ==================== PRIVATE: ASYNC EMBED QUEUE ====================

  _runEmbedQueue() {
    if (this._embedRunning) return;
    this._embedRunning = true;
    setTimeout(() => this._processEmbedQueue(), ASYNC_EMBED_DELAY);
  }

  async _processEmbedQueue() {
    while (this._embedQueue.length > 0) {
      const id = this._embedQueue.shift();
      try {
        const entry = await idbGet(STORE_NAME, id);
        if (!entry || entry.vector || !entry.text) continue;

        const emb = await getEmbedder(); if (!emb) continue;
        const vector = await emb.embed(entry.text);
        if (vector) {
          await idbPut(STORE_NAME, { ...entry, vector: Array.from(vector) });
        }
      } catch (e) {
        // Non-fatal — doc exists without vector, BM25 still works
      }
    }
    this._embedRunning = false;
  }
}

// ==================== SINGLETON ====================

const mirrorIndex = new MirrorIndex();

export { MirrorIndex, mirrorIndex };
