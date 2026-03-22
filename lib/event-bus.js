/**
 * MemBrain — Typed Event Bus
 * v0.5.0
 *
 * A lightweight pub/sub event bus used within a single JS environment
 * (service worker OR content script — not shared across them).
 *
 * Two instances exist in practice:
 *   - Service Worker: the authoritative INPUT + OUTPUT bus
 *   - Content Script (bridge.js): a thin relay bus for page-world events
 *
 * The chrome.runtime messaging layer (in bridge.js) connects them.
 *
 * Usage:
 *   import { inputBus, outputBus } from './event-bus.js';
 *
 *   // Subscribe
 *   inputBus.on(EVENTS.TURN_CAPTURED, (payload) => { ... });
 *
 *   // Publish
 *   inputBus.emit(EVENTS.TURN_CAPTURED, { platform, role, content, ... });
 *
 *   // One-time listener
 *   outputBus.once(EVENTS.INJECTION_READY, (payload) => { ... });
 *
 *   // Unsubscribe
 *   const handler = (p) => { ... };
 *   inputBus.on(EVENTS.FACTS_EXTRACTED, handler);
 *   inputBus.off(EVENTS.FACTS_EXTRACTED, handler);
 */

// ==================== EVENTS ====================

/**
 * All typed event names for the input and output buses.
 *
 * INPUT BUS: data flowing into the system
 *   Sources: interceptor → bridge → SW
 *
 * OUTPUT BUS: commands/updates flowing out
 *   Sources: SW → bridge → content/page
 */
export const EVENTS = {
  // ── INPUT: Capture pipeline ────────────────────────────────
  /** A complete SSE stream turn was captured (user or assistant). */
  TURN_CAPTURED: 'turn.captured',

  /** An outgoing user request was intercepted (before it hits the AI). */
  REQUEST_INTERCEPTED: 'request.intercepted',

  /** The fetch interceptor in the page world is active. */
  INTERCEPTOR_READY: 'interceptor.ready',

  /** A conversation was updated by the ConversationParser. */
  CONVERSATION_UPDATED: 'conversation.updated',

  /** Facts were extracted from a conversation (LLM extraction complete). */
  FACTS_EXTRACTED: 'facts.extracted',

  /** A single fact was saved to IndexedDB. */
  FACT_SAVED: 'fact.saved',

  /** Embeddings were generated for a set of facts. */
  EMBEDDINGS_READY: 'embeddings.ready',

  /** User requested a manual flush to backend. */
  FLUSH_REQUESTED: 'flush.requested',

  /** User configured API credentials. */
  API_CONFIGURED: 'api.configured',

  /** User toggled the memory injector on/off. */
  INJECTOR_TOGGLED: 'injector.toggled',

  /** User triggered data import. */
  DATA_IMPORTED: 'data.imported',

  /** User cleared all local data. */
  DATA_CLEARED: 'data.cleared',

  // ── INPUT: Storage tier ────────────────────────────────────
  /** Free tier: user upgraded to paid — begin migration. */
  TIER_UPGRADED: 'tier.upgraded',

  /** Migration of local vectors to cloud backend completed. */
  MIGRATION_COMPLETE: 'migration.complete',

  // ── OUTPUT: Injection pipeline ─────────────────────────────
  /** An injection block is ready to be prepended to the next outgoing message. */
  INJECTION_READY: 'injection.ready',

  /** An injection was applied to an outgoing message. */
  INJECTION_APPLIED: 'injection.applied',

  /** Injection was skipped (no relevant facts, or disabled). */
  INJECTION_SKIPPED: 'injection.skipped',

  // ── OUTPUT: UI updates ─────────────────────────────────────
  /** HUD token display should update. */
  HUD_UPDATE: 'hud.update',

  /** Popup stats should refresh. */
  STATS_UPDATE: 'stats.update',

  /** Extension badge count changed. */
  BADGE_UPDATE: 'badge.update',

  // ── OUTPUT: Sync / backend ─────────────────────────────────
  /** Background flush to backend completed. */
  FLUSH_COMPLETE: 'flush.complete',

  /** Background flush failed. */
  FLUSH_ERROR: 'flush.error',

  /** Cloud sync of vectors completed. */
  CLOUD_SYNC_COMPLETE: 'cloud.sync.complete',

  // ── SYSTEM ─────────────────────────────────────────────────
  /** Service worker initialized and storage ready. */
  SW_READY: 'sw.ready',

  /** An unhandled error occurred in the pipeline. */
  PIPELINE_ERROR: 'pipeline.error',
};

// ==================== EVENT BUS CLASS ====================

class EventBus {
  /**
   * @param {string} name - Debug label ('input' or 'output')
   */
  constructor(name = 'bus') {
    this._name = name;
    this._listeners = new Map(); // event → Set<handler>
    this._onceListeners = new Map(); // event → Set<{ handler, wrapper }>
    this._debugMode = false;
  }

  /**
   * Enable debug logging for all events on this bus.
   */
  setDebug(enabled) {
    this._debugMode = !!enabled;
    return this;
  }

  /**
   * Subscribe to an event.
   * @param {string} event - Event name (use EVENTS constants)
   * @param {Function} handler - Called with (payload, meta)
   * @returns {Function} Unsubscribe function
   */
  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);

    // Return unsubscribe fn for easy cleanup
    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event once — auto-removes after first fire.
   * @param {string} event
   * @param {Function} handler
   * @returns {Function} Unsubscribe function
   */
  once(event, handler) {
    const wrapper = (payload, meta) => {
      handler(payload, meta);
      this.off(event, wrapper);
      // Also clean up once registry
      const onceSet = this._onceListeners.get(event);
      if (onceSet) {
        for (const entry of onceSet) {
          if (entry.handler === handler) {
            onceSet.delete(entry);
            break;
          }
        }
      }
    };

    if (!this._onceListeners.has(event)) {
      this._onceListeners.set(event, new Set());
    }
    this._onceListeners.get(event).add({ handler, wrapper });

    return this.on(event, wrapper);
  }

  /**
   * Unsubscribe a handler.
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) this._listeners.delete(event);
    }
  }

  /**
   * Emit an event to all subscribers.
   * Errors in individual handlers are caught and logged — one bad handler
   * does not block the rest.
   *
   * @param {string} event - Event name
   * @param {*} payload - Event data
   * @returns {number} Number of handlers called
   */
  emit(event, payload = null) {
    const meta = { event, bus: this._name, timestamp: Date.now() };

    if (this._debugMode) {
      console.debug(`[MemBrain:${this._name}] ▶ ${event}`, payload);
    }

    const handlers = this._listeners.get(event);
    if (!handlers || handlers.size === 0) return 0;

    let count = 0;
    for (const handler of handlers) {
      try {
        handler(payload, meta);
        count++;
      } catch (e) {
        console.error(`[MemBrain:${this._name}] Handler error on "${event}":`, e);
      }
    }

    return count;
  }

  /**
   * Emit an event and await all async handlers.
   * Use for pipeline steps where order matters.
   *
   * @param {string} event
   * @param {*} payload
   * @returns {Promise<number>} Number of handlers awaited
   */
  async emitAsync(event, payload = null) {
    const meta = { event, bus: this._name, timestamp: Date.now() };

    if (this._debugMode) {
      console.debug(`[MemBrain:${this._name}] ▶ ${event} (async)`, payload);
    }

    const handlers = this._listeners.get(event);
    if (!handlers || handlers.size === 0) return 0;

    let count = 0;
    for (const handler of handlers) {
      try {
        await handler(payload, meta);
        count++;
      } catch (e) {
        console.error(`[MemBrain:${this._name}] Async handler error on "${event}":`, e);
      }
    }

    return count;
  }

  /**
   * Remove all listeners for an event, or all listeners on the bus.
   * @param {string} [event] - If omitted, clears everything
   */
  clear(event) {
    if (event) {
      this._listeners.delete(event);
      this._onceListeners.delete(event);
    } else {
      this._listeners.clear();
      this._onceListeners.clear();
    }
  }

  /**
   * List all events that have active listeners.
   * @returns {string[]}
   */
  activeEvents() {
    return [...this._listeners.keys()];
  }

  /**
   * Get listener count for an event (or total).
   * @param {string} [event]
   * @returns {number}
   */
  listenerCount(event) {
    if (event) {
      return this._listeners.get(event)?.size || 0;
    }
    let total = 0;
    for (const set of this._listeners.values()) total += set.size;
    return total;
  }
}

// ==================== BUS SINGLETONS ====================

/**
 * INPUT BUS — data flowing INTO the system.
 *
 * Published by: bridge.js (forwarding from chrome.runtime messages)
 * Subscribed by: service-worker pipeline handlers
 *
 * Events: TURN_CAPTURED, REQUEST_INTERCEPTED, FACTS_EXTRACTED,
 *         EMBEDDINGS_READY, FLUSH_REQUESTED, API_CONFIGURED, etc.
 */
export const inputBus = new EventBus('input');

/**
 * OUTPUT BUS — commands/updates flowing OUT.
 *
 * Published by: service-worker pipeline handlers
 * Subscribed by: bridge.js relay (forwards to content script via chrome.runtime)
 *
 * Events: INJECTION_READY, HUD_UPDATE, STATS_UPDATE, BADGE_UPDATE,
 *         FLUSH_COMPLETE, FLUSH_ERROR, etc.
 */
export const outputBus = new EventBus('output');

// ==================== BRIDGE HELPERS ====================

/**
 * Serialize a bus event for transmission over chrome.runtime messaging.
 * Used by bridge.js to relay outputBus events to content scripts.
 *
 * @param {string} event
 * @param {*} payload
 * @returns {{ _membrainBusEvent: true, event: string, payload: * }}
 */
export function serializeBusEvent(event, payload) {
  return { _membrainBusEvent: true, event, payload };
}

/**
 * Check if a chrome.runtime message is a serialized bus event.
 * @param {*} msg
 * @returns {boolean}
 */
export function isBusEvent(msg) {
  return msg?._membrainBusEvent === true && typeof msg.event === 'string';
}
