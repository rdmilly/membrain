/**
 * MemBrain — Token Counter & Compression HUD v0.5.9
 *
 * Two tabs:
 *   [Tokens]      — input/output counts, compression comparison, cost estimate
 *   [Captures]    — pipeline health, recent conversations, sync status
 *   [Intelligence] — live injection stream, § symbol growth, CI visualizer
 *
 * v0.5.9: Added Intelligence tab with live injection stream + § symbol growth
 */

(function () {
  'use strict';

  const PREFIX = 'memory-ext';
  const HUD_ID = 'membrain-hud';
  const STORAGE_KEY = 'membrainState';

  let state = {
    conversation: { input: 0, output: 0, turns: 0 },
    session: { input: 0, output: 0, turns: 0, conversations: 1 },
    lastConversationId: null,
    minimized: false,
    capturing: false,
    compressionEnabled: false,
    compressionSaved: 0,
    conversationRawInput: 0,
    sessionRawInput: 0,
    activeTab: 'tokens',
  };

  // Intelligence tab live data (not persisted)
  let intel = {
    stream: [],        // [{turn, type, chars, query, layers, symbols, ts}]
    symbols: [],       // growing § symbol list
    totalInjected: 0,  // chars
    totalSaved: 0,     // tokens
    lifetimeSaved: 604,// from storage
  };

  let liveData = {
    conversations: [],
    interceptors: {},
    stats: null,
    lastFetch: 0,
  };

  async function loadState() {
    try {
      const r = await chrome.storage.session.get(STORAGE_KEY);
      if (r[STORAGE_KEY]) state = { ...state, ...r[STORAGE_KEY] };
    } catch {}
  }
  async function saveState() {
    try { await chrome.storage.session.set({ [STORAGE_KEY]: state }); } catch {}
  }

  async function fetchLiveData() {
    const now = Date.now();
    if (now - liveData.lastFetch < 4000) return;
    liveData.lastFetch = now;
    try {
      const [statsRes, convsRes, interceptorData] = await Promise.all([
        sendToSW({ action: 'get-stats' }),
        sendToSW({ action: 'get-conversations', data: { limit: 10 } }),
        chrome.storage.session.get('interceptor_status'),
      ]);
      liveData.stats = statsRes;
      liveData.conversations = convsRes?.conversations || [];
      liveData.interceptors = interceptorData?.interceptor_status || {};
    } catch {}
  }

  function sendToSW(msg) {
    return new Promise(resolve => {
      try { chrome.runtime.sendMessage(msg, r => resolve(r)); }
      catch { resolve(null); }
    });
  }

  function fmt(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toLocaleString();
  }
  function cost(inp, out) {
    const c = (inp * 3 + out * 15) / 1000000;
    return c < 0.001 ? '<$0.01' : '$' + c.toFixed(3);
  }
  function pct(saved, raw) {
    if (!raw || !saved) return null;
    return Math.round((saved / raw) * 100);
  }
  function timeAgo(ts) {
    if (!ts) return '—';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function injectStyles() {
    if (!document.head || document.getElementById(`${HUD_ID}-css`)) return;
    const s = document.createElement('style');
    s.id = `${HUD_ID}-css`;
    s.textContent = `
      #${HUD_ID} {
        position: fixed; bottom: 16px; right: 16px; z-index: 2147483646;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        user-select: none; pointer-events: auto;
      }
      .mb-card {
        background: rgba(13, 13, 25, 0.96); border: 1px solid rgba(100, 116, 139, 0.22);
        border-radius: 14px; min-width: 270px; max-width: 300px;
        backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
        box-shadow: 0 6px 32px rgba(0,0,0,0.5); transition: border-color 0.3s;
        overflow: hidden;
      }
      .mb-card.active { border-color: rgba(52, 211, 153, 0.3); }
      .mb-card:hover { border-color: rgba(139, 92, 246, 0.25); }
      .mb-head { display: flex; align-items: center; justify-content: space-between; padding: 11px 14px 9px; border-bottom: 1px solid rgba(100, 116, 139, 0.1); }
      .mb-brand { display: flex; align-items: center; gap: 7px; }
      .mb-logo { width: 20px; height: 20px; border-radius: 5px; background: linear-gradient(135deg, #8b5cf6, #06b6d4); display: flex; align-items: center; justify-content: center; font-size: 11px; color: white; font-weight: 800; flex-shrink: 0; }
      .mb-name { font-size: 12px; font-weight: 700; letter-spacing: 0.7px; background: linear-gradient(135deg, #a78bfa, #67e8f9); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
      .mb-dot { width: 8px; height: 8px; border-radius: 50%; transition: all 0.3s; flex-shrink: 0; }
      .mb-dot.on  { background: #34d399; box-shadow: 0 0 9px rgba(52,211,153,0.65); }
      .mb-dot.off { background: #475569; }
      .mb-btns { display: flex; gap: 2px; }
      .mb-btn { background: none; border: none; color: #475569; cursor: pointer; font-size: 14px; padding: 2px 5px; border-radius: 4px; line-height: 1; }
      .mb-btn:hover { color: #a78bfa; background: rgba(167,139,250,0.1); }
      .mb-tabs { display: flex; border-bottom: 1px solid rgba(100,116,139,0.1); }
      .mb-tab { flex: 1; padding: 6px 0; text-align: center; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; color: #475569; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.2s; }
      .mb-tab.active { color: #a78bfa; border-bottom-color: #a78bfa; }
      .mb-tab:hover:not(.active) { color: #94a3b8; }
      .mb-tab-badge { display: inline-block; background: rgba(139,92,246,0.2); color: #a78bfa; font-size: 9px; padding: 0px 4px; border-radius: 8px; margin-left: 3px; font-weight: 700; }
      .mb-tab-badge.green { background: rgba(52,211,153,0.15); color: #34d399; }
      .mb-tab-badge.yellow { background: rgba(250,204,21,0.15); color: #facc15; }
      .mb-panel { padding: 11px 14px 12px; }
      .mb-row { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; font-size: 13px; }
      .mb-lbl { color: #64748b; font-size: 11px; font-weight: 500; }
      .mb-val { font-weight: 600; font-variant-numeric: tabular-nums; }
      .mb-val.inp { color: #60a5fa; }
      .mb-val.out { color: #a78bfa; }
      .mb-val.tot { color: #f1f5f9; font-size: 15px; }
      .mb-cost { color: #64748b; font-size: 10px; margin-top: 1px; text-align: right; }
      .mb-div { border: none; border-top: 1px solid rgba(100,116,139,0.1); margin: 6px 0; }
      .mb-comp-panel { margin-top: 8px; padding: 8px 10px; background: rgba(52,211,153,0.05); border: 1px solid rgba(52,211,153,0.15); border-radius: 8px; }
      .mb-comp-title { font-size: 10px; font-weight: 700; color: #34d399; letter-spacing: 0.5px; margin-bottom: 7px; display: flex; align-items: center; gap: 5px; }
      .mb-comp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .mb-comp-box { background: rgba(15,15,28,0.6); border-radius: 6px; padding: 5px 8px; text-align: center; }
      .mb-comp-box-lbl { font-size: 9px; color: #64748b; font-weight: 600; letter-spacing: 0.4px; margin-bottom: 2px; }
      .mb-comp-box-val { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .mb-comp-box-val.raw { color: #fb923c; }
      .mb-comp-box-val.compressed { color: #34d399; }
      .mb-comp-savings { margin-top: 6px; display: flex; justify-content: space-between; align-items: center; }
      .mb-comp-saved-lbl { font-size: 10px; color: #64748b; }
      .mb-comp-saved-val { font-size: 11px; font-weight: 700; color: #34d399; }
      .mb-comp-inactive { font-size: 10px; color: #475569; text-align: center; padding: 4px 0; font-style: italic; }
      .mb-comp-pct { display: inline-block; background: rgba(52,211,153,0.15); color: #34d399; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 10px; margin-left: 4px; }
      .mb-toggle-row { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; padding-top: 7px; border-top: 1px solid rgba(100,116,139,0.08); }
      .mb-toggle-lbl { font-size: 12px; font-weight: 600; color: #64748b; }
      .mb-toggle { position: relative; display: inline-block; width: 36px; height: 20px; cursor: pointer; }
      .mb-toggle input { opacity: 0; width: 0; height: 0; }
      .mb-slider { position: absolute; inset: 0; background: #1e293b; border-radius: 10px; border: 1px solid #334155; transition: all 0.25s; }
      .mb-slider:before { content: ''; position: absolute; height: 13px; width: 13px; left: 3px; bottom: 3px; background: #475569; border-radius: 50%; transition: all 0.25s; }
      .mb-toggle input:checked + .mb-slider { background: rgba(52,211,153,0.2); border-color: rgba(52,211,153,0.4); }
      .mb-toggle input:checked + .mb-slider:before { transform: translateX(16px); background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.5); }
      .mb-foot { display: flex; justify-content: space-between; font-size: 10px; color: #475569; margin-top: 8px; padding-top: 7px; border-top: 1px solid rgba(100,116,139,0.08); }
      .mb-pipe { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-radius: 8px; margin-bottom: 9px; font-size: 11px; font-weight: 600; }
      .mb-pipe.ok   { background: rgba(52,211,153,0.08); border: 1px solid rgba(52,211,153,0.18); color: #34d399; }
      .mb-pipe.warn { background: rgba(250,204,21,0.08); border: 1px solid rgba(250,204,21,0.2); color: #facc15; }
      .mb-pipe.err  { background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.2); color: #f87171; }
      .mb-pipe-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .mb-pipe.ok   .mb-pipe-dot { background: #34d399; box-shadow: 0 0 8px rgba(52,211,153,0.6); }
      .mb-pipe.warn .mb-pipe-dot { background: #facc15; }
      .mb-pipe.err  .mb-pipe-dot { background: #f87171; }
      .mb-pipe-right { margin-left: auto; font-size: 10px; opacity: 0.7; }
      .mb-cap-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-bottom: 9px; }
      .mb-cap-stat { background: rgba(255,255,255,0.03); border-radius: 6px; padding: 5px 7px; text-align: center; border: 1px solid rgba(100,116,139,0.1); }
      .mb-cap-stat-val { font-size: 14px; font-weight: 700; color: #e2e8f0; }
      .mb-cap-stat-lbl { font-size: 9px; color: #64748b; margin-top: 1px; font-weight: 500; }
      .mb-conv-hdr { font-size: 10px; font-weight: 700; color: #475569; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 5px; display: flex; justify-content: space-between; align-items: center; }
      .mb-conv-hdr-right { font-size: 9px; font-weight: 400; color: #334155; }
      .mb-conv-list { display: flex; flex-direction: column; gap: 4px; max-height: 185px; overflow-y: auto; }
      .mb-conv-list::-webkit-scrollbar { width: 3px; }
      .mb-conv-list::-webkit-scrollbar-track { background: transparent; }
      .mb-conv-list::-webkit-scrollbar-thumb { background: rgba(100,116,139,0.3); border-radius: 2px; }
      .mb-conv-item { padding: 6px 9px; border-radius: 7px; font-size: 11px; background: rgba(255,255,255,0.03); border-left: 3px solid #334155; transition: background 0.15s; }
      .mb-conv-item.synced  { border-left-color: #34d399; }
      .mb-conv-item.pending { border-left-color: #facc15; }
      .mb-conv-item.active  { border-left-color: #a78bfa; background: rgba(139,92,246,0.05); }
      .mb-conv-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; }
      .mb-conv-plat { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; padding: 1px 5px; border-radius: 3px; }
      .mb-conv-plat.claude  { background: rgba(167,139,250,0.2); color: #c4a8ff; }
      .mb-conv-plat.chatgpt { background: rgba(74,222,128,0.15); color: #86efac; }
      .mb-conv-plat.gemini  { background: rgba(96,165,250,0.15); color: #93c5fd; }
      .mb-conv-plat.other   { background: rgba(100,116,139,0.2); color: #94a3b8; }
      .mb-conv-badge { font-size: 9px; font-weight: 600; padding: 1px 5px; border-radius: 10px; }
      .mb-conv-badge.synced  { background: rgba(52,211,153,0.12); color: #34d399; }
      .mb-conv-badge.pending { background: rgba(250,204,21,0.12); color: #facc15; }
      .mb-conv-badge.active  { background: rgba(139,92,246,0.15); color: #a78bfa; }
      .mb-conv-title { color: #cbd5e1; font-size: 11px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 3px; }
      .mb-conv-meta { display: flex; gap: 8px; font-size: 9px; color: #475569; }
      .mb-empty { padding: 20px 0; text-align: center; color: #475569; font-size: 11px; font-style: italic; }
      .mb-sync-row { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; padding-top: 7px; border-top: 1px solid rgba(100,116,139,0.08); font-size: 10px; color: #475569; }
      .mb-sync-btn { background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.2); color: #34d399; font-size: 10px; font-weight: 600; padding: 3px 9px; border-radius: 5px; cursor: pointer; }
      .mb-sync-btn:hover { background: rgba(52,211,153,0.18); }
      .mb-mini { background: rgba(13,13,25,0.94); border: 1px solid rgba(100,116,139,0.2); border-radius: 10px; padding: 6px 13px; cursor: pointer; display: flex; align-items: center; gap: 7px; backdrop-filter: blur(12px); box-shadow: 0 2px 14px rgba(0,0,0,0.4); font-size: 13px; color: #94a3b8; transition: all 0.2s; }
      .mb-mini:hover { border-color: rgba(139,92,246,0.3); color: #e2e8f0; }
      .mb-mini.active { border-color: rgba(52,211,153,0.3); }
      .mb-mini-pct { font-size: 10px; font-weight: 700; color: #34d399; background: rgba(52,211,153,0.12); padding: 1px 5px; border-radius: 8px; }
      .mb-mini-cap { font-size: 10px; color: #a78bfa; background: rgba(139,92,246,0.1); padding: 1px 5px; border-radius: 8px; }
      /* Intelligence tab */
      .mb-intel-stream { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; padding-bottom: 4px; }
      .mb-intel-stream::-webkit-scrollbar { width: 3px; }
      .mb-intel-stream::-webkit-scrollbar-thumb { background: rgba(100,116,139,0.3); border-radius: 2px; }
      .mb-intel-event { padding: 7px 9px; border-radius: 7px; font-size: 11px; border-left: 3px solid #334155; background: rgba(255,255,255,0.02); animation: mb-fadein 0.4s ease; }
      .mb-intel-event.inject { border-left-color: #a78bfa; background: rgba(139,92,246,0.06); }
      .mb-intel-event.compress { border-left-color: #34d399; background: rgba(52,211,153,0.05); }
      .mb-intel-event-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; }
      .mb-intel-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.4px; }
      .mb-intel-badge.inject { background: rgba(139,92,246,0.2); color: #c4a8ff; }
      .mb-intel-badge.compress { background: rgba(52,211,153,0.15); color: #34d399; }
      .mb-intel-time { font-size: 9px; color: #475569; }
      .mb-intel-detail { color: #94a3b8; font-size: 10px; line-height: 1.4; }
      .mb-intel-detail .hi { color: #e2e8f0; font-weight: 600; }
      .mb-intel-detail .sym { color: #facc15; font-family: monospace; }
      .mb-intel-layers { display: flex; gap: 4px; margin-top: 3px; }
      .mb-intel-layer { font-size: 9px; padding: 1px 5px; border-radius: 3px; font-weight: 600; }
      .mb-intel-layer.shard { background: rgba(96,165,250,0.15); color: #60a5fa; }
      .mb-intel-layer.rag   { background: rgba(240,160,112,0.15); color: #f0a070; }
      .mb-intel-layer.ci    { background: rgba(167,139,250,0.15); color: #a78bfa; }
      .mb-intel-layer.local { background: rgba(74,222,128,0.15); color: #4ade80; }
      .mb-sym-row { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; padding: 7px 9px; background: rgba(250,204,21,0.04); border: 1px solid rgba(250,204,21,0.12); border-radius: 7px; min-height: 32px; align-items: center; }
      .mb-sym { font-family: monospace; font-size: 12px; color: #facc15; background: rgba(250,204,21,0.1); padding: 1px 5px; border-radius: 4px; animation: mb-popin 0.3s cubic-bezier(0.34,1.56,0.64,1); }
      .mb-sym.new { color: #fde68a; box-shadow: 0 0 6px rgba(250,204,21,0.4); }
      .mb-sym-empty { font-size: 10px; color: #475569; font-style: italic; }
      .mb-intel-stats { display: grid; grid-template-columns: repeat(3,1fr); gap: 5px; margin-bottom: 8px; }
      .mb-intel-stat { background: rgba(255,255,255,0.03); border-radius: 6px; padding: 5px 7px; text-align: center; border: 1px solid rgba(100,116,139,0.1); }
      .mb-intel-stat-val { font-size: 14px; font-weight: 700; }
      .mb-intel-stat-val.purple { color: #a78bfa; }
      .mb-intel-stat-val.green  { color: #34d399; }
      .mb-intel-stat-val.yellow { color: #facc15; }
      .mb-intel-stat-lbl { font-size: 9px; color: #64748b; margin-top: 1px; }
      .mb-intel-hdr { font-size: 10px; font-weight: 700; color: #475569; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 5px; display: flex; justify-content: space-between; }
      .mb-bar-wrap { height: 4px; background: rgba(100,116,139,0.15); border-radius: 2px; overflow: hidden; margin-top: 4px; }
      .mb-bar-fill { height: 100%; border-radius: 2px; transition: width 0.6s ease; background: linear-gradient(90deg, #6b21a8, #a78bfa); }
      @keyframes mb-fadein { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes mb-popin  { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: scale(1); } }
    `;
    document.head.appendChild(s);
  }

  function renderCompressionPanel() {
    const c = state.conversation;
    const rawInput = state.conversationRawInput || c.input;
    const saved = state.compressionSaved || 0;
    const savingsPct = pct(saved, rawInput);
    if (!state.compressionEnabled && saved === 0) {
      return `<div class="mb-comp-panel"><div class="mb-comp-title">⚡ COMPRESSION</div><div class="mb-comp-inactive">Toggle on to start measuring savings</div></div>`;
    }
    return `
      <div class="mb-comp-panel">
        <div class="mb-comp-title">⚡ COMPRESSION ${savingsPct ? '<span class="mb-comp-pct">-' + savingsPct + '%</span>' : ''}</div>
        <div class="mb-comp-grid">
          <div class="mb-comp-box"><div class="mb-comp-box-lbl">WITHOUT</div><div class="mb-comp-box-val raw">${fmt(rawInput)}</div></div>
          <div class="mb-comp-box"><div class="mb-comp-box-lbl">WITH</div><div class="mb-comp-box-val compressed">${fmt(c.input)}</div></div>
        </div>
        <div class="mb-comp-savings">
          <span class="mb-comp-saved-lbl">Tokens saved</span>
          <span class="mb-comp-saved-val">${fmt(saved)}${savingsPct ? ' <span class="mb-comp-pct">-' + savingsPct + '%</span>' : ''}</span>
        </div>
      </div>`;
  }


  function timeAgoShort(ts) {
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s/60) + 'm';
    return Math.floor(s/3600) + 'h';
  }

  function renderIntelligencePanel() {
    const stream = intel.stream.slice().reverse(); // newest first
    const symCount = intel.symbols.length;
    const pctSaved = intel.totalSaved > 0 && state.conversationRawInput > 0
      ? Math.round(intel.totalSaved / state.conversationRawInput * 100) : 0;

    // Stats bar
    const statsHTML = `
      <div class="mb-intel-stats">
        <div class="mb-intel-stat">
          <div class="mb-intel-stat-val purple">${intel.stream.filter(e=>e.type==='inject').length}</div>
          <div class="mb-intel-stat-lbl">Injections</div>
        </div>
        <div class="mb-intel-stat">
          <div class="mb-intel-stat-val yellow">${symCount}</div>
          <div class="mb-intel-stat-lbl">§ Symbols</div>
        </div>
        <div class="mb-intel-stat">
          <div class="mb-intel-stat-val green">${pctSaved > 0 ? pctSaved + '%' : fmt(intel.totalSaved)}</div>
          <div class="mb-intel-stat-lbl">Saved</div>
        </div>
      </div>`;

    // Symbol dictionary row
    const symsHTML = intel.symbols.length === 0
      ? `<div class="mb-sym-row"><span class="mb-sym-empty">Symbols appear here as patterns are recognized…</span></div>`
      : `<div class="mb-sym-row">${intel.symbols.map((s,i) => `<span class="mb-sym${i >= intel.symbols.length - 3 ? ' new' : ''}" title="${esc(s.phrase||'')}">${esc(s.symbol)}</span>`).join('')}</div>`;

    // Stream events
    let streamHTML = '<div class="mb-intel-stream">' ;
    if (stream.length === 0) {
      streamHTML += '<div class="mb-empty">Send a message on Claude to see live injection events…</div>';
    } else {
      streamHTML += stream.slice(0, 12).map(ev => {
        if (ev.type === 'inject') {
          const layersHTML = (ev.layers || []).map(l => `<span class="mb-intel-layer ${l}">${l.toUpperCase()}</span>`).join('');
          const ciHTML = ev.ciChars > 0 ? `<span class="mb-intel-layer ci">CI +${fmt(ev.ciChars)}c</span>` : '';
          return `
            <div class="mb-intel-event inject">
              <div class="mb-intel-event-head">
                <span class="mb-intel-badge inject">⚡ Inject</span>
                <span class="mb-intel-time">${timeAgoShort(ev.ts)}</span>
              </div>
              <div class="mb-intel-detail">
                <span class="hi">${fmt(ev.chars)}c</span> injected${ev.factsCount ? ' <span style="color:#4ade80">· ' + ev.factsCount + ' facts</span>' : ''}
                ${ev.method ? ' <span style="color:#64748b">[' + ev.method + ']</span>' : ''}
                ${ev.query ? ' · <span style="color:#64748b">' + esc(ev.query.slice(0,40)) + '</span>' : ''}
              </div>
              <div class="mb-intel-layers">${layersHTML}${ciHTML}</div>
              <div class="mb-bar-wrap"><div class="mb-bar-fill" style="width:${Math.min(100, Math.round(ev.chars/50))}%"></div></div>
            </div>`;
        } else {
          return `
            <div class="mb-intel-event compress">
              <div class="mb-intel-event-head">
                <span class="mb-intel-badge compress">§ Compress</span>
                <span class="mb-intel-time">${timeAgoShort(ev.ts)}</span>
              </div>
              <div class="mb-intel-detail">
                <span class="hi">${fmt(ev.saved)}</span> tokens saved
                ${ev.syms ? ' · <span class="sym">' + esc(ev.syms) + '</span>' : ''}
              </div>
            </div>`;
        }
      }).join('');
    }
    streamHTML += '</div>';

    return `
      <div class="mb-panel">
        ${statsHTML}
        <div class="mb-intel-hdr"><span>§ Symbol Dictionary</span><span style="font-size:9px;color:#334155">grows with patterns</span></div>
        ${symsHTML}
        <div class="mb-intel-hdr" style="margin-top:8px"><span>Live Stream</span><span style="font-size:9px;color:#334155">newest first</span></div>
        ${streamHTML}
      </div>`;
  }

  function renderTokensPanel() {
    const c = state.conversation;
    const total = c.input + c.output;
    const sTotal = state.session.input + state.session.output;
    return `
      <div class="mb-panel">
        <div class="mb-row"><span class="mb-lbl">INPUT</span><span class="mb-val inp">${fmt(c.input)}</span></div>
        <div class="mb-row"><span class="mb-lbl">OUTPUT</span><span class="mb-val out">${fmt(c.output)}</span></div>
        <hr class="mb-div">
        <div class="mb-row"><span class="mb-lbl">TOTAL</span><span class="mb-val tot">${fmt(total)}</span></div>
        <div class="mb-cost">${cost(c.input, c.output)} est.</div>
        ${renderCompressionPanel()}
        <div class="mb-toggle-row">
          <span class="mb-toggle-lbl">⚡ Compress</span>
          <label class="mb-toggle"><input type="checkbox" id="mb-comp-toggle" ${state.compressionEnabled ? 'checked' : ''}><span class="mb-slider"></span></label>
        </div>
        <div class="mb-foot"><span>Turn ${c.turns}</span><span>Session ${fmt(sTotal)}</span></div>
      </div>`;
  }

  function renderCapturesPanel() {
    const db = liveData.stats?.db || {};
    const convos = liveData.conversations;
    const interceptors = liveData.interceptors;
    const interceptorCount = Object.keys(interceptors).length;
    let pipeClass = 'err', pipeMsg = 'No interceptor active', pipeRight = 'Open an AI chat';
    if (interceptorCount > 0) {
      const recent = Object.values(interceptors).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
      pipeClass = 'ok';
      pipeMsg = interceptorCount === 1 ? 'Interceptor active' : `${interceptorCount} interceptors active`;
      pipeRight = timeAgo(recent?.timestamp);
    } else if (state.capturing) {
      pipeClass = 'warn';
      pipeMsg = 'Capturing (no interceptor ping yet)';
      pipeRight = '';
    }
    const unsynced = db.unsynced || 0;
    const totalConvs = db.conversations || 0;
    const totalTurns = db.totalTurns || 0;
    let convHTML = '';
    if (!convos.length && !totalConvs) {
      convHTML = '<div class="mb-empty">No conversations captured yet</div>';
    } else if (!convos.length) {
      convHTML = '<div class="mb-empty">Loading...</div>';
    } else {
      convHTML = convos.map(conv => {
        const platKey = (conv.platform || 'other').toLowerCase();
        const isActive = conv.id === state.lastConversationId;
        const itemClass = isActive ? 'active' : (conv.synced ? 'synced' : 'pending');
        const badgeClass = isActive ? 'active' : (conv.synced ? 'synced' : 'pending');
        const badgeText = isActive ? '● live' : (conv.synced ? '✓ synced' : '○ pending');
        return `
          <div class="mb-conv-item ${itemClass}">
            <div class="mb-conv-top">
              <span class="mb-conv-plat ${platKey}">${conv.platform || '?'}</span>
              <span class="mb-conv-badge ${badgeClass}">${badgeText}</span>
            </div>
            <div class="mb-conv-title">${esc(conv.title || '(untitled)')}</div>
            <div class="mb-conv-meta">
              <span>💬 ${conv.turnCount || 0} turns</span>
              <span>📝 ~${fmt(conv.tokenEstimate || 0)}</span>
              <span>🕒 ${timeAgo(conv.updatedAt)}</span>
            </div>
          </div>`;
      }).join('');
    }
    const lastSync = liveData.stats?.lastSync;
    let syncLine = 'Never synced';
    if (lastSync) {
      syncLine = lastSync.status === 'ok' ? `Synced ${timeAgo(lastSync.timestamp)}` : `Sync failed ${timeAgo(lastSync.timestamp)}`;
    } else if (unsynced === 0 && totalConvs > 0) {
      syncLine = 'All synced';
    }
    return `
      <div class="mb-panel">
        <div class="mb-pipe ${pipeClass}">
          <div class="mb-pipe-dot"></div><span>${pipeMsg}</span>
          ${pipeRight ? '<span class="mb-pipe-right">' + pipeRight + '</span>' : ''}
        </div>
        <div class="mb-cap-stats">
          <div class="mb-cap-stat"><div class="mb-cap-stat-val">${totalConvs || 0}</div><div class="mb-cap-stat-lbl">Convos</div></div>
          <div class="mb-cap-stat"><div class="mb-cap-stat-val">${totalTurns || 0}</div><div class="mb-cap-stat-lbl">Turns</div></div>
          <div class="mb-cap-stat"><div class="mb-cap-stat-val" style="${unsynced > 0 ? 'color:#facc15' : 'color:#34d399'}">${unsynced}</div><div class="mb-cap-stat-lbl">Unsynced</div></div>
        </div>
        <div class="mb-conv-hdr"><span>Recent Captures</span><span class="mb-conv-hdr-right">last 10</span></div>
        <div class="mb-conv-list" id="mb-conv-list">${convHTML}</div>
        <div class="mb-sync-row">
          <span id="mb-sync-status">${syncLine}</span>
          <button class="mb-sync-btn" id="mb-sync-btn">↻ Sync</button>
        </div>
      </div>`;
  }

  function render() {
    if (!document.body) return;
    injectStyles();
    let hud = document.getElementById(HUD_ID);
    if (!hud) { hud = document.createElement('div'); hud.id = HUD_ID; document.body.appendChild(hud); }
    const c = state.conversation;
    const total = c.input + c.output;
    const isOn = state.capturing;
    const savingsPct = pct(state.compressionSaved, state.conversationRawInput || c.input);
    const db = liveData.stats?.db || {};
    const unsynced = db.unsynced || 0;
    if (state.minimized) {
      hud.innerHTML = `
        <div class="mb-mini ${isOn ? 'active' : ''}" id="mb-expand">
          <div class="mb-dot ${isOn ? 'on' : 'off'}"></div>
          <span style="font-weight:600;color:#e2e8f0">${fmt(total)}</span>
          <span style="color:#64748b">tok</span>
          ${savingsPct ? '<span class="mb-mini-pct">-' + savingsPct + '%</span>' : ''}
          ${db.conversations ? '<span class="mb-mini-cap">' + db.conversations + ' caps</span>' : ''}
        </div>`;
      hud.querySelector('#mb-expand')?.addEventListener('click', () => { state.minimized = false; render(); saveState(); });
      return;
    }
    const tokenBadge = total > 0 ? `<span class="mb-tab-badge">${fmt(total)}</span>` : '';
    const captureBadge = db.conversations > 0 ? `<span class="mb-tab-badge ${unsynced > 0 ? 'yellow' : 'green'}">${db.conversations}</span>` : '';
    hud.innerHTML = `
      <div class="mb-card ${isOn ? 'active' : ''}">
        <div class="mb-head">
          <div class="mb-brand"><div class="mb-logo">M</div><span class="mb-name">MEMBRAIN</span><div class="mb-dot ${isOn ? 'on' : 'off'}"></div></div>
          <div class="mb-btns"><button class="mb-btn" id="mb-reset" title="Reset">↻</button><button class="mb-btn" id="mb-min" title="Minimize">−</button></div>
        </div>
        <div class="mb-tabs">
          <div class="mb-tab ${state.activeTab === 'tokens' ? 'active' : ''}" data-tab="tokens">Tokens${tokenBadge}</div>
          <div class="mb-tab ${state.activeTab === 'captures' ? 'active' : ''}" data-tab="captures">Captures${captureBadge}</div>
          <div class="mb-tab ${state.activeTab === 'intelligence' ? 'active' : ''}" data-tab="intelligence">⚡CI${intel.stream.length > 0 ? '<span class="mb-tab-badge green">' + intel.stream.length + '</span>' : ''}</div>
        </div>
        ${state.activeTab === 'tokens' ? renderTokensPanel() : state.activeTab === 'captures' ? renderCapturesPanel() : renderIntelligencePanel()}
      </div>`;
    hud.querySelectorAll('.mb-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        state.activeTab = tab.dataset.tab;
        if (state.activeTab === 'captures') fetchLiveData().then(() => render());
        else if (state.activeTab === 'intelligence') render();
        else render();
        saveState();
      });
    });
    hud.querySelector('#mb-min')?.addEventListener('click', () => { state.minimized = true; render(); saveState(); });
    hud.querySelector('#mb-reset')?.addEventListener('click', () => {
      state.conversation = { input: 0, output: 0, turns: 0 };
      state.compressionSaved = 0; state.conversationRawInput = 0;
      render(); saveState();
    });
    hud.querySelector('#mb-comp-toggle')?.addEventListener('change', (e) => {
      state.compressionEnabled = e.target.checked;
      window.postMessage({ source: PREFIX, type: `${PREFIX}:compression-toggle`, payload: { enabled: state.compressionEnabled } }, '*');
      render(); saveState();
    });
    hud.querySelector('#mb-sync-btn')?.addEventListener('click', async () => {
      const btn = hud.querySelector('#mb-sync-btn');
      const status = hud.querySelector('#mb-sync-status');
      if (btn) { btn.textContent = 'Syncing...'; btn.disabled = true; }
      const result = await sendToSW({ action: 'manual-flush' });
      if (status) {
        if (result?.status === 'flushed') status.textContent = `Synced ${result.conversations || 0} convos`;
        else if (result?.status === 'no_conversations') status.textContent = 'All synced';
        else status.textContent = 'Sync failed';
      }
      liveData.lastFetch = 0;
      await fetchLiveData();
      render();
    });
  }

  function handleTokenUsage(data) {
    const { input_tokens, output_tokens, raw_input_tokens, conversationId } = data;
    if (conversationId && conversationId !== state.lastConversationId) {
      if (state.lastConversationId) state.session.conversations++;
      state.conversation = { input: 0, output: 0, turns: 0 };
      state.compressionSaved = 0; state.conversationRawInput = 0;
      state.lastConversationId = conversationId;
      liveData.lastFetch = 0;
    }
    if (input_tokens)  { state.conversation.input  += input_tokens;  state.session.input  += input_tokens; }
    if (output_tokens) { state.conversation.output += output_tokens; state.session.output += output_tokens; }
    if (raw_input_tokens) { state.conversationRawInput += raw_input_tokens; state.sessionRawInput += raw_input_tokens; }
    else if (input_tokens) { state.conversationRawInput += input_tokens; state.sessionRawInput += input_tokens; }
    state.conversation.turns++; state.session.turns++;
    state.capturing = true;
    render(); saveState();
    fetchLiveData();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== PREFIX) return;
    const t = event.data.type;
    if (t === `${PREFIX}:token-usage`)        handleTokenUsage(event.data.payload || {});
    if (t === `${PREFIX}:interceptor-ready`)  { state.capturing = true; render(); fetchLiveData(); }
    if (t === `${PREFIX}:compression-applied`) {
      const { tokens_saved = 0, raw_tokens = 0, symbols_used = [] } = event.data.payload || {};
      state.compressionSaved += tokens_saved;
      intel.totalSaved += tokens_saved;
      if (raw_tokens) state.conversationRawInput += raw_tokens;
      // Add to stream
      intel.stream.push({ type: 'compress', saved: tokens_saved, syms: symbols_used.slice(0,6).join(' '), ts: Date.now() });
      if (intel.stream.length > 50) intel.stream.shift();
      render(); saveState();
    }
    if (t === `${PREFIX}:context-injected`) {
      const p = event.data.payload || {};
      intel.totalInjected += p.totalChars || 0;
      intel.stream.push({
        type: 'inject',
        chars: p.totalChars || 0,
        shardChars: p.shardChars || 0,
        ragChars: p.ragChars || 0,
        ciChars: p.ciChars || 0,
        query: p.query || '',
        layers: p.layers || [],
        factsCount: p.factsCount || 0,
        method: p.method || '',
        ts: Date.now(),
      });
      if (intel.stream.length > 50) intel.stream.shift();
      if (state.activeTab === 'intelligence') render();
    }
    if (t === `${PREFIX}:symbol-promoted`) {
      // Fired when phrase_promoter promotes a new § symbol
      const { symbol, phrase } = event.data.payload || {};
      if (symbol && !intel.symbols.find(s => s.symbol === symbol)) {
        intel.symbols.push({ symbol, phrase, ts: Date.now() });
        if (intel.symbols.length > 40) intel.symbols.shift();
        if (state.activeTab === 'intelligence') render();
      }
    }
  });

  try { chrome.runtime.onMessage.addListener((msg) => { if (msg.action === 'token-usage') handleTokenUsage(msg.data || {}); }); } catch {}

  setInterval(() => {
    if (!state.minimized && state.activeTab === 'captures') {
      liveData.lastFetch = 0;
      fetchLiveData().then(() => render());
    }
  }, 8000);

  function init() {
    loadState().then(async () => {
      if (state.compressionEnabled) {
        window.postMessage({ source: PREFIX, type: `${PREFIX}:compression-toggle`, payload: { enabled: true } }, '*');
      }
      await fetchLiveData();
      render();
    });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();