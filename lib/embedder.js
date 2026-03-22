/**
 * MemBrain — Embedder (Item 9)
 * Wraps transformers.js for local, offline text embedding.
 *
 * Model: Xenova/all-MiniLM-L6-v2
 *   - 384-dimensional output
 *   - ~25MB download (cached by browser after first use)
 *   - Fast: ~10-50ms per embedding after warm-up
 *
 * MV3 Service Worker constraint:
 *   transformers.js must be bundled locally — MV3 CSP blocks CDN imports.
 *   Run setup.sh in the project root to download it to lib/transformers.min.js
 *
 * Design decisions:
 *   - Lazy init: model loads on first embed() call, not at startup
 *   - Pipeline is cached after first load — subsequent calls are fast
 *   - If transformers.js is unavailable, falls back to null (caller must handle)
 *   - All embeddings are L2-normalized (unit vectors) for consistent cosine scoring
 *
 * Usage:
 *   import { embedder } from './embedder.js';
 *   const vector = await embedder.embed('user works at MW Development');
 *   // → Float32Array(384) | null (if model not available)
 *
 *   const stats = embedder.getStats();
 *   // → { ready, modelId, dim, embedCount, avgMs, status }
 */

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MODEL_DIM = 384;

// Path to bundled transformers.js (relative to service worker)
// This file must exist — run setup.sh to download it.
const TRANSFORMERS_PATH = '../lib/transformers.min.js';

class Embedder {
  constructor() {
    this._pipeline = null;
    this._loading = false;
    this._loadPromise = null;
    this._available = null; // null = unknown, true/false after first attempt
    this._embedCount = 0;
    this._totalMs = 0;
    this._status = 'uninitialized';
  }

  /**
   * Embed a text string into a 384-dimensional normalized vector.
   * Lazy-loads the model on first call.
   *
   * @param {string} text
   * @returns {Promise<Float32Array | null>} null if model unavailable
   */
  async embed(text) {
    if (!text?.trim()) return null;

    // Load model if not ready
    if (!this._pipeline) {
      const loaded = await this._loadModel();
      if (!loaded) return null;
    }

    try {
      const start = Date.now();
      const output = await this._pipeline(text, { pooling: 'mean', normalize: true });
      const elapsed = Date.now() - start;

      this._embedCount++;
      this._totalMs += elapsed;

      // output.data is a Float32Array of length 384
      return output.data;
    } catch (e) {
      console.error('[Embedder] embed() failed:', e);
      this._status = `error: ${e.message}`;
      return null;
    }
  }

  /**
   * Embed multiple texts in batch.
   * Returns nulls for any failed embeddings.
   *
   * @param {string[]} texts
   * @returns {Promise<Array<Float32Array | null>>}
   */
  async embedBatch(texts) {
    const results = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  /**
   * Pre-warm the model. Call this on extension startup so the first
   * embed() call isn't slow. Safe to call multiple times.
   */
  async warmUp() {
    if (this._pipeline || this._loading) return;
    await this._loadModel();
  }

  /**
   * Whether the model is loaded and ready.
   */
  isReady() {
    return this._pipeline !== null;
  }

  /**
   * Whether transformers.js is available at all.
   * Returns null if we haven't tried yet.
   */
  isAvailable() {
    return this._available;
  }

  /**
   * Get runtime statistics.
   */
  getStats() {
    return {
      ready: this.isReady(),
      available: this._available,
      modelId: MODEL_ID,
      dim: MODEL_DIM,
      embedCount: this._embedCount,
      avgMs: this._embedCount > 0 ? Math.round(this._totalMs / this._embedCount) : 0,
      status: this._status,
    };
  }

  // ==================== PRIVATE ====================

  async _loadModel() {
    // Already loading — wait for the existing promise
    if (this._loading && this._loadPromise) {
      return this._loadPromise;
    }

    // Already failed — don't retry
    if (this._available === false) return false;

    this._loading = true;
    this._status = 'loading';

    this._loadPromise = (async () => {
      try {
        console.debug('[Embedder] Loading transformers.js...');

        // Dynamic import of locally bundled transformers.js
        // This file must be present at lib/transformers.min.js
        // Run: ./setup.sh to download it
        let transformers;
        try {
          transformers = await import(TRANSFORMERS_PATH);
        } catch (importErr) {
          console.warn('[Embedder] transformers.js not found at', TRANSFORMERS_PATH);
          console.warn('[Embedder] Run setup.sh to download it. Falling back to keyword matching.');
          this._available = false;
          this._status = 'unavailable: transformers.js not found';
          this._loading = false;
          return false;
        }

        const { pipeline, env } = transformers;

        // Configure transformers.js for extension environment
        // Use local cache in extension storage, not CDN
        env.allowLocalModels = false; // We're using Hugging Face hosted models
        env.useBrowserCache = true;   // Cache model weights in browser cache
        env.allowRemoteModels = true; // First download from HF Hub

        console.debug('[Embedder] Creating pipeline for', MODEL_ID);
        this._status = 'downloading model (~25MB, first time only)...';

        // feature-extraction pipeline for sentence embeddings
        this._pipeline = await pipeline('feature-extraction', MODEL_ID, {
          quantized: true, // Use 8-bit quantized model (~6MB vs ~25MB)
          progress_callback: (progress) => {
            if (progress.status === 'downloading') {
              const pct = progress.loaded && progress.total
                ? Math.round((progress.loaded / progress.total) * 100)
                : '?';
              this._status = `downloading model: ${pct}%`;
            }
          },
        });

        this._available = true;
        this._status = 'ready';
        this._loading = false;

        console.debug('[Embedder] Model ready:', MODEL_ID);
        return true;
      } catch (e) {
        console.error('[Embedder] Model load failed:', e);
        this._available = false;
        this._status = `load error: ${e.message}`;
        this._loading = false;
        return false;
      }
    })();

    return this._loadPromise;
  }
}

// ==================== SINGLETON ====================

const embedder = new Embedder();

export { Embedder, embedder, MODEL_ID, MODEL_DIM };
