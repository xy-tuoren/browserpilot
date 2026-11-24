# Changelog

All notable changes to **BrowserPilot** (formerly DevPilot) are documented in this file.

## [1.2.0] - 2026-11-24

### Added
- **npm OIDC Trusted Publishing (`.github/workflows/publish.yml`)**: upgraded release workflow to `id-token: write`, `--provenance`, Node 24 / `npm@latest`, and `workflow_dispatch` so releases publish automatically to npm without static `NPM_TOKEN` secrets or manual 2FA prompts.
- **Download Tracking & Wait API (`DownloadManager`, `browser_downloads`, `browserpilot downloads`)**: tracks file downloads across both Direct CDP (`Browser.setDownloadBehavior` with `allowAndName` + automatic rename to clean `suggestedFilename`) and Chrome Extension mode (`chrome.downloads` permission + live event bridge), exposing `configure`, `list`, `wait`, and `clear`.
- **Live User Action Recorder & Skill Generator (`ActionRecorder`, `browser_action_recorder`, `browserpilot record-actions`)**: captures real user clicks, debounced inputs (with automatic password masking), `<select>` changes, key presses, scrolls, and cross-page navigations via CDP `Runtime.addBinding`, generating compressed `RecordedStep[]`, `browser_batch` JSON, replayable `browserpilot exec` JS scripts, and ready-to-save Agent Skill Markdown.
- **Enhanced Video Recording (`ScreenRecorder` + Smart Idle-Only `createDemoVideo`)**:
  - Added optional `audio: true` Web Audio / `<audio>` / `<video>` MediaRecorder tapping muxed cleanly via `ffmpeg` (with graceful video-only fallback on silent pages).
  - Upgraded `createDemoVideo` with `computeDemoSegments` and multi-segment `ffmpeg` `filter_complex` so interaction moments stay at **1x real speed** while idle waiting periods fast-forward at `idleSpeed`x (default 6x).
- Expanded MCP Server to **43 tools** and exposed `downloads` & `actionRecorder` directly in the stateful JS sandbox.
- Added unit tests and full real-Chromium E2E verification (`packages/core/test/parity-v12.test.ts`).

## [1.1.0] - 2026-11-23

### Changed
- Renamed the entire project, GitHub repository (`xy-tuoren/browserpilot`), Chrome MV3 Extension (`BrowserPilot`), Native Messaging host (`com.browserpilot.bridge`), CLI (`browserpilot`), MCP server (`browserpilot`), home directory (`~/.browserpilot`), and Agent Skill (`skills/browserpilot/SKILL.md`) to **BrowserPilot**, published on npm as **`browserpilot-cdp`** (providing the `browserpilot` CLI binary).

### Added
- **Standalone Single-Package npm Build (`packages/server/build.mjs`)**: bundles `@browserpilot/protocol` and `@browserpilot/core` inline via `esbuild`, keeps only published npm runtime dependencies (`@modelcontextprotocol/sdk`, `diff`, `ws`), and embeds the prebuilt Chrome MV3 extension inside `extension/` so `npm i -g browserpilot && browserpilot setup` works out of the box without cloning the repository.
- **Automated npm + GitHub Release Workflow (`.github/workflows/publish.yml`)**: runs full build, typecheck, and real Chromium/MV3 tests on `v*` tags, publishes `browserpilot` to npm (when `NPM_TOKEN` is configured), and uploads `browserpilot-extension-vX.Y.Z.zip` to GitHub Releases.

## [1.0.1] - 2026-11-23

### Added
- Added a persistent **Dark / Light theme switch** to the Chrome Extension settings (`popup.html` / `popup.ts`) and a quick theme toggle in the **Companion Side Panel** (`sidepanel.html` / `sidepanel.ts`), backed by `ExtensionConfig.theme` (`'dark' | 'light'`) in `@devpilot/protocol` and synced in real time via `chrome.storage.local`.
- Added E2E verification in `packages/extension/test/extension-e2e.test.ts` confirming `theme` persistence (`dark` <-> `light`).

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
