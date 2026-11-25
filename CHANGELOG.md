# Changelog

All notable changes to **BrowserPilot** (formerly DevPilot) are documented in this file.

## [1.4.0] - 2026-11-24

### Added
- **Chained, Visibility-Aware & Cross-Frame Locator Engine (`packages/core/src/locator.ts`)**:
  - Full multi-stage `>>` pipeline supporting CSS, Shadow DOM piercing, `role=`, `text=`, `label=`, `placeholder=`, `alt=`, `title=`, `testid=`, `xpath=`, `pinned`, plus filter/index stages (`has-text=`, `has=`, `visible=true|false`, `first`, `last`, `nth=N` including negative indices) and Playwright-style `:has-text(...)` / `:visible` shorthand expansion.
  - Smart default visibility preference (automatically skips hidden responsive mobile/desktop duplicates while preserving hidden `<input type="file">` and `<option>` controls) and interactive-aware exact text tie-breaking (`<button><span>Save</span></button>` clicks the button rather than a full-width wrapper `<div>`).
  - Seamless same-origin AND cross-origin OOPIF iframe piercing via chained selectors (e.g. `iframe#pay >> role=button[name="Pay"]`).
  - Fluent immutable `Locator` API (`tab.locator('.card').filter({ hasText: 'Pro' }).locator('button').first().click()` and `frameLocator(...)`) plus reverse stable locator generation (`getLocatorString`, `browser_inspect_element`, `browserpilot locator`).
- **First-Class Frame Control, Popup Tab Awareness & JS Dialog History (`cdp-client.ts`, `snapshot.ts`, `tab.ts`)**:
  - Added `browser_frames` / `browserpilot frames` / `tab.page.listFrames()` listing main, same-origin, and cross-origin OOPIF frames.
  - Added `frame` targeting to `browser_snapshot` (`--frame`), `browser_evaluate` (`--frame`), and `browser_wait` (`--frame`).
  - Enhanced `ActionFeedback` (`runWithFeedback`) with adaptive post-action settling, automatic `openedTabs` detection (`target="_blank"` / `window.open`), and captured JS `dialogs` history, plus `manager.waitForPopup()` / `browser_wait({ popup: true })`.
- **Upgraded Smart Wait Engine (`packages/core/src/wait.ts`)**:
  - Upgraded `waitForSelector` to use the full locator engine and support `state: 'visible' | 'hidden' | 'attached' | 'detached'` (enabling reliable spinner/modal disappearance waits) plus `frame` targeting.
  - Added `waitForUrl` (substring/glob/regex), `waitForResponse` (with status/method filters and response body capture), `waitForFunction` (async JS polling), and `waitForText({ gone: true })`.
- **Complete Interaction & System-Context Controls (`page-controller.ts`, `tools.ts`, `cli.ts`)**:
  - Added idempotent `check()` / `uncheck()` (`browser_check` / `browserpilot check|uncheck`), multi-select `<select multiple>` arrays in `selectOption`, `range` slider & `file` support in `fillForm`, multi-point continuous `mouseStroke()` (`browser_drag({ points })` / `browserpilot drag --points`), and `action: 'press' | 'down' | 'up'` + `repeat` in `pressKey`.
  - Added `browser_clipboard` (`read`/`write` plain text & rich HTML), `browser_pdf` (`Page.printToPDF`), `browser_init_script` (`add`/`remove`/`list` persistent preload scripts), `browser_permissions` (`grant`/`reset`), and `session update` (dynamic tab group rename/recolor) — **51 MCP tools** total.
- **Full Sandbox `exec` & Action Recorder Parity (`session-manager.ts`, `action-recorder.ts`)**:
  - Exposed fluent `locator()`, `frameLocator()`, `mouse` & `keyboard` namespaces, direct action/wait/clipboard/pdf/initScript helpers, real-time `onRequest` / `onResponse` (with `await res.json()` / `res.text()`), and `getDebugger`/`getLiveEditor`/`getRecorder`/`getPerformance` in `browserpilot exec`.
  - Enhanced `ActionRecorder` to also capture concurrent XHR/Fetch API calls, dialogs, and uncaught exceptions alongside recorded user steps.
- Added comprehensive real-Chromium E2E test suite `packages/core/test/v14-control.test.ts` and expanded MCP/CLI E2E coverage in `packages/server/test/e2e-full.test.ts`.

### Fixed
- **macOS Chromium 5-Second Input Stall After Non-Text Keys (`PageController.pressKey`)**: omitted `nativeVirtualKeyCode` from synthetic CDP `Input.dispatchKeyEvent` payloads (retaining `windowsVirtualKeyCode`, `key`, `code`, `modifiers`, `commands`), eliminating a macOS Chromium AppKit input-queue stall that previously slowed subsequent `Input.dispatchMouseEvent` calls to ~5s each after `ArrowDown` / navigation keys.
- **Held Mouse Buttons & Modifiers During Drags/Strokes (`PageController.mouseMove/mouseDown/mouseUp`)**: tracked active `pressedButtonsMask` and `activeModifiersMask` across mouse and key transitions so Canvas drawing, custom sliders, and Shift+Click selections receive genuine `e.buttons` and `e.shiftKey` states.
- **Same-Origin Iframe Actionability & OOPIF URL Freshness (`PageController.ensureClickActionable`, `TabCDPSession.listFrames`)**: ran `elementFromPoint` in the target element's `ownerDocument` with frame-local coordinates, tracked `Target.targetInfoChanged` for OOPIF frame URLs, and resolved cross-origin status reliably in `listFrames()`.

## [1.3.0] - 2026-11-24

### Added
- **In-Page Breathing Glow Border & Floating Control Capsule (`content-script.ts` + `background.ts`)**: controlled Chrome tabs now display a subtle fresh cyan-mint breathing viewport border and a sleek bottom-center pill showing live AI action status (`Clicking...`, `Scrolling...`) with one-click **Pause / Resume** and **Take Over** buttons (auto-synced across page navigations and Dark/Light themes).
- **Smooth SVG Pointer Ghost Cursor, Click Ripple & Clean Screenshots**: upgraded the ghost cursor to an eased multi-step animated SVG arrow with expanding click ripple rings, and automatically hides all BrowserPilot overlays during `screenshot()` so UI elements never appear in captured images.
- **Interactive Human Handoff (`browser_handoff`, `browserpilot handoff`, sandbox `handoff()`)**: injects an in-page amber "BrowserPilot · Your Turn" card with **Done, Continue AI** and **Cancel** buttons (working in both Chrome Extension and Direct CDP modes, auto-re-injecting across navigations) for seamless human-in-the-loop logins, 2FA, CAPTCHAs, and approvals.
- **Pre-Click Actionability & Occlusion Detection (`PageController.click`)**: verifies element stability across animation frames, detects `disabled` / `pointer-events: none`, runs Shadow-DOM-aware `elementFromPoint` hit-testing, automatically re-centers elements hidden behind sticky/fixed headers, and reports exact occluding overlays (with `force: true` override).
- **Native macOS / Cross-Platform Editor Shortcut `commands` (`PageController.pressKey`)**: populates Chromium CDP `commands` (`selectAll`, `copy`, `cut`, `paste`, `undo`, `redo`, `deleteBackward`, `deleteForward`) so shortcuts work reliably inside Notion, Feishu/Lark, Google Docs, and Monaco/CodeMirror editors.
- **Smart Main-Container Scrolling & Scroll Telemetry (`PageController.scroll`)**: automatically detects inner SPA scroll containers (`main`, `div` with `overflow-y: auto|scroll`) instead of scrolling a hardcoded coordinate, returning `{ scrolled, scrollX, scrollY, maxScrollY, percentY, atTop, atBottom, container }`.
- **Visual Zoom-In Crop & Coordinate Grid Screenshots (`browser_screenshot` / `browserpilot screenshot`)**: added `zoom` (2x upscaled region crop for Canvas/Figma/tiny icons) and `grid` / `gridStep` (translucent pixel coordinate ruler overlay, auto-cleaned after capture) plus `--clip`, `--zoom`, `--grid` CLI flags.
- **Batch Form Filler (`browser_fill_form`, `browserpilot fill-form`, sandbox `fillForm()`)** and multi-browser `--client <id>` CLI targeting (45 MCP tools total).
- Added real-Chromium E2E verification suite `packages/core/test/v13-ux.test.ts` covering occlusion detection, native editor commands, smart inner-container scroll, zoom+grid screenshots, batch form filling, and interactive human handoff.

### Fixed
- **macOS Chromium `Meta`/`Control` Key Combo Stability (`PageController.pressKey`)**: tracked active modifier bitmasks across `keyDown`/`keyUp` modifier transitions to prevent Chromium macOS input-dispatcher stalls after `Cmd+A` / `Cmd+C` / `Cmd+V` shortcuts.
- **OOPIF Cross-Origin Frame Stability Check & Self-Overlay Click Guard (`PageController.ensureClickActionable`)**: preserved iframe viewport offsets during pre-click stability checks and ignored/cleared BrowserPilot's own floating control capsule if an interactive target sits behind it.

## [1.2.6] - 2026-11-24

### Fixed
- **Eliminated Chrome Extension 401 WebSocket Error Badge (`background.ts` + `daemon.ts`)**:
  - Skipped unauthenticated WebSocket fallback in `background.ts` when `config.authToken` is empty (standard Native Messaging mode), cleanly scheduling Native Messaging reconnect instead of triggering Chrome's uncatchable `WebSocket connection failed: HTTP Authentication failed` error in `chrome://extensions`.
  - Updated daemon WebSocket upgrade auth rejection from `401 Unauthorized` to `403 Forbidden` for cleaner browser error handling.

### Changed
- **Fresh Geek Extension Icon Redesign (`packages/extension/scripts/gen-icons.mjs`)**: replaced the legacy aliased dark icon with a supersampled SDF anti-aliased fresh glacier-mint to sky-cyan squircle featuring a crisp pure-white `>_` terminal prompt and 4-point pilot spark (`16px`, `32px`, `48px`, `128px`).

## [1.2.5] - 2026-11-24

### Fixed
- **Clean Tab Group Auto-Ungroup on Close & Detach (`background.ts`)**:
  - Keeps Chrome Tab Grouping enabled by default (and groups newly opened AI tabs into `browserpilot` for clear visual identification while active).
  - Automatically calls `chrome.tabs.ungroup()` on BrowserPilot-managed tabs right before `chrome.tabs.remove()` and on `detach` / `debugger.onDetach`, ensuring Chrome dissolves empty groups cleanly instead of leaving behind persistent "Saved Tab Groups" capsules in the bookmark bar.
  - Added E2E verification in `packages/extension/test/extension-e2e.test.ts` confirming `detachTab` cleanly clears `groupId`.

## [1.2.4] - 2026-11-24

### Added
- **Direct CLI Navigation & Extraction Shortcuts (`cli.ts`)**: added `browserpilot scroll`, `markdown`, `html`, `back`, `forward`, `reload`, `hover`, and `wait` top-level commands, and updated `skills/browserpilot/REFERENCE.md`.
- **Progressive-Disclosure Agent Skill (`skills/browserpilot/SKILL.md` + `REFERENCE.md`)**: rewrote skill description with concrete action triggers and negative boundary, added MCP vs CLI selection flow, explicit pure-CDP `browserpilot exec` sandbox API (preventing Playwright API hallucination), safety/pitfall guards, and split full 43-tool/locator/troubleshooting reference into `skills/browserpilot/REFERENCE.md` (with `packages/server/src/skill-doc.ts` kept in sync).
- **Simplified Chinese Documentation (`README.zh-CN.md`)**: added full Chinese README with top-level `English | 简体中文` switcher, plus npm version, GitHub Actions CI, and Node.js badges in `README.md`.
- **GitHub Repository Metadata**: configured repository homepage (`https://www.npmjs.com/package/browserpilot-cdp`) and discovery topics (`chrome-extension`, `cdp`, `mcp`, `ai-agent`, `browser-automation`, `devtools`, etc.).

### Changed
- **Clear Non-Invasive Onboarding Docs (`README.md` & `browserpilot setup`)**: documented the 3-step new-user setup flow explicitly separating **Option A (opt-in Agent Skill + CLI via `npx skills add xy-tuoren/browserpilot`)** and **Option B (MCP Server)**, and clarifying that `browserpilot setup` never modifies any agent config or skill directory.

### Fixed
- **Fast Load Detection on Long-Polling SPAs (`waitForPageLoad`)**: ignores Discourse `/message-bus/`, `longpoll`, `socket.io`, `signalr`, and hanging >2.5s requests once `document.readyState === 'complete'`, cutting `browserpilot open` time on live forums/apps from ~10s timeout down to ~1–2s.
- **30–40% Leaner AXTree Snapshots (`formatAXTree`)**: suppresses redundant/split highlight `StaticText` children already represented inside a parent `link`, `button`, `heading`, or interactive control's accessible name, and raised `filterSnapshotLines` default match cap from 25 to 40.
- **Consistent Regex Search in `network` & `console`**: `NetworkInspector.getRequests` and `ConsoleCollector.getLogs` now compile string `search` filters as case-insensitive regular expressions (with literal fallback on invalid regex syntax).
- **CSS `!important` Deduplication (`formatStylesAsText`)**: prevents duplicate `!important !important` when CDP property values already contain `!important`.

## [1.2.3] - 2026-11-24

### Fixed
- **Large Payloads Over Chrome Native Messaging (64 MB Incoming + Automatic Outgoing Chunking)**:
  - Raised `native-host.ts`'s incoming `NativeMessageDecoder` limit from 1 MB to Chrome's actual 64 MB extension-to-host limit (`NATIVE_INCOMING_MAX_BYTES`), preventing bridge disconnects on large real-world sites (e.g., GitHub `CSS.getMatchedStylesForNode`, large `Accessibility.getFullAXTree` snapshots, or full Retina PNG screenshots).
  - Added automatic `encodeNativeMessageFrames` + `BridgeChunkReassembler` (`type: 'chunk'`) so host-to-extension payloads larger than Chrome's 1 MB stdout cap are chunked and reassembled transparently.
- **Instant Native Messaging Auto-Reconnect (`background.ts`)**: once Native Messaging has connected at least once (`nativeEverConnected`), transient native-host restarts reconnect within 1 second instead of triggering a 30-second cooldown.
- **Regex Search Support in `snapshot` / `cleanHTML` / `markdown` (`filterSnapshotLines`)**: string `--search` patterns (e.g. `"BrowserPilot|CHANGELOG|packages"`) now compile as case-insensitive regular expressions, with automatic literal-substring fallback if the pattern contains invalid regex syntax.

## [1.2.2] - 2026-11-24

### Fixed
- **New-Tab `about:blank` Load Race (`waitForPageLoad` + `browser_open_tab`)**: added `ignoreAboutBlank` support so opening an `http(s)://` tab no longer resolves early on Chrome's transient initial `about:blank` document before the target page commits.
- **Cleaner `browser_styles` Output (`StylesInspector`)**: filtered out CDP implicit shorthand-expanded longhand properties (`implicit: true` / missing authored source `range`), cutting noise and LLM token usage by ~5x while preserving exact author-written CSS rules.
- **Set-of-Mark Screenshot Reliability (`captureLabeledScreenshot`)**: explicitly enables the CDP `DOM` domain before querying `DOM.getContentQuads`, ensuring `browser_labeled_screenshot` works even as the very first call on a fresh tab.
- **Default Desktop Viewport for `browserpilot browser start`**: passes `--window-size=1280,800` so headless/launched browsers render full desktop layouts instead of tiny default windows.

## [1.2.1] - 2026-11-24

### Added
- **Zero-Flag Auto-Magic `browserpilot setup`**:
  - Automatically syncs the bundled Chrome MV3 extension into an upgrade-proof stable directory (`~/.browserpilot/extension`) so Node.js / npm upgrades never break Chrome's unpacked extension path or change its ID.
  - Pre-computes Chromium's exact deterministic 32-char unpacked Extension ID (`computeChromeExtensionId`) AND scans local Chromium profiles (`Preferences` / `Secure Preferences`) for existing BrowserPilot extensions (`discoverInstalledExtensionIds`), registering Chrome Native Messaging Host (`com.browserpilot.bridge`) automatically with zero manual `--extension-id` copy-pasting.
- **`browserpilot daemon restart` & `browserpilot status`** CLI subcommands.
- **Upgraded `browserpilot doctor`**: displays stable extension sync status, expected Chrome Extension ID, auto-discovered loaded Chrome extensions, daemon PID/version/address, CLI-vs-daemon version mismatch warnings, and detailed per-browser connection info (`transport`, `extensionVersion`, `attachedTabCount`).

### Fixed
- **Native Messaging Daemon Restart Reconnection (`native-host.ts` + `daemon.ts`)**: cached the extension's `hello` handshake and re-read `~/.browserpilot/daemon.json` on WebSocket reconnect so restarting or upgrading the local daemon re-registers the Chrome extension immediately with full metadata; daemon now sends an immediate `bridge.ready` event upon registration.
- **MCP Self-Healing on Daemon Restart (`mcp.ts`)**: long-running MCP stdio servers now automatically reconnect/respawn the local daemon and retry once if the daemon restarts mid-session.
- **Debugger Conflict Detection (`background.ts`)**: distinguished `"Another debugger is already attached"` (e.g., Chrome DevTools or Playwriter) from same-extension re-attach, returning a clear actionable error instead of silently continuing.
- **Duplicate Tab Group Prevention (`background.ts`)**: queries existing `chrome.tabGroups` by window & title before creating a new group so MV3 Service Worker restarts reuse the existing tab group.
- **Restricted Tab Filtering (`SessionManager.resolveActiveTab`)**: now uses `isRestrictedUrl()` to skip `chrome-extension://`, `devtools://`, and Chrome Web Store tabs when auto-selecting an active tab.
- **Smart Chrome Binary Discovery (`cli.ts`)**: prefers installed system Google Chrome / Canary / Chromium / Brave over Playwright caches and dynamically discovers cached Chrome for Testing installs instead of hardcoding a single revision.
- **URL Ergonomics (`tools.ts`)**: bare domains like `example.com` or `localhost:3000` are automatically normalized with `https://` / `http://`, and `browser_open_tab` waits briefly for initial `domcontentloaded` so immediate snapshots see page content.

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
