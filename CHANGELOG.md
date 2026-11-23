# Changelog

All notable changes to **DevPilot** are documented in this file.

## [0.4.0] - 2026-11-23

### Added
- Implemented `@devpilot/extension` — zero-click Chrome Manifest V3 extension:
  - **Zero-Click Auto-Attach** (`background.ts`): automatically attaches `chrome.debugger` (CDP v1.3) on demand to any existing tab or newly opened tab without requiring manual icon clicks or Chrome `--autoConnect` dialogs.
  - **Dual Transport**: connects automatically via Chrome Native Messaging (`com.devpilot.bridge`) with instant fallback to authenticated localhost WebSocket (`127.0.0.1`) + MV3 alarm & heartbeat keepalive.
  - **Resilience & Safety**: cleans foreign third-party `chrome-extension://` iframes before attaching, forwards OOPIF child `sessionId` events, auto-tracks popups into Chrome Tab Groups, enforces domain allowlist/denylist rules, and provides an instant Pause/Resume kill switch.
  - **Visual Feedback (`content-script.ts`)**: closed Shadow Root overlay rendering action highlight boxes, animated ghost cursor with click feedback, right-click "Pin Element for DevPilot" context menu, interactive element picker, and toast notifications without polluting page DOM.
  - **Popup & Companion Side Panel (`popup.html`, `sidepanel.html`)**: Claude/ChatGPT-style companion sidebar showing real-time AI activity timeline, active controlled tabs, element picker trigger, and domain safety controls.
  - **Zero-Dep Icon Generator & esbuild Bundler**: builds self-contained unpacked extension in `packages/extension/dist/`.
- Added `ExtensionBridgeTransport` to `@devpilot/core` connecting any `ExtensionChannel` cleanly to the full pure-CDP `SessionManager` & DevTools suite.
- Verified zero-click auto-attach and full CDP/DevTools execution with the real compiled MV3 extension loaded inside real Google Chrome for Testing (`packages/extension/test/extension-e2e.test.ts`).

## [0.3.0] - 2026-11-23

### Added
- Implemented complete pure-CDP DevTools Debugging Suite (`ConsoleCollector`, `NetworkInspector`, `StylesInspector`, `JSDebugger`, `LiveEditor`, `getReactComponentInfo`, `PerformanceProfiler`, `ScreenRecorder`, `DevPilotTab`, `SessionManager`) verified against real Chromium.

## [0.2.0] - 2026-11-23

### Added
- Implemented `@devpilot/core` pure-CDP engine (`DirectCDPTransport`, `TabCDPSession`, `PageController`, `SnapshotEngine`, `captureLabeledScreenshot`, `DOMExtractor`, `waitForPageLoad`).

## [0.1.0] - 2026-11-23

### Added
- Initialized `devpilot` TypeScript monorepo and `@devpilot/protocol` package with Chrome Native Messaging binary framing and profile-wide CDP safety guards.
