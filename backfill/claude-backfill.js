/**
 * MemBrain Claude.ai Backfill Worker v1.0
 * Pulls all historical conversations from claude.ai and sends to Helix.
 * Resume-safe: tracks progress in chrome.storage.local 'backfill_state'.
 * Completeness check: re-fetches if online has more turns than stored.
 */
export class ClaudeBackfill {
  constructor(config) {
    this.backendUrl = config.BACKEND_URL;
    this.apiKey     = config.API_KEY;
    this.running    = false;
    this.abortFlag  = false;
    this._progress  = null;
  }

  async _loadState() {
    const r = await chrome.storage.local.get('backfill_state');
    return r.backfill_state || {
      status:'idle', startedAt:null, lastUpdated:null, orgId:null,
      totalFound:0, completed:{}, failed:{},
      summariesPulled:false, currentOffset:0, log:[],
    };
  }

  async _saveState(s) {
    s.lastUpdated = Date.now();
    this._progress = s;
    await chrome.storage.local.set({ backfill_state: s });
  }

  async _log(s, msg) {
    const line = `[${new Date().toISOString().slice(11,19)}] ${msg}`;
    s.log = [line, ...s.log.slice(0,199)];
    console.debug('[Backfill]', msg);
  }

  async _getOrgId() {
    return new Promise(resolve => {
      chrome.tabs.query({ url:'https://claude.ai/*' }, tabs => {
        if (!tabs.length) { resolve(null); return; }
        chrome.tabs.sendMessage(tabs[0].id, { action:'get-org-id' }, r =>
          resolve(r?.orgId || null)
        );
      });
    });
  }

  async _api(path) {
    const r = await fetch(`https://claude.ai${path}`, { credentials:'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
    return r.json();
  }

  _extractArtifacts(messages) {
    const out = [];
    for (const msg of messages||[]) {
      for (const b of Array.isArray(msg.content)?msg.content:[]) {
        const txt = b.text||b.content||'';
        if (!txt.includes('<antArtifact') && b.type !== 'tool_result') continue;
        const cm = txt.match(/<antArtifact[^>]*>([\s\S]*?)<\/antArtifact>/);
        out.push({
          id:       (txt.match(/identifier="([^"]+)"/)||[])[1]||null,
          title:    (txt.match(/title="([^"]+)"/)||[])[1]||'untitled',
          language: (txt.match(/language="([^"]+)"/)||[])[1]||'text',
          content:  cm?.[1]?.trim()||txt,
          msgRole:  msg.role||msg.sender,
        });
      }
    }
    return out;
  }

  _extractTurns(data, convId) {
    const turns = [];
    for (const msg of data.chat_messages||data.messages||[]) {
      const role = msg.sender||msg.role||'unknown';
      let text = '';
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.content))
        text = msg.content.filter(b=>b.type==='text').map(b=>b.text||'').join('\n');
      else if (msg.text) text = msg.text;
      if (!text?.trim()) continue;
      turns.push({
        id:             msg.uuid||msg.id||`${convId}-${Date.now()}-${Math.random()}`,
        platform:       'claude.ai',
        conversationId: convId,
        role:           role==='human'?'user':role,
        content:        text,
        captureType:    'backfill',
        timestamp:      msg.created_at ? new Date(msg.created_at).getTime() : Date.now(),
      });
    }
    return turns;
  }

  _shouldFetch(meta, done) {
    if (!done) return true;
    return (meta.message_count||0) > (done.turns||0);
  }

  async _sendToHelix(turns, meta, artifacts) {
    if (!turns.length) return;
    const r = await fetch(`${this.backendUrl}/api/v1/ext/ingest`, {
      method:'POST',
      headers:{'Content-Type':'application/json','X-API-Key':this.apiKey},
      body: JSON.stringify({
        turns, artifacts,
        extensionVersion:'backfill-1.0',
        flushedAt: new Date().toISOString(),
        backfill: true,
        conversationMeta:{
          id:    meta.uuid||meta.id,
          title: meta.name||meta.title||'',
          created_at:    meta.created_at,
          updated_at:    meta.updated_at,
          message_count: meta.message_count||turns.length,
        },
      }),
    });
    if (!r.ok) throw new Error(`Helix ${r.status}: ${await r.text()}`);
    return r.json();
  }

  async _importMemories(orgId) {
    const [summaries, memories] = await Promise.all([
      this._api(`/api/organizations/${orgId}/chat_conversations/recent_summaries`).catch(()=>null),
      this._api(`/api/organizations/${orgId}/memories`).catch(()=>null),
    ]);
    if (!summaries && !memories) return;
    await fetch(`${this.backendUrl}/api/v1/ext/memory-import`, {
      method:'POST',
      headers:{'Content-Type':'application/json','X-API-Key':this.apiKey},
      body: JSON.stringify({ summaries:summaries||[], memories:memories||[],
                             source:'claude.ai', importedAt:new Date().toISOString() }),
    }).catch(e=>console.warn('[Backfill] memory-import failed:',e.message));
  }

  async run(onProgress) {
    if (this.running) return { status:'already_running' };
    this.running = true; this.abortFlag = false;
    let s = await this._loadState();
    s.status='running'; s.startedAt=s.startedAt||Date.now();
    await this._saveState(s);
    try {
      const orgId = s.orgId || await this._getOrgId();
      if (!orgId) throw new Error('No orgId -- open claude.ai in a tab');
      s.orgId = orgId;

      if (!s.summariesPulled) {
        await this._log(s,'Importing Claude memories...');
        await this._importMemories(orgId);
        s.summariesPulled=true;
        await this._saveState(s);
      }

      const PAGE=50; let offset=s.currentOffset||0; let hasMore=true;
      let nDone=Object.keys(s.completed).length;

      while (hasMore && !this.abortFlag) {
        const listData = await this._api(
          `/api/organizations/${orgId}/chat_conversations?limit=${PAGE}&offset=${offset}&sort=updated_at&direction=desc`
        );
        const list = Array.isArray(listData)?listData:(listData.conversations||[]);
        hasMore = list.length===PAGE;
        s.totalFound=Math.max(s.totalFound, offset+list.length);

        for (const meta of list) {
          if (this.abortFlag) break;
          const cid = meta.uuid||meta.id;
          if (!this._shouldFetch(meta, s.completed[cid])) continue;
          try {
            await new Promise(r=>setTimeout(r,1000)); // 1 req/sec
            const detail    = await this._api(
              `/api/organizations/${orgId}/chat_conversations/${cid}?tree=True&rendering_mode=messages&render_all_tools=true`
            );
            const msgs      = detail.chat_messages||detail.messages||[];
            const turns     = this._extractTurns(detail, cid);
            const artifacts = this._extractArtifacts(msgs);
            await this._sendToHelix(turns, meta, artifacts);
            s.completed[cid]={turns:turns.length,artifacts:artifacts.length,sentAt:Date.now(),title:(meta.name||cid).slice(0,80)};
            nDone++;
            await this._log(s,`OK ${(meta.name||cid).slice(0,50)} (${turns.length}t ${artifacts.length}a)`);
            await this._saveState(s);
            if (onProgress) onProgress({total:s.totalFound,completed:nDone,failed:Object.keys(s.failed).length,lastTitle:(meta.name||cid).slice(0,50)});
          } catch(e) {
            s.failed[cid]={error:e.message,attempts:(s.failed[cid]?.attempts||0)+1};
            await this._log(s,`ERR ${cid}: ${e.message}`);
            await this._saveState(s);
          }
        }
        offset+=PAGE; s.currentOffset=offset;
        await this._saveState(s);
      }
      s.status=this.abortFlag?'paused':'done';
      await this._log(s,`${s.status.toUpperCase()}. ${nDone} processed.`);
      await this._saveState(s);
    } catch(e) {
      s=await this._loadState(); s.status='error';
      await this._log(s,`FATAL: ${e.message}`);
      await this._saveState(s);
    } finally { this.running=false; }
    return this._progress;
  }

  pause() { this.abortFlag=true; }
  async reset() { await chrome.storage.local.remove('backfill_state'); this._progress=null; }
  async getStatus() { return this._progress||this._loadState(); }
}
