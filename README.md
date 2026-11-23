# DevPilot

> **Zero-click, pure-CDP Chrome Extension, MCP Server & CLI for AI Agents.**  
> Control, inspect, and debug your real logged-in Chrome browser without Playwright/Puppeteer runtime bloat or repetitive confirmation popups.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## Why DevPilot?

- **Zero-Click Auto-Attach**: Connects directly to your everyday Chrome tabs (with your existing logins, cookies, and extensions) on demand — no clicking the extension icon per tab, no Chrome `--autoConnect` "Allow" popups.
- **100% Pure CDP (Zero Playwright/Puppeteer Dependency)**: Lightweight MV3 extension + pure CDP engine supporting both **Chrome Native Messaging** (extension-ID-bound, zero exposed ports) and **authenticated localhost WebSocket**, plus **Direct CDP** mode (`--remote-debugging-port`) for headless/CI Chrome.
- **Full Browser Automation + Deep DevTools Suite**:
  - **Perception**: Semantic AXTree snapshots (`ref`-addressed, searchable, scoped, diffable), Vimium-style Set-of-Mark labeled screenshots, Clean HTML, Readability Markdown, Element Inspector.
  - **Trusted Interaction**: Real CDP `Input.*` mouse/keyboard/drag/wheel/hover events (`isTrusted === true`), smart SPA waiting, OOPIF iframe & Shadow DOM support, file upload, dialogs, popups, Chrome Tab Groups.
  - **DevTools Debugging**: Persistent Console & Exception ring buffer (`sinceLastCall`), Network inspector (headers, bodies, timing breakdown, JS Initiator stack, Fetch mocking/interception), CSS Matched Styles (`file:line` + `:hover`/`:focus` forcing), Live JS Debugger (breakpoints, stepping, scope inspection), Live Script/CSS Editor, React Fiber component inspector, Core Web Vitals & Performance profiling, CDP Screencast video recording (`ffmpeg`) with Ghost Cursor.
  - **AI-Native Interfaces**: First-class **MCP Server**, ergonomic **CLI**, **Stateful JS Sandbox** (`devpilot exec -s 1 -e '...'`), **TypeScript SDK**, and **Companion Side Panel**.

## Architecture

```text
AI Agents (Claude Code / Cursor / Codex / Antigravity / Custom SDK)
        │  MCP (stdio)  /  CLI  /  TypeScript SDK
        ▼
┌────────────────────────────────────────────────────────┐
│  @devpilot/server (Local Daemon + Native Host + MCP)   │
│  @devpilot/core   (Pure CDP Engine & DevTools Suite)   │
└───────────────┬──────────────────────────┬─────────────┘
                │ Native Messaging /       │ Direct CDP WS
                │ Authenticated Local WS   │ (Headless / CI)
                ▼                          ▼
┌────────────────────────────────┐   ┌───────────────────┐
│  @devpilot/extension (MV3)     │   │ Chrome / Chromium │
│  Zero-click chrome.debugger    │   │ --remote-debugging│
│  + Side Panel + Content Script │   └───────────────────┘
└────────────────────────────────┘
```

## Status & Roadmap

See [CHANGELOG.md](./CHANGELOG.md) for detailed iteration logs.
