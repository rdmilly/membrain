# 🧠 MemBrain

> Chrome extension that gives AI conversations persistent memory — captures, compresses, and injects context across Claude, ChatGPT, Gemini, and Perplexity.

**In plain English:** Every time you start a new AI chat, MemBrain automatically provides the AI with relevant context from your past sessions. No copy-pasting history. No re-explaining yourself. It runs entirely in your browser — nothing stored externally.

[![CI](https://github.com/rdmilly/membrain/actions/workflows/ci.yml/badge.svg)](https://github.com/rdmilly/membrain/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-0.6.0-blue?style=flat-square)
![MV3](https://img.shields.io/badge/Chrome-MV3-red?style=flat-square)

**[🌐 Download & Dashboard →](https://helixmaster.millyweb.com)**

---

## Features

| Feature | Description |
|---------|-------------|
| 🧠 **Memory** | Captures conversations from Claude, ChatGPT, Gemini, Perplexity |
| ⚡ **Compression** | Reduces token usage by replacing repeated phrases with symbols |
| 🔍 **Context Injection** | Injects relevant past context into every new message automatically |
| 📊 **Live HUD** | Real-time stream of injections, compression stats, and token savings |

---

## Install

1. Download latest zip from [helixmaster.millyweb.com](https://helixmaster.millyweb.com)
2. Extract → `chrome://extensions` → Developer mode → Load unpacked → select `memory-ext/`

---

## Architecture

```
Page load → SW injects interceptors into MAIN world (bypasses CSP)
                    ↓
        Fetch hook captures AI API calls
                    ↓
  Context injected before every message → Helix Cortex
                    ↓
     HUD: tokens · captures · live injection stream
```

## Stack

`Chrome MV3` `Service Workers` `chrome.scripting` `transformers.js` `IndexedDB`

Backend: [Helix Cortex](https://github.com/rdmilly/helix)

---

## Builder

Ryan Milly — [ryanmilly.com](https://ryanmilly.com) · [LinkedIn](https://linkedin.com/in/rdmilly)
