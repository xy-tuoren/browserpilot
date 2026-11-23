# Changelog

All notable changes to **DevPilot** are documented in this file.

## [0.3.0] - 2026-11-23

### Added
- Implemented complete pure-CDP DevTools Debugging Suite in `@devpilot/core`:
  - `ConsoleCollector`: persistent ring buffer (up to 5,000 entries) capturing console API calls, uncaught exceptions, and browser logs with `sinceLastCall` cursor tracking, regex search, and stack traces.
  - `NetworkInspector`: captures full request/response metadata, headers, ResourceTiming phase breakdowns, JS Initiator call stacks, `Network.getResponseBody`, `sinceLastCall` cursor tracking, and `Fetch` domain request blocking/mocking/header modification.
  - `StylesInspector`: DevTools Styles panel parity (`CSS.getMatchedStylesForNode`, stylesheet `sourceUrl:line` mapping, cascade override detection, inherited rules, `CSS.forcePseudoState` for `:hover`/`:focus`/`:active`).
  - `JSDebugger` & `LiveEditor`: script discovery, conditional breakpoints, pause/resume/stepOver/stepInto/stepOut, local scope variable inspection, `evaluateOnCallFrame`, grep across loaded scripts, and live in-memory script/CSS patching (`Debugger.setScriptSource`, `CSS.setStyleSheetText`).
  - `getReactComponentInfo`: React Fiber traversal returning component name, dev `_debugSource` location, component hierarchy, and safely sanitized props.
  - `PerformanceProfiler`: Core Web Vitals (`LCP`, `CLS`, `FCP`, `TTFB`), `Performance.getMetrics`, V8 heap summary, CPU profiling (`Profiler.start`/`stop`), and `Tracing` long-task insight analysis.
  - `ScreenRecorder` & `createDemoVideo`: CDP `Page.startScreencast` piped to `ffmpeg` producing `.mp4`/`.webm` recordings surviving navigation, plus idle-speedup demo generation.
  - `DevPilotTab` unified per-tab controller with automatic post-action error/failure feedback (`runWithFeedback`).
  - `SessionManager` & stateful JS execution sandbox (`exec`) with per-session isolated `state`, Chrome Tab Group assignments, and full Playwriter-compatible helpers.
- Verified every single DevTools, Recording, and Sandbox feature end-to-end against real Chromium (`packages/core/test/devtools-sandbox.test.ts`).

## [0.2.0] - 2026-11-23

### Added
- Implemented `@devpilot/core` pure-CDP browser engine (zero Playwright/Puppeteer dependencies):
  - `DirectCDPTransport`, `TabCDPSession`, `PageController`, `SnapshotEngine`, `captureLabeledScreenshot`, `DOMExtractor`, and `waitForPageLoad`.
  - Unit tests and real Chromium E2E tests (`packages/core/test/browser-core.test.ts`).

## [0.1.0] - 2026-11-23

### Added
- Initialized `devpilot` TypeScript monorepo and `@devpilot/protocol` package with Chrome Native Messaging binary framing and profile-wide CDP safety guards.
