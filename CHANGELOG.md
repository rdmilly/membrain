## v1.4.1 — 2026-05-15
- feat: ClaudeBackfill worker — pulls all historical claude.ai conversations verbatim
  - Paginated fetch of all conversations via internal claude.ai API
  - Full turn extraction + antArtifact block extraction inline
  - Claude memory summaries + memory store imported to Helix
  - Resume-safe: tracks progress in chrome.storage.local
  - Completeness check: re-fetches if online has more turns than stored
  - 1 req/sec rate limit to avoid hammering claude.ai
- feat: get-org-id handler in bridge.js (extracts orgId from Next.js page data)
- feat: start-backfill / pause-backfill / reset-backfill / get-backfill-status message cases
- feat: _store_raw_turns 5th subscriber — verbatim turn text stored in Helix postgres
- feat: ONNX embedding backend (helix-embeddings rebuilt 3GB PyTorch -> 587MB ONNX)
- feat: session_journal system — journal_write / journal_read MCP tools live
- fix: version numbers now consistent between manifest.json and CHANGELOG.md

## v0.6.2 — 2026-03-22
- fix: inject script content via func arg instead of files, bypasses tab state issues

## v0.6.1 — 2026-03-22
- fix: content script triggers SW injection on load, not just tab navigation

# Changelog

## v0.5.6 — 2026-03-22
- Fixed SW registration failure (lazy vector backend import)
- Fixed triple-quote and curly-quote syntax errors

## v0.5.5 — 2026-03-22
- Added ⚡CI Intelligence tab to HUD
- Live injection stream (SHARD/RAG layers per turn)
- § Symbol Dictionary grows with pattern recognition
- Compression event cards showing tokens saved

## v0.5.2
- Tier 1 context injection on every claude.ai message
- HUD Tokens + Captures tabs
