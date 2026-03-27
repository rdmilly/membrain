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
    // Injection handled by service worker via chrome.scripting.executeScript (MAIN world)
    // This bypasses page CSP. bridge.js just coordinates messaging.
    if (onload) setTimeout(onload, 100); // signal ready after SW injection
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
      console.debug('[MemBrain:bridge] received message:', type);

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
            // Also send current storage mode so MAIN world context-inject.js knows
            chrome.storage.session.get('mb_storage_mode').then(r => {
              const mode = r.mb_storage_mode || 'local';
              window.postMessage({ source: PREFIX, type: `${PREFIX}:storage-mode`, payload: { mode } }, '*');
            }).catch(() => {});
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

  async function refreshInjectionCache(userMessage) {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'get-injection', data: { userMessage: userMessage || '' } });
      if (response) {
        window.postMessage({ source: PREFIX, type: `${PREFIX}:injection-update`, payload: response }, '*');
      }
    } catch {}
  }

  function setupBubbleSanitizer() {
    const SPEC_START = '--- CMPRS ---';
    const MB_CTX_START = '[MEMBRAIN CONTEXT]';
    const MB_CTX_END = '[END MEMBRAIN CONTEXT]';
    const SPEC_END = '--- END ---';
    const CTX_START = '<helix_context>';
    const CTX_END = '</helix_context>';
    const USER_MSG_SELECTORS = ['[data-testid="user-message"]', '.human-turn', '[class*="user-message"]', '[class*="HumanTurn"]'];

    // Get direct text content of element (excluding children)
    function ownText(el) {
      let t = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) t += node.textContent;
      }
      return t;
    }

    function sanitize(container) {
      if (!container) return;
      const full = container.textContent || '';
      if (!full.includes(MB_CTX_START) && !full.includes(SPEC_START) && !full.includes(CTX_START)) return;

      // Use TreeWalker to process text nodes in document order
      // Track hiding state across the whole container
      let hiding = false, hiding2 = false, hiding3 = false;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let node;
      const toHide = new Set();

      while ((node = walker.nextNode())) {
        const t = node.textContent;
        if (!hiding3 && t.includes(MB_CTX_START)) hiding3 = true;
        if (!hiding && t.includes(SPEC_START)) hiding = true;
        if (!hiding2 && t.includes(CTX_START)) hiding2 = true;

        if (hiding || hiding2 || hiding3) {
          // Hide the closest block-level ancestor
          let el = node.parentElement;
          while (el && el !== container) {
            const style = window.getComputedStyle(el);
            if (style.display === 'block' || style.display === 'flex' || el.tagName === 'P' || el.tagName === 'DIV') {
              toHide.add(el);
              break;
            }
            el = el.parentElement;
          }
          if (!el || el === container) toHide.add(node.parentElement);
        }

        if (hiding3 && t.includes(MB_CTX_END)) hiding3 = false;
        if (hiding && t.includes(SPEC_END)) hiding = false;
        if (hiding2 && t.includes(CTX_END)) hiding2 = false;
      }

      for (const el of toHide) {
        if (el && el !== container) {
          el.style.setProperty('display', 'none', 'important');
          el.setAttribute('data-mbrain-sys', '1');
        }
      }
    }

    let _sanitizeTimer = null;
    let _sanitizeRepeat = null;
    function scheduleSanitize() {
      // Run immediately then repeat every 200ms for 3s to beat React reconciliation
      clearTimeout(_sanitizeTimer);
      clearInterval(_sanitizeRepeat);
      let _count = 0;
      const run = () => {
        for (const sel of USER_MSG_SELECTORS) {
          for (const el of document.querySelectorAll(sel)) sanitize(el);
        }
      };
      run();
      _sanitizeRepeat = setInterval(() => {
        run();
        if (++_count >= 15) clearInterval(_sanitizeRepeat);
      }, 200);
    }
    function _scheduleSanitizeOld() {
      if (_sanitizeTimer) return;
      _sanitizeTimer = setTimeout(() => {
        _sanitizeTimer = null;
        // Scan user message containers
        for (const sel of USER_MSG_SELECTORS) {
          for (const el of document.querySelectorAll(sel)) sanitize(el);
        }
        // TreeWalker fallback: find text nodes with our markers, walk up to container
        if (document.body) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const t = node.textContent || '';
            if (t.includes(MB_CTX_START) || t.includes(SPEC_START)) {
              let el = node.parentElement;
              for (let i = 0; i < 8 && el && el !== document.body; i++) {
                if (el.offsetHeight > 30) { sanitize(el); break; }
                el = el.parentElement;
              }
            }
          }
        }
      }, 150);
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) {
          if (added.nodeType !== Node.ELEMENT_NODE) continue;
          const t = added.textContent || '';
          if (t.includes(MB_CTX_START) || t.includes(SPEC_START) || t.includes(CTX_START)) {
            scheduleSanitize();
            break;
          }
        }
      }
    });

    const start = () => observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    document.body ? start() : document.addEventListener('DOMContentLoaded', start);
  }

  injectAll();
  setupInputRelay();
  setupOutputRelay();
  setupBubbleSanitizer();
  // Listen for injection refresh requests from context-inject.js (MAIN world)
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== PREFIX) return;
    if (event.data?.type === PREFIX + ':request-injection') {
      const userMessage = event.data?.payload?.userMessage || '';
      refreshInjectionCache(userMessage);
    }
  });

  // Pre-warm injection cache on page load with empty query
  // This ensures __memoryExtInjection is populated before first message
  // Send storage mode to MAIN world on init
  chrome.storage.session.get('mb_storage_mode').then(r => {
    const mode = r.mb_storage_mode || 'local';
    window.postMessage({ source: PREFIX, type: `${PREFIX}:storage-mode`, payload: { mode } }, '*');
  }).catch(() => {});
  setTimeout(() => refreshInjectionCache(''), 1500);
  setTimeout(() => refreshInjectionCache(''), 5000); // second pass after backfill
  setInterval(refreshInjectionCache, 30000);

  console.debug('[MemBrain] Bridge v0.5.5 active on', window.location.hostname);
})();
