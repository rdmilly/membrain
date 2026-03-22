/**
 * MemBrain — Platform URL Patterns
 * Configurable regex patterns for detecting AI platform API calls.
 * Each pattern extracts the conversation ID where possible.
 */

const PLATFORM_PATTERNS = {
  claude: {
    // Claude SSE completion endpoint
    response: [
      {
        pattern: /\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/completion/,
        conversationIdGroup: 1,
        streaming: true,
        description: 'Claude chat completion (SSE)',
      },
    ],
    // Claude message send endpoint
    request: [
      {
        pattern: /\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/completion/,
        conversationIdGroup: 1,
        description: 'Claude outgoing message',
      },
    ],
    hostPattern: /claude\.ai$/,
  },

  chatgpt: {
    response: [
      {
        pattern: /\/backend-api\/conversation$/,
        conversationIdGroup: null, // ID is in the response body
        streaming: true,
        description: 'ChatGPT conversation (SSE)',
      },
    ],
    request: [
      {
        pattern: /\/backend-api\/conversation$/,
        conversationIdGroup: null,
        description: 'ChatGPT outgoing message',
      },
    ],
    hostPattern: /chat\.openai\.com$|chatgpt\.com$/,
  },

  gemini: {
    response: [
      {
        // Gemini uses various streaming endpoints
        pattern: /\/(_\/BardChatUi\/|api\/generate|StreamGenerate)/,
        conversationIdGroup: null,
        streaming: true,
        description: 'Gemini generation endpoint',
      },
    ],
    request: [
      {
        pattern: /\/(_\/BardChatUi\/|api\/generate|StreamGenerate)/,
        conversationIdGroup: null,
        description: 'Gemini outgoing',
      },
    ],
    hostPattern: /gemini\.google\.com$/,
  },

  perplexity: {
    response: [
      {
        pattern: /\/api\/query/,
        conversationIdGroup: null,
        streaming: true,
        description: 'Perplexity query (SSE)',
      },
    ],
    request: [
      {
        pattern: /\/api\/query/,
        conversationIdGroup: null,
        description: 'Perplexity outgoing',
      },
    ],
    hostPattern: /perplexity\.ai$/,
  },
};

/**
 * Match a URL against all platform patterns.
 * @param {string} url - The request URL
 * @param {'request'|'response'} direction - Which pattern set to check
 * @returns {{ platform: string, pattern: object, match: RegExpMatchArray } | null}
 */
function matchUrl(url, direction = 'response') {
  // Parse URL to check host first for efficiency
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  for (const [platform, config] of Object.entries(PLATFORM_PATTERNS)) {
    // Quick host check
    if (!config.hostPattern.test(parsedUrl.hostname)) continue;

    const patterns = config[direction] || [];
    for (const patternDef of patterns) {
      const match = url.match(patternDef.pattern);
      if (match) {
        return {
          platform,
          pattern: patternDef,
          match,
          conversationId: patternDef.conversationIdGroup !== null
            ? match[patternDef.conversationIdGroup]
            : null,
        };
      }
    }
  }

  return null;
}

/**
 * Get all host patterns for manifest.json host_permissions.
 * @returns {string[]} Array of match patterns
 */
function getHostPermissions() {
  return [
    '*://claude.ai/*',
    '*://chat.openai.com/*',
    '*://chatgpt.com/*',
    '*://gemini.google.com/*',
    '*://www.perplexity.ai/*',
    '*://perplexity.ai/*',
  ];
}
