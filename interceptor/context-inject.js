/**
 * MemBrain — Context Injection Module v2.0.0
 *
 * TWO-LAYER injection strategy:
 *
 *   LAYER 1 — SHARD (once per conversation):
 *     On the FIRST message of a new conversation, fetches a session-start
 *     shard from Cortex (/api/v1/context/shard/recent). Contains recent
 *     decisions, key entities, stable code patterns, and session summaries.
 *     Cached for the lifetime of the conversation tab.
 *
 *   LAYER 2 — RAG (per-message):
 *     On every message, fetches query-relevant context from Cortex
 *     (/api/v1/context/inject). Semantic search over atoms and sessions
 *     scoped to the current message.
 *
 * Combined, both layers are prepended to the outgoing user message.
 * Runs BEFORE compression. Falls back silently on any error.
 *
 * This closes the Maturation Loop: enriched Cortex knowledge flows
 * back into every new session automatically.
 */

(function () {
  'use strict';

  if (window.__membrainContextInjectInstalled) return;
  window.__membrainContextInjectInstalled = true;

  // ==================== CONFIG ====================
  const BACKEND_URL = 'https://helix.millyweb.com';
  const API_KEY = 'ce-prod-6292b483717db14c83924a52715988ae';

  const SHARD_ENDPOINT  = '/api/v1/context/shard/recent';
  const INJECT_ENDPOINT = '/api/v1/context/inject';

  const SHARD_TOKEN_BUDGET  = 1200;  // chars budget for shard block
  const RAG_MAX_CHARS       = 1000;  // chars budget for RAG block
  const RAG_CACHE_TTL_MS    = 90_000; // 90s — re-fetch RAG on new topic
  const SHARD_CACHE_TTL_MS  = 600_000; // 10 min — refresh shard mid-session

  const ENABLED_KEY = 'membrain_context_inject_enabled';

  const state = {
    enabled: false,

    // Shard cache — keyed by conversationId, refreshed after TTL
    shardCache: {},   // { [convId]: { text, fetchedAt } }

    // RAG cache — per query
    ragLastQuery:     null,
    ragLastResult:    null,
    ragLastFetchedAt: 0,

    stats: { injections: 0, shardHits: 0, ragHits: 0, errors: 0 },
  };

  // ==================== PERSIST STATE ====================
  function loadEnabled() {
    try {
      const v = sessionStorage.getItem(ENABLED_KEY);
      state.enabled = v === null ? true : v === 'true';
    } catch { state.enabled = true; }
  }

  function saveEnabled() {
    try { sessionStorage.setItem(ENABLED_KEY, String(state.enabled)); } catch {}
  }

  loadEnabled();

  // ==================== CONVERSATION ID ====================
  // Extract conversation ID from claude.ai URL, e.g.
  // https://claude.ai/chat/abc123  →  'abc123'
  function getConversationId() {
    try {
      const match = window.location.pathname.match(/\/chat\/([a-zA-Z0-9_-]+)/);
      return match ? match[1] : 'default';
    } catch {
      return 'default';
    }
  }

  // ==================== LAYER 1: SHARD FETCH ====================
  async function fetchShard(convId) {
    const cached = state.shardCache[convId];
    const now = Date.now();

    if (cached && now - cached.fetchedAt < SHARD_CACHE_TTL_MS) {
      state.stats.shardHits++;
      return cached.text;
    }

    try {
      const resp = await fetch(
        `${BACKEND_URL}${SHARD_ENDPOINT}?token_budget=${SHARD_TOKEN_BUDGET}`,
        {
          method: 'GET',
          headers: { 'X-API-Key': API_KEY },
          signal: AbortSignal.timeout(5000),
        }
      );

      if (!resp.ok) { console.debug("[MemBrain:CI] shard fail", resp.status); return null; }
      const data = await resp.json();
      const text = data?.injection_text;

      console.debug("[MemBrain:CI] shard chars:", text?.length || 0);
      if (!text || text.trim() === '') return null;

      // Cache it
      state.shardCache[convId] = { text, fetchedAt: now };

      // Evict old entries (keep last 5 conversations)
      const keys = Object.keys(state.shardCache);
      if (keys.length > 5) {
        const oldest = keys.sort((a, b) =>
          state.shardCache[a].fetchedAt - state.shardCache[b].fetchedAt
        )[0];
        delete state.shardCache[oldest];
      }

      return text;

    } catch (e) {
      state.stats.errors++;
      return null;
    }
  }

  // ==================== LAYER 2: RAG FETCH ====================
  function extractQuery(msgText) {
    if (!msgText) return '';
    const clean = msgText.replace(/---.*?---/gs, '').trim();
    const sentences = clean.split(/(?<=[.!?])\s+/);
    return sentences.slice(-2).join(' ').slice(0, 200);
  }

  async function fetchRag(query) {
    if (!query || query.length < 10) return null;

    const now = Date.now();
    if (
      state.ragLastQuery === query &&
      state.ragLastResult &&
      now - state.ragLastFetchedAt < RAG_CACHE_TTL_MS
    ) {
      state.stats.ragHits++;
      return state.ragLastResult;
    }

    try {
      const resp = await fetch(`${BACKEND_URL}${INJECT_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': API_KEY,
        },
        body: JSON.stringify({ query, max_atoms: 5, max_sessions: 4 }),
        signal: AbortSignal.timeout(4000),
      });

      if (!resp.ok) return null;
      const data = await resp.json();
      const text = data?.context?.injection_text;

      if (!text || text === 'No relevant context found.' || text.trim() === '') {
        return null;
      }

      const result = text.slice(0, RAG_MAX_CHARS);
      state.ragLastQuery = query;
      state.ragLastResult = result;
      state.ragLastFetchedAt = now;
      return result;

    } catch (e) {
      state.stats.errors++;
      return null;
    }
  }

  // ==================== BUILD COMBINED BLOCK ====================
  function buildInjectionBlock(shardText, ragText) {
    const parts = [];

    if (shardText) {
      parts.push('--- HELIX SESSION CONTEXT ---');
      parts.push('(Recent decisions, entities, and stable patterns from your work history.)');
      parts.push(shardText);
      parts.push('--- END SESSION CONTEXT ---');
    }

    if (ragText) {
      parts.push('--- HELIX RELEVANT CONTEXT ---');
      parts.push('(Query-matched context from past sessions. Use to inform response; do not narrate.)');
      parts.push(ragText);
      parts.push('--- END RELEVANT CONTEXT ---');
    }

    if (!parts.length) return null;
    return parts.join('\n') + '\n\n';
  }

  // ==================== INJECT INTO REQUEST BODY ====================
  async function injectContext(bodyText) {
    if (!state.enabled) return null;
    // Check storage mode - only call Helix in cloud/self-hosted mode
    const _mode = sessionStorage.getItem('mb_storage_mode') || 'local';
    if (_mode === 'local') { console.debug('[MemBrain:CI] local mode, skipping Helix inject'); return null; }

    let body;
    try { body = JSON.parse(bodyText); } catch { return null; }

    // Extract user message text
    let msgText = '';
    if (body.prompt && typeof body.prompt === 'string') {
      msgText = body.prompt;
    } else if (Array.isArray(body.messages)) {
      const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
      if (lastUser) {
        if (typeof lastUser.content === 'string') msgText = lastUser.content;
        else if (Array.isArray(lastUser.content)) {
          const tb = lastUser.content.find(b => b.type === 'text');
          if (tb) msgText = tb.text || '';
        }
      }
    }

    if (!msgText || msgText.length < 15) return null;

    // Skip if message already has injected context (avoid double-inject)
    if (msgText.includes('--- HELIX SESSION CONTEXT ---') ||
        msgText.includes('--- HELIX RELEVANT CONTEXT ---') ||
        msgText.includes('[MEMBRAIN CONTEXT]')) {
      return null;
    }

    const convId = getConversationId();
    const query  = extractQuery(msgText);

    // Fire both fetches in parallel
    const [shardText, ragText] = await Promise.all([
      fetchShard(convId),
      fetchRag(query),
    ]);

    if (!shardText && !ragText) return null;

    const block = buildInjectionBlock(shardText, ragText);
    if (!block) return null;

    // Prepend to user message
    let modified = false;
    if (body.prompt && typeof body.prompt === 'string') {
      body.prompt = block + body.prompt;
      modified = true;
    } else if (Array.isArray(body.messages)) {
      const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
      if (lastUser) {
        if (typeof lastUser.content === 'string') {
          lastUser.content = block + lastUser.content;
          modified = true;
        } else if (Array.isArray(lastUser.content)) {
          const tb = lastUser.content.find(b => b.type === 'text');
          if (tb) { tb.text = block + (tb.text || ''); modified = true; }
        }
      }
    }

    if (!modified) return null;

    state.stats.injections++;

    // Notify HUD
    try {
      window.postMessage({
        source: 'memory-ext',
        type: 'memory-ext:context-injected',
        payload: {
          injections:  state.stats.injections,
          shardChars:  shardText?.length || 0,
          ragChars:    ragText?.length || 0,
          totalChars:  (shardText?.length || 0) + (ragText?.length || 0),
          convId:      convId,
          query:       query.slice(0, 60),
          layers:      [shardText ? 'shard' : null, ragText ? 'rag' : null].filter(Boolean),
        },
      }, '*');
    } catch {}

    return JSON.stringify(body);
  }

  // ==================== FETCH HOOK ====================
  function installFetchHook() {
    const prevFetch = window.fetch;

    window.fetch = async function (input, init) {
      if (!state.enabled || !init?.body || typeof init.body !== 'string') {
        return prevFetch.apply(this, arguments);
      }

      const url = typeof input === 'string' ? input
        : (input instanceof Request ? input.url : String(input));

      const isClaudeChat = /claude\.ai.*\/completion/.test(url);
      const isChatGPT   = /chatgpt\.com.*\/conversation/.test(url) ||
                          /chat\.openai\.com.*\/conversation/.test(url);

      if (isClaudeChat || isChatGPT) {
        try {
          const modified = await injectContext(init.body);
          if (modified) {
            init = { ...init, body: modified };
          }
        } catch (e) {
          console.warn('[MemBrain] Context inject error (sending original):', e.message);
        }
      }

      return prevFetch.apply(this, [input, init]);
    };

    console.debug('[MemBrain] Context inject fetch hook installed (v2 — shard+RAG)');
  }

  // ==================== TOGGLE ====================
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (msg?.source === 'memory-ext' && msg?.type === 'memory-ext:context-inject-toggle') {
      state.enabled = !!msg.payload?.enabled;
      saveEnabled();
      console.debug('[MemBrain] Context inject', state.enabled ? 'ENABLED' : 'DISABLED');
    }
    // Allow manual shard cache invalidation (e.g. after a long session)
    if (msg?.source === 'memory-ext' && msg?.type === 'memory-ext:shard-invalidate') {
      const convId = msg.payload?.convId || getConversationId();
      delete state.shardCache[convId];
      console.debug('[MemBrain] Shard cache invalidated for', convId);
    }
  });

  // ==================== STATUS API ====================
  window.__membrainContextInjectStatus = () => ({
    enabled:         state.enabled,
    version:         '2.0.0',
    stats:           state.stats,
    shardCached:     Object.keys(state.shardCache),
    ragLastQuery:    state.ragLastQuery,
    ragLastFetchedAt: state.ragLastFetchedAt,
  });

  installFetchHook();

})();
