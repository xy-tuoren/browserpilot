# Changelog

All notable changes to **BrowserPilot** (`browserpilot-cdp`) are documented in this file.

> BrowserPilot follows pre-1.0 Semantic Versioning (`0.x.y`) while core APIs, extension UX, and real-world site compatibility continue to mature toward `1.0.0`.

## [Unreleased]

## [0.4.0] - 2026-11-26

### Added
- **Full Feature Parity & Beyond Claude in Chrome / ChatGPT Browser Extension (`browser_find`, `browser_gif`, `browser_tabs_context`, `browser_shortcuts`, `browser_schedule`, `browser_memory`, `Trust This Site`)**:
  - **Bilingual Natural-Language Fuzzy Element Finder (`browser_find` / `page.find` / `browserpilot find`)**: Multi-signal semantic scorer (English + Chinese synonyms, accessible name, visible text, placeholder, section heading context, role/tag intent) piercing open Shadow DOM, same-origin iframes, and cross-origin OOPIF frames — automatically registering live clickable `[eN]` refs without needing a full-page snapshot (included directly in the default 20-tool `core` MCP profile!).
  - **Native Step-Frame Animated GIF Creator (`browser_gif` / `tab.gif` / `browserpilot gif` + `.gif` in `browser_record`)**: Automatically captures keyframes on browser interactions with red click indicator rings, bilingual action caption pills, and step progress bars, exporting via 2-pass `ffmpeg` `palettegen`+`paletteuse` OR a built-in zero-dependency pure-TypeScript GIF89a LZW encoder (`packages/core/src/gif-encoder.ts`).
  - **Parallel Multi-Tab Context Synthesis & Chrome Tab Group Auto-Organization (`browser_tabs_context` / `browserpilot tabs read-all|group|ungroup|organize` + Side Panel `整理标签`)**: Reads titles, URLs, headings, and compact summaries/Markdown/interactive snapshots across multiple open tabs concurrently via `Promise.all`, and auto-groups Chrome tabs into color-coded Chrome Tab Groups by `domain` or `topic`.
  - **Saved Workflow Shortcuts, Daemon Recurring Scheduler & Local-First Site Memory (`packages/server/src/{shortcuts-memory,scheduler}.ts`)**: Added reusable `/shortcut` flows (`~/.browserpilot/shortcuts/`), Daemon recurring background task scheduler (`~/.browserpilot/schedules.json`, `/api/schedules`, `browser_schedule` / `browserpilot schedule`), and local-first per-domain Site Memory (`~/.browserpilot/memory.json`, `browser_memory` / `browserpilot memory`) with zero cloud upload.
  - **Per-Site Granular Permission Memory (`允许本次` / `信任本站` / `拒绝`)**: Upgraded the in-page high-risk approval card (`packages/core/src/page/handoff.ts`) with a 3rd **`信任本站` (`Trust This Site`)** action persisted to `~/.browserpilot/trusted-domains.json` and synced to the Extension Side Panel **`安全 / Security`** tab where trusted sites can be inspected and revoked anytime.
- **Core CDP & MV3 Extension Performance Overhaul**:
  - **Single-RPC Fused Actionability & Scroll+Rect Fast Path (`packages/core/src/page/actionability.ts`, `page/input.ts`, `page-controller.ts`, `page/forms.ts`)**: Fused 2-rAF bounding-box stability + disabled/pointer-events/Shadow-DOM `elementFromPoint` occlusion + sticky-header nudge into a single in-page `Runtime.callFunctionOn` round-trip, combined scroll-check + viewport rect reads, made non-critical visual cues (`highlightElement`, `moveGhostCursor`, `setControlBanner`) fire-and-forget, and removed unnecessary multi-step mouse interpolation on single clicks — cutting real Chromium click latency by **~26.5%** (`73.6ms -> 54.1ms`, near the 2-rAF hardware floor) and fill latency by **~29.6%** (`40.5ms -> 28.5ms`).
  - **Cached Base Domain Setup, Concurrent Snapshot Capture & Native Skia Screenshot Downscaling (`packages/core/src/{cdp-client,snapshot,tab}.ts`, `page/capture.ts`)**: Cached `ensureBaseDomains()` + per-child `Accessibility.enable`, parallelized `Runtime.evaluate(meta)` + `Accessibility.getFullAXTree` + `DOMSnapshot.captureSnapshot` + OOPIF child AXTree fetches, parallelized `runWithFeedback` pre/post queries, and switched `screenshot({ maxDimension })` to native CDP `Page.captureScreenshot` `clip.scale` hardware downscaling (zero multi-MB base64 JS round-trip, 100% immune to strict `img-src 'self'` CSP).
  - **Eliminated Extension IPC Storm (`packages/extension/src/bg/{rpc,state}.ts`)**: Removed noisy per-command `Runtime.evaluate` / `Input.dispatchMouseEvent` activity logs and added 120ms coalescing throttle to `broadcastUiUpdate()`.
- **Smart Large-Page Snapshot Budgeting (`viewportOnly`, `maxChars`, Shadow-Piercing `scope`) (`packages/core/src/snapshot.ts`, `tools/navigation.ts`, `cli/commands.ts`)**:
  - Added single-call `DOMSnapshot.captureSnapshot` viewport filtering (`viewportOnly: true` / `--viewport`) cutting 11,000-node admin table snapshots by **98.7%** (`20,517 -> 257` tokens) and real public pages (GitHub / Wikipedia / MDN) by **78%–92%**.
  - Added soft `maxChars` budgeting (default `32000` in MCP `browser_snapshot`, `0` disables) applied *after* incremental diffing so diffs remain compact even on gigantic pages, plus Shadow-DOM-piercing `scope` resolution via `DOM.describeNode({ pierce: true })`.
- **Extension Side Panel Security Controls & Live AI Action Feed Export (`packages/extension/src/{sidepanel,background,bg,i18n}`, `packages/server/src/{tools,daemon}.ts`)**:
  - Added a dedicated **`安全 / Security`** tab in the Companion Side Panel for 3-way approval mode switching (`关闭 / 仅高危 / 严格`), live `profileLabel` sync to Daemon, and interactive Blocked/Allowed domain chip lists (with one-click **Block Current Site**).
  - Streamed high-level MCP/CLI tool actions with timing and replayable step metadata into Side Panel **`动态 / Activity`** via `extension.logActivity`, with one-click **`导出 flow.json`** in both Activity and Record tabs.
- **Managed Chrome Launcher & Zero-Daemon Headless CI Replay (`packages/server/src/cli/launch.ts`, `cli/replay.ts`)**:
  - Added `browserpilot launch [--headless] [--port N] [--profile <dir>|--ephemeral] | status | stop` (plus SDK `launchManagedBrowser` / `stopManagedBrowser` / `getManagedBrowserStatus`) with automatic free-port allocation and ephemeral temp-profile cleanup.
  - Added `browserpilot run <flow.json> --headless [--trace report.html]` so the exact same recorded workflow runs zero-edit in both your logged-in Chrome and isolated headless CI with zero daemon dependency.
- **Multi-Archetype Complex-Page E2E Suite & Reproducible MCP Agent Eval (`packages/core/test/complex-pages-{a,b}.test.ts`, `scripts/agent-eval.mjs`)**:
  - Added 7 real-Chromium complex page archetypes (11k-DOM enterprise admin table + cascading selects + Portal combobox + stacked Modal/Drawer, collaborative `contenteditable` slash/`@mention`/CodeMirror editor, 3-level nested Shadow DOM Web Components + `<slot>`, 2-level nested cross-origin + OOPIF iframes, IntersectionObserver infinite scroll + Kanban HTML5 DnD + Pointer sortable list, interactive Canvas + SVG/`foreignObject` + Mobile H5 touch gestures, and strict CSP + History SPA + OAuth popup + 503 route recovery + prompt-injection boundary) plus runnable `node scripts/agent-eval.mjs`.

### Fixed
- **Table-Layout Websites Returning 0 Snapshot Refs (`packages/core/src/snapshot.ts`)**: Stopped hard-skipping `LayoutTable`, `LayoutTableRow`, and `LayoutTableCell` without recursing children, restoring full AXTree refs on table-layout sites such as Hacker News (`0 -> 223` refs) and legacy enterprise ERPs.
- **Same-Site Cross-Origin + Nested OOPIF Locator & Coordinate Resolution (`packages/core/src/locator/evaluator.ts`, `cdp-client.ts`, `page/actionability.ts`)**: Fixed `matchChildSession()` not to fall back blindly to an unrelated OOPIF when `desc.src` does not match, added `session.resolveFrame()` `contextId` handoff for in-process same-site cross-origin iframes (e.g. `app.company.com -> billing.company.com`), enabled recursive `Target.setAutoAttach` inside child iframe sessions, and walked nested `parentSessionId` chains in `getIframeOffset()`.
- **Post-Action `returnDiff: true` Missing Status Text Updates (`packages/server/src/tools/guardrails.ts`)**: Switched `appendPostActionDiff` from `interactiveOnly: true` to `viewportOnly: true, showDiffSinceLastCall: true, maxChars: 6000` so status labels, error toasts, and newly mounted controls all appear cleanly in single-turn diffs.
- **CLI Boolean Flag Parsing (`packages/server/src/cli/args.ts`)**: Prevented strictly boolean CLI flags (such as `--headless`, `--viewport`, `--diff`) from consuming subsequent positional arguments (e.g. `browserpilot run --headless flow.json`).

## [0.3.0] - 2026-11-26

### Changed
- **Full Simplified Chinese Default Across All In-Page UI Surfaces (`packages/extension`, `packages/core/src/page/handoff.ts`)**:
  - In-page floating control capsule (`运行中` / `已暂停` / `暂停` / `恢复` / `接管`), live action status & highlight labels (`正在点击` / `正在输入` / `向下滚动` / `等待你操作…`), Element Picker / Pin / Codegen assertion toasts, right-click context menu (`固定此元素到 BrowserPilot`), and Human Handoff card (`请你手动完成操作` / `我已完成，继续执行` / `取消`) now all default to Simplified Chinese (`zh`) and follow the Popup / Side Panel `中文` <-> `EN` toggle.
  - Added automatic cleanup of orphaned `#__browserpilot_ui_host` overlays (skipping discarded Memory-Saver tabs) and on-demand `content-script.js` injection across already-open tabs after extension reload so open webpages update immediately without refreshing, stripped broken `sourceMappingURL` comments from unpacked extension bundles, and added automated `chrome.developerPrivate` Error Console assertions (`runtimeErrors === []`, `runtimeWarnings === []`, `manifestErrors === []`) to the real Chrome MV3 E2E suite.

### Added
- **Multi-Browser / Multi-Profile Routing & Auto-Start Daemon Service (`packages/server/src/daemon.ts`, `cli/service.ts`)**:
  - Added `browserpilot clients`, `browserpilot daemon use <clientId|browser|profile>`, and `--browser` / `--profile` CLI targeting across concurrent Chrome, Edge, Brave, Opera, Vivaldi, and Direct-CDP connections.
  - Added opt-in cross-platform user auto-start daemon service commands (`browserpilot daemon install-service` / `uninstall-service`) for macOS LaunchAgents, Linux `systemd --user`, and Windows Startup.
- **Windows CI (`windows-latest`), UTF-16LE Extension IDs & Chrome ErrorConsole Gate (`.github/workflows/ci.yml`, `packages/server/src/native-install.ts`, `packages/extension/test/extension-e2e.test.ts`)**:
  - Expanded GitHub Actions CI matrix to `ubuntu-latest`, `macos-latest`, and `windows-latest` with real Chrome for Testing + `ffmpeg`, fixed Windows `computeChromeExtensionId()` to match Chromium's `GenerateIdForPath` (UTF-16LE + uppercase drive letter), and enforced zero `manifestErrors`, `runtimeErrors`, and `runtimeWarnings` via `chrome.developerPrivate.getExtensionsInfo()`.
- **Real-World SPA Interaction Hardening (`packages/core/src/page/{forms,context,input}.ts`, `page-controller.ts`, `tools/interaction.ts`)**:
  - Hardened `fill()` for ProseMirror/Slate/TipTap/Draft.js `contenteditable` editors via native CDP `Cmd/Ctrl+A` + `Backspace` + `insertText` fallback.
  - Added virtual-scroll finder `page.scrollUntil(target, opts)` (`browser_scroll` `untilTarget` / CLI `scroll --until`) for lazily mounted infinite lists and tables.
  - Added auto-detected HTML5 native `draggable="true"` `DataTransfer` drag-and-drop (`mode: 'auto' | 'pointer' | 'html5'`) and mobile CDP Touch gestures (`page.tap` / `page.swipe` / `browser_touch` / CLI `tap` & `swipe`).
- **Single-Turn Post-Action Compact Diff (`returnDiff: true` / `--diff`)**:
  - Interaction tools (`browser_click`, `browser_fill`, `browser_fill_form`, `browser_check`, `browser_select_option`, `browser_press_key`, `browser_scroll`, `browser_drag`, `browser_touch`) can now append a compact interactive AXTree diff right in the action response, cutting LLM round-trips in half.
- **Security Guardrails Suite (`packages/protocol/src/security.ts`, `packages/core/src/page/handoff.ts`, `packages/server/src/tools/guardrails.ts`)**:
  - **Action-Level Risk Approval (`BROWSERPILOT_APPROVAL_MODE=high-risk|strict`)**: Detects high-risk financial/destructive actions and sensitive domains, displaying a bilingual in-page confirmation card (`允许本次` / `拒绝`) before execution.
  - **Default Secret Redaction**: Automatically redacts `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, password values, Bearer tokens, and secret query parameters in Trace reports and `browser_network` detail output (`includeSensitive: true` to opt out).
  - **Prompt-Injection Untrusted Content Boundary**: `--wrap-untrusted` (`wrapUntrusted: true` / `BROWSERPILOT_UNTRUSTED_BOUNDARY=1`) wraps page snapshots, Markdown, and HTML in `<untrusted_page_content>` boundary tags.
  - **Optional Restricted `exec` Sandbox (`--restricted-sandbox` / `BROWSERPILOT_SANDBOX_MODE=restricted`)**: Blocks `child_process`, `fs`, `net`, `http`, and arbitrary module imports inside `browser_exec`.
- **Streamable HTTP MCP Transport & Workflow Replay CLI (`packages/server/src/mcp.ts`, `cli/replay.ts`)**:
  - Added Bearer-token-authenticated Streamable HTTP MCP mode (`browserpilot mcp --http --port 19889`) serving `/mcp` and `/health` via `StreamableHTTPServerTransport`.
  - Added `browserpilot run <flow.json> [--trace report.html] [--open]` to replay recorded Codegen / `browser_batch` workflows with assertions (`assert_visible`, `assert_text`, `assert_value`) and automatic Trace Viewer reporting.
- **Interactive-Only Compact Snapshot Mode (`snapshot -i` / `--interactive` / `interactiveOnly: true`)**:
  - Emits only interactive controls (`[e1]`, `[e2]`...) and enclosing container landmarks that actually hold interactive descendants, cutting snapshot token usage by ~60–75% on content-heavy pages while maintaining independent full vs interactive diff baselines.
- **Tiered Low-Token MCP Tool Profiles (`packages/server/src/mcp.ts`, `cli.ts`)**:
  - `browserpilot mcp` now advertises a lean **19-tool `core` profile** (+ `browser_exec` Code Mode) by default (`12.2 KB` / ~3,038 schema tokens vs `30.8 KB` / ~7,711 tokens in `--full`, cutting upfront MCP schema tokens by **60.6%**); pass `--full` (or `BROWSERPILOT_MCP_CAPS=all`) for all 53 tools, or `--caps=interaction,extraction,devtools,context,media` to enable specific tool groups.
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
