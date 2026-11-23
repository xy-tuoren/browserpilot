# Changelog

All notable changes to **DevPilot** are documented in this file.

## [0.6.0] - 2026-11-23

### Added
- **Cross-Origin OOPIF Iframe Resolution**: enhanced `PageController.getIframeOffset` with `DOM.getFrameOwner` + iframe URL rect fallback, verified end-to-end clicking a button inside a real cross-origin OOPIF iframe (`127.0.0.1` -> `localhost` with `--site-per-process`).
- **Rich Playwriter-Compatible Locators**: added `role=button[name="..."]`, `label=...`, `placeholder=...`, `>> nth=N` index disambiguation, and `pinned` (`globalThis.__devpilotPinnedN`) locators across open Shadow DOM and standard DOM.
- **Viewport & Scroll Context in Snapshots**: `SnapshotEngine` header now includes `Viewport: WxH | Scroll: Y/Total (Pct%)` so agents immediately know fold position and remaining scrollable content.
- **Compound Batch Tool (`browser_batch`) & Pinned Inspector (`browser_pinned`)**: execute multi-step action sequences in a single MCP round-trip with post-batch snapshot & error feedback, plus inspect right-click-pinned elements (HTML + box + styles + React Fiber). Total MCP tools expanded to **41**.
- **Companion Side Panel Live Diagnostics**: upgraded `background.ts` and `sidepanel.html`/`sidepanel.ts` with real-time **Activity | Errors | Failed Net** tabs capturing console errors, exceptions, and 4xx/5xx/blocked requests directly in the sidebar.
- **GitHub Actions CI (`.github/workflows/ci.yml`)**: automated typecheck, build, and test pipeline on push/PR.
- Added comprehensive real-browser E2E tests for cross-origin OOPIF iframes, rich locators, `browser_batch`, `browser_pinned`, and extension popup auto-attach (`window.open`).

## [0.5.0] - 2026-11-23

### Added
- Implemented `@devpilot/server` (authenticated local Daemon, Chrome Native Messaging Host & cross-platform installer, 39-tool MCP stdio server, ergonomic CLI, and `skills/devpilot/SKILL.md`).

## [0.4.0] - 2026-11-23

### Added
- Implemented `@devpilot/extension` (zero-click Chrome MV3 extension with Native Messaging + authenticated WS, Side Panel, Popup, closed-shadow-DOM visual highlights & ghost cursor) and `ExtensionBridgeTransport`.

## [0.3.0] - 2026-11-23

### Added
- Implemented complete pure-CDP DevTools Debugging Suite (`ConsoleCollector`, `NetworkInspector`, `StylesInspector`, `JSDebugger`, `LiveEditor`, `getReactComponentInfo`, `PerformanceProfiler`, `ScreenRecorder`, `DevPilotTab`, `SessionManager`).

## [0.2.0] - 2026-11-23

### Added
- Implemented `@devpilot/core` pure-CDP engine (`DirectCDPTransport`, `TabCDPSession`, `PageController`, `SnapshotEngine`, `captureLabeledScreenshot`, `DOMExtractor`, `waitForPageLoad`).

## [0.1.0] - 2026-11-23

### Added
- Initialized `devpilot` TypeScript monorepo and `@devpilot/protocol` package with Chrome Native Messaging binary framing and profile-wide CDP safety guards.
