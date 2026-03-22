# 🧠 MemBrain v0.6.0

> AI conversation memory, compression & context injection — Chrome extension

[![CI](https://github.com/rdmilly/membrain/actions/workflows/ci.yml/badge.svg)](https://github.com/rdmilly/membrain/actions/workflows/ci.yml)
[![README](https://github.com/rdmilly/membrain/actions/workflows/readme.yml/badge.svg)](https://github.com/rdmilly/membrain/actions)
![Version](https://img.shields.io/badge/version-0.6.0-blue?style=flat-square)
![MV3](https://img.shields.io/badge/Chrome-MV3-red?style=flat-square)

**[🌐 Live Dashboard →](https://helixmaster.millyweb.com)**

---

## What it does

| Feature | Description |
|---------|-------------|
| 🧠 **Memory** | Captures conversations from Claude, ChatGPT, Gemini, Perplexity |
| ⚡ **Compression** | Replaces repeated phrases with `§` symbols, cutting token usage |
| 🔍 **Context Injection** | Injects relevant past context into every new message |
| 📊 **⚡CI Tab** | Live stream of injections, symbol growth, and token savings |

## Install

1. Download latest zip from [helixmaster.millyweb.com](https://helixmaster.millyweb.com)
2. Extract → `chrome://extensions` → Developer mode on → Load unpacked → select `memory-ext/`

## Architecture

```
Page load → SW injects interceptors into MAIN world (bypasses CSP)
                    ↓
        Fetch hook captures AI API calls
                    ↓
  Context injected before every message → Helix Cortex
                    ↓
     HUD: tokens · captures · ⚡CI live stream
```

## HUD Tabs

- **TOKENS** — Input/Output/Total + compression savings
- **CAPTURES** — Conversations captured, sync status
- **⚡CI** — Live injection stream, § symbol dictionary

## Stack

`Chrome MV3` `Service Workers` `chrome.scripting MAIN world` `transformers.js` `IndexedDB`

## Backend

Powered by [Helix Cortex](https://github.com/rdmilly/helix)

---

*README auto-updated on every push · Built in public at [helixmaster.millyweb.com](https://helixmaster.millyweb.com)*
