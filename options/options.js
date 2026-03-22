/**
 * MemBrain — Options Page JS (v0.5.1)
 *
 * Communicates with the background service worker via chrome.runtime.sendMessage.
 * New in v0.5.1:
 *   - Vector store stats (count, size, avg embed ms)
 *   - Embedder status (loading / ready / unavailable)
 *   - Tier display + upgrade/migrate flow
 *   - Similarity threshold setting
 *   - "Extract Facts Now" button with live status
 *   - "Sync Now" button wired to manual flush
 *   - Fixed: facts count now reads db.facts (not db.factCount)
 *   - Fully loads/saves all settings from IndexedDB via SW
 */

// ==================== MESSAGING ====================

function send(action, data) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action, data }, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp);
      });
    } catch { resolve(null); }
  });
}

// ==================== TOAST ====================

function toast(text, type = 'default', duration = 3500) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast${type !== 'default' ? ' ' + type : ''}`;
  el.textContent = text;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, duration);
}

// ==================== FORMATTERS ====================

function fmt(n, suffix = '') {
  if (n == null || n === undefined) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M${suffix}`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K${suffix}`;
  return `${n}${suffix}`;
}

function setStatus(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `status ${cls}`;
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '-';
}

// ==================== LOAD ALL ====================

async function loadAll() {
  try {
    const stats = await send('get-stats');
    if (!stats) { console.warn('[Options] SW not ready'); return; }

    // Version
    document.getElementById('versionInfo').textContent =
      `v${stats.version || '?'} · Settings`;

    // Overview stats
    const db = stats.db || {};
    setText('statConvs', db.conversations ?? 0);
    setText('statFacts', db.facts ?? 0);               // Fixed: was db.factCount
    setText('statTokens', fmt(db.totalTokens ?? 0));

    // Backend status
    if (stats.lastSync?.status === 'ok') {
      setStatus('backendStatus', 'connected', 'ok');
      document.getElementById('syncBadge').textContent = 'synced';
      document.getElementById('syncBadge').style.color = '#4ade80';
    } else if (stats.lastSync?.status === 'error') {
      setStatus('backendStatus', 'error', 'err');
      document.getElementById('syncBadge').textContent = 'error';
      document.getElementById('syncBadge').style.color = '#f87171';
    } else {
      setStatus('backendStatus', 'not synced', 'warn');
      document.getElementById('syncBadge').textContent = 'never synced';
    }

    // Injector status
    if (stats.injector?.enabled) {
      setStatus('injectorStatus', 'active', 'ok');
      document.getElementById('injectorEnabled').checked = true;
    } else {
      setStatus('injectorStatus', 'disabled', 'warn');
      document.getElementById('injectorEnabled').checked = false;
    }

    // Extractor provider
    if (stats.extractor?.provider) {
      document.getElementById('apiProvider').value = stats.extractor.provider;
    }

    // ── Vector / Tier stats ────────────────────────────────────
    await loadVectorStats(stats);
    await loadTierState();
    await loadSavedSettings();

  } catch (e) {
    console.error('[Options] loadAll failed:', e);
  }
}

async function loadVectorStats(stats) {
  // Pull vector stats from SW
  const vsStats = await send('get-vector-stats');

  if (vsStats?.vectorStore) {
    const vs = vsStats.vectorStore;
    setText('statVectors', vs.count ?? 0);
    setText('vsCount', vs.count ?? 0);
    setText('vsSizeKB', vs.estimatedSizeKB != null ? `${vs.estimatedSizeKB}` : '-');
  } else {
    setText('statVectors', 0);
  }

  if (vsStats?.embedder) {
    const emb = vsStats.embedder;
    setText('vsEmbedAvgMs', emb.avgMs != null ? `${emb.avgMs}` : '-');

    const embedderEl = document.getElementById('embedderStatus');
    if (emb.ready) {
      embedderEl.innerHTML = `Embedder: <span class="status ok">ready</span>`;
    } else if (emb.available === false) {
      embedderEl.innerHTML = `Embedder: <span class="status err">unavailable — run setup.sh</span>`;
    } else {
      embedderEl.innerHTML = `Embedder: <span class="status warn">${emb.status || 'loading…'}</span>`;
    }
  }
}

async function loadTierState() {
  const tierData = await send('get-tier-state');
  const tier = tierData?.tier || 'local';

  const freeTierCard = document.getElementById('freeTierCard');
  const paidTierCard = document.getElementById('paidTierCard');
  const migrateBox = document.getElementById('migrateBox');
  const downgradeBox = document.getElementById('downgradeBox');
  const memTierStatus = document.getElementById('memoryTierStatus');

  if (tier === 'cloud') {
    // On paid tier
    paidTierCard.classList.add('active');
    freeTierCard.classList.remove('active');
    migrateBox.style.display = 'none';
    downgradeBox.style.display = 'block';
    document.getElementById('localVectorStats').style.display = 'none';
    setStatus('memoryTierStatus', 'cloud ⚡', 'ok');
  } else {
    // On free local tier
    freeTierCard.classList.add('active');
    paidTierCard.classList.remove('active');
    migrateBox.style.display = 'block';
    downgradeBox.style.display = 'none';
    document.getElementById('localVectorStats').style.display = 'block';
    setStatus('memoryTierStatus', 'local 🔒', 'info');
  }
}

async function loadSavedSettings() {
  // Load settings from IndexedDB via SW
  const s = await send('get-all-settings');
  if (!s) return;

  if (s.injectorEnabled !== undefined) {
    document.getElementById('injectorEnabled').checked = s.injectorEnabled !== false;
  }
  if (s.maxFactsToInject) {
    document.getElementById('maxFacts').value = s.maxFactsToInject;
  }
  if (s.tokenBudget) {
    document.getElementById('tokenBudget').value = s.tokenBudget;
  }
  if (s.vectorThreshold) {
    document.getElementById('vectorThreshold').value = s.vectorThreshold;
  }
  if (s.backendUrl) {
    document.getElementById('backendUrl').value = s.backendUrl;
  }
  // Mask API key if set
  if (s.apiKeyHint) {
    document.getElementById('apiKey').placeholder = `••••${s.apiKeyHint}`;
  }
  if (s.apiProvider) {
    document.getElementById('apiProvider').value = s.apiProvider;
  }
  if (s.apiModel) {
    document.getElementById('apiModel').value = s.apiModel;
  }
}

// ==================== API SETTINGS ====================

document.getElementById('saveApiBtn').addEventListener('click', async () => {
  const provider = document.getElementById('apiProvider').value;
  const apiKey = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('apiModel').value.trim();
  const statusEl = document.getElementById('apiSaveStatus');

  if (!apiKey) {
    statusEl.textContent = 'Enter an API key';
    statusEl.style.color = '#f87171';
    return;
  }

  const data = { apiKey, apiProvider: provider };
  if (model) data.apiModel = model;

  statusEl.textContent = 'Saving…';
  statusEl.style.color = '#8b949e';

  const result = await send('configure-api', data);
  if (result?.configured) {
    statusEl.textContent = '✓ Saved';
    statusEl.style.color = '#4ade80';
    document.getElementById('apiKey').value = '';
    document.getElementById('apiKey').placeholder = `••••${apiKey.slice(-4)}`;
    toast('API key saved', 'success');
  } else {
    statusEl.textContent = result?.error || 'Failed';
    statusEl.style.color = '#f87171';
    toast('Failed to save API key', 'error');
  }
});

// ==================== INJECTOR ====================

document.getElementById('injectorEnabled').addEventListener('change', async (e) => {
  await send('set-injector', { enabled: e.target.checked });
  setStatus('injectorStatus', e.target.checked ? 'active' : 'disabled', e.target.checked ? 'ok' : 'warn');
  toast(e.target.checked ? 'Auto-inject enabled' : 'Auto-inject disabled');
});

document.getElementById('saveInjectorBtn').addEventListener('click', async () => {
  const maxFacts = parseInt(document.getElementById('maxFacts').value, 10);
  const tokenBudget = parseInt(document.getElementById('tokenBudget').value, 10);
  const vectorThreshold = parseFloat(document.getElementById('vectorThreshold').value);

  await send('save-settings', {
    maxFactsToInject: maxFacts,
    tokenBudget,
    vectorThreshold,
  });
  toast('Injection settings saved', 'success');
});

// ==================== SYNC ====================

document.getElementById('flushNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('flushNowBtn');
  const statusEl = document.getElementById('syncStatus');
  btn.disabled = true;
  btn.textContent = '↑ Syncing…';
  statusEl.textContent = '';

  const result = await send('manual-flush');
  btn.disabled = false;
  btn.textContent = '↑ Sync Now';

  if (result?.status === 'flushed') {
    statusEl.textContent = `✓ Synced ${result.conversations} convos, ${result.turns} turns`;
    statusEl.style.color = '#4ade80';
    toast(`Synced ${result.turns} turns`, 'success');
    loadAll();
  } else if (result?.status === 'no_conversations') {
    statusEl.textContent = 'Nothing to sync';
    statusEl.style.color = '#8b949e';
  } else {
    statusEl.textContent = result?.error || 'Sync failed';
    statusEl.style.color = '#f87171';
    toast('Sync failed', 'error');
  }
});

// ==================== MIGRATE / UPGRADE ====================

document.getElementById('migrateBtn').addEventListener('click', async () => {
  const token = document.getElementById('cloudToken').value.trim();
  const clearLocal = document.getElementById('clearLocalAfterMigrate').checked;
  const statusEl = document.getElementById('migrateStatus');
  const progressBar = document.getElementById('migrateProgress');
  const progressFill = document.getElementById('migrateProgressFill');

  if (!token) {
    statusEl.textContent = 'Enter your Cortex API token';
    statusEl.style.color = '#f87171';
    return;
  }

  const btn = document.getElementById('migrateBtn');
  btn.disabled = true;
  btn.textContent = '⚡ Migrating…';
  statusEl.textContent = 'Exporting local data…';
  statusEl.style.color = '#8b949e';
  progressBar.style.display = 'block';
  progressFill.style.width = '20%';

  // Send tier upgrade event to SW — it handles migration via VectorBackendFactory.migrate()
  const result = await send('tier-upgrade', { token, clearLocal });

  progressFill.style.width = '100%';

  if (result?.success) {
    statusEl.textContent = `✓ Migrated ${result.migrated} facts to Cortex`;
    statusEl.style.color = '#4ade80';
    btn.textContent = '✓ Upgraded';
    toast(`Migrated ${result.migrated} facts — now on Cortex cloud tier`, 'success', 5000);
    document.getElementById('cloudToken').value = '';
    setTimeout(() => { progressBar.style.display = 'none'; loadAll(); }, 1500);
  } else {
    statusEl.textContent = result?.error || 'Migration failed';
    statusEl.style.color = '#f87171';
    btn.disabled = false;
    btn.textContent = '⚡ Migrate & Upgrade';
    progressBar.style.display = 'none';
    toast('Migration failed: ' + (result?.error || 'unknown error'), 'error');
  }
});

document.getElementById('downgradeLink').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!confirm('Switch back to local embeddings? Your cloud data is preserved.')) return;
  await send('tier-downgrade');
  toast('Switched to local tier');
  loadAll();
});

// ==================== EXTRACT FACTS ====================

document.getElementById('extractNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('extractNowBtn');
  const statusEl = document.getElementById('extractStatus');
  btn.disabled = true;
  btn.textContent = '🔍 Extracting…';
  statusEl.style.display = 'block';
  statusEl.style.color = '#8b949e';
  statusEl.textContent = 'Running fact extraction…';

  const result = await send('extract-facts', { maxConversations: 10, minTurns: 2 });
  btn.disabled = false;
  btn.textContent = '🔍 Extract Facts Now';

  if (result?.error) {
    statusEl.textContent = `✗ ${result.error}`;
    statusEl.style.color = '#f87171';
    toast(result.error, 'error');
  } else {
    const newFacts = result?.totalNewFacts ?? 0;
    const processed = result?.conversationsProcessed ?? 0;
    statusEl.textContent = `✓ ${newFacts} new facts from ${processed} conversations`;
    statusEl.style.color = '#4ade80';
    if (newFacts > 0) {
      toast(`Extracted ${newFacts} new facts`, 'success');
    } else {
      toast('No new facts found');
    }
    loadAll(); // Refresh stats
  }
});

// ==================== DATA MANAGEMENT ====================

document.getElementById('exportBtn').addEventListener('click', async () => {
  const data = await send('export-data');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `membrain-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Data exported');
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const result = await send('import-data', data);
    toast(`Imported: ${result?.conversations ?? 0} convos, ${result?.facts ?? 0} facts`, 'success');
    loadAll();
  } catch (err) {
    toast('Import failed: ' + err.message, 'error');
  }
  e.target.value = '';
});

document.getElementById('clearBtn').addEventListener('click', async () => {
  if (!confirm('Permanently delete ALL conversations, facts, vectors, and settings?')) return;
  if (!confirm('This cannot be undone. Are you sure?')) return;
  await send('clear-data');
  toast('All data cleared');
  loadAll();
});

// ==================== INIT ====================

loadAll();

// Refresh stats every 30 seconds while options page is open
setInterval(loadAll, 30_000);
