/**
 * MemBrain — cortex_act.js v1.2.0
 *
 * Changes from v1.1.0:
 *  - Delta tracking: computes what changed vs previous message
 *  - Content type routing: pre-calls /classify to get turn_type + adjusted params
 *  - Uses adjusted params (max_atoms, max_decisions) per turn type
 *  - Still falls back silently on any error or timeout
 */

(function () {
  'use strict';

  if (window.__membrainCortexActInstalled) return;
  window.__membrainCortexActInstalled = true;

  const BACKEND_URL      = 'https://helix.millyweb.com';
  const API_KEY          = 'ce-prod-6292b483717db14c83924a52715988ae';
  const INJECT_ENDPOINT  = '/api/v1/context/inject';
  const CLASSIFY_ENDPOINT = '/api/v1/context/classify';
  const LOG_ENDPOINT     = '/api/v1/actions/log';
  const INJECT_TIMEOUT   = 2000;
  const CLASSIFY_TIMEOUT = 500;   // classify is pure keywords, should be <5ms server-side
  const MIN_MSG_LEN      = 15;
  const CACHE_TTL_MS     = 300_000; // 5 min
  const PREWARM_DELAY_MS = 3000;

  const stats = {
    fired: 0, matched: 0, timeouts: 0, errors: 0, skipped: 0,
    classified: 0, warmed: false,
    turn_types: { code: 0, infra: 0, decision: 0, entity: 0, language: 0 },
  };

  // Cache
  let _lastQuery = null;
  let _lastResult = null;
  let _lastFiredAt = 0;

  // Delta tracking — store cleaned version of each message
  let _prevCleanText = '';

  // ==================== TEXT CLEANING ====================
  function cleanText(msgText) {
    return msgText
      .replace(/--- HELIX.*?---/gs, '')
      .replace(/--- CORTEX ENRICHMENT ---.*?--- END CORTEX ENRICHMENT ---/gs, '')
      .replace(/<helix_context>.*?<\/helix_context>/gs, '')
      .replace(/\[MEMBRAIN CONTEXT\].*$/s, '')
      .trim();
  }

  // ==================== DELTA GENERATOR ====================
  // Returns only what's meaningfully new vs the previous message.
  // Falls back to last 500 chars of full text if no useful diff.
  function extractDelta(clean) {
    if (!clean || clean.length < MIN_MSG_LEN) return null;

    if (!_prevCleanText) {
      _prevCleanText = clean;
      return clean.slice(-500);
    }

    // Word-level diff: find words in current that weren't in previous
    const prevWords = new Set(_prevCleanText.toLowerCase().split(/\s+/));
    const currWords = clean.toLowerCase().split(/\s+/);
    const newWords = currWords.filter(w => w.length > 3 && !prevWords.has(w));

    // Update prev for next turn
    _prevCleanText = clean;

    // If substantial new content, use the new words as delta signal
    if (newWords.length >= 5) {
      return newWords.slice(-50).join(' '); // last 50 new words
    }

    // Otherwise use last 500 chars (covers short follow-up questions)
    return clean.slice(-500);
  }

  // ==================== CLASSIFY TURN ====================
  async function classifyTurn(query, delta) {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT);

      const resp = await fetch(`${BACKEND_URL}${CLASSIFY_ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify({ query: (delta || query).slice(0, 300) }),
        signal: controller.signal,
      });

      if (!resp.ok) return null;
      const data = await resp.json();
      const tt = data?.turn_type || 'language';
      stats.classified++;
      stats.turn_types[tt] = (stats.turn_types[tt] || 0) + 1;
      return data; // { turn_type, adjusted_params }

    } catch (e) {
      return null; // silent fallback — use defaults
    }
  }

  // ==================== CORTEX_ACT QUERY ====================
  async function queryCortexAct(delta, sessionId, adjustedParams) {
    const now = Date.now();
    const cacheKey = delta.slice(0, 100);

    if (_lastQuery === cacheKey && _lastResult !== null && now - _lastFiredAt < CACHE_TTL_MS) {
      stats.matched++;
      return _lastResult;
    }

    const params = adjustedParams || {
      max_atoms: 3, max_decisions: 3, max_sessions: 2, include_entities: true,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      stats.timeouts++;
    }, INJECT_TIMEOUT);

    try {
      const resp = await fetch(`${BACKEND_URL}${INJECT_ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify({
          query: delta,
          session_id: sessionId || 'cortex_act',
          max_atoms: params.max_atoms,
          max_decisions: params.max_decisions,
          max_sessions: params.max_sessions,
          include_entities: params.include_entities,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);
      if (!resp.ok) { stats.errors++; return null; }

      const data = await resp.json();
      const text =
        data?.context?.injection_text ||
        data?.injection_text ||
        data?.recent_shard?.injection_text ||
        null;

      if (!text || text.trim().length < 20) return null;

      _lastQuery = cacheKey;
      _lastResult = text;
      _lastFiredAt = now;
      stats.matched++;
      return text;

    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') stats.timeouts++;
      else stats.errors++;
      return null;
    }
  }

  // ==================== LOG ====================
  function logToObserver(sessionId, matched, turnType) {
    try {
      fetch(`${BACKEND_URL}${LOG_ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify({
          session_id: sessionId || 'cortex_act',
          tool_name: 'cortex_act',
          intent: `pre-send enrichment (${turnType || 'unknown'})`,
          outcome: matched ? 'matched' : 'no_match',
          result_summary: `v1.2 fired:${stats.fired} matched:${stats.matched} timeouts:${stats.timeouts} classified:${stats.classified}`,
          negative_signal: false,
        }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }

  // ==================== BUILD BLOCK ====================
  function buildBlock(text, turnType) {
    return (
      `--- CORTEX ENRICHMENT [${(turnType || 'auto').toUpperCase()}] ---\n` +
      '(Pre-matched patterns, decisions, entities for this message.)\n' +
      text.trim() +
      '\n--- END CORTEX ENRICHMENT ---\n\n'
    );
  }

  // ==================== INJECT ====================
  function injectIntoBody(bodyStr, block) {
    let body;
    try { body = JSON.parse(bodyStr); } catch { return null; }
    let modified = false;

    if (body.prompt && typeof body.prompt === 'string') {
      if (body.prompt.includes('--- CORTEX ENRICHMENT')) return null;
      body.prompt = block + body.prompt; modified = true;
    } else if (Array.isArray(body.messages)) {
      const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
      if (lastUser) {
        if (typeof lastUser.content === 'string') {
          if (lastUser.content.includes('--- CORTEX ENRICHMENT')) return null;
          lastUser.content = block + lastUser.content; modified = true;
        } else if (Array.isArray(lastUser.content)) {
          const tb = lastUser.content.find(b => b.type === 'text');
          if (tb) {
            if ((tb.text || '').includes('--- CORTEX ENRICHMENT')) return null;
            tb.text = block + (tb.text || ''); modified = true;
          }
        }
      }
    }
    return modified ? JSON.stringify(body) : null;
  }

  // ==================== EXTRACT MSG ====================
  function extractUserMessage(bodyStr) {
    try {
      const body = JSON.parse(bodyStr);
      if (body.prompt && typeof body.prompt === 'string') return body.prompt;
      if (Array.isArray(body.messages)) {
        const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
        if (!lastUser) return '';
        if (typeof lastUser.content === 'string') return lastUser.content;
        if (Array.isArray(lastUser.content)) {
          return lastUser.content.find(b => b.type === 'text')?.text || '';
        }
      }
    } catch {}
    return '';
  }

  function getSessionId() {
    try {
      const m = window.location.pathname.match(/\/chat\/([a-zA-Z0-9_-]+)/);
      return m ? m[1] : 'unknown';
    } catch { return 'unknown'; }
  }

  // ==================== PRE-WARM ====================
  async function prewarm() {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 8000);
      await fetch(`${BACKEND_URL}${INJECT_ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify({
          query: 'paving agent membrain helix watchtower cortex_act',
          max_atoms: 2, max_decisions: 1, max_sessions: 1, include_entities: false,
        }),
        signal: controller.signal,
      });
      stats.warmed = true;
      console.debug('[MemBrain:cortex_act] prewarm complete');
    } catch (e) {
      console.debug('[MemBrain:cortex_act] prewarm failed (non-fatal):', e.message);
    }
  }

  // ==================== MAIN HOOK ====================
  function installHook() {
    const prevFetch = window.fetch;

    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input
        : (input instanceof Request ? input.url : String(input));

      const isAI = (
        url.includes('/completion') ||
        /\/backend-api\/conversation/.test(url) ||
        /\/_\/BardChatUi\/|api\/generate|StreamGenerate/.test(url)
      );

      if (!isAI || !init?.body || typeof init.body !== 'string') {
        return prevFetch.apply(this, arguments);
      }

      stats.fired++;
      const sessionId = getSessionId();

      try {
        const msgText = extractUserMessage(init.body);
        const clean = cleanText(msgText);
        const delta = extractDelta(clean);

        if (!delta) {
          stats.skipped++;
          return prevFetch.apply(this, [input, init]);
        }

        // Classify turn type and get adjusted params (fast, parallel-safe)
        const classification = await classifyTurn(clean, delta);
        const turnType = classification?.turn_type || 'language';
        const adjustedParams = classification?.adjusted_params || null;

        // Query with adjusted params
        const enrichmentText = await queryCortexAct(delta, sessionId, adjustedParams);

        if (enrichmentText) {
          const block = buildBlock(enrichmentText, turnType);
          const modifiedBody = injectIntoBody(init.body, block);
          if (modifiedBody) {
            init = { ...init, body: modifiedBody };
            try {
              window.postMessage({
                source: 'memory-ext',
                type: 'memory-ext:cortex-act-injected',
                payload: {
                  chars: enrichmentText.length,
                  sessionId, turnType,
                  query: delta.slice(0, 60),
                  fired: stats.fired,
                  matched: stats.matched,
                  version: '1.2.0',
                },
              }, '*');
            } catch (_) {}
          }
        }

        logToObserver(sessionId, !!enrichmentText, turnType);

      } catch (e) {
        stats.errors++;
        console.debug('[MemBrain:cortex_act] error (silent):', e.message);
      }

      return prevFetch.apply(this, [input, init]);
    };

    console.debug('[MemBrain] cortex_act hook installed v1.2.0 (delta+classify+routing)');
  }

  // ==================== STATUS ====================
  window.__membrainCortexActStatus = () => ({
    version: '1.2.0',
    installed: true,
    stats,
    lastQuery: _lastQuery?.slice(0, 80),
    lastFiredAt: _lastFiredAt,
    warmed: stats.warmed,
    prevMsgLen: _prevCleanText.length,
  });

  setTimeout(prewarm, PREWARM_DELAY_MS);
  installHook();

})();
