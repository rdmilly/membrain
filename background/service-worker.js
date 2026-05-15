/**
 * MemBrain — Background Service Worker (v0.5.0)
 * Event-driven architecture with dual Input/Output buses.
 *
 * Data flow (Input Bus):
 *   interceptor → bridge.js → chrome.runtime.sendMessage
 *     → SW message handler → inputBus.emit(EVENTS.TURN_CAPTURED)
 *       → ConversationParser → IndexedDB
 *       → FactExtractor (on flush)
 *       → VectorStore.embed() (Item 9)
 *
 * Data flow (Output Bus):
 *   outputBus.emit(EVENTS.INJECTION_READY) → bridge relay
 *     → chrome.runtime.sendMessage to tab → content script
 *       → window.postMessage → interceptor injects into request
 *
 * Adding new pipeline steps: just subscribe to the right bus event.
 * No touching the message handler.
 */

import { ConversationParser } from '../lib/conversation-parser.js';
import { mirrorIndex as _mirrorIndexSingleton } from '../lib/mirror-index.js';
import { memoryStorage } from '../lib/storage.js';
import { FactExtractor } from '../lib/fact-extractor.js';
import { MemoryInjector } from '../lib/memory-injector.js';
import { buildDictionary, getDictionary } from '../lib/symbol-dictionary.js';
import { ingestAllFacts, queryGraph, getGraphStats } from '../lib/knowledge-graph.js';
import {
  inputBus,
  outputBus,
  EVENTS,
  isBusEvent,
} from '../lib/event-bus.js';
// Mirror Index: dual BM25 + vector search for local RAG
// Statically imported above to avoid dynamic import() restriction in SW
let _mirrorIndex = null;
async function getMirrorIndex() {
  if (!_mirrorIndex) {
    try {
      await _mirrorIndexSingleton.init();
      _mirrorIndex = _mirrorIndexSingleton;
    } catch (e) {
      console.warn('[MemBrain] MirrorIndex init failed:', e.message);
    }
  }
  return _mirrorIndex;
}

// Vector backend: lazy-loaded to avoid SW parse errors with transformers.min.js
let _vectorBackendModule = null;
async function getVectorBackend() {
  if (!_vectorBackendModule) {
    try { _vectorBackendModule = await import('../lib/vector-backend.js'); }
    catch (e) { console.warn('[MemBrain] Vector backend unavailable:', e.message); return null; }
  }
  return _vectorBackendModule.getVectorBackend ? _vectorBackendModule.getVectorBackend() : null;
}
function resetVectorBackend() {
  _vectorBackendModule = null;
}

// ==================== CONFIG ====================

const CONFIG = {
  BACKEND_URL: 'https://helix.millyweb.com',
  API_KEY: 'ce-prod-6292b483717db14c83924a52715988ae',
  FLUSH_INTERVAL_MINUTES: 2,
  EXTENSION_VERSION: '0.5.2',
};

// ==================== INIT ====================

const parser = new ConversationParser();
const extractor = new FactExtractor(memoryStorage);
const injector = new MemoryInjector(memoryStorage);
let storageReady = false;
let pendingTurns = [];

async function initialize() {
  try {
    await memoryStorage.ready();
    storageReady = true;

    const existing = await memoryStorage.getConversations();
    if (existing.length > 0) {
      parser.loadConversations(existing);
      console.debug(`[MemBrain] Loaded ${existing.length} conversations`);
    }

    await extractor.configure();
    await injector.configure();

    // Warm up the local embedding model (non-blocking — fires in background)
    getVectorBackend().then(backend => backend.warmUp()).catch(() => {});

    if (pendingTurns.length > 0) {
      for (const turn of pendingTurns) {
        inputBus.emit(EVENTS.TURN_CAPTURED, turn);
      }
      pendingTurns = [];
    }

    const currentMode = await memoryStorage.getSetting('storageMode', 'local');
    await chrome.storage.session.set({ mb_storage_mode: currentMode });
    console.debug('[MemBrain] Storage mode:', currentMode);
    inputBus.emit(EVENTS.SW_READY, { version: CONFIG.EXTENSION_VERSION, storageMode: currentMode });
    console.debug(`[MemBrain] SW v${CONFIG.EXTENSION_VERSION} ready`);
    // Clean dirty Mirror Index entries first, then backfill
    setTimeout(() => cleanMirrorIndex().then(() => backfillMirrorIndex()).catch(() => {}), 3000);
  } catch (e) {
    console.error('[MemBrain] Init failed:', e);
    inputBus.emit(EVENTS.PIPELINE_ERROR, { phase: 'init', error: e.message });
  }
}

initialize();

// ==================== INPUT BUS HANDLERS ====================
// Each handler is a self-contained module — no switch statement sprawl.

/**
 * TURN_CAPTURED → parse + persist conversation
 */
// Auto-flush to backend after each turn is captured
// Only fires in cloud/self-hosted mode. Local mode keeps data in IndexedDB only.
let _flushTimer = null;
inputBus.on(EVENTS.TURN_CAPTURED, () => {
  clearTimeout(_flushTimer);
  _flushTimer = setTimeout(async () => {
    const mode = await memoryStorage.getSetting('storageMode', 'local');
    if (mode !== 'local') {
      console.debug('[MemBrain] Auto-flushing after turn capture (mode:', mode, ')');
      inputBus.emit(EVENTS.FLUSH_REQUESTED, { source: 'auto' });
    } else {
      console.debug('[MemBrain] Local mode - turn saved to IndexedDB, not flushed to backend');
    }
  }, 1000);
});

inputBus.on(EVENTS.TURN_CAPTURED, async (turn) => {
  try {
    const result = parser.ingestTurns([turn]);

    if (result.newTurns > 0 && result.updatedConversations.length > 0) {
      const toSave = result.updatedConversations
        .map(key => parser.exportForSync(key))
        .filter(Boolean);

      if (toSave.length > 0) {
        await memoryStorage.saveConversations(toSave);
        console.debug(`[MemBrain] Persisted ${toSave.length} conversations`);

        for (const conv of toSave) {
          outputBus.emit(EVENTS.CONVERSATION_UPDATED, {
            id: conv.id,
            platform: conv.platform,
            turnCount: conv.turnCount,
          });
        }
      }
    }

    await incrementStat('totalTurns');
    await incrementStat(`turns_${turn.platform}`);

    // Index into Mirror Index for local BM25 + vector search
    getMirrorIndex().then(idx => {
      if (idx && turn.content) {
        // Strip injected context blocks before indexing to prevent recursive nesting
        const cleanContent = turn.content
          .replace(/\[MEMBRAIN CONTEXT\][\s\S]*?\[END MEMBRAIN CONTEXT\]\n*/g, '')
          .replace(/<memory_context>[\s\S]*?<\/memory_context>\n*/g, '')
          .replace(/--- HELIX SESSION CONTEXT ---[\s\S]*?--- END SESSION CONTEXT ---\n*/g, '')
          .replace(/--- HELIX RELEVANT CONTEXT ---[\s\S]*?--- END RELEVANT CONTEXT ---\n*/g, '')
          .trim();
        if (!cleanContent || cleanContent.length < 5) return;
        idx.add({
          id: turn.id || `${turn.conversationId}-${Date.now()}`,
          text: cleanContent,
          role: turn.role,
          platform: turn.platform,
          conversationId: turn.conversationId,
          ts: turn.timestamp || Date.now(),
        }).catch(() => {});
      }
    }).catch(() => {});

    // Update badge
    const stats = await memoryStorage.getConversationStats();
    outputBus.emit(EVENTS.BADGE_UPDATE, { count: stats.unsynced });
  } catch (e) {
    console.error('[MemBrain] Turn processing failed:', e);
    outputBus.emit(EVENTS.PIPELINE_ERROR, { phase: 'turn_captured', error: e.message });
  }
});

/**
 * REQUEST_INTERCEPTED → extract user message → emit TURN_CAPTURED
 */
inputBus.on(EVENTS.REQUEST_INTERCEPTED, async (data) => {
  // Buffer raw request for popup display
  try {
    const result = await chrome.storage.session.get('captured_requests');
    const requests = result.captured_requests || [];
    requests.push({ id: generateId(), ...data, timestamp: data.timestamp || Date.now() });
    if (requests.length > 50) requests.splice(0, requests.length - 50);
    await chrome.storage.session.set({ captured_requests: requests });
  } catch { /* non-critical */ }

  // Extract user message and re-emit as a turn
  try {
    const parsed = JSON.parse(data.body);
    const userContent = extractUserMessage(parsed, data.platform);
    if (userContent) {
      inputBus.emit(EVENTS.TURN_CAPTURED, {
        id: generateId(),
        platform: data.platform,
        conversationId: data.conversationId,
        role: 'user',
        content: userContent,
        captureType: 'request',
        url: data.url,
        timestamp: data.timestamp || Date.now(),
        tabId: data.tabId,
        flushed: false,
      });
    }
  } catch { /* body wasn't JSON */ }
});

/**
 * FACTS_EXTRACTED → save to IndexedDB, emit FACT_SAVED per fact
 * (VectorStore will subscribe to FACT_SAVED in Item 9)
 */
inputBus.on(EVENTS.FACTS_EXTRACTED, async ({ facts, conversationId }) => {
  if (!facts?.length) return;

  for (const fact of facts) {
    try {
      const id = await memoryStorage.saveFact(fact);
      inputBus.emit(EVENTS.FACT_SAVED, { ...fact, id });
    } catch (e) {
      console.error('[MemBrain] Failed to save fact:', e);
    }
  }

  // Ingest new facts into knowledge graph (non-blocking)
  ingestAllFacts(facts).catch(e => console.warn('[MemBrain] KG ingest error:', e));

  console.debug(`[MemBrain] Saved ${facts.length} facts from ${conversationId}`);
  outputBus.emit(EVENTS.STATS_UPDATE, { factsAdded: facts.length });
});

/**
 * FLUSH_REQUESTED → flush to backend → emit FLUSH_COMPLETE or FLUSH_ERROR
 */
inputBus.on(EVENTS.FLUSH_REQUESTED, async (opts) => {
  const mode = await memoryStorage.getSetting('storageMode', 'local');
  if (mode === 'local' && opts?.source !== 'manual') {
    console.debug('[MemBrain] Flush skipped - local mode');
    return;
  }
  const result = await flushToBackend();
  console.log('[MemBrain] Flush result:', JSON.stringify(result));
  if (result.status === 'error') {
    outputBus.emit(EVENTS.FLUSH_ERROR, result);
  } else {
    outputBus.emit(EVENTS.FLUSH_COMPLETE, result);

    // Trigger fact extraction after successful flush
    if (extractor.isConfigured()) {
      const extractResult = await extractor.extractAll({ maxConversations: 3, minTurns: 4 });
      if (extractResult.totalNewFacts > 0) {
        inputBus.emit(EVENTS.FACTS_EXTRACTED, {
          facts: extractResult.newFacts || [],
          conversationId: 'batch-extract',
        });
      }
    }
  }
});

/**
 * FACT_SAVED → embed and store in vector store
 * This is the Item 9 pipeline hook.
 * The EVENTS.FACT_SAVED is emitted inside the FACTS_EXTRACTED handler above.
 */
inputBus.on(EVENTS.FACT_SAVED, async (fact) => {
  try {
    const backend = await getVectorBackend();
    const stored = await backend.embedAndStore(fact);
    if (stored) {
      console.debug(`[MemBrain] Embedded fact: ${fact.id.substring(0, 12)}...`);
    }
  } catch (e) {
    console.error('[MemBrain] FACT_SAVED embed failed:', e);
  }
});

/**
 * TIER_UPGRADED → reset backend singleton so next call picks up cloud tier
 */
inputBus.on(EVENTS.TIER_UPGRADED, async ({ token, cortexUrl, clearLocal }) => {
  if (!_vectorBackendModule) { try { _vectorBackendModule = await import('../lib/vector-backend.js'); } catch(e) { throw new Error('Vector backend unavailable'); } }
  const { VectorBackendFactory } = _vectorBackendModule;
  const result = await VectorBackendFactory.migrate(token, { cortexUrl, clearLocal });
  resetVectorBackend(); // Force re-init on next call
  inputBus.emit(EVENTS.MIGRATION_COMPLETE, result);
  outputBus.emit(EVENTS.STATS_UPDATE, { migration: result });
});

/**
 * API_CONFIGURED → re-initialize extractor + injector
 */
inputBus.on(EVENTS.API_CONFIGURED, async (data) => {
  if (data.apiKey) await memoryStorage.setSetting('apiKey', data.apiKey);
  if (data.apiProvider) await memoryStorage.setSetting('apiProvider', data.apiProvider);
  if (data.apiModel) await memoryStorage.setSetting('apiModel', data.apiModel);
  await extractor.configure();
  outputBus.emit(EVENTS.STATS_UPDATE, {
    extractorConfigured: extractor.isConfigured(),
    extractorStats: extractor.getStats(),
  });
});

/**
 * INJECTOR_TOGGLED → update injector state
 */
inputBus.on(EVENTS.INJECTOR_TOGGLED, async ({ enabled }) => {
  await injector.setEnabled(!!enabled);
  outputBus.emit(EVENTS.STATS_UPDATE, { injectorEnabled: injector.isEnabled() });
});

/**
 * DATA_CLEARED → wipe storage + reset parser
 */
inputBus.on(EVENTS.DATA_CLEARED, async () => {
  await memoryStorage.clearAll();
  parser.loadConversations([]);
  outputBus.emit(EVENTS.BADGE_UPDATE, { count: 0 });
  outputBus.emit(EVENTS.STATS_UPDATE, { cleared: true });
});

// ==================== OUTPUT BUS HANDLERS ====================

/**
 * BADGE_UPDATE → update extension badge
 */
outputBus.on(EVENTS.BADGE_UPDATE, ({ count }) => {
  updateBadge(count);
});

// ==================== CHROME RUNTIME MESSAGE HANDLER ====================
// Thin translation layer: chrome.runtime message → inputBus event
// or direct action for popup queries.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  const tabId = sender.tab?.id;

  // ── Forwarded bus events from bridge.js ──────────────────────
  if (isBusEvent(message)) {
    // Attach tabId so downstream handlers know which tab
    inputBus.emit(message.event, { ...message.payload, tabId });
    sendResponse({ received: true });
    return true;
  }

  // ── Legacy action-based messages (backwards compat) ──────────
  switch (message.action) {
    // Capture events (translate to bus)
    case 'conversation-turn':
      handleLegacyTurn(message.data, tabId);
      sendResponse({ received: true });
      return false;

    case 'request-outgoing':
      inputBus.emit(EVENTS.REQUEST_INTERCEPTED, { ...message.data, tabId });
      sendResponse({ received: true });
      return false;

    case 'interceptor-status':
      handleInterceptorStatus(message.data, tabId);
      sendResponse({ received: true });
      return false;

    case 'error-report':
      console.warn(`[MemBrain] Error from ${message.data?.platform}:`, message.data?.error);
      sendResponse({ received: true });
      return false;

    // Popup queries (async — must return true)
    case 'manual-flush':
      inputBus.emit(EVENTS.FLUSH_REQUESTED, {});
      outputBus.once(EVENTS.FLUSH_COMPLETE, sendResponse);
      outputBus.once(EVENTS.FLUSH_ERROR, sendResponse);
      return true;

    case 'get-flush-status':
      getFlushStatus().then(sendResponse);
      return true;

    case 'get-conversations':
      getConversationsForPopup(message.data).then(sendResponse);
      return true;

    case 'get-all-conversations':
      memoryStorage.getConversations({ limit: 9999 }).then(sendResponse);
      return true;

    case 'open-options':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return true;

    case 'mark-all-synced':
      (async () => {
        const convs = await memoryStorage.getConversations({ limit: 9999 });
        for (const c of convs) { await memoryStorage.markSynced(c.id); }
        sendResponse({ marked: convs.length });
      })();
      return true;

    case 'get-graph-stats':
      getGraphStats().then(stats => sendResponse(stats));
      return true;
    case 'get-dictionary':
      getDictionary().then(dict => sendResponse({ symbols: dict }));
      return true;
    case 'get-stats':
      getFullStats().then(sendResponse);
      return true;

    case 'export-data':
      memoryStorage.exportAll().then(sendResponse);
      return true;

    case 'import-data':
      memoryStorage.importAll(message.data).then((result) => {
        inputBus.emit(EVENTS.DATA_IMPORTED, result);
        sendResponse(result);
      });
      return true;

    case 'extract-facts':
      extractFacts(message.data).then(sendResponse);
      return true;

    case 'get-facts':
      memoryStorage.getFacts(message.data).then(sendResponse);
      return true;

    case 'configure-api':
      inputBus.emit(EVENTS.API_CONFIGURED, message.data);
      // Respond after extractor re-configures
      setTimeout(async () => {
        sendResponse({ configured: extractor.isConfigured(), stats: extractor.getStats() });
      }, 200);
      return true;

    case 'get-injection':
      getInjectionForPage(message.data).then(sendResponse);
      return true;

    case 'inject-now':
      // Content script is ready — inject interceptors into this tab
      chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
        if (tabs[0]?.id && tabs[0]?.url) injectInterceptors(tabs[0].id, tabs[0].url);
      }).catch(() => {});
      sendResponse({ ok: true });
      break;

    case 'context-injected':
      // Store v2 inject stats (shard+RAG) to session storage for popup HUD
      (async () => {
        try {
          const payload = message.data || {};
          const existing = await chrome.storage.session.get('contextInjectStats').catch(() => ({}));
          const prev = existing.contextInjectStats || {};
          await chrome.storage.session.set({
            contextInjectStats: {
              injections:   (prev.injections || 0) + 1,
              shardChars:   payload.shardChars  || 0,
              ragChars:     payload.ragChars    || 0,
              totalChars:   payload.totalChars  || 0,
              layers:       payload.layers      || [],
              lastQuery:    payload.query       || '',
              lastConvId:   payload.convId      || '',
              lastAt:       Date.now(),
            }
          }).catch(() => {});
        } catch {}
      })();
      sendResponse({ ok: true });
      return false;

    case 'get-context-inject-stats':
      chrome.storage.session.get('contextInjectStats')
        .then(r => sendResponse(r.contextInjectStats || null))
        .catch(() => sendResponse(null));
      return true;

    case 'injection-applied':
      outputBus.emit(EVENTS.INJECTION_APPLIED, message.data);
      sendResponse({ ok: true });
      return false;

    case 'set-injector':
      inputBus.emit(EVENTS.INJECTOR_TOGGLED, { enabled: !!message.data?.enabled });
      sendResponse({ enabled: injector.isEnabled() });
      return false;

    case 'clear-data':
      inputBus.emit(EVENTS.DATA_CLEARED, {});
      sendResponse({ cleared: true });
      return false;

    // ── New v0.5.1 options page messages ─────────────────────

    case 'get-vector-stats':
      getVectorStats().then(sendResponse);
      return true;

    case 'get-tier-state':
      getTierState().then(sendResponse);
      return true;

    case 'get-all-settings':
      getAllSettingsForOptions().then(sendResponse);
      return true;

    case 'save-settings':
      saveSettingsFromOptions(message.data).then(sendResponse);
      return true;

    case 'tier-upgrade':
      handleTierUpgrade(message.data).then(sendResponse);
      return true;

    case 'tier-downgrade':
      handleTierDowngrade().then(sendResponse);
      return true;
  }

  sendResponse({ received: true });
  return true;
});

// ==================== LEGACY COMPAT ====================

async function handleLegacyTurn(data, tabId) {
  if (!data) return;
  const turn = {
    id: generateId(),
    platform: data.platform,
    conversationId: data.conversationId,
    role: data.role || 'assistant',
    content: data.content || '',
    captureType: data.captureType || 'unknown',
    url: data.url || data.tabUrl || '',
    timestamp: data.timestamp || Date.now(),
    tabId,
    flushed: false,
  };

  // Buffer in session for popup
  await bufferTurnInSession(turn);

  if (storageReady) {
    inputBus.emit(EVENTS.TURN_CAPTURED, turn);
  } else {
    pendingTurns.push(turn);
  }
}

async function handleInterceptorStatus(data, tabId) {
  try {
    const result = await chrome.storage.session.get('interceptor_status');
    const status = result.interceptor_status || {};
    status[tabId] = { ...data, timestamp: data.timestamp || Date.now() };
    await chrome.storage.session.set({ interceptor_status: status });
  } catch { /* non-critical */ }
}

// ==================== BACKEND FLUSH ====================

async function flushToBackend() {
  try {
    const unsynced = await memoryStorage.getUnsyncedConversations();
    if (unsynced.length === 0) return { status: 'no_conversations', flushed: 0 };

    const allTurns = [];
    for (const conv of unsynced) {
      for (const turn of (conv.turns || [])) {
        allTurns.push({
          id: turn.id || generateId(),
          platform: conv.platform,
          conversationId: conv.conversationId,
          role: turn.role,
          content: turn.content,
          captureType: turn.captureType || 'parsed',
          timestamp: turn.timestamp,
        });
      }
    }

    if (allTurns.length === 0) return { status: 'no_turns', flushed: 0 };

    const response = await fetch(`${CONFIG.BACKEND_URL}/api/v1/ext/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': CONFIG.API_KEY,
      },
      body: JSON.stringify({
        turns: allTurns,
        extensionVersion: CONFIG.EXTENSION_VERSION,
        flushedAt: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const responseData = await response.json();

    for (const conv of unsynced) {
      await memoryStorage.markSynced(conv.id);
    }

    await memoryStorage.logSync({
      conversationsFlushed: unsynced.length,
      turnsFlushed: allTurns.length,
      backendResponse: responseData,
      status: 'ok',
    });

    await incrementStat('totalFlushes');
    await incrementStat('totalFlushedTurns', allTurns.length);

    const stats = await memoryStorage.getConversationStats();
    outputBus.emit(EVENTS.BADGE_UPDATE, { count: stats.unsynced });

    return {
      status: 'flushed',
      conversations: unsynced.length,
      turns: allTurns.length,
      backendSuccess: responseData.success || 0,
    };
  } catch (e) {
    console.error('[MemBrain] Flush failed:', e);
    await memoryStorage.logSync({ error: e.message, status: 'error' });
    await incrementStat('flushErrors');
    return { status: 'error', error: e.message };
  }
}

// ==================== POPUP/UI DATA ====================

async function getConversationsForPopup(options = {}) {
  try {
    const convs = await memoryStorage.getConversations({ limit: options?.limit || 20, platform: options?.platform });
    return {
      conversations: convs.map(c => ({
        id: c.id,
        platform: c.platform,
        title: c.title || '(untitled)',
        turnCount: c.turnCount,
        tokenEstimate: c.tokenEstimate,
        updatedAt: c.updatedAt,
        synced: c.syncedAt && c.syncedAt >= c.updatedAt,
      })),
      total: convs.length,
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function getFullStats() {
  try {
    const dbStats = await memoryStorage.getConversationStats();
    const sessionData = await chrome.storage.session.get(['captured_turns', 'capture_stats', 'flush_log']);
    const syncLog = await memoryStorage.getSyncLog(5);

    return {
      db: dbStats,
      session: {
        bufferedTurns: (sessionData.captured_turns || []).length,
        ...(sessionData.capture_stats || {}),
      },
      lastSync: syncLog.length > 0 ? syncLog[0] : null,
      version: CONFIG.EXTENSION_VERSION,
      extractor: extractor.getStats(),
      injector: injector.getStats(),
      backendUrl: CONFIG.BACKEND_URL,
      bus: {
        inputEvents: inputBus.activeEvents(),
        outputEvents: outputBus.activeEvents(),
        inputListeners: inputBus.listenerCount(),
        outputListeners: outputBus.listenerCount(),
      },
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function getFlushStatus() {
  try {
    const stats = await memoryStorage.getConversationStats();
    const syncLog = await memoryStorage.getSyncLog(5);
    return {
      conversations: stats.conversations,
      unsynced: stats.unsynced,
      totalTurns: stats.totalTurns,
      platforms: stats.platforms,
      lastSync: syncLog.length > 0 ? syncLog[0] : null,
      backendUrl: CONFIG.BACKEND_URL,
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function extractFacts(options = {}) {
  try {
    await extractor.configure();
    if (!extractor.isConfigured()) {
      return { error: 'API key not configured. Go to Settings to add your API key.' };
    }
    const result = await extractor.extractAll(options);
    if (result.totalNewFacts > 0) {
      inputBus.emit(EVENTS.FACTS_EXTRACTED, {
        facts: result.newFacts || [],
        conversationId: 'manual-extract',
      });
    }
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

async function getInjectionForPage(data) {
  try {
    const userMessage = data?.userMessage || '';

    // ── LAYER 1: Mirror Index (BM25 + vector hybrid) ──────────────────────
    // Searches full conversation history in real-time, no extraction needed
    // Empty query = return most recent turns (for pre-warm)
    if (userMessage.trim().length >= 0) {
      try {
        const idx = await getMirrorIndex();
        if (idx) {
          // Empty query = get recent turns for pre-warm
          const results = userMessage.trim().length > 5
            ? await idx.search(userMessage, { topK: 6 })
            : await idx.getRecent(6);
          console.debug('[MemBrain] Mirror Index search:', JSON.stringify({query: userMessage.slice(0,40), results: results.length, stats: idx.getStats()}));
          if (results.length > 0) {
            const now = Date.now();
            const lines = results.map(r => {
              const role = r.role === 'user' ? 'You' : 'Claude';
              const mins = r.ts ? Math.round((now - r.ts) / 60000) : 0;
              const ago = mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins/60)}h ago` : `${Math.round(mins/1440)}d ago`;
              return `[${role} · ${ago}]: ${r.text.slice(0, 300)}`;
            });
            const block = `<helix_context>\nRelated from your history:\n${lines.join('\n')}\n</helix_context>`;
            return {
              enabled: true,
              block,
              facts: results.map(r => ({
                content: r.text.slice(0, 150),
                category: 'conversation',
                confidence: 'high',
                score: r.score,
              })),
              method: results[0]?.method || 'hybrid',
              source: 'local',
              count: results.length,
            };
          }
        }
      } catch (e) {
        console.warn('[MemBrain] MirrorIndex search failed:', e.message);
      }
    }


    // ── LAYER 2: Knowledge Graph ─────────────────────────────────────────
    if (userMessage.trim().length > 5) {
      try {
        const kgContext = await queryGraph(userMessage, 2);
        if (kgContext && kgContext.length > 50) {
          console.debug('[MemBrain] KG hit:', kgContext.split('\n').length, 'lines');
          const kgBlock = '<helix_context>\n' + kgContext + '\n</helix_context>';
          return {
            enabled: true,
            block: kgBlock,
            facts: [],
            method: 'kg',
            source: 'local',
          };
        }
      } catch(e) {
        console.warn('[MemBrain] KG query error:', e.message);
      }
    }

    // ── LAYER 3: Extracted facts fallback ─────────────────────────────────
    const facts = await memoryStorage.getFacts();
    if (!facts.length) return { enabled: true, block: '', facts: [], method: 'none', source: 'local' };

    const selectedFacts = facts
      .sort((a, b) => {
        const w = { high: 3, medium: 2, low: 1 };
        return (w[b.confidence] || 0) - (w[a.confidence] || 0) || (b.timestamp || 0) - (a.timestamp || 0);
      })
      .slice(0, 8);

    const block = `<helix_context>\n${selectedFacts.map(f => `- ${f.content} (${f.confidence || 'medium'})`).join('\n')}\n</helix_context>`;

    return {
      enabled: true,
      block,
      facts: selectedFacts.map(f => ({ content: f.content, category: f.category, confidence: f.confidence })),
      method: 'facts',
      source: 'local',
    };
  } catch (e) {
    return { enabled: false, block: '', facts: [], error: e.message };
  }
}



// ==================== OPTIONS PAGE HANDLERS ====================

async function getVectorStats() {
  try {
    const backend = await getVectorBackend();
    return backend.getStats();
  } catch (e) {
    return { error: e.message };
  }
}

async function getTierState() {
  try {
    const tier = await memoryStorage.getSetting('storageMode', 'local');
    return { tier };
  } catch (e) {
    return { tier: 'local', error: e.message };
  }
}

async function getAllSettingsForOptions() {
  try {
    const keys = [
      'injectorEnabled', 'maxFactsToInject', 'tokenBudget', 'vectorThreshold',
      'backendUrl', 'apiProvider', 'apiModel', 'storageMode',
    ];
    const result = {};
    for (const key of keys) {
      result[key] = await memoryStorage.getSetting(key);
    }
    // Return last 4 chars of API key as hint (never the full key)
    const apiKey = await memoryStorage.getSetting('apiKey');
    if (apiKey && apiKey.length >= 4) {
      result.apiKeyHint = apiKey.slice(-4);
    }
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

async function saveSettingsFromOptions(data) {
  try {
    const allowed = ['maxFactsToInject', 'tokenBudget', 'vectorThreshold', 'backendUrl', 'syncEnabled', 'storageMode'];
    for (const key of allowed) {
      if (data[key] !== undefined) {
        await memoryStorage.setSetting(key, data[key]);
      }
    }
    // Broadcast mode change to content scripts
    await broadcastStorageMode().catch(() => {});
    return { saved: true };
  } catch (e) {
    return { saved: false, error: e.message };
  }
}

async function handleTierUpgrade(data) {
  if (!data?.token) return { success: false, error: 'No token provided' };
  inputBus.emit(EVENTS.TIER_UPGRADED, {
    token: data.token,
    cortexUrl: data.cortexUrl,
    clearLocal: data.clearLocal !== false,
  });
  // Wait for migration to complete via a one-shot bus listener
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ success: false, error: 'Migration timed out' }), 60000);
    inputBus.once(EVENTS.MIGRATION_COMPLETE, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

async function handleTierDowngrade() {
  try {
    if (!_vectorBackendModule) { try { _vectorBackendModule = await import('../lib/vector-backend.js'); } catch(e) { throw new Error('Vector backend unavailable'); } }
  const { VectorBackendFactory } = _vectorBackendModule;
    await VectorBackendFactory.downgradeToLocal();
    resetVectorBackend();
    return { success: true, tier: 'local' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ==================== ALARMS ====================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'memory-flush') {
    inputBus.emit(EVENTS.FLUSH_REQUESTED, { source: 'alarm' });
  }
  if (alarm.name === 'memory-extract') {
    await extractFacts({ maxConversations: 3, minTurns: 4 });
  }
});

chrome.alarms.create('memory-flush', { periodInMinutes: CONFIG.FLUSH_INTERVAL_MINUTES });
chrome.alarms.create('memory-extract', { periodInMinutes: 10 });

// ==================== UTILITIES ====================

function extractUserMessage(parsed, platform) {
  switch (platform) {
    case 'claude':
      if (parsed.prompt) return parsed.prompt;
      if (parsed.messages) {
        const last = parsed.messages[parsed.messages.length - 1];
        if (last?.role === 'user') {
          return typeof last.content === 'string'
            ? last.content
            : last.content?.map(c => c.text || '').join('') || null;
        }
      }
      return null;
    case 'chatgpt':
      if (parsed.messages) {
        const last = parsed.messages[parsed.messages.length - 1];
        if (last?.content?.parts) return last.content.parts.join('');
        if (last?.content) return typeof last.content === 'string' ? last.content : null;
      }
      if (parsed.action === 'next' && parsed.messages?.[0]?.content?.parts) {
        return parsed.messages[0].content.parts.join('');
      }
      return null;
    default:
      if (parsed.query) return parsed.query;
      if (parsed.prompt) return parsed.prompt;
      if (parsed.messages) {
        const last = parsed.messages[parsed.messages.length - 1];
        return last?.content || null;
      }
      return null;
  }
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

async function incrementStat(key, amount = 1) {
  try {
    const result = await chrome.storage.session.get('capture_stats');
    const stats = result.capture_stats || {};
    stats[key] = (stats[key] || 0) + amount;
    stats.lastUpdate = Date.now();
    await chrome.storage.session.set({ capture_stats: stats });
  } catch { /* non-critical */ }
}

function updateBadge(count) {
  try {
    if (count > 0) {
      chrome.action.setBadgeText({ text: String(count) });
      chrome.action.setBadgeBackgroundColor({ color: '#6B5CE7' });
    } else {
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#4ade80' });
    }
  } catch { /* badge API might not be available */ }
}

async function bufferTurnInSession(turn) {
  try {
    const result = await chrome.storage.session.get('captured_turns');
    const turns = result.captured_turns || [];
    turns.push(turn);
    if (turns.length > 200) turns.splice(0, turns.length - 200);
    await chrome.storage.session.set({ captured_turns: turns });
  } catch { /* non-critical */ }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const result = await chrome.storage.session.get('interceptor_status');
    const status = result.interceptor_status || {};
    delete status[tabId];
    await chrome.storage.session.set({ interceptor_status: status });
  } catch { /* non-critical */ }
});

console.debug(`[MemBrain] Service worker v${CONFIG.EXTENSION_VERSION} started`);

// ==================== MAIN WORLD SCRIPT INJECTION ====================
// Manifest content_scripts with world:MAIN handles injection declaratively.
// Imperative injection removed — new Function() eval is blocked by claude.ai CSP.
// The onUpdated listener below re-injects on navigation for tabs opened before the SW started.

const INJECT_SCRIPTS = [
  'interceptor/interceptor.js',
  'interceptor/compression.js',
  'interceptor/context-inject.js',
];

const INJECT_HOSTS = [
  'claude.ai',
  'chat.openai.com',
  'chatgpt.com',
  'gemini.google.com',
  'perplexity.ai',
];

function shouldInject(url) {
  try {
    const host = new URL(url).hostname;
    return INJECT_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch { return false; }
}

async function injectInterceptors(tabId, url) {
  if (!shouldInject(url)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: INJECT_SCRIPTS,
    });
    console.log('[MemBrain] Interceptors injected into tab', tabId);
  } catch (e) {
    console.warn('[MemBrain] Injection failed:', e.message);
  }
}

// Inject on navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    injectInterceptors(tabId, tab.url);
  }
});

// Inject into already-open tabs on SW startup
chrome.tabs.query({}).then(tabs => {
  tabs.forEach(tab => {
    if (tab.id && tab.url) injectInterceptors(tab.id, tab.url);
  });
}).catch(() => {});

// Broadcast storage mode to all eligible tabs so content scripts can read it
async function broadcastStorageMode() {
  const mode = await memoryStorage.getSetting('storageMode', 'local');
  await chrome.storage.session.set({ mb_storage_mode: mode });
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && tab.url && shouldInject(tab.url)) {
      chrome.tabs.sendMessage(tab.id, { action: 'storage-mode', mode }).catch(() => {});
    }
  }
}

// Broadcast on startup and whenever mode changes
broadcastStorageMode().catch(() => {});

// ==================== MIRROR INDEX BACKFILL ====================
// On startup, index existing conversation turns into Mirror Index.
// Runs once per SW lifecycle, 3s after init so it doesn't slow startup.
async function backfillMirrorIndex() {
  try {
    const idx = await getMirrorIndex();
    if (!idx) return;

    const stats = idx.getStats();
    console.debug('[MemBrain] Mirror Index stats before backfill:', JSON.stringify(stats));
    // Only skip if we have substantial content already
    if (stats.bm25Docs > 200) {
      console.debug('[MemBrain] Mirror Index already populated:', stats.bm25Docs, 'docs');
      return;
    }

    console.debug('[MemBrain] Backfilling Mirror Index from conversation history...');
    const conversations = await memoryStorage.getConversations({ limit: 50 });
    let count = 0;

    for (const conv of conversations) {
      if (!conv.turns) continue;
      for (const turn of conv.turns) {
        if (!turn.content || turn.content.length < 10) continue;
        await idx.add({
          id: `${conv.id}-${turn.index || count}`,
          text: turn.content,
          role: turn.role,
          platform: conv.platform || 'claude',
          conversationId: conv.id,
          ts: turn.timestamp || conv.updatedAt || Date.now(),
        });
        count++;
        // Yield every 20 to avoid blocking SW
        if (count % 20 === 0) await new Promise(r => setTimeout(r, 50));
      }
    }

    console.debug(`[MemBrain] Mirror Index backfill complete: ${count} turns indexed`);
  } catch (e) {
    console.warn('[MemBrain] Backfill failed:', e.message);
  }
}

// ==================== MIRROR INDEX CLEANUP ====================
async function cleanMirrorIndex() {
  try {
    const idx = await getMirrorIndex();
    if (!idx) return;
    await idx.purgeContaining('[MEMBRAIN CONTEXT]');
    await idx.purgeContaining('<helix_context>');
    console.debug('[MemBrain] Mirror Index cleanup complete');
  } catch (e) {
    console.warn('[MemBrain] Cleanup failed:', e.message);
  }
}


// ==================== SYMBOL DICTIONARY ====================

async function broadcastDictionary() {
  try {
    const dict = await getDictionary();
    if (dict.length === 0) {
      console.debug('[MemBrain] Symbol dict empty, skipping broadcast');
      return;
    }
    // Broadcast to all active AI tabs via chrome.tabs.sendMessage
    const tabs = await chrome.tabs.query({});
    const aiPatterns = [/claude\.ai/, /chatgpt\.com/, /chat\.openai\.com/, /gemini\.google\.com/, /perplexity\.ai/];
    let sent = 0;
    for (const tab of tabs) {
      if (!tab.url || !aiPatterns.some(p => p.test(tab.url))) continue;
      try {
        await chrome.tabs.sendMessage(tab.id, {
          _membrainBusEvent: true,
          event: 'dictionary.update',
          payload: { symbols: dict },
        });
        sent++;
      } catch { /* tab may not have content script */ }
    }
    console.debug(`[MemBrain] Symbol dict broadcast: ${dict.length} symbols to ${sent} tabs`);
    return dict;
  } catch(e) {
    console.warn('[MemBrain] Dictionary broadcast failed:', e);
  }
}

async function refreshDictionary() {
  try {
    await memoryStorage.ready();
    const convos = await memoryStorage.getConversations({ limit: 500 });
    console.debug(`[MemBrain] Building symbol dict from ${convos.length} conversations...`);
    if (convos.length === 0) {
      console.debug('[MemBrain] No conversations for dict build, skipping');
      return;
    }
    await buildDictionary(convos);
    await broadcastDictionary();
  } catch(e) {
    console.warn('[MemBrain] Dictionary refresh failed:', e);
  }
}

// ==================== AUTO-UPDATE via SSE (v1.0) ====================
// Replaces polling entirely. EventSource holds one persistent connection.
// Server broadcasts instantly when version.json changes.
// SW stays alive naturally — no throttling, no setInterval fights.

const UPDATE_SSE_URL   = 'https://update.membrain.millyweb.com/events';
const UPDATE_CHECK_URL = 'https://update.membrain.millyweb.com/version.json'; // fallback
const NATIVE_HOST = 'com.millyweb.membrain';

// Apply an update received from SSE or fallback poll
function applyUpdate(remote) {
  const current = chrome.runtime.getManifest().version;
  if (!remote?.version || remote.version === current) return;
  console.log(`[MemBrain] Update available: ${current} -> ${remote.version}`);
  chrome.runtime.sendNativeMessage(NATIVE_HOST, {
    action: 'update',
    version: remote.version,
    zip_url: remote.zip_url,
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('[MemBrain] Native host unavailable:', chrome.runtime.lastError.message);
      chrome.notifications?.create('mb-update', {
        type: 'basic',
        iconUrl: '/icons/icon48.png',
        title: 'MemBrain Update Available',
        message: `v${remote.version} ready. ${remote.changelog || ''}`,
        buttons: [{ title: 'Download' }],
        priority: 1,
      });
      return;
    }
    if (response?.ok) {
      console.log('[MemBrain] Update extracted, reloading...');
      setTimeout(() => chrome.runtime.reload(), 1500);
    } else {
      console.error('[MemBrain] Update failed:', response?.error);
    }
  });
}

// Notification click — open download page
chrome.notifications?.onButtonClicked?.addListener((id, btnIdx) => {
  if (id === 'mb-update' && btnIdx === 0) {
    chrome.tabs.create({ url: UPDATE_CHECK_URL });
  }
});

// SSE connection — persistent, server pushes instantly on version change
function connectUpdateSSE() {
  console.log('[MemBrain] Connecting to update SSE...');
  let retryDelay = 2000;

  function connect() {
    const es = new EventSource(UPDATE_SSE_URL);

    es.addEventListener('version', (e) => {
      try {
        const remote = JSON.parse(e.data);
        console.log('[MemBrain] SSE version event:', remote.version);
        applyUpdate(remote);
      } catch {}
    });

    es.onopen = () => {
      console.log('[MemBrain] SSE connected to update server');
      retryDelay = 2000; // reset backoff on success
    };

    es.onerror = () => {
      console.warn(`[MemBrain] SSE disconnected, retrying in ${retryDelay}ms...`);
      es.close();
      // Exponential backoff, cap at 60s
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    };
  }

  connect();
}

// Start SSE after 3s (let SW fully initialize first)
setTimeout(connectUpdateSSE, 3000);
// Broadcast symbol dictionary on startup
setTimeout(refreshDictionary, 5000);
// Refresh dictionary every 30 minutes
setInterval(refreshDictionary, 30 * 60 * 1000);

// Initialize knowledge graph from existing facts
setTimeout(async () => {
  try {
    await memoryStorage.ready();
    const facts = await memoryStorage.getFacts();
    if (facts.length > 0) {
      await ingestAllFacts(facts);
      console.debug(`[MemBrain] KG initialized from ${facts.length} facts`);
    } else {
      console.debug('[MemBrain] KG init: no facts yet, skipping');
    }
  } catch(e) { console.warn('[MemBrain] KG init failed:', e); }
}, 8000);
