# 🧠 MemBrain

[![CI](https://github.com/rdmilly/membrain/actions/workflows/ci.yml/badge.svg)](https://github.com/rdmilly/membrain/actions/workflows/ci.yml)

> AI conversation memory, compression & context injection browser extension

**Current version: v0.5.6**

## What it does

- **Memory** — captures conversations from Claude, ChatGPT, Gemini, Perplexity
- **Compression** — replaces repeated phrases with `§` symbols, cutting token usage
- **Context Injection** — injects relevant past context into every new message automatically  
- **⚡CI tab** — live stream of injections, § symbol growth, and token savings in real-time

## Install (unpacked)

1. Download zip from [Releases](https://github.com/rdmilly/membrain/releases)
2. Extract → `chrome://extensions` → Developer mode on → Load unpacked → select folder

## Built with

- Chrome Extension Manifest V3
- transformers.js (local offline embeddings)
- [Helix Cortex](https://github.com/rdmilly/helix) backend

Built in public as part of [Millyweb](https://millyweb.com).
