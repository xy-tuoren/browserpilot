# Changelog

All notable changes to **DevPilot** are documented in this file.

## [0.5.0] - 2026-11-23

### Added
- Implemented `@devpilot/server` — complete local Daemon, Chrome Native Messaging Host, MCP Server, CLI (`devpilot`), and TypeScript SDK:
  - **Authenticated Local Daemon (`daemon.ts`, `config.ts`)**: runs on `127.0.0.1:19888` with 256-bit random auth token (`~/.devpilot/daemon.json`, mode `0600`), managing both Extension WebSocket/Native connections and Direct CDP browser instances.
  - **Chrome Native Messaging Host & Installer (`native-host.ts`, `native-install.ts`)**: 4-byte length-prefixed stdio host (`com.devpilot.bridge`) auto-spawning the local daemon and injecting auth tokens transparently; cross-platform installer generating NVM-safe wrapper script and browser manifests for Chrome, Chrome for Testing, Chromium, Brave, Edge, and Arc.
  - **Full MCP Server (`mcp.ts`, `tools.ts`)**: exposes 39 high-signal browser automation & DevTools tools over MCP stdio (with native multimodal `image` blocks for screenshots & Set-of-Mark overlays, post-action console/network error feedback, live debugger, live script/CSS edit, React Fiber inspection, performance/Web Vitals, recording, and stateful JS sandbox).
  - **Ergonomic CLI (`cli.ts`)**: `devpilot setup`, `daemon`, `mcp`, `browser start`, `connect-cdp`, stateful `session new|list|reset|close` + `exec -s <id> -e '<js>'`, direct shortcuts (`tabs`, `open`, `snapshot`, `click`, `fill`, `screenshot`, `labeled-screenshot`, `console`, `network`, `styles`, `react`, `eval`, `perf`), and `devpilot skill`.
  - **Agent Skill (`skills/devpilot/SKILL.md`)**: ready-to-deploy skill instructions for AI coding agents.
- Verified full stack end-to-end (`packages/server/test/e2e-full.test.ts`): Daemon Bearer auth, real Native Messaging stdio framing binary, real MCP stdio client invoking tools + multimodal image blocks, and real CLI driving the compiled MV3 extension with zero clicks.

## [0.4.0] - 2026-11-23

### Added
- Implemented `@devpilot/extension` (zero-click Chrome MV3 extension with Native Messaging + authenticated WS, Side Panel, Popup, closed-shadow-DOM visual highlights & ghost cursor) and `ExtensionBridgeTransport`, verified in real Google Chrome for Testing.

## [0.3.0] - 2026-11-23

### Added
- Implemented complete pure-CDP DevTools Debugging Suite (`ConsoleCollector`, `NetworkInspector`, `StylesInspector`, `JSDebugger`, `LiveEditor`, `getReactComponentInfo`, `PerformanceProfiler`, `ScreenRecorder`, `DevPilotTab`, `SessionManager`) verified against real Chromium.

## [0.2.0] - 2026-11-23

### Added
- Implemented `@devpilot/core` pure-CDP engine (`DirectCDPTransport`, `TabCDPSession`, `PageController`, `SnapshotEngine`, `captureLabeledScreenshot`, `DOMExtractor`, `waitForPageLoad`).

## [0.1.0] - 2026-11-23

### Added
- Initialized `devpilot` TypeScript monorepo and `@devpilot/protocol` package with Chrome Native Messaging binary framing and profile-wide CDP safety guards.
