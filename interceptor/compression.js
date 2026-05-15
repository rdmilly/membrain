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

  // Dynamic symbol dictionary received from SW via bridge
  let symbolMap = new Map();   // phrase → §symbol
  let expandMap = new Map();   // §symbol → phrase
  let symbolDictionary = [];   // full list for SPEC

  function updateDictionary(symbols) {
    symbolMap.clear(); expandMap.clear();
    symbolDictionary = symbols || [];
    for (const { symbol, phrase } of symbolDictionary) {
      if (symbol && phrase) {
        symbolMap.set(phrase.toLowerCase(), symbol);
        expandMap.set(symbol, phrase);
      }
    }
    console.debug(`[MemBrain] Symbol dict: ${symbolDictionary.length} symbols`);
  }

  // ==================== COMPRESSION SPEC ====================
  // Dynamically built — includes symbol dictionary when available
  function buildSpec() {
    const lines = [
      '--- CMPRS ---',
      'Respond concisely. Skip filler phrases.',
      "DROP: essentially, basically, actually, hope this helps, it's worth noting, I'd be happy to",
      'ABR: info config app env docs impl reqs deps perf auth auto comms org fn svc param',
    ];
    if (symbolDictionary.length > 0) {
      const top = symbolDictionary.slice(0, 20);
      const dictStr = top.map(({symbol, phrase}) => `${symbol}=${phrase}`).join(' ');
      lines.push(`SYMBOLS: ${dictStr}`);
      lines.push('USE: replace above phrases with their § code in your responses.');
    }
    lines.push('RULE: terse prose. no filler. code unchanged.');
    lines.push('--- END ---');
    return lines.join('\n');
  }

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
    // Static phrase replacements
    for (const [phrase, rep] of PHRASES) {
      r = r.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), rep);
    }
    for (const f of FILLERS) {
      r = r.replace(new RegExp('\\b' + f + '\\b\\s*,?\\s*', 'gi'), '');
    }
    for (const [full, short] of WORD_ABBREVS) {
      r = r.replace(new RegExp('\\b' + full + '\\b', 'gi'), short);
    }
    // Dynamic symbol substitution (longest phrases first to avoid partial matches)
    if (symbolMap.size > 0) {
      const sortedPhrases = [...symbolMap.entries()]
        .sort((a, b) => b[0].length - a[0].length);
      for (const [phrase, symbol] of sortedPhrases) {
        r = r.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), symbol);
      }
    }
    return r.replace(/\s+/g, ' ').trim().replace(/ +([.,;:])/g, '$1');
  }

  // ==================== RESPONSE EXPANDER ====================
  // Expands § symbols in Claude's responses back to plain text
  function expandText(text) {
    if (!text || expandMap.size === 0) return text;
    let r = text;
    for (const [symbol, phrase] of expandMap.entries()) {
      // Match symbol followed by word boundary or space
      r = r.replace(new RegExp(symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\s.,;:!?]|$)', 'g'), phrase);
    }
    return r;
  }

  // Expose expander globally for interceptor to use
  window.__membrainExpand = expandText;

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
      body.prompt = buildSpec() + '\n\n' + compressed;
      rawTokens = Math.ceil(original.length / 4);
      tokensSaved = Math.max(0, Math.ceil((original.length - compressed.length) / 4));
      modified = true;
    } else if (Array.isArray(body.messages)) {
      const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
      if (lastUser) {
        if (typeof lastUser.content === 'string' && lastUser.content.length > 10) {
          const original = lastUser.content;
          const compressed = compressText(original);
          lastUser.content = buildSpec() + '\n\n' + compressed;
          rawTokens = Math.ceil(original.length / 4);
          tokensSaved = Math.max(0, Math.ceil((original.length - compressed.length) / 4));
          modified = true;
        } else if (Array.isArray(lastUser.content)) {
          const textBlock = lastUser.content.find(b => b.type === 'text');
          if (textBlock && textBlock.text?.length > 10) {
            const original = textBlock.text;
            const compressed = compressText(original);
            textBlock.text = buildSpec() + '\n\n' + compressed;
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
    if (!event.data?.source?.startsWith('memory-ext') && event.data?.source !== 'memory-ext') return;
    if (event.data.type === 'memory-ext:compression-toggle') {
      state.enabled = !!event.data.payload?.enabled;
      console.debug('[MemBrain] Compression', state.enabled ? 'ENABLED' : 'DISABLED');
    }
    if (event.data.type === 'memory-ext:dictionary-update') {
      updateDictionary(event.data.payload?.symbols || []);
      // Notify HUD about symbol promotions
      const newSymbols = event.data.payload?.symbols || [];
      for (const entry of newSymbols) {
        window.postMessage({
          source: 'memory-ext',
          type: 'memory-ext:symbol-promoted',
          payload: { symbol: entry.symbol, phrase: entry.phrase },
        }, '*');
      }
    }
  });

  // ==================== INIT ====================

  installFetchHook();

  // Pull dictionary on load rather than waiting for broadcast
  setTimeout(() => {
    window.postMessage({ source: 'memory-ext', type: 'memory-ext:request-dictionary' }, '*');
    console.debug('[MemBrain] Compression requested dictionary');
  }, 2000);

  window.__membrainCompression = state;
  console.debug('[MemBrain] Compression module loaded (disabled, waiting for toggle)');
})();