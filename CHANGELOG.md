# Changelog

All notable changes to **BrowserPilot** (`browserpilot-cdp`) are documented in this file.

> BrowserPilot follows pre-1.0 Semantic Versioning (`0.x.y`) while core APIs, extension UX, and real-world site compatibility continue to mature toward `1.0.0`.

## [Unreleased]

### Added
- **Interactive-Only Compact Snapshot Mode (`snapshot -i` / `--interactive` / `interactiveOnly: true`)**:
  - Emits only interactive controls (`[e1]`, `[e2]`...) and enclosing container landmarks that actually hold interactive descendants, cutting snapshot token usage by ~60–75% on content-heavy pages while maintaining independent full vs interactive diff baselines.
- **Tiered Low-Token MCP Tool Profiles (`packages/server/src/mcp.ts`, `cli.ts`)**:
  - `browserpilot mcp` now advertises a lean **19-tool `core` profile** (+ `browser_exec` Code Mode) by default, slashing upfront MCP schema context tokens by **>65%**; pass `--full` (or `BROWSERPILOT_MCP_CAPS=all`) for all 52 tools, or `--caps=interaction,extraction,devtools,context,media` to enable specific tool groups.
- **Playwright Misuse Guidance Guards in `exec` Sandbox (`packages/core/src/session-manager.ts`)**:
  - Intercepts accidental `page.*`, `context.*`, `browser.*`, `expect()`, and `require('playwright' | 'puppeteer')` calls inside `browserpilot exec` with one-line correction hints pointing to BrowserPilot's pure-CDP globals without interfering with local variables.
- **Idle Unpacked Extension Auto-Reload & Stale-Memory Diagnostics (`packages/extension/src/bg/rpc.ts`, `daemon.ts`, `cli/setup-doctor.ts`)**:
  - Added `extension.reload` bridge RPC and automatic once-per-version idle hot-reload in `BrowserPilotDaemon` when `~/.browserpilot/extension` on disk has been updated, plus live memory-vs-CLI extension version warnings in `browserpilot doctor`.

## [0.2.0] - 2026-11-26

### Changed
- **Pre-1.0 Versioning Reset (`0.2.0`)**:
  - Reset package, Chrome MV3 manifest, CLI, MCP server, and GitHub Release versioning to **`0.2.0`** (`dist-tag: latest`) to accurately reflect the project's pre-1.0 stage, with atomic workspace version synchronization via `scripts/sync-version.mjs`.
- **Modular Pure-CDP Architecture & ~74% Smaller npm Package**:
  - Modularized all four workspace packages (`@browserpilot/protocol`, `@browserpilot/core`, `@browserpilot/extension`, `browserpilot-cdp`) into focused sub-modules (`page/{types,input,actionability,forms,context,capture,handoff}`, `locator/{parser,evaluator}`, `network/router`, `bg/{state,bridge,tabs,rpc}`, `content/{overlay,picker,codegen}`, `tools/{types,validate,navigation,interaction,devtools,context}`, `cli/{args,setup-doctor,daemon-browser,commands}`) with zero files exceeding 750 lines and strict `noUnusedLocals` / `noUnusedParameters` checks across `src/` and `test/`.
  - Re-exported full `@browserpilot/protocol` and `@browserpilot/core` APIs from `browserpilot-cdp` with self-contained `.d.ts` TypeScript declarations, ESM code-splitting (`splitting: true`), and sourcemap-free tarballs (`3.2 MB -> 841 KB` unpacked, `-74%`).

### Added
- **Zero-Click Chrome MV3 Extension & Cross-Platform Native Messaging (`macOS` / `Linux` / `Windows`)**:
  - Connects to the user's running Chrome profile (existing logins, cookies, tabs) with zero per-tab confirmation prompts, automatic Chrome Tab Grouping + auto-ungroup cleanup, MV3 Service Worker sleep/wake state restoration, adaptive byte-safe 64 MB / chunked Native Messaging framing, classic-IIFE idempotent `content-script.js`, and a simplified bilingual (`简体中文` default / `EN` toggle, Dark/Light) Popup, Side Panel, and in-page control capsule.
  - Non-invasive `browserpilot setup` & `browserpilot doctor` auto-syncing `~/.browserpilot/extension` and installing Native Messaging hosts across macOS, Linux, and Windows (`win32` `.cmd` + `HKCU` registry).
- **Playwright-Grade Pure-CDP Browser Control & Chained Locator Engine**:
  - Chained `>>` selector pipeline (`role=`, `label=`, `placeholder=`, `testid=`, `text=`, `xpath=`, `:has-text(...)`, `:visible`, `first`, `last`, `nth=`, `pinned`) piercing Shadow DOM, same-origin `iframe`s, and cross-origin OOPIF frames, backed by canonical cross-realm `computeStableDomSelector()`.
  - 2-frame `requestAnimationFrame` stability checks, Shadow-DOM-aware occlusion detection, sticky-header scroll nudging, background-tab focus emulation (`267x` faster background mouse dispatch), native editor shortcut `commands`, smart inner-container scrolling, dynamic `Fetch` `route()` / `unroute()`, `waitForFileChooser()` custom upload interception, and interactive in-page Human Handoff (`browser_handoff`).
- **52 MCP Tools with JSON-Schema Validation & Stateful JS Sandbox (`browserpilot exec`)**:
  - Unified JSON-Schema validator & safe primitive coercer (`packages/server/src/tools/validate.ts`), bounded long-running Daemon tab/session lifecycle GC, AXTree incremental diff snapshots, Set-of-Mark labeled screenshots, zoom/grid screenshots, PDF export, clipboard, permissions, init scripts, downloads, and smart idle-accelerated MP4/WebM video recording.
- **Multi-Target Live Codegen & Interactive Single-File HTML Trace Viewer**:
  - `browserpilot codegen` / Side Panel **`录制 / Record`** tab compiling live user actions & `Alt+Shift+Click` assertions into **Playwright TS**, **BrowserPilot JS**, **MCP `browser_batch` JSON**, and **Agent Skill Markdown**.
  - `browserpilot trace` / `browser_trace` / `browserpilot exec --trace` generating self-contained XSS-safe HTML Trace Viewer reports with Filmstrip timeline, Before/After/Side-by-Side screenshots + click reticle, Console logs, and Network request/response previews.

## [0.1.0] - 2026-11-23

### Added
- Initialized TypeScript monorepo (`protocol`, `core`, `extension`, `server`), Chrome Native Messaging binary framing, profile-wide destructive CDP command guards, Direct-CDP & MV3 Extension transports, core DevTools inspectors (`ConsoleCollector`, `NetworkInspector`, `StylesInspector`, `JSDebugger`, `LiveEditor`, `ReactInspector`, `PerformanceProfiler`), local authenticated Daemon, CLI, and MCP stdio server.
