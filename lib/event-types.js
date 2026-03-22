/**
 * MemBrain — Shared Event Types
 * Used across page world, content script, and service worker.
 */

const MEMORY_EXT_PREFIX = 'memory-ext';

// Message types for window.postMessage (page world → content script)
const MSG_TYPES = {
  // Interceptor → Content Script
  RESPONSE_CAPTURED: `${MEMORY_EXT_PREFIX}:response-captured`,
  REQUEST_CAPTURED: `${MEMORY_EXT_PREFIX}:request-captured`,
  STREAM_CHUNK: `${MEMORY_EXT_PREFIX}:stream-chunk`,
  STREAM_COMPLETE: `${MEMORY_EXT_PREFIX}:stream-complete`,
  STREAM_ERROR: `${MEMORY_EXT_PREFIX}:stream-error`,
  INTERCEPTOR_READY: `${MEMORY_EXT_PREFIX}:interceptor-ready`,
};

// Chrome runtime message actions (content script → service worker)
const ACTIONS = {
  CONVERSATION_TURN: 'conversation-turn',
  INTERCEPTOR_STATUS: 'interceptor-status',
  REQUEST_OUTGOING: 'request-outgoing',
  ERROR_REPORT: 'error-report',
};

// Platforms
const PLATFORMS = {
  CLAUDE: 'claude',
  CHATGPT: 'chatgpt',
  GEMINI: 'gemini',
  PERPLEXITY: 'perplexity',
};

// Roles
const ROLES = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
};

/**
 * Structured event emitted when a complete conversation turn is captured.
 * @typedef {Object} CapturedTurn
 * @property {string} platform - One of PLATFORMS values
 * @property {string} conversationId - Platform-specific conversation identifier
 * @property {string} role - One of ROLES values
 * @property {string} content - Full text content of the turn
 * @property {number} timestamp - Unix timestamp (ms)
 * @property {string} url - The intercepted URL
 * @property {Object} [metadata] - Platform-specific extra data
 */

// Export for both module and non-module contexts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MSG_TYPES, ACTIONS, PLATFORMS, ROLES, MEMORY_EXT_PREFIX };
}
