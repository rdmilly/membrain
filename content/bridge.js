/**
 * MemBrain â€" Content Script Bridge (v0.5.5)
 *
 * Injection order: interceptor.js â†' compression.js â†' synapse.js
 * Call order when fetch() fires: synapse â†' compression â†' interceptor â†' original fetch
 */

(function () {
  'use strict';

  const PREFIX = 'memory-ext';

  function injectScript(src, onload, onerror) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(src);
    script.type = 'text/javascript';
    script.onload = () => { script.remove(); if (onload) onload(); };
    script.onerror = () => { script.remove(); if (onerror) onerror(); };
    (document.head || document.documentElement).prepend(script);
  }

  function injectAll() {
    // interceptor + compression injected via src (work fine on all platforms)
    // synapse is injected by service worker via chrome.scripting (world: MAIN) to bypass CSP
    injectScript(
      'interceptor/interceptor.js',
      () => {
        injectScript(
          'interceptor/compression.js',
          () => {
            console.debug('[MemBrain] Page scripts injected (interceptor + compression)');
            // Also inject context-inject.js for Helix CI/context injection
            injectScript(
              'interceptor/context-inject.js',
              () => console.debug('[MemBrain] context-inject.js loaded'),
              () => console.warn('[MemBrain] context-inject.js failed to load'),
            );
          },
          () => console.warn('[MemBrain] compression.js failed to load'),
        );
      },
      () => console.error('[MemBrain] interceptor.js failed to inject'),
    );
  }

  function setupInputRelay() {
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      if (!event.data || event.data.source !== PREFIX) return;

      const { type, payload } = event.data;

      // Tier 1 async relay â€" needs round-trip response
      if (type === `${PREFIX}:tier1-request`) {
        const { session_id, query, budget, nonce } = payload || {};
        if (!session_id || !query || !nonce) return;

        try {
          const result = await chrome.runtime.sendMessage({
            action: 'tier1-request',
            data: { session_id, query, budget: budget || 1000 },
          });
          window.postMessage({
            source: PREFIX,
            type: `${PREFIX}:tier1-response-${nonce}`,
            payload: {
              injection_text: result?.injection_text || null,
              tokens_used: result?.tokens_used || 0,
            },
          }, '*');
        } catch {
          window.postMessage({
            source: PREFIX,
            type: `${PREFIX}:tier1-response-${nonce}`,
            payload: { injection_text: null },
          }, '*');
        }
        return;
      }

      let action = null;
      let data = payload;

      switch (type) {
        case `${PREFIX}:stream-complete`:
        case `${PREFIX}:response-captured`:
          action = 'conversation-turn';
          data = { ...payload, captureType: type === `${PREFIX}:stream-complete` ? 'stream' : 'response', tabUrl: window.location.href };
          break;
        case `${PREFIX}:request-captured`:
          action = 'request-outgoing';
          data = { ...payload, tabUrl: window.location.href };
          break;
        case `${PREFIX}:interceptor-ready`:
          action = 'interceptor-status';
          data = { ...payload, status: 'ready', tabUrl: window.location.href };
          break;
        case `${PREFIX}:stream-error`:
          action = 'error-report';
          data = { ...payload, tabUrl: window.location.href };
          break;
        case `${PREFIX}:injection-applied`:
          action = 'injection-applied';
          data = { ...payload, tabUrl: window.location.href };
          break;
        case `${PREFIX}:token-usage`:
          action = 'token-usage';
          data = { ...payload, tabUrl: window.location.href };
          break;
        case `${PREFIX}:context-injected`:
          action = 'context-injected';
          data = { ...payload };
          break;
        default:
          return;
      }

      if (!action) return;
      try { chrome.runtime.sendMessage({ action, data }).catch(() => {}); } catch {}
    });
  }

  function setupOutputRelay() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return false;

      if (msg._membrainBusEvent === true) {
        switch (msg.event) {
          case 'injection.ready':
            window.postMessage({ source: PREFIX, type: `${PREFIX}:injection-update`, payload: msg.payload }, '*');
            break;
          case 'synapse.ready':
            window.postMessage({ source: PREFIX, type: `${PREFIX}:synapse-toggle`, payload: { enabled: true } }, '*');
            window.postMessage({ source: PREFIX, type: `${PREFIX}:compression-toggle`, payload: { enabled: true } }, '*');
            break;
          case 'hud.update':
            window.postMessage({ source: PREFIX, type: `${PREFIX}:hud-update`, payload: msg.payload }, '*');
            break;

          case 'dictionary.update':
            // Push shorthand map to compression.js in page world
            window.postMessage({ source: PREFIX, type: `${PREFIX}:dictionary-update`, payload: msg.payload }, '*');
            break;
        }
        sendResponse({ relayed: true });
        return false;
      }

      switch (msg.action) {
        case 'context-inject-toggle':
          window.postMessage({ source: PREFIX, type: `${PREFIX}:context-inject-toggle`, payload: { enabled: msg.enabled } }, '*');
          sendResponse({ ok: true });
          return false;
        case 'synapse-toggle':
          window.postMessage({ source: PREFIX, type: `${PREFIX}:synapse-toggle`, payload: { enabled: msg.enabled } }, '*');
          sendResponse({ ok: true });
          return false;
        case 'expander-toggle':
          window.postMessage({ source: PREFIX, type: `${PREFIX}:expander-toggle`, payload: { enabled: msg.enabled } }, '*');
          sendResponse({ ok: true });
          return false;
        case 'refresh-injection':
          refreshInjectionCache();
          sendResponse({ ok: true });
          return false;
      }

      return false;
    });
  }

  async function refreshInjectionCache() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'get-injection' });
      if (response) {
        window.postMessage({ source: PREFIX, type: `${PREFIX}:injection-update`, payload: response }, '*');
      }
    } catch {}
  }

  function setupBubbleSanitizer() {
    const SPEC_START = '--- CMPRS ---';
    const SPEC_END = '--- END ---';
    const CTX_START = '<helix_context>';
    const CTX_END = '</helix_context>';
    const USER_MSG_SELECTORS = ['[data-testid="user-message"]', '.human-turn', '[class*="user-message"]', '[class*="HumanTurn"]'];

    function sanitize(container) {
      const txt = container ? container.textContent : '';
      if (!txt.includes(SPEC_START) && !txt.includes(CTX_START)) return;
      if (!container) return;
      if (container.querySelector('[data-mbrain-sys]')) return;
      const allChildren = Array.from(container.querySelectorAll('p, div, li, pre, code, span'));
      let hiding = false;
      let hiding2 = false;
      for (const el of allChildren) {
        if (el.querySelector('[data-mbrain-sys]')) continue;
        const t = el.textContent.trim();
        if (!hiding && t.includes(SPEC_START)) hiding = true;
        if (!hiding2 && t.includes(CTX_START)) hiding2 = true;
        if (hiding || hiding2) { el.style.setProperty('display', 'none', 'important'); el.setAttribute('data-mbrain-sys', '1'); }
        if (hiding && t.includes(SPEC_END)) { hiding = false; }
        if (hiding2 && t.includes(CTX_END)) { hiding2 = false; break; }
      }
    }

    const observer = new MutationObserver((mutations) => {
      const toSanitize = new Set();
      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) {
          if (added.nodeType !== Node.ELEMENT_NODE || !added.textContent.includes(SPEC_START) || added.textContent.includes(CTX_START)) continue;
          let container = null;
          for (const sel of USER_MSG_SELECTORS) { if (added.matches?.(sel)) { container = added; break; } }
          if (!container) { let el = added.parentElement; for (let i = 0; i < 10 && el; i++) { for (const sel of USER_MSG_SELECTORS) { if (el.matches?.(sel)) { container = el; break; } } if (container) break; el = el.parentElement; } }
          if (container) { toSanitize.add(container); } else { let found = false; for (const sel of USER_MSG_SELECTORS) { for (const child of added.querySelectorAll(sel)) { if (child.textContent.includes(SPEC_START) || child.textContent.includes(CTX_START)) { toSanitize.add(child); found = true; } } } if (!found) toSanitize.add(added); }
        }
      }
      for (const el of toSanitize) sanitize(el);
      // Rescan all existing user messages (catches post-response React reconcile)
      for (const sel of USER_MSG_SELECTORS) {
        for (const el of document.querySelectorAll(sel)) { sanitize(el); }
      }
    });

    const start = () => observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    document.body ? start() : document.addEventListener('DOMContentLoaded', start);
  }

  injectAll();
  setupInputRelay();
  setupOutputRelay();
  setupBubbleSanitizer();
  setTimeout(refreshInjectionCache, 2000);
  setInterval(refreshInjectionCache, 30000);

  console.debug('[MemBrain] Bridge v0.5.5 active on', window.location.hostname);
})();
