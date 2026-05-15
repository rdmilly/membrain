/**
 * Memory Extension — Fetch Interceptor
 * Runs in the PAGE WORLD (not isolated world).
 * Monkey-patches window.fetch() and XMLHttpRequest to capture AI platform traffic.
 *
 * Injected by content/bridge.js via <script> tag.
 * Communicates back via window.postMessage().
 *
 * CRITICAL: Must never break the original page behavior.
 */

(function () {
  'use strict';

  // Guard against double-injection
  if (window.__memoryExtInterceptorInstalled) return;
  window.__memoryExtInterceptorInstalled = true;

  // ==================== CONFIG ====================

  const PREFIX = 'memory-ext';
  const MSG_TYPES = {
    RESPONSE_CAPTURED: `${PREFIX}:response-captured`,
    REQUEST_CAPTURED: `${PREFIX}:request-captured`,
    STREAM_COMPLETE: `${PREFIX}:stream-complete`,
    STREAM_ERROR: `${PREFIX}:stream-error`,
    INTERCEPTOR_READY: `${PREFIX}:interceptor-ready`,
    INJECTION_APPLIED: `${PREFIX}:injection-applied`,
  };

  // Injection cache — updated by bridge.js via postMessage
  window.__memoryExtInjection = { block: '', facts: [], enabled: false };

  // Listen for injection updates from bridge
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source === PREFIX && event.data?.type === `${PREFIX}:injection-update`) {
      window.__memoryExtInjection = event.data.payload || { block: '', facts: [], enabled: false };
    }
  });

  // Inline platform patterns (avoids module import in page world)
  const PLATFORM_PATTERNS = {
    claude: {
      response: [
        { pattern: /\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/completion/, conversationIdGroup: 1, streaming: true },
      ],
      request: [
        { pattern: /\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/completion/, conversationIdGroup: 1 },
      ],
      hostPattern: /claude\.ai$/,
    },
    chatgpt: {
      response: [
        { pattern: /\/backend-api\/conversation$/, conversationIdGroup: null, streaming: true },
      ],
      request: [
        { pattern: /\/backend-api\/conversation$/, conversationIdGroup: null },
      ],
      hostPattern: /chat\.openai\.com$|chatgpt\.com$/,
    },
    gemini: {
      response: [
        { pattern: /\/(_\/BardChatUi\/|api\/generate|StreamGenerate)/, conversationIdGroup: null, streaming: true },
      ],
      request: [
        { pattern: /\/(_\/BardChatUi\/|api\/generate|StreamGenerate)/, conversationIdGroup: null },
      ],
      hostPattern: /gemini\.google\.com$/,
    },
    perplexity: {
      response: [
        { pattern: /\/api\/query/, conversationIdGroup: null, streaming: true },
      ],
      request: [
        { pattern: /\/api\/query/, conversationIdGroup: null },
      ],
      hostPattern: /perplexity\.ai$/,
    },
  };

  // ==================== URL MATCHING ====================

  function matchUrl(url, direction) {
    let parsed;
    try { parsed = new URL(url, window.location.origin); } catch { return null; }

    for (const [platform, config] of Object.entries(PLATFORM_PATTERNS)) {
      if (!config.hostPattern.test(parsed.hostname)) continue;
      const patterns = config[direction] || [];
      for (const def of patterns) {
        const match = url.match(def.pattern);
        if (match) {
          return {
            platform,
            pattern: def,
            match,
            conversationId: def.conversationIdGroup !== null ? match[def.conversationIdGroup] : null,
          };
        }
      }
    }
    return null;
  }

  // ==================== SSE REASSEMBLER (INLINE) ====================

  class SSEReassembler {
    constructor(platform, conversationId) {
      this.platform = platform;
      this._buffer = '';
      this._textParts = [];
      this._chunks = [];
      this._conversationId = conversationId;
      this._done = false;
      this._usage = { input_tokens: 0, output_tokens: 0 };
    }

    feed(text) {
      if (this._done) return;
      this._buffer += text;
      const lines = this._buffer.split('\n');
      this._buffer = lines.pop() || '';
      for (const line of lines) this._processLine(line);
    }

    finish() {
      if (this._done) return null;
      this._done = true;
      if (this._buffer.trim()) {
        this._processLine(this._buffer);
        this._buffer = '';
      }
      return {
        platform: this.platform,
        conversationId: this._conversationId,
        content: this._textParts.join(''),
        chunkCount: this._chunks.length,
        timestamp: Date.now(),
      };
    }

    _processLine(line) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) return;
      const data = trimmed.slice(6);
      if (data === '[DONE]' || data === '[done]') { this.finish(); return; }

      let parsed;
      try { parsed = JSON.parse(data); } catch { this._chunks.push({ raw: data }); return; }

      this._chunks.push(parsed);
      this._extractUsage(parsed);
      const text = this._extractText(parsed);
      if (text) this._textParts.push(text);
      if (!this._conversationId) {
        this._conversationId = parsed.conversation_id || parsed.message?.conversation_id || null;
      }
    }

    _extractText(data) {
      switch (this.platform) {
        case 'claude':
          if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') return data.delta.text || '';
          if (data.type === 'completion' && data.completion) return data.completion;
          return null;
        case 'chatgpt':
          // ChatGPT sends full parts each time; capture last part, parser will dedup
          if (data.message?.content?.parts) {
            const parts = data.message.content.parts;
            return parts[parts.length - 1] || null;
          }
          return null;
        case 'gemini':
          return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
        case 'perplexity':
          return data.choices?.[0]?.delta?.content || data.text || null;
        default:
          return data.choices?.[0]?.delta?.content || data.delta?.text || data.text || null;
      }
    }
    _extractUsage(data) {
      // Claude: message_start has input token count
      if (data.type === 'message_start' && data.message?.usage) {
        this._usage.input_tokens = data.message.usage.input_tokens || 0;
      }
      // Claude: message_delta has output token count at end of stream
      if (data.type === 'message_delta' && data.usage) {
        this._usage.output_tokens = data.usage.output_tokens || 0;
      }
      // OpenAI: usage in final chunk
      if (data.usage) {
        if (data.usage.prompt_tokens) this._usage.input_tokens = data.usage.prompt_tokens;
        if (data.usage.completion_tokens) this._usage.output_tokens = data.usage.completion_tokens;
      }
    }
  }

  // ==================== MEMORY INJECTION ====================

  /**
   * Modify outgoing request body to include memory context.
   * Returns true if modified, false if skipped.
   */
  function injectMemoryContext(body, platform, block) {
    if (!block) return false;

    switch (platform) {
      case 'claude': {
        // Prepend to user message
        if (body.prompt && typeof body.prompt === 'string') {
          body.prompt = block + '\n\n' + body.prompt;
          return true;
        }
        if (Array.isArray(body.messages)) {
          const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
          if (lastUser) {
            if (typeof lastUser.content === 'string') {
              lastUser.content = block + '\n\n' + lastUser.content;
              return true;
            } else if (Array.isArray(lastUser.content)) {
              const textBlock = lastUser.content.find(b => b.type === 'text');
              if (textBlock) { textBlock.text = block + '\n\n' + textBlock.text; return true; }
            }
          }
        }
        return false;
      }

      case 'chatgpt': {
        // ChatGPT: body.messages array, modify last user message
        if (Array.isArray(body.messages)) {
          const lastUser = [...body.messages].reverse().find(m => m.author?.role === 'user' || m.role === 'user');
          if (lastUser?.content?.parts) {
            const lastPart = lastUser.content.parts.length - 1;
            if (typeof lastUser.content.parts[lastPart] === 'string') {
              lastUser.content.parts[lastPart] = block + '\n\n' + lastUser.content.parts[lastPart];
              return true;
            }
          } else if (lastUser && typeof lastUser.content === 'string') {
            lastUser.content = block + '\n\n' + lastUser.content;
            return true;
          }
        }
        return false;
      }

      case 'gemini':
      case 'perplexity':
      default: {
        // Generic: find messages/contents array, modify last user text
        if (Array.isArray(body.contents)) {
          const lastUser = [...body.contents].reverse().find(c => c.role === 'user');
          if (lastUser?.parts?.[0]?.text) {
            lastUser.parts[0].text = block + '\n\n' + lastUser.parts[0].text;
            return true;
          }
        }
        if (Array.isArray(body.messages)) {
          const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
          if (lastUser && typeof lastUser.content === 'string') {
            lastUser.content = block + '\n\n' + lastUser.content;
            return true;
          }
        }
        return false;
      }
    }
  }

  // ==================== SAFE POST MESSAGE ====================

  function emit(type, payload) {
    try {
      window.postMessage({ source: PREFIX, type, payload }, '*');
    } catch (e) {
      // Swallow — never break the page
    }
  }

  // ==================== FETCH INTERCEPTOR ====================

  const originalFetch = window.fetch;

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));

    // Check if this is an outgoing request to a known platform
    const requestMatch = matchUrl(url, 'request');
    if (requestMatch && init?.body) {
      try {
        const bodyText = typeof init.body === 'string' ? init.body : null;
        if (bodyText) {
          // Capture the outgoing request
          emit(MSG_TYPES.REQUEST_CAPTURED, {
            platform: requestMatch.platform,
            conversationId: requestMatch.conversationId,
            url,
            body: bodyText,
            timestamp: Date.now(),
          });

          // === MEMORY INJECTION ===
          const injection = window.__memoryExtInjection;
          if (injection?.enabled && injection?.block) {
            try {
              const body = JSON.parse(bodyText);
              const modified = injectMemoryContext(body, requestMatch.platform, injection.block);
              if (modified) {
                init.body = JSON.stringify(body);
                emit(MSG_TYPES.INJECTION_APPLIED, {
                  platform: requestMatch.platform,
                  factCount: injection.facts?.length || 0,
                  tokenEstimate: Math.ceil(injection.block.length / 4),
                  facts: injection.facts || [],
                  timestamp: Date.now(),
                });
              }
            } catch { /* Don't break outgoing request */ }
          }
        }
      } catch { /* swallow */ }
    }

    // Call original fetch — MUST happen regardless
    const response = await originalFetch.apply(this, arguments);

    // Check if this response should be captured
    const responseMatch = matchUrl(url, 'response');
    if (!responseMatch) return response;

    // Clone the response so we don't consume the original
    try {
      const cloned = response.clone();
      const contentType = response.headers.get('content-type') || '';
      const isSSE = contentType.includes('text/event-stream') ||
                    responseMatch.pattern.streaming;

      if (isSSE && cloned.body) {
        // Stream processing — read the cloned body without affecting original
        processSSEStream(cloned, responseMatch).catch(() => {});
      } else {
        // Non-streaming response
        processNonStreamResponse(cloned, responseMatch).catch(() => {});
      }
    } catch {
      // Never break the page — if cloning fails, just return original
    }

    return response;
  };

  async function processSSEStream(response, match) {
    const reassembler = new SSEReassembler(match.platform, match.conversationId);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        reassembler.feed(text);
      }
    } catch (e) {
      emit(MSG_TYPES.STREAM_ERROR, {
        platform: match.platform,
        error: e.message,
        timestamp: Date.now(),
      });
    }

    const result = reassembler.finish();
    if (result) {
      // Expand § symbols in response if expander is available
      if (result.content && typeof window.__membrainExpand === 'function') {
        result.content = window.__membrainExpand(result.content);
      }
      emit(MSG_TYPES.STREAM_COMPLETE, {
        ...result,
        url: typeof response.url === 'string' ? response.url : '',
        role: 'assistant',
        usage: reassembler._usage,
      });
      // Always emit token-usage — even if content is empty (tool use, etc)
      console.debug('[MemBrain] token-usage emit:', reassembler._usage, 'content len:', result.content?.length);
      emit(`${PREFIX}:token-usage`, {
        input_tokens: reassembler._usage.input_tokens || 0,
        output_tokens: reassembler._usage.output_tokens || 0,
        conversationId: result.conversationId,
        platform: result.platform,
        timestamp: Date.now(),
      });
    }
  }

  async function processNonStreamResponse(response, match) {
    try {
      const text = await response.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }

      emit(MSG_TYPES.RESPONSE_CAPTURED, {
        platform: match.platform,
        conversationId: match.conversationId,
        url: response.url || '',
        body: text.substring(0, 50000), // Cap at 50KB
        parsed,
        role: 'assistant',
        timestamp: Date.now(),
      });
    } catch { /* swallow */ }
  }

  // ==================== XHR INTERCEPTOR ====================
  // Claude.ai uses XHR mode=legacy for streaming completions.
  // We hook onprogress to parse SSE chunks incrementally (same as fetch path),
  // then emit token-usage on load. Both paths converge on the same HUD events.

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._memoryExtUrl = url;
    this._memoryExtMethod = method;
    return originalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this._memoryExtUrl;
    if (!url) return originalXHRSend.call(this, body);

    const match = matchUrl(url, 'response');
    if (match) {
      // Capture outgoing request body
      if (body) {
        try {
          emit(MSG_TYPES.REQUEST_CAPTURED, {
            platform: match.platform,
            conversationId: match.conversationId,
            url,
            body: typeof body === 'string' ? body : null,
            timestamp: Date.now(),
          });
        } catch { /* swallow */ }
      }

      // SSE reassembler for this XHR stream
      const xhrReassembler = new SSEReassembler(match.platform, match.conversationId);
      let xhrLastLength = 0;

      // onprogress: feed new SSE chunks as they arrive (same as fetch processSSEStream)
      this.addEventListener('progress', function () {
        try {
          const chunk = this.responseText.slice(xhrLastLength);
          xhrLastLength = this.responseText.length;
          if (chunk) xhrReassembler.feed(chunk);
        } catch { /* swallow */ }
      });

      // onload: finalize, emit token-usage + stream-complete
      this.addEventListener('load', function () {
        try {
          // Feed any remaining bytes not caught by last progress event
          const remaining = (this.responseText || '').slice(xhrLastLength);
          if (remaining) xhrReassembler.feed(remaining);

          const result = xhrReassembler.finish();
          const usage = xhrReassembler._usage;

          console.debug('[MemBrain] XHR onload usage:', usage, 'responseText len:', (this.responseText || '').length);

          // Always emit token-usage so HUD receives it (even if 0 — helps debug)
          emit(`${PREFIX}:token-usage`, {
            input_tokens: usage ? usage.input_tokens : 0,
            output_tokens: usage ? usage.output_tokens : 0,
            conversationId: result ? result.conversationId : match.conversationId,
            platform: match.platform,
            timestamp: Date.now(),
          });

          // Emit stream-complete for capture pipeline
          if (result && result.content) {
            emit(MSG_TYPES.STREAM_COMPLETE, {
              ...result,
              url,
              role: 'assistant',
              usage,
            });
          }
        } catch { /* swallow */ }
      });
    }

    return originalXHRSend.call(this, body);
  };

  // ==================== READY SIGNAL ====================

  function emitReady() {
    emit(MSG_TYPES.INTERCEPTOR_READY, {
      platform: window.location.hostname,
      timestamp: Date.now(),
      version: '0.1.1',
    });
  }

  // Fire immediately, then re-fire every 10s so SW catches it even after waking
  emitReady();
  setInterval(emitReady, 10000);

  console.debug('[Memory Extension] Fetch interceptor installed v0.1.1');
})();
