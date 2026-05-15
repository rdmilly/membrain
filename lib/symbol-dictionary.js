/**
 * MemBrain Symbol Dictionary v2.0 — Mathematically Optimal
 *
 * Uses compression value scoring to select the highest-ROI symbols:
 *   value(phrase) = (phrase_tokens - symbol_tokens) * frequency - spec_cost
 *
 * Only promotes phrases where value > 0 (break-even analysis).
 * Greedily fills a SPEC token budget with highest-value phrases first.
 * Learns entirely from the user's actual conversation history.
 *
 * Token estimates: 1 token ≈ 4 chars (conservative)
 * Symbol tokens: 1 (e.g. "§sw" = 1 token)
 * Spec cost per entry: ~3 tokens (e.g. "§sw=service worker")
 * SPEC budget: 80 tokens (leaves room, avoids bloat)
 */

const DB_NAME = 'memory-ext';
const DB_VERSION = 5;  // must match storage.js (v5 is authoritative)
const SYMBOL_STORE = 'symbol_dictionary';
const SPEC_TOKEN_BUDGET = 80;  // max tokens to spend on the symbol dictionary in SPEC
const MIN_FREQUENCY = 2; // lowered: catch phrases seen 2+ times       // phrase must appear at least this many times
const MIN_CONVERSATIONS = 1; // lowered: build from single conversation   // across at least this many conversations
const SYMBOL_TOKENS = 1;       // cost of using a symbol in-message
const SPEC_COST_PER_SYMBOL = 3;// tokens spent in SPEC defining each symbol

// ===== TOKEN ESTIMATION =====
function estimateTokens(text) {
  // Conservative estimate: 1 token per 4 chars, minimum 1
  return Math.max(1, Math.ceil(text.length / 4));
}

// ===== COMPRESSION VALUE =====
// Returns expected token savings over a conversation, minus spec overhead
function compressionValue(phrase, frequency) {
  const phraseTokens = estimateTokens(phrase);
  const savedPerUse = phraseTokens - SYMBOL_TOKENS;
  if (savedPerUse <= 0) return -1; // single-token phrases not worth compressing
  return (savedPerUse * frequency) - SPEC_COST_PER_SYMBOL;
}

// ===== SYMBOL ASSIGNMENT =====
// Creates compact memorable symbol from phrase
function assignSymbol(phrase, usedSymbols) {
  const words = phrase.split(' ').filter(w => w.length > 1);
  const candidates = [
    // Initials of all significant words
    '\u00a7' + words.map(w => w[0]).join('').slice(0, 4),
    // First 2-3 chars of first word
    '\u00a7' + words[0].slice(0, 3),
    // First char of each of first 3 words
    '\u00a7' + words.slice(0, 3).map(w => w[0]).join(''),
    // First word abbrev + first char of second
    '\u00a7' + words[0].slice(0, 2) + (words[1]?.[0] || ''),
  ].filter((s, i, arr) => arr.indexOf(s) === i); // dedupe

  for (const c of candidates) {
    if (c.length >= 2 && !usedSymbols.has(c)) return c;
  }
  // Fallback: sequential
  let n = 1;
  while (usedSymbols.has(`\u00a7${n}`)) n++;
  return `\u00a7${n}`;
}

// ===== N-GRAM EXTRACTION =====
function extractNgrams(text, minN = 2, maxN = 6) {
  if (!text || text.length < 10) return {};
  const counts = {};
  // Normalize: lowercase, collapse whitespace, remove special chars
  const clean = text.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').filter(w => w.length > 1);

  for (let n = minN; n <= maxN; n++) {
    for (let i = 0; i <= words.length - n; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      // Skip phrases that are too short to compress meaningfully
      if (phrase.length < 6) continue;
      // Skip phrases starting/ending with stop words
      const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'this', 'that', 'it']);
      if (stopWords.has(words[i]) || stopWords.has(words[i + n - 1])) continue;
      counts[phrase] = (counts[phrase] || 0) + 1;
    }
  }
  return counts;
}

// ===== INDEXEDDB =====
async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(SYMBOL_STORE)) {
        db.createObjectStore(SYMBOL_STORE, { keyPath: 'symbol' });
        console.log('[SymbolDict] Created symbol_dictionary store');
      }
    };
  });
}

async function loadDictionary() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(SYMBOL_STORE, 'readonly');
      const req = tx.objectStore(SYMBOL_STORE).getAll();
      req.onsuccess = e => resolve(e.target.result || []);
      req.onerror = () => resolve([]);
    });
  } catch(e) {
    console.warn('[SymbolDict] Load failed:', e);
    return [];
  }
}

async function saveDictionary(entries) {
  try {
    const db = await openDB();
    const tx = db.transaction(SYMBOL_STORE, 'readwrite');
    const store = tx.objectStore(SYMBOL_STORE);
    // Clear and rewrite for clean state
    store.clear();
    for (const entry of entries) store.put(entry);
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  } catch(e) {
    console.warn('[SymbolDict] Save failed:', e);
  }
}

// ===== CORE: BUILD OPTIMAL DICTIONARY =====
async function buildDictionary(conversations) {
  console.log(`[SymbolDict] Building from ${conversations.length} conversations...`);

  // 1. Count phrase frequencies across all conversations
  const globalCounts = {};     // phrase → total count
  const phraseConvos = {};     // phrase → Set of conversation IDs

  for (const conv of conversations) {
    const convId = conv.id || conv.conversationId || Math.random().toString(36);
    // Extract text from turns
    const turns = conv.turns || conv.messages || [];
    const text = turns.map(t => {
      if (typeof t.content === 'string') return t.content;
      if (typeof t.text === 'string') return t.text;
      if (Array.isArray(t.content)) return t.content.map(b => b.text || '').join(' ');
      return '';
    }).join(' ');

    const counts = extractNgrams(text);
    for (const [phrase, count] of Object.entries(counts)) {
      globalCounts[phrase] = (globalCounts[phrase] || 0) + count;
      if (!phraseConvos[phrase]) phraseConvos[phrase] = new Set();
      phraseConvos[phrase].add(convId);
    }
  }

  // 2. Score every candidate phrase
  const candidates = [];
  for (const [phrase, freq] of Object.entries(globalCounts)) {
    if (freq < MIN_FREQUENCY) continue;
    if ((phraseConvos[phrase]?.size || 0) < MIN_CONVERSATIONS) continue;
    const value = compressionValue(phrase, freq);
    if (value <= 0) continue; // not worth compressing
    candidates.push({ phrase, freq, value });
  }

  // 3. Sort by compression value descending (greedy knapsack)
  candidates.sort((a, b) => b.value - a.value);

  // 4. Fill SPEC budget greedily
  const usedSymbols = new Set();
  const selected = [];
  let specTokensUsed = 0;

  for (const { phrase, freq, value } of candidates) {
    const cost = SPEC_COST_PER_SYMBOL + estimateTokens(phrase); // define + the phrase itself
    if (specTokensUsed + cost > SPEC_TOKEN_BUDGET) continue;
    const symbol = assignSymbol(phrase, usedSymbols);
    usedSymbols.add(symbol);
    selected.push({
      symbol,
      phrase,
      freq,
      value: Math.round(value),
      specCost: cost,
      promoted: Date.now(),
      source: 'learned',
    });
    specTokensUsed += cost;
  }

  console.log(`[SymbolDict] Selected ${selected.length} symbols using ${specTokensUsed}/${SPEC_TOKEN_BUDGET} spec tokens`);
  console.log(`[SymbolDict] Top 5:`, selected.slice(0, 5).map(s => `${s.symbol}=${s.phrase}(${s.value}pts)`));

  await saveDictionary(selected);
  return selected;
}

// ===== GET CURRENT DICTIONARY =====
async function getDictionary() {
  const stored = await loadDictionary();
  return stored.sort((a, b) => (b.value || 0) - (a.value || 0));
}

// ===== EXPORTS =====
export { buildDictionary, getDictionary, saveDictionary, loadDictionary, compressionValue, estimateTokens, SPEC_TOKEN_BUDGET };
