/**
 * MemBrain — SSE Stream Reassembler
 * Accumulates Server-Sent Events data lines and emits complete messages.
 * Handles the various SSE formats used by AI platforms.
 */

class SSEReassembler {
  constructor(options = {}) {
    this.platform = options.platform || 'unknown';
    this.onChunk = options.onChunk || null;     // Called per SSE event
    this.onComplete = options.onComplete || null; // Called when stream ends
    this.onError = options.onError || null;       // Called on parse error

    this._buffer = '';
    this._chunks = [];        // Accumulated parsed data objects
    this._textParts = [];     // Accumulated text content
    this._conversationId = options.conversationId || null;
    this._done = false;
  }

  /**
   * Feed raw text from the response stream.
   * @param {string} text - Raw SSE text chunk
   */
  feed(text) {
    if (this._done) return null;

    this._buffer += text;
    const lines = this._buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this._buffer = lines.pop() || '';

    for (const line of lines) {
      this._processLine(line);
    }
  }

  /**
   * Signal that the stream has ended. Process any remaining buffer.
   */
  finish() {
    if (this._done) return null;
    this._done = true;

    // Process any remaining buffer
    if (this._buffer.trim()) {
      this._processLine(this._buffer);
      this._buffer = '';
    }

    const result = {
      platform: this.platform,
      conversationId: this._conversationId,
      content: this._textParts.join(''),
      chunks: this._chunks,
      timestamp: Date.now(),
    };

    if (this.onComplete) {
      try { this.onComplete(result); } catch (e) { this._emitError(e); }
    }

    return result;
  }

  /**
   * Process a single SSE line.
   * @param {string} line
   */
  _processLine(line) {
    const trimmed = line.trim();

    // Empty line = end of SSE event (we handle data accumulation per-line)
    if (!trimmed) return;

    // SSE data: prefix
    if (trimmed.startsWith('data: ')) {
      const data = trimmed.slice(6);
      this._processData(data);
    } else if (trimmed === 'data:') {
      // Empty data line (some platforms send this)
      return;
    }
    // Ignore event:, id:, retry: lines — we only care about data
  }

  /**
   * Process the data payload of an SSE event.
   * @param {string} data - Raw data string (usually JSON)
   */
  _processData(data) {
    // Check for stream termination signals
    if (data === '[DONE]' || data === '[done]') {
      this.finish();
      return;
    }

    // Try to parse as JSON
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Not JSON — some platforms send raw text
      // Store as-is for later parsing
      this._chunks.push({ raw: data });
      return;
    }

    this._chunks.push(parsed);

    // Extract text content based on platform
    const text = this._extractText(parsed);
    if (text) {
      this._textParts.push(text);
      if (this.onChunk) {
        try { this.onChunk({ text, parsed }); } catch (e) { this._emitError(e); }
      }
    }

    // Try to extract conversation ID if we don't have one
    if (!this._conversationId) {
      this._conversationId = this._extractConversationId(parsed);
    }
  }

  /**
   * Extract text content from a parsed SSE data object.
   * Platform-specific extraction logic.
   * @param {Object} data
   * @returns {string|null}
   */
  _extractText(data) {
    switch (this.platform) {
      case 'claude':
        return this._extractClaudeText(data);
      case 'chatgpt':
        return this._extractChatGPTText(data);
      case 'gemini':
        return this._extractGeminiText(data);
      case 'perplexity':
        return this._extractPerplexityText(data);
      default:
        return this._extractGenericText(data);
    }
  }

  /**
   * Claude SSE format:
   * {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "..."}}
   */
  _extractClaudeText(data) {
    if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
      return data.delta.text || '';
    }
    // Also handle completion type
    if (data.type === 'completion' && data.completion) {
      return data.completion;
    }
    return null;
  }

  /**
   * ChatGPT SSE format:
   * {"message": {"content": {"parts": ["..."]}, "author": {"role": "assistant"}}}
   * Or delta format: content.parts contains incremental text
   */
  _extractChatGPTText(data) {
    // Delta/streaming format
    if (data.message?.content?.parts) {
      const parts = data.message.content.parts;
      // ChatGPT sends full content each time in streaming, we need to diff
      // For now capture the latest part — the parser (Item 2) will handle dedup
      return parts[parts.length - 1] || null;
    }
    return null;
  }

  /**
   * Gemini format varies but typically has candidates[0].content.parts[0].text
   */
  _extractGeminiText(data) {
    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text;
    }
    return null;
  }

  /**
   * Perplexity format: similar to OpenAI-style delta
   */
  _extractPerplexityText(data) {
    if (data.choices?.[0]?.delta?.content) {
      return data.choices[0].delta.content;
    }
    if (data.text) return data.text;
    return null;
  }

  /**
   * Generic fallback — look for common patterns
   */
  _extractGenericText(data) {
    if (data.choices?.[0]?.delta?.content) return data.choices[0].delta.content;
    if (data.delta?.text) return data.delta.text;
    if (data.text) return data.text;
    if (data.content) return typeof data.content === 'string' ? data.content : null;
    return null;
  }

  /**
   * Try to extract conversation ID from response data.
   * @param {Object} data
   * @returns {string|null}
   */
  _extractConversationId(data) {
    // ChatGPT includes conversation_id in response
    if (data.conversation_id) return data.conversation_id;
    // Some platforms use other fields
    if (data.message?.conversation_id) return data.message.conversation_id;
    if (data.id) return data.id;
    return null;
  }

  _emitError(error) {
    if (this.onError) {
      try { this.onError(error); } catch { /* swallow */ }
    }
  }
}
