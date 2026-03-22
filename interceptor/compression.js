/**
 * MemBrain — Compression Module v0.4.3
 * 
 * COMPLETELY SEPARATE from the main interceptor.
 * Has its own fetch hook that only activates when enabled.
 * The main interceptor handles capture + token counting regardless.
 * 
 * When enabled:
 *   1. Outgoing: Prepends compression spec to user message + compresses text
 *   2. Incoming: NOT modified (expansion is future work)
 * 
 * CRITICAL: Uses the same injection method as memory injection
 * (prepend to body.prompt or last user message content).
 * Does NOT set body.system (claude.ai web doesn't support that).
 */

(function () {
  'use strict';

  if (window.__membrainCompressionInstalled) return;
  window.__membrainCompressionInstalled = true;

  // ==================== STATE ====================

  const state = {
    enabled: false,
    stats: { requests_compressed: 0, tokens_saved_est: 0 },
  };

  // ==================== COMPRESSION SPEC ====================
  // Teaches the LLM to output shorter. ~137 tokens.
  const SPEC = [
    '--- CMPRS ---',
    'Respond concisely. Skip filler phrases.',
    'DROP: essentially, basically, actually, "hope this helps", "it\'s worth noting", "I\'d be happy to", "feel free to", "let me know if you have any questions"',
    'ABR: info config app env docs impl reqs deps perf auth auto comms org fn svc param',
    'RULE: terse prose. no filler. code unchanged.',
    '--- END ---',
  ].join('\n');

  // ==================== PHRASE COMPRESSIONS ====================
  const PHRASES = [
    ['let me know if you have any questions', ''],
    ['feel free to ask if you need', ''],
    ['would you like me to', 'shall I'],
    ['it\'s important to note that', 'note:'],
    ['it is important to note that', 'note:'],
    ['it\'s worth noting that', 'note:'],
    ['I would recommend', 'I recommend'],
    ['I\'d recommend', 'I recommend'],
    ['I\'ve successfully', ''],
    ['has been successfully', ''],
    ['in addition to', 'plus'],
    ['as well as', 'and'],
    ['in order to', 'to'],
    ['for example', 'e.g.'],
    ['for instance', 'e.g.'],
    ['as a result', 'so'],
    ['additionally', 'also'],
    ['furthermore', 'also'],
    ['hope this helps', ''],
    ['I\'d be happy to', 'I can'],
    ['feel free to', ''],
  ];

  const FILLERS = ['essentially', 'basically', 'actually', 'honestly'];

  const WORD_ABBREVS = [
    ['implementation', 'impl'], ['infrastructure', 'infra'],
    ['configuration', 'config'], ['environment', 'env'],
    ['authentication', 'auth'], ['documentation', 'docs'],
    ['requirements', 'reqs'], ['dependencies', 'deps'],
    ['performance', 'perf'], ['approximately', 'approx'],
  ];

  // ==================== COMPRESS TEXT ====================

  function compressText(text) {
    if (!text || text.length < 30) return text;
    let r = text;
    for (const [phrase, rep] of PHRASES) {
      r = r.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), rep);
    }
    for (const f of FILLERS) {
      r = r.replace(new RegExp('\\b' + f + '\\b\\s*,?\\s*', 'gi'), '');
    }
    for (const [full, short] of WORD_ABBREVS) {
      r = r.replace(new RegExp('\\b' + full + '\\b', 'gi'), short);
    }
    return r.replace(/\s+/g, ' ').trim().replace(/ +([.,;:])/g, '$1');
  }

  // ==================== INJECT INTO REQUEST ====================

  function injectCompression(bodyText) {
    // Only process JSON bodies
    let body;
    try { body = JSON.parse(bodyText); } catch { return null; }

    let modified = false;
    let tokensSaved = 0;
    let rawTokens = 0;

    // Inject spec + compress using SAME method as memory injection
    // Claude.ai web: body.prompt (string) or body.messages array
    if (body.prompt && typeof body.prompt === 'string') {
      const original = body.prompt;
      const compressed = compressText(original);
      body.prompt = SPEC + '\n\n' + compressed;
      rawTokens = Math.ceil(original.length / 4);
      tokensSaved = Math.max(0, Math.ceil((original.length - compressed.length) / 4));
      modified = true;
    } else if (Array.isArray(body.messages)) {
      const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
      if (lastUser) {
        if (typeof lastUser.content === 'string' && lastUser.content.length > 10) {
          const original = lastUser.content;
          const compressed = compressText(original);
          lastUser.content = SPEC + '\n\n' + compressed;
          rawTokens = Math.ceil(original.length / 4);
          tokensSaved = Math.max(0, Math.ceil((original.length - compressed.length) / 4));
          modified = true;
        } else if (Array.isArray(lastUser.content)) {
          const textBlock = lastUser.content.find(b => b.type === 'text');
          if (textBlock && textBlock.text?.length > 10) {
            const original = textBlock.text;
            const compressed = compressText(original);
            textBlock.text = SPEC + '\n\n' + compressed;
            rawTokens = Math.ceil(original.length / 4);
            tokensSaved = Math.max(0, Math.ceil((original.length - compressed.length) / 4));
            modified = true;
          }
        }
      }
    }

    if (!modified) return null;

    state.stats.requests_compressed++;
    state.stats.tokens_saved_est += tokensSaved;

    // Tell the HUD — include raw_tokens so the savings % can be calculated
    try {
      window.postMessage({
        source: 'memory-ext',
        type: 'memory-ext:compression-applied',
        payload: {
          tokens_saved: tokensSaved,
          raw_tokens: rawTokens,
          total_saved: state.stats.tokens_saved_est,
        },
      }, '*');
    } catch {}

    return JSON.stringify(body);
  }

  // ==================== SEPARATE FETCH HOOK ====================
  // This wraps the CURRENT window.fetch (which may already be wrapped by interceptor)
  // It only modifies outgoing requests when compression is enabled

  function installFetchHook() {
    const prevFetch = window.fetch;

    window.fetch = async function (input, init) {
      // Only act if compression is ON
      if (!state.enabled) return prevFetch.apply(this, arguments);

      const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));

      // Only compress requests to known AI chat endpoints
      const isClaudeChat = /claude\.ai.*\/completion/.test(url);
      const isChatGPT = /chatgpt\.com.*\/conversation/.test(url) || /chat\.openai\.com.*\/conversation/.test(url);

      if ((isClaudeChat || isChatGPT) && init?.body && typeof init.body === 'string') {
        try {
          const modified = injectCompression(init.body);
          if (modified) {
            init = { ...init, body: modified };
          }
        } catch (e) {
          // NEVER break the request. If compression fails, send original.
          console.warn('[MemBrain] Compression error (sending original):', e.message);
        }
      }

      return prevFetch.apply(this, [input, init]);
    };

    console.debug('[MemBrain] Compression fetch hook installed');
  }

  // ==================== TOGGLE LISTENER ====================

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source === 'memory-ext' && event.data?.type === 'memory-ext:compression-toggle') {
      state.enabled = !!event.data.payload?.enabled;
      console.debug('[MemBrain] Compression', state.enabled ? 'ENABLED' : 'DISABLED');
    }
  });

  // ==================== INIT ====================

  installFetchHook();

  window.__membrainCompression = state;
  console.debug('[MemBrain] Compression module loaded (disabled, waiting for toggle)');
})();