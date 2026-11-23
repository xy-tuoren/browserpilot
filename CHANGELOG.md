# Changelog

All notable changes to **DevPilot** are documented in this file.

## [1.0.0] - 2026-11-23

### Added
- Added `devpilot doctor` CLI diagnostics command (`--json` supported) inspecting Node.js version, compiled MV3 extension bundle, Chrome binary, `ffmpeg`, local daemon status, connected browsers, and Chrome Native Messaging host manifests.
- Added full end-to-end verification of `devpilot doctor` and `devpilot setup --dry-run` in `@devpilot/server`.
- Upgraded GitHub Actions CI workflow (`.github/workflows/ci.yml`) to provision `ffmpeg` and Chrome for Testing on Ubuntu so **all 4 packages — including real Direct-CDP, MP4 video recording, AND real loaded MV3 Extension E2E suites — execute live on every push and PR**.
- Synchronized all workspace packages and Chrome Extension manifest to **v1.0.0** for initial production release.

## [0.6.0] - 2026-11-23

### Added
- **Cross-Origin OOPIF Iframe Resolution**: enhanced `PageController.getIframeOffset` with `DOM.getFrameOwner` + iframe URL rect fallback, verified clicking inside a real cross-origin OOPIF iframe (`--site-per-process`).
- **Rich Playwriter-Compatible Locators**: `role=button[name="..."]`, `label=...`, `placeholder=...`, `>> nth=N`, and `pinned` across Shadow DOM and standard DOM.
- **Viewport & Scroll Context** in AXTree snapshot headers (`Viewport: WxH | Scroll: Y/Total (Pct%)`).
- **`browser_batch` & `browser_pinned` MCP tools** (41 total MCP tools).
- **Companion Side Panel Live Diagnostics**: real-time **Activity | Errors | Failed Net** tabs powered by extension-side CDP event tracking.
- Added GitHub Actions CI workflow and real-browser E2E tests for OOPIF iframes, rich locators, popup auto-attach, `browser_batch`, and `browser_pinned`.

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
