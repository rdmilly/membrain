/**
 * MemBrain Knowledge Graph v1.0
 *
 * Sits on top of the existing fact store. Converts extracted facts
 * into a typed entity+relation graph stored in IndexedDB.
 *
 * Two new stores (DB v5):
 *   kg_entities  { id, name, type, aliases, props, firstSeen, lastSeen, mentions }
 *   kg_relations { id, from, to, rel, evidence, confidence, ts }
 *
 * Entity types: person | project | tool | location | preference | concept
 * Relation types: USES | WORKS_ON | RUNS_ON | PREFERS | KNOWS |
 *                 HAS_VALUE | LOCATED_AT | PART_OF | DEPENDS_ON | CREATED_BY
 *
 * Retrieval: given a query string, find mentioned entities, traverse
 * 1-2 hops, return rich context string for injection.
 */

const KG_DB_NAME = 'memory-ext';
const KG_DB_VERSION = 5;
const ENT_STORE = 'kg_entities';
const REL_STORE = 'kg_relations';

// ==================== ENTITY DETECTION ====================
// Pattern-based entity recognition — no LLM needed, runs locally

const ENTITY_PATTERNS = [
  // Tools & Technologies
  { pattern: /\b(docker|kubernetes|k8s|nginx|traefik|postgres|postgresql|sqlite|redis|minio|n8n|ollama|llama|claude|openai|anthropic|chromium|chrome)\b/gi, type: 'tool' },
  // Infrastructure
  { pattern: /\b(vps[1-9]?|vps2|vps1|homelab|raspberry ?pi|ubuntu|debian|windows|macos)\b/gi, type: 'location' },
  // MemBrain-specific
  { pattern: /\b(membrain|memory.ext|mirror.index|helix|cortex|MemBrain|MirrorIndex)\b/g, type: 'project' },
  // Projects (camelCase or hyphenated names)
  { pattern: /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+|[a-z]+-[a-z]+-[a-z]+)\b/g, type: 'project', minLen: 6 },
  // Versions
  { pattern: /\bv(\d+\.\d+\.\d+(?:-[a-z]+)?)\b/gi, type: 'concept', prefix: 'version:' },
  // Port numbers
  { pattern: /\bport (\d{2,5})\b/gi, type: 'concept', prefix: 'port:' },
  // File paths
  { pattern: /\/opt\/projects\/([\w-]+)/g, type: 'project', prefix: 'path:' },
  // URLs / domains
  { pattern: /([a-z0-9-]+\.millyweb\.com)/gi, type: 'location' },
];

const RELATION_PATTERNS = [
  { regex: /uses?\s+([\w.-]+)/gi,            rel: 'USES' },
  { regex: /runs?\s+on\s+([\w.-]+)/gi,       rel: 'RUNS_ON' },
  { regex: /works?\s+on\s+([\w.-]+)/gi,      rel: 'WORKS_ON' },
  { regex: /prefers?\s+([\w.-]+)/gi,         rel: 'PREFERS' },
  { regex: /depends?\s+on\s+([\w.-]+)/gi,    rel: 'DEPENDS_ON' },
  { regex: /part\s+of\s+([\w.-]+)/gi,        rel: 'PART_OF' },
  { regex: /located?\s+(?:at|in)\s+([\w.-]+)/gi, rel: 'LOCATED_AT' },
  { regex: /created?\s+by\s+([\w.-]+)/gi,    rel: 'CREATED_BY' },
  { regex: /([\w.-]+)\s+is\s+(?:a|the|an)\s+/gi, rel: 'IS_A' },
];

function extractEntitiesFromText(text) {
  const found = new Map(); // name.toLowerCase() → {name, type}
  for (const { pattern, type, minLen, prefix } of ENTITY_PATTERNS) {
    const rx = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = rx.exec(text)) !== null) {
      const raw = m[1] || m[0];
      if (minLen && raw.length < minLen) continue;
      const name = prefix ? prefix + raw.toLowerCase() : raw.toLowerCase();
      if (!found.has(name)) found.set(name, { name: raw, type });
    }
  }
  return [...found.values()];
}

function generateId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ==================== INDEXEDDB ====================

// KG DB cache - reuse same connection
let _kgDb = null;

async function openKGDB() {
  if (_kgDb) return _kgDb;
  return new Promise((resolve, reject) => {
    // Open at same version as storage.js (v5) - stores already created there
    const req = indexedDB.open(KG_DB_NAME, KG_DB_VERSION);
    req.onsuccess = e => { _kgDb = e.target.result; resolve(_kgDb); };
    req.onerror = e => reject(e.target.error);
    // Upgrade handler needed in case this runs before storage.js opens
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(ENT_STORE)) {
        const s = db.createObjectStore(ENT_STORE, { keyPath: 'id' });
        s.createIndex('name', 'name', { unique: false });
        s.createIndex('type', 'type', { unique: false });
        s.createIndex('lastSeen', 'lastSeen', { unique: false });
      }
      if (!db.objectStoreNames.contains(REL_STORE)) {
        const s = db.createObjectStore(REL_STORE, { keyPath: 'id' });
        s.createIndex('from', 'from', { unique: false });
        s.createIndex('to', 'to', { unique: false });
        s.createIndex('rel', 'rel', { unique: false });
        s.createIndex('ts', 'ts', { unique: false });
      }
      // Also ensure symbol_dictionary exists (v4)
      if (!db.objectStoreNames.contains('symbol_dictionary')) {
        db.createObjectStore('symbol_dictionary', { keyPath: 'symbol' });
      }
    };
  });
}

async function kgGet(store, key) {
  const db = await openKGDB();
  return new Promise((resolve) => {
    db.transaction(store, 'readonly').objectStore(store).get(key)
      .onsuccess = e => resolve(e.target.result);
  });
}

async function kgGetAll(store) {
  const db = await openKGDB();
  return new Promise((resolve) => {
    db.transaction(store, 'readonly').objectStore(store).getAll()
      .onsuccess = e => resolve(e.target.result || []);
  });
}

async function kgPut(store, record) {
  const db = await openKGDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(record);
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

async function kgGetByIndex(store, indexName, value) {
  const db = await openKGDB();
  return new Promise((resolve) => {
    const results = [];
    const req = db.transaction(store, 'readonly')
      .objectStore(store).index(indexName).openCursor(IDBKeyRange.only(value));
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { results.push(cursor.value); cursor.continue(); }
      else resolve(results);
    };
    req.onerror = () => resolve([]);
  });
}

// ==================== ENTITY MANAGEMENT ====================

async function upsertEntity(name, type, props = {}) {
  const normalizedName = name.toLowerCase().trim();
  // Try to find existing by name
  const existing = await kgGetByIndex(ENT_STORE, 'name', normalizedName);
  if (existing.length > 0) {
    const ent = existing[0];
    ent.mentions = (ent.mentions || 0) + 1;
    ent.lastSeen = Date.now();
    Object.assign(ent.props || {}, props);
    await kgPut(ENT_STORE, ent);
    return ent;
  }
  const ent = {
    id: generateId('ent'),
    name: normalizedName,
    displayName: name,
    type,
    props: props || {},
    aliases: [],
    mentions: 1,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
  };
  await kgPut(ENT_STORE, ent);
  return ent;
}

async function upsertRelation(fromId, toId, rel, evidence = '', confidence = 0.8) {
  // Check if this relation already exists
  const existing = await kgGetByIndex(REL_STORE, 'from', fromId);
  const dup = existing.find(r => r.to === toId && r.rel === rel);
  if (dup) {
    dup.confidence = Math.min(1, dup.confidence + 0.05);
    dup.evidence = evidence || dup.evidence;
    dup.ts = Date.now();
    await kgPut(REL_STORE, dup);
    return dup;
  }
  const rel_record = {
    id: generateId('rel'),
    from: fromId,
    to: toId,
    rel,
    evidence: evidence.slice(0, 200),
    confidence,
    ts: Date.now(),
  };
  await kgPut(REL_STORE, rel_record);
  return rel_record;
}

// ==================== INGEST ====================

/**
 * Ingest a single fact into the knowledge graph.
 * Extracts entities and relations, upserts them.
 */
async function ingestFact(fact) {
  const text = fact.content || fact.text || '';
  if (!text) return;

  const entities = extractEntitiesFromText(text);
  const entObjs = [];

  for (const { name, type } of entities) {
    const ent = await upsertEntity(name, type);
    entObjs.push(ent);
  }

  // Create relations between co-occurring entities
  // and extract explicit relations from text
  if (entObjs.length >= 2) {
    // Co-occurrence relation (weak, inferred)
    for (let i = 0; i < entObjs.length - 1; i++) {
      await upsertRelation(
        entObjs[i].id, entObjs[i+1].id,
        'CO_OCCURS_WITH', text.slice(0, 100), 0.4
      );
    }
  }

  // Explicit relation patterns
  for (const { regex, rel } of RELATION_PATTERNS) {
    const rx = new RegExp(regex.source, regex.flags);
    let m;
    while ((m = rx.exec(text)) !== null) {
      const targetName = (m[1] || '').toLowerCase().trim();
      if (!targetName || targetName.length < 2) continue;
      // Find or create subject (first entity) and target
      const subj = entObjs[0];
      if (!subj) continue;
      const targetEnt = await upsertEntity(targetName, 'concept');
      await upsertRelation(subj.id, targetEnt.id, rel, m[0], 0.75);
    }
  }
}

/**
 * Ingest all facts from storage into the KG.
 * Idempotent — upsert logic prevents duplicates.
 */
async function ingestAllFacts(facts) {
  let ingested = 0;
  for (const fact of facts) {
    try {
      await ingestFact(fact);
      ingested++;
    } catch(e) {
      console.warn('[KG] ingest error:', e);
    }
  }
  console.log(`[KG] Ingested ${ingested}/${facts.length} facts`);
  return ingested;
}

// ==================== RETRIEVAL ====================

/**
 * Given a query string, find relevant entities, traverse the graph,
 * and return a rich context string for injection.
 *
 * @param {string} query
 * @param {number} hops - graph traversal depth (1 or 2)
 * @returns {string} context block for injection
 */
async function queryGraph(query, hops = 2) {
  const allEntities = await kgGetAll(ENT_STORE);
  const allRelations = await kgGetAll(REL_STORE);

  if (allEntities.length === 0) return '';

  // 1. Find entities mentioned in the query
  const queryLower = query.toLowerCase();
  const seed = allEntities.filter(e =>
    queryLower.includes(e.name) ||
    (e.aliases || []).some(a => queryLower.includes(a))
  );

  if (seed.length === 0) {
    // Fuzzy fallback: partial name match
    const words = queryLower.split(/\s+/).filter(w => w.length > 3);
    for (const word of words) {
      const matches = allEntities.filter(e => e.name.includes(word) || word.includes(e.name));
      seed.push(...matches.slice(0, 2));
    }
  }

  if (seed.length === 0) return '';

  // 2. BFS traversal up to `hops` depth
  const visited = new Set(seed.map(e => e.id));
  const frontier = [...seed];
  const relMap = new Map(); // entityId → [relations]

  for (let hop = 0; hop < hops; hop++) {
    const nextFrontier = [];
    for (const ent of frontier) {
      const rels = allRelations.filter(r =>
        (r.from === ent.id || r.to === ent.id) && r.confidence >= 0.5
      );
      relMap.set(ent.id, rels);
      for (const rel of rels) {
        const neighborId = rel.from === ent.id ? rel.to : rel.from;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          const neighbor = allEntities.find(e => e.id === neighborId);
          if (neighbor) nextFrontier.push(neighbor);
        }
      }
    }
    frontier.push(...nextFrontier);
  }

  // 3. Build context string
  const lines = ['[KNOWLEDGE GRAPH]'];
  const entById = new Map(allEntities.map(e => [e.id, e]));

  // Entity facts
  const seen = new Set();
  for (const ent of [...seed, ...frontier.filter(e => !seed.includes(e))].slice(0, 15)) {
    const key = ent.name + '|' + ent.type;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${ent.type.toUpperCase()}: ${ent.displayName || ent.name} (seen ${ent.mentions}x)`);

    // Add relations for this entity
    const rels = relMap.get(ent.id) || [];
    for (const rel of rels.slice(0, 4)) {
      if (rel.confidence < 0.5) continue;
      const other = entById.get(rel.from === ent.id ? rel.to : rel.from);
      if (!other) continue;
      const dir = rel.from === ent.id ? '→' : '←';
      lines.push(`  ${dir} ${rel.rel} ${other.displayName || other.name}`);
    }
  }

  lines.push('[/KNOWLEDGE GRAPH]');
  return lines.join('\n');
}

/**
 * Get graph statistics for the HUD.
 */
async function getGraphStats() {
  const [entities, relations] = await Promise.all([
    kgGetAll(ENT_STORE),
    kgGetAll(REL_STORE),
  ]);
  const typeCount = {};
  for (const e of entities) typeCount[e.type] = (typeCount[e.type] || 0) + 1;
  return {
    entities: entities.length,
    relations: relations.length,
    types: typeCount,
    topEntities: entities
      .sort((a, b) => (b.mentions || 0) - (a.mentions || 0))
      .slice(0, 10)
      .map(e => ({ name: e.displayName || e.name, type: e.type, mentions: e.mentions })),
  };
}

export { ingestFact, ingestAllFacts, queryGraph, getGraphStats, upsertEntity, upsertRelation, extractEntitiesFromText, KG_DB_VERSION };
