/**
 * MemBrain — SSE Reassembler Tests
 * Run: node test/test-sse-reassembler.js
 *
 * Tests parsing logic against real-world SSE payloads from each platform.
 */

const fs = require('fs');
const path = require('path');

// Load the reassembler (page-world script, not a module — eval it)
const reassemblerSrc = fs.readFileSync(
  path.join(__dirname, '..', 'interceptor', 'sse-reassembler.js'),
  'utf-8'
);
require("vm").runInThisContext(reassemblerSrc);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2705 ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \u274c ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// ==================== CLAUDE TESTS ====================

console.log('\n\ud83d\udd35 Claude SSE Parsing');

const CLAUDE_SAMPLE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant"}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", how can I help?"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  'data: [DONE]',
  '',
].join('\n');

test('parses Claude SSE stream into complete text', () => {
  let result = null;
  const r = new SSEReassembler({
    platform: 'claude',
    conversationId: 'conv-abc',
    onComplete: (res) => { result = res; },
  });
  r.feed(CLAUDE_SAMPLE);
  assert(result !== null, 'onComplete should have fired');
  assert(result.content === 'Hello there, how can I help?', `Got: "${result.content}"`);
  assert(result.platform === 'claude', 'Platform mismatch');
  assert(result.conversationId === 'conv-abc', 'ConversationId mismatch');
});

test('handles Claude stream in chunks (simulating network packets)', () => {
  let result = null;
  const r = new SSEReassembler({
    platform: 'claude',
    onComplete: (res) => { result = res; },
  });
  r.feed('event: content_block_delta\ndata: {"type":"content_block_');
  r.feed('delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n');
  r.feed('data: [DONE]\n');
  assert(result !== null, 'onComplete should fire');
  assert(result.content === 'Hi', `Got: "${result.content}"`);
});

// ==================== CHATGPT TESTS ====================

console.log('\n\ud83d\udfe2 ChatGPT SSE Parsing');

const CHATGPT_SAMPLE = [
  'data: {"message":{"id":"msg-1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["Hello"]},"status":"in_progress"},"conversation_id":"conv-gpt-123"}',
  '',
  'data: {"message":{"id":"msg-1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["Hello, how"]},"status":"in_progress"},"conversation_id":"conv-gpt-123"}',
  '',
  'data: {"message":{"id":"msg-1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["Hello, how can I help?"]},"status":"finished_successfully"},"conversation_id":"conv-gpt-123"}',
  '',
  'data: [DONE]',
  '',
].join('\n');

test('parses ChatGPT SSE stream (captures cumulative parts)', () => {
  let result = null;
  const r = new SSEReassembler({
    platform: 'chatgpt',
    onComplete: (res) => { result = res; },
  });
  r.feed(CHATGPT_SAMPLE);
  assert(result !== null, 'onComplete should fire');
  assert(result.conversationId === 'conv-gpt-123', `ConvID: ${result.conversationId}`);
  assert(result.content.includes('Hello'), `Content should contain Hello: "${result.content}"`);
});

test('extracts conversation_id from ChatGPT response body', () => {
  let result = null;
  const r = new SSEReassembler({
    platform: 'chatgpt',
    onComplete: (res) => { result = res; },
  });
  r.feed(CHATGPT_SAMPLE);
  assert(result.conversationId === 'conv-gpt-123', `Got: ${result.conversationId}`);
});

// ==================== PERPLEXITY TESTS ====================

console.log('\n\ud83d\udfe3 Perplexity SSE Parsing');

const PERPLEXITY_SAMPLE = [
  'data: {"choices":[{"index":0,"delta":{"content":"The answer"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{"content":" is 42."}}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');

test('parses Perplexity OpenAI-style deltas', () => {
  let result = null;
  const r = new SSEReassembler({
    platform: 'perplexity',
    onComplete: (res) => { result = res; },
  });
  r.feed(PERPLEXITY_SAMPLE);
  assert(result !== null, 'onComplete should fire');
  assert(result.content === 'The answer is 42.', `Got: "${result.content}"`);
});

// ==================== GEMINI TESTS ====================

console.log('\n\ud83d\udd34 Gemini SSE Parsing');

const GEMINI_SAMPLE = [
  'data: {"candidates":[{"content":{"parts":[{"text":"Gemini says hello"}],"role":"model"}}]}',
  '',
  'data: {"candidates":[{"content":{"parts":[{"text":" and goodbye"}],"role":"model"}}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');

test('parses Gemini candidate format', () => {
  let result = null;
  const r = new SSEReassembler({
    platform: 'gemini',
    onComplete: (res) => { result = res; },
  });
  r.feed(GEMINI_SAMPLE);
  assert(result !== null, 'onComplete should fire');
  assert(result.content === 'Gemini says hello and goodbye', `Got: "${result.content}"`);
});

// ==================== EDGE CASES ====================

console.log('\n\u26a1 Edge Cases');

test('handles empty stream gracefully', () => {
  const r = new SSEReassembler({ platform: 'claude' });
  r.feed('');
  const result = r.finish();
  assert(result.content === '', 'Should produce empty content');
});

test('handles malformed JSON without crashing', () => {
  let result = null;
  const r = new SSEReassembler({
    platform: 'claude',
    onComplete: (res) => { result = res; },
  });
  r.feed('data: {not valid json}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\ndata: [DONE]\n');
  assert(result !== null, 'Should still complete');
  assert(result.content === 'ok', `Got: "${result.content}"`);
});

test('double-finish is safe (idempotent)', () => {
  const r = new SSEReassembler({ platform: 'claude' });
  r.feed('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n');
  const r1 = r.finish();
  const r2 = r.finish();
  assert(r1.content === 'hi', 'First finish should work');
  assert(r2 === null, 'Second finish should return null');
});

test('handles data: lines with no space after colon', () => {
  const r = new SSEReassembler({ platform: 'claude' });
  r.feed('data:{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"nope"}}\n\n');
  const result = r.finish();
  assert(result.content === '', 'Should not parse data: without space');
});

// ==================== SUMMARY ====================

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}\n`);
process.exit(failed > 0 ? 1 : 0);
