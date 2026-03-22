/**
 * MemBrain — Auto-Inject HUD (Item 6)
 * 
 * Non-blocking overlay that appears when memories are injected.
 * Shows: fact count, categories, token estimate, confidence.
 * Slides in from top-right, auto-dismisses after 5 seconds.
 * 
 * Injected as content script (isolated world), listens for
 * injection-applied events from bridge.js.
 */

(function () {
  'use strict';

  const PREFIX = 'memory-ext';
  const HUD_ID = `${PREFIX}-hud`;
  const AUTO_DISMISS_MS = 6000;

  // ==================== STYLES ====================

  function injectStyles() {
    if (document.getElementById(`${HUD_ID}-styles`)) return;

    const style = document.createElement('style');
    style.id = `${HUD_ID}-styles`;
    style.textContent = `
      #${HUD_ID} {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        pointer-events: auto;
        transform: translateX(120%);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      #${HUD_ID}.visible {
        transform: translateX(0);
      }
      .${HUD_ID}-card {
        background: #1a1a2eee;
        border: 1px solid #a78bfa44;
        border-radius: 10px;
        padding: 10px 14px;
        color: #e0e0e0;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        min-width: 220px;
        max-width: 320px;
      }
      .${HUD_ID}-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
      }
      .${HUD_ID}-title {
        font-size: 11px;
        font-weight: 700;
        color: #a78bfa;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .${HUD_ID}-close {
        background: none;
        border: none;
        color: #666;
        cursor: pointer;
        font-size: 14px;
        padding: 0 2px;
        line-height: 1;
      }
      .${HUD_ID}-close:hover { color: #ccc; }
      .${HUD_ID}-stats {
        display: flex;
        gap: 12px;
        margin-bottom: 6px;
        font-size: 11px;
        color: #888;
      }
      .${HUD_ID}-stat-value { color: #ccc; font-weight: 600; }
      .${HUD_ID}-facts {
        font-size: 11px;
        color: #999;
        line-height: 1.5;
        max-height: 80px;
        overflow: hidden;
      }
      .${HUD_ID}-fact {
        padding: 1px 0;
        border-left: 2px solid #a78bfa44;
        padding-left: 6px;
        margin-bottom: 2px;
      }
      .${HUD_ID}-progress {
        height: 2px;
        background: #a78bfa22;
        border-radius: 1px;
        margin-top: 8px;
        overflow: hidden;
      }
      .${HUD_ID}-progress-bar {
        height: 100%;
        background: #a78bfa;
        border-radius: 1px;
        width: 100%;
        transition: width ${AUTO_DISMISS_MS}ms linear;
      }
      .${HUD_ID}-progress-bar.depleting {
        width: 0%;
      }
    `;
    document.head.appendChild(style);
  }

  // ==================== HUD ELEMENT ====================

  let dismissTimer = null;

  function getOrCreateHud() {
    let hud = document.getElementById(HUD_ID);
    if (!hud) {
      hud = document.createElement('div');
      hud.id = HUD_ID;
      document.body.appendChild(hud);
    }
    return hud;
  }

  function showHud(data) {
    injectStyles();
    const hud = getOrCreateHud();

    const factCount = data.factCount || 0;
    const tokenEstimate = data.tokenEstimate || 0;
    const platform = data.platform || 'unknown';
    const facts = data.facts || [];

    const factLines = facts.slice(0, 5).map(f => {
      const label = typeof f === 'string' ? f : (f.content || '');
      return `<div class="${HUD_ID}-fact">${escapeHtml(label.substring(0, 80))}</div>`;
    }).join('');

    hud.innerHTML = `
      <div class="${HUD_ID}-card">
        <div class="${HUD_ID}-header">
          <div class="${HUD_ID}-title">
            \u{1F9E0} Memory Injected
          </div>
          <button class="${HUD_ID}-close" id="${HUD_ID}-close">&times;</button>
        </div>
        <div class="${HUD_ID}-stats">
          <span><span class="${HUD_ID}-stat-value">${factCount}</span> facts</span>
          <span><span class="${HUD_ID}-stat-value">~${tokenEstimate}</span> tokens</span>
          <span>${platform}</span>
        </div>
        ${factLines ? `<div class="${HUD_ID}-facts">${factLines}</div>` : ''}
        <div class="${HUD_ID}-progress">
          <div class="${HUD_ID}-progress-bar" id="${HUD_ID}-progress"></div>
        </div>
      </div>
    `;

    // Animate in
    requestAnimationFrame(() => {
      hud.classList.add('visible');
      // Start progress bar countdown
      requestAnimationFrame(() => {
        const bar = document.getElementById(`${HUD_ID}-progress`);
        if (bar) bar.classList.add('depleting');
      });
    });

    // Close button
    document.getElementById(`${HUD_ID}-close`)?.addEventListener('click', () => dismissHud());

    // Auto-dismiss
    clearTimeout(dismissTimer);
    dismissTimer = setTimeout(dismissHud, AUTO_DISMISS_MS);
  }

  function dismissHud() {
    clearTimeout(dismissTimer);
    const hud = document.getElementById(HUD_ID);
    if (hud) {
      hud.classList.remove('visible');
      setTimeout(() => { if (hud.parentNode) hud.parentNode.removeChild(hud); }, 400);
    }
  }

  // ==================== EVENT LISTENER ====================

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== PREFIX) return;
    if (event.data.type === `${PREFIX}:injection-applied`) {
      showHud(event.data.payload || {});
    }
  });

  // Also listen for direct messages from service worker via chrome.runtime
  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'show-injection-hud') {
        showHud(message.data || {});
      }
    });
  } catch {}

  // ==================== UTILITIES ====================

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  console.debug('[MemBrain] HUD loaded on', window.location.hostname);
})();
