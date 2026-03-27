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

  // Re-entrant guard removed: manifest injects at document_start, SW re-injects on
  // navigation. Both runs needed to ensure hook is in place after SPAs navigate.
  // The prevFetch chain handles multiple wraps correctly.

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

  // Local injection cache (MAIN world) — populated via postMessage from bridge.js
  // Cannot use window.__memoryExtInjection directly (set in ISOLATED world, invisible here)
  let _localInjection = { block: '', facts: [], method: 'none', enabled: true };
  let _storageMode = 'local'; // default until SW broadcasts

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
    // Context injection is always enabled by default
    // Only disabled if user explicitly turns it off
    try {
      const v = sessionStorage.getItem(ENABLED_KEY);
      // Default TRUE - only false if explicitly set to 'false'
      state.enabled = v !== 'false';
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

    // Block double-injection: if msgText already has injected context, skip
    if (msgText.includes('[MEMBRAIN CONTEXT]') ||
        msgText.includes('--- HELIX SESSION CONTEXT ---') ||
        msgText.includes('--- HELIX RELEVANT CONTEXT ---') ||
        msgText.includes('<helix_context>')) return null;
    // Strip any stale context remnants before processing
    const cleanMsg = msgText.trim();
    if (!cleanMsg || cleanMsg.length < 5) return null;

    // Use MAIN-world local var (sessionStorage not reliably readable from MAIN world)
    const _mode = _storageMode;
    const convId = getConversationId();

    // ====== LOCAL MODE: inject from IndexedDB via Mirror Index ======
    if (_mode === 'local') {
      // Use MAIN-world cache - window.__memoryExtInjection lives in ISOLATED world
      const injection = _localInjection;
      const block = injection?.block;

      // Always pre-fetch for NEXT message with current query
      window.postMessage({
        source: 'memory-ext',
        type: 'memory-ext:request-injection',
        payload: { userMessage: msgText },
      }, '*');

      if (!block || block.trim() === '') {
        // No content yet — notify HUD so CI tab shows MemBrain is active
        try {
          window.postMessage({
            source: 'memory-ext',
            type: 'memory-ext:context-injected',
            payload: {
              injections: 0, totalChars: 0, ragChars: 0, shardChars: 0,
              query: msgText.slice(0, 60), layers: ['local'],
              factsCount: 0, method: 'warming up…',
            },
          }, '*');
        } catch {}
        return null;
      }

      // Inject local block
      const localBlock = block + '\n\n'; // block already has <helix_context> tags
      let modified = false;

      if (body.prompt && typeof body.prompt === 'string') {
        body.prompt = localBlock + body.prompt; modified = true;
      } else if (Array.isArray(body.messages)) {
        const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
        if (lastUser) {
          if (typeof lastUser.content === 'string') {
            lastUser.content = localBlock + lastUser.content; modified = true;
          } else if (Array.isArray(lastUser.content)) {
            const tb = lastUser.content.find(b => b.type === 'text');
            if (tb) { tb.text = localBlock + (tb.text || ''); modified = true; }
          }
        }
      }

      if (!modified) return null;

      state.stats.injections++;
      const factsCount = injection?.facts?.length || 0;

      // Notify HUD
      try {
        window.postMessage({
          source: 'memory-ext',
          type: 'memory-ext:context-injected',
          payload: {
            injections: state.stats.injections,
            shardChars: 0,
            ragChars: block.length,
            totalChars: block.length,
            convId,
            query: msgText.slice(0, 60),
            layers: ['local'],
            factsCount,
            method: injection?.method || 'hybrid',
          },
        }, '*');
      } catch {}

      console.debug('[MemBrain:CI] local inject:', factsCount, 'facts,', block.length, 'chars');
      return JSON.stringify(body);
    }

    // ====== CLOUD MODE: inject from Helix shard + RAG ======
    const query = extractQuery(msgText);
    const [shardText, ragText] = await Promise.all([
      fetchShard(convId),
      fetchRag(query),
    ]);

    if (!shardText && !ragText) return null;

    const block = buildInjectionBlock(shardText, ragText);
    if (!block) return null;

    let modified = false;
    if (body.prompt && typeof body.prompt === 'string') {
      body.prompt = block + body.prompt; modified = true;
    } else if (Array.isArray(body.messages)) {
      const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
      if (lastUser) {
        if (typeof lastUser.content === 'string') {
          lastUser.content = block + lastUser.content; modified = true;
        } else if (Array.isArray(lastUser.content)) {
          const tb = lastUser.content.find(b => b.type === 'text');
          if (tb) { tb.text = block + (tb.text || ''); modified = true; }
        }
      }
    }

    if (!modified) return null;

    state.stats.injections++;

    try {
      window.postMessage({
        source: 'memory-ext',
        type: 'memory-ext:context-injected',
        payload: {
          injections: state.stats.injections,
          shardChars: shardText?.length || 0,
          ragChars: ragText?.length || 0,
          totalChars: (shardText?.length || 0) + (ragText?.length || 0),
          convId,
          query: query.slice(0, 60),
          layers: [shardText ? 'shard' : null, ragText ? 'rag' : null].filter(Boolean),
        },
      }, '*');
    } catch {}

    return JSON.stringify(body);
  }


  // ==================== FETCH HOOK ====================
  function installFetchHook() {
    const prevFetch = window.fetch;

    window.fetch = async function (input, init) {
      const _url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
      const _isAI = _url.includes('completion') || _url.includes('conversation') || _url.includes('claude.ai') || _url.includes('chatgpt');
      if (_isAI) {
        console.debug('[MemBrain:CI] fetch:', _url.slice(0,100), '| enabled:', state.enabled, '| body:', typeof init?.body, init?.body?.length);
      }
      if (!state.enabled || !init?.body || typeof init.body !== 'string') {
        return prevFetch.apply(this, arguments);
      }

      const url = typeof input === 'string' ? input
        : (input instanceof Request ? input.url : String(input));

      const isClaudeChat = url.includes('/completion') || url.includes('claude.ai');
      const isChatGPT   = /chatgpt\.com.*\/conversation/.test(url) ||
                          /chat\.openai\.com.*\/conversation/.test(url);

      if (isClaudeChat || isChatGPT) {
        console.debug('[MemBrain:CI] fetch hook fired, url:', url.slice(0,60), 'mode:', sessionStorage.getItem('mb_storage_mode'));
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
    if (!msg?.source || msg.source !== 'memory-ext') return;

    // Receive injection block from bridge.js (ISOLATED world → MAIN world via postMessage)
    if (msg.type === 'memory-ext:injection-update') {
      const p = msg.payload || {};
      _localInjection = {
        block: p.block || '',
        facts: p.facts || [],
        method: p.method || 'keyword',
        enabled: p.enabled !== false,
        count: p.count || 0,
      };
      console.debug('[MemBrain:CI] injection cache updated:', _localInjection.block.length, 'chars,', _localInjection.facts.length, 'facts');
    }

    // Receive storage mode from bridge.js
    if (msg.type === 'memory-ext:storage-mode') {
      _storageMode = msg.payload?.mode || 'local';
      console.debug('[MemBrain:CI] storage mode:', _storageMode);
    }

    if (msg.type === 'memory-ext:context-inject-toggle') {
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
