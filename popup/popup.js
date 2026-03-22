/**
 * MemBrain — Popup UI (v0.5.7)
 * Shows conversations, live captures, and status.
 */

const STORAGE_KEYS = {
  CAPTURED_TURNS: 'captured_turns',
  INTERCEPTOR_STATUS: 'interceptor_status',
  STATS: 'capture_stats',
  FLUSH_LOG: 'flush_log',
};

// ==================== TAB SWITCHING ====================

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ==================== LOAD DATA ====================

async function loadAll() {
  await Promise.all([
    loadStats(),
    loadConversations(),
    loadCaptures(),
    loadStatus(),
  ]);
}

async function loadStats() {
  try {
    const stats = await sendMessage({ action: 'get-stats' });
    if (stats?.error) return;

    const db = stats.db || {};
    document.getElementById('convCount').textContent = db.conversations || 0;
    document.getElementById('turnCount').textContent = db.totalTurns || 0;
    document.getElementById('unsyncedCount').textContent = db.unsynced || 0;
    document.getElementById('tokenCount').textContent = formatTokens(db.totalTokens || 0);
    document.getElementById('version').textContent = `v${stats.version || '?'}`;

    // Flush bar
    const dot = document.getElementById('flushDot');
    const info = document.getElementById('flushInfo');
    if (stats.lastSync) {
      const ago = timeAgo(stats.lastSync.timestamp);
      if (stats.lastSync.status === 'ok') {
        dot.className = 'flush-dot ok';
        info.innerHTML = `Last sync: <strong>${ago}</strong> • ${stats.lastSync.conversationsFlushed || 0} convs, ${stats.lastSync.turnsFlushed || 0} turns`;
      } else {
        dot.className = 'flush-dot error';
        info.innerHTML = `Sync failed ${ago}: <strong>${stats.lastSync.error || 'unknown'}</strong>`;
      }
    } else if (db.unsynced > 0) {
      dot.className = 'flush-dot pending';
      info.innerHTML = `<strong>${db.unsynced}</strong> conversations pending sync`;
    } else {
      dot.className = 'flush-dot ok';
      info.textContent = 'All synced';
    }
  } catch (e) {
    console.error('Stats load failed:', e);
  }
}

async function loadConversations() {
  try {
    const data = await sendMessage({ action: 'get-conversations', data: { limit: 30 } });
    const container = document.getElementById('convList');

    if (!data?.conversations?.length) {
      container.innerHTML = '<div class="empty">No conversations yet. Open an AI chat to start.</div>';
      return;
    }

    container.innerHTML = data.conversations.map(conv => {
      const platformClass = conv.platform || '';
      const syncClass = conv.synced ? 'synced' : 'unsynced';
      const syncBadge = conv.synced
        ? '<span class="sync-badge synced">✓ synced</span>'
        : '<span class="sync-badge pending">○ pending</span>';
      const title = escapeHtml(conv.title || '(untitled)');
      const ago = timeAgo(conv.updatedAt);

      const tabBadge = conv.tabId ? `<span class="conv-tab-badge">tab ${conv.tabId}</span>` : '';
      const truncated = title.length > 60;
      return `
        <div class="conv ${syncClass}" onclick="this.classList.toggle('expanded')">
          <div class="conv-header">
            <span class="conv-platform ${platformClass}">${conv.platform}</span>
            <span>${tabBadge}${syncBadge}</span>
          </div>
          <div class="conv-title">${title}</div>
          <div class="conv-stats">
            <span>💬 ${conv.turnCount} turns</span>
            <span>📝 ~${formatTokens(conv.tokenEstimate)} tokens</span>
            <span>🕒 ${ago}</span>
          </div>
          ${truncated ? '<div class="expand-hint">click to expand</div>' : ''}
        </div>
      `;
    }).join('');
  } catch (e) {
    console.error('Conversations load failed:', e);
  }
}

async function loadCaptures() {
  try {
    const data = await chrome.storage.session.get(STORAGE_KEYS.CAPTURED_TURNS);
    const turns = (data[STORAGE_KEYS.CAPTURED_TURNS] || []).slice(-30).reverse();
    const container = document.getElementById('turnList');

    if (!turns.length) {
      container.innerHTML = '<div class="empty">No captures yet. Open an AI chat to start.</div>';
      return;
    }

    container.innerHTML = turns.map(turn => {
      const roleClass = turn.role || 'assistant';
      const flushedClass = turn.flushed ? 'flushed' : '';
      const badge = turn.flushed ? '<span class="turn-flushed-badge">✓ sent</span>' : '';
      const time = new Date(turn.timestamp).toLocaleTimeString();
      const preview = escapeHtml((turn.content || '').substring(0, 200));

      const fullContent = escapeHtml(turn.content || '');
      const isLong = (turn.content || '').length > 200;
      return `
        <div class="turn ${roleClass} ${flushedClass}" onclick="this.classList.toggle('expanded')">
          <div class="turn-header">
            <span class="turn-platform">${turn.platform || '?'}${badge}</span>
            <span class="turn-time">${time}</span>
          </div>
          <div class="turn-role">${turn.role || 'assistant'} • ${turn.captureType || ''} • ${(turn.content || '').length} chars</div>
          <div class="turn-content">${preview}</div>
          <div class="turn-full"><div class="turn-full-content">${fullContent}</div></div>
          ${isLong ? '<div class="expand-hint">click to expand</div>' : ''}
        </div>
      `;
    }).join('');
  } catch (e) {
    console.error('Captures load failed:', e);
  }
}

async function loadStatus() {
  try {
    // Interceptors
    const statusData = await chrome.storage.session.get(STORAGE_KEYS.INTERCEPTOR_STATUS);
    const status = statusData[STORAGE_KEYS.INTERCEPTOR_STATUS] || {};
    const container = document.getElementById('interceptors');
    const entries = Object.entries(status);

    if (entries.length) {
      container.innerHTML = entries.map(([tabId, s]) => {
        const ago = timeAgo(s.timestamp);
        return `
          <div class="interceptor-row">
            <span class="dot"></span>
            <span>${s.platform} (tab ${tabId}) • ${ago}</span>
          </div>
        `;
      }).join('');
    } else {
      container.innerHTML = '<div style="padding:4px 0;font-size:12px;color:#666">No active interceptors</div>';
    }

    // Platform breakdown
    const stats = await sendMessage({ action: 'get-stats' });
    const platforms = stats?.db?.platforms || {};
    const breakdown = document.getElementById('platformBreakdown');
    if (Object.keys(platforms).length) {
      breakdown.innerHTML = Object.entries(platforms)
        .map(([p, count]) => `<div style="padding:2px 0;"><strong>${p}:</strong> ${count} conversations</div>`)
        .join('');
    } else {
      breakdown.textContent = 'No conversations yet';
    }

    // Last sync
    const lastSyncEl = document.getElementById('lastSync');
    if (stats?.lastSync) {
      const ago = timeAgo(stats.lastSync.timestamp);
      lastSyncEl.innerHTML = `${ago} • Status: ${stats.lastSync.status}`;
    } else {
      lastSyncEl.textContent = 'Never synced';
    }

    // Backend
    document.getElementById('backendInfo').textContent = stats?.backendUrl || 'Unknown';

  } catch (e) {
    console.error('Status load failed:', e);
  }
}

// ==================== ACTIONS ====================

document.getElementById('flushBtn').addEventListener('click', async () => {
  const btn = document.getElementById('flushBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing...';

  try {
    const result = await sendMessage({ action: 'manual-flush' });
    const info = document.getElementById('flushInfo');
    const dot = document.getElementById('flushDot');

    if (result?.status === 'flushed') {
      dot.className = 'flush-dot ok';
      info.innerHTML = `Synced <strong>${result.conversations}</strong> conversations, <strong>${result.turns}</strong> turns`;
    } else if (result?.status === 'no_conversations') {
      dot.className = 'flush-dot ok';
      info.textContent = 'All synced — nothing to send';
    } else if (result?.error) {
      dot.className = 'flush-dot error';
      info.innerHTML = `Error: <strong>${result.error}</strong>`;
    }

    await loadAll();
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Sync';
  }
});

document.getElementById('exportBtn').addEventListener('click', async () => {
  try {
    const data = await sendMessage({ action: 'export-data' });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `memory-ext-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error('Export failed:', e);
  }
});

// ==================== UTILITIES ====================

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response);
    });
  });
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==================== INIT ====================

loadAll();

// Auto-refresh every 3 seconds
setInterval(loadAll, 3000);

// ==================== FACTS ====================

async function loadFacts() {
  try {
    const facts = await sendMessage({ action: 'get-facts' });
    const container = document.getElementById('factList');
    const statsEl = document.getElementById('factStats');
    
    if (!facts?.length) {
      container.innerHTML = '<div class="empty">No facts extracted yet. Add API key in Status tab, then click Extract.</div>';
      statsEl.textContent = '0 facts';
      return;
    }

    statsEl.textContent = `${facts.length} facts`;

    container.innerHTML = facts.slice(0, 50).map(fact => {
      const ago = timeAgo(fact.timestamp);
      const catColor = {
        personal: '#a78bfa', preference: '#4ade80', decision: '#facc15',
        project: '#60a5fa', technical: '#f472b6', work: '#fb923c',
        location: '#34d399', relationship: '#c084fc', goal: '#f87171',
      }[fact.category] || '#888';

      return `
        <div class="conv fact-card" style="border-left-color: ${catColor};" onclick="this.classList.toggle('expanded')">
          <div class="conv-header">
            <span class="conv-platform" style="background: ${catColor}22; color: ${catColor};">${fact.category || 'general'}</span>
            <span style="font-size: 10px; color: #666;">${fact.confidence || 'medium'}</span>
          </div>
          <div class="conv-title fact-content">${escapeHtml(fact.content)}</div>
          <div class="conv-stats">
            <span>📅 ${ago}</span>
            <span>🔗 ${fact.source?.platform || '?'}</span>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    console.error('Facts load failed:', e);
  }
}

document.getElementById('extractBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('extractBtn');
  btn.disabled = true;
  btn.textContent = '🔄 Extracting...';

  try {
    const result = await sendMessage({ action: 'extract-facts' });
    if (result?.error) {
      btn.textContent = '❌ ' + result.error.substring(0, 30);
    } else {
      btn.textContent = `✅ ${result.totalNewFacts || 0} new facts`;
      await loadFacts();
      await loadStats();
    }
  } catch (e) {
    btn.textContent = '❌ Failed';
  }

  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '🔍 Extract Now';
  }, 3000);
});

// ==================== API CONFIG ====================

document.getElementById('saveApiBtn')?.addEventListener('click', async () => {
  const provider = document.getElementById('apiProvider').value;
  const apiKey = document.getElementById('apiKeyInput').value.trim();
  const statusEl = document.getElementById('apiStatus');

  if (!apiKey) {
    statusEl.textContent = '❌ Enter an API key';
    statusEl.style.color = '#f87171';
    return;
  }

  const result = await sendMessage({
    action: 'configure-api',
    data: { apiKey, apiProvider: provider }
  });

  if (result?.configured) {
    statusEl.textContent = '✅ Saved';
    statusEl.style.color = '#4ade80';
    document.getElementById('apiKeyInput').value = '';
    document.getElementById('apiKeyInput').placeholder = '••••••••' + apiKey.slice(-4);
  } else {
    statusEl.textContent = '❌ ' + (result?.error || 'Failed');
    statusEl.style.color = '#f87171';
  }
});

async function loadApiConfig() {
  try {
    const stats = await sendMessage({ action: 'get-stats' });
    if (stats?.extractor?.configured) {
      document.getElementById('apiStatus').textContent = '✅ Configured (' + stats.extractor.provider + ')';      
      document.getElementById('apiStatus').style.color = '#4ade80';
      if (stats.extractor.provider) {
        document.getElementById('apiProvider').value = stats.extractor.provider;
      }
    }
  } catch {}
}

// Add to load cycle
const origLoadAll = loadAll;
loadAll = async function() {
  await origLoadAll();
  await loadFacts();
  await loadApiConfig();
};

// Re-run init
loadFacts();
loadApiConfig();

// ==================== INJECTOR ====================

document.getElementById('injectorToggle')?.addEventListener('change', async (e) => {
  const result = await sendMessage({ action: 'set-injector', data: { enabled: e.target.checked } });
  const statsEl = document.getElementById('injectorStats');
  statsEl.textContent = result?.enabled ? 'Auto-inject: ON' : 'Auto-inject: OFF';
});

async function loadInjectorConfig() {
  try {
    const stats = await sendMessage({ action: 'get-stats' });
    const inj = stats?.injector;
    if (inj) {
      const toggle = document.getElementById('injectorToggle');
      if (toggle) toggle.checked = inj.enabled;
      const statsEl = document.getElementById('injectorStats');
      if (statsEl) {
        const parts = [`${inj.injectionCount || 0} injections`];
        if (inj.lastInjection) parts.push(`last: ${timeAgo(inj.lastInjection.timestamp)}`);
        statsEl.textContent = parts.join(' • ');
      }
    }
  } catch {}
}

// Extend loadAll
const _origLoadAll2 = loadAll;
loadAll = async function() {
  await _origLoadAll2();
  await loadInjectorConfig();
};
loadInjectorConfig();

// ==================== CONTEXT INJECT TOGGLE ====================

document.getElementById('contextInjectToggle')?.addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  // Relay toggle to page world via content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      action: 'context-inject-toggle',
      enabled,
    }).catch(() => {});
  }
  const statsEl = document.getElementById('contextInjectStats');
  if (statsEl) statsEl.textContent = enabled ? 'Context inject: ON' : 'Context inject: OFF';
  // Persist
  chrome.storage.session.set({ contextInjectEnabled: enabled }).catch(() => {});
});

function updateInjectHud(stats) {
  const hudEl   = document.getElementById('contextInjectHud');
  if (!hudEl) return;

  const countEl = document.getElementById('injectTotalCount');
  const queryEl = document.getElementById('hudLastQuery');

  const shardLayer  = document.getElementById('hudShardLayer');
  const shardDot    = document.getElementById('hudShardDot');
  const shardChars  = document.getElementById('hudShardChars');

  const ragLayer = document.getElementById('hudRagLayer');
  const ragDot   = document.getElementById('hudRagDot');
  const ragChars = document.getElementById('hudRagChars');

  if (!stats || !stats.lastAt) {
    if (countEl) countEl.textContent = '';
    if (queryEl) queryEl.innerHTML = '<span class="inject-never">No injections yet this session</span>';
    return;
  }

  const layers = stats.layers || [];
  const hasShard = layers.includes('shard');
  const hasRag   = layers.includes('rag');

  // Count
  if (countEl) countEl.textContent = `${stats.injections || 0} injections`;

  // Shard layer
  if (shardLayer) shardLayer.className = 'inject-layer ' + (hasShard ? 'active' : 'inactive');
  if (shardDot)   shardDot.className = hasShard ? 'dot-green' : 'dot-grey';
  if (shardChars) shardChars.textContent = hasShard ? `${(stats.shardChars || 0).toLocaleString()} ch` : '—';

  // RAG layer
  if (ragLayer) ragLayer.className = 'inject-layer ' + (hasRag ? 'active' : 'inactive');
  if (ragDot)   ragDot.className = hasRag ? 'dot-green' : 'dot-grey';
  if (ragChars) ragChars.textContent = hasRag ? `${(stats.ragChars || 0).toLocaleString()} ch` : '—';

  // Last query
  if (queryEl) {
    const ago = stats.lastAt ? Math.round((Date.now() - stats.lastAt) / 1000) : null;
    const agoStr = ago !== null ? (ago < 60 ? `${ago}s ago` : `${Math.round(ago/60)}m ago`) : '';
    const q = stats.lastQuery ? stats.lastQuery.slice(0, 55) + (stats.lastQuery.length > 55 ? '…' : '') : '';
    queryEl.innerHTML = q
      ? `<strong>Last:</strong> ${q} <span style="color:#555">${agoStr}</span>`
      : `<span style="color:#555">Injected ${agoStr}</span>`;
  }
}

async function loadContextInjectConfig() {
  try {
    const result = await chrome.storage.session.get('contextInjectEnabled');
    const enabled = result.contextInjectEnabled !== false; // default ON
    const toggle = document.getElementById('contextInjectToggle');
    if (toggle) toggle.checked = enabled;
    // Load live inject stats from SW
    try {
      const stats = await sendMessage({ action: 'get-context-inject-stats' });
      updateInjectHud(stats);
    } catch {}
  } catch {}
}

const _origLoadAll3 = loadAll;
loadAll = async function() {
  await _origLoadAll3();
  await loadContextInjectConfig();
};
loadContextInjectConfig();


// ==================== INJECT HUD LIVE POLL ====================
// Refresh inject stats while popup is open so the HUD stays live.
(function startInjectHudPoller() {
  async function poll() {
    try {
      const stats = await sendMessage({ action: 'get-context-inject-stats' });
      updateInjectHud(stats);
    } catch {}
  }
  // Initial load happens via loadContextInjectConfig() on startup.
  // Poll every 5s after that.
  setInterval(poll, 5000);
})();
