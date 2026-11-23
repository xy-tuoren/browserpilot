# Changelog

All notable changes to **DevPilot** are documented in this file.

## [0.2.0] - 2026-11-23

### Added
- Implemented `@devpilot/core` pure-CDP browser engine (zero Playwright/Puppeteer dependencies):
  - `DirectCDPTransport` & `CDPTransport` abstraction supporting direct Chrome `--remote-debugging-port` connections, target lifecycle sync, OOPIF child frame auto-attach (`Target.setAutoAttach` with `flatten: true`), and profile-wide safety guards.
  - `TabCDPSession` managing CDP domains, child iframe sessions, JS dialog tracking (`Page.javascriptDialogOpening`), and event listeners.
  - `PageController` with browser-trusted (`isTrusted === true`) CDP `Input.*` mouse/keyboard/hover/wheel/drag actions, auto-waiting element resolution (snapshot refs, CSS, `text=`, open Shadow DOM, OOPIF offsets), SPA-safe `fill()`, `<select>`, file upload (`DOM.setFileInputFiles`), CSS-scaled & pure-canvas-resized screenshots, viewport/CPU/network/media/geolocation emulation, page-scoped cookies, and Web Storage helpers.
  - `SnapshotEngine` building compressed semantic AXTree snapshots with deterministic short refs (`e1`, `e2`...), OOPIF iframe merging, scoped subtree snapshots, regex search, and automatic unified diffs (`showDiffSinceLastCall`).
  - `captureLabeledScreenshot` generating Vimium-style color-coded Set-of-Mark overlays in a closed shadow root synchronized with snapshot refs.
  - `DOMExtractor` providing `getCleanHTML` (diffable), `getPageMarkdown` (Readability-style extraction, diffable), and `inspectElement`.
  - `waitForPageLoad` smart load detector ignoring analytics/ad beacons, plus `waitForSelector`, `waitForText`, and `waitForCondition`.
- Added unit tests and full real-Chromium E2E tests (`packages/core/test/browser-core.test.ts`) verifying trusted clicks, Shadow DOM, JS dialogs, file upload, drag gestures, snapshots/diffs, Set-of-Mark screenshots, DOM extraction, and cookie safety guards.

## [0.1.0] - 2026-11-23

### Added
- Initialized `devpilot` TypeScript monorepo (`pnpm` workspace) with zero Playwright/Puppeteer runtime dependencies.
- Added `@devpilot/protocol` package defining:
  - Complete shared data contracts for Tabs, AXTree Snapshots, Console/Network capture, CSS Styles, Live JS Debugger, React Fiber inspection, Performance/Web Vitals, Screen Recording, and multi-session management.
  - Bidirectional JSON-RPC bridge protocol between Chrome MV3 Extension, Native Messaging Host, and Local Daemon.
  - Chrome Native Messaging 4-byte little-endian binary framing encoder/decoder (`encodeNativeMessage`, `NativeMessageDecoder`).
  - Safety guard (`BLOCKED_PROFILE_WIDE_CDP_COMMANDS`) blocking destructive profile-wide CDP commands (`Network.clearBrowserCookies`, `Network.clearBrowserCache`).
  - Unit tests verifying framing edge cases (chunked streams, multi-byte UTF-8, oversized message rejection) and protocol helpers.
