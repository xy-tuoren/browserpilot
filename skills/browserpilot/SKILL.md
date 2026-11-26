---
name: browserpilot
description: Control, automate, and debug the user's real logged-in Chrome browser (existing cookies, logins, and tabs) via BrowserPilot CLI or MCP. Use when the user asks to open or interact with web pages, click buttons, fill forms, handle JS-heavy or authenticated sites, take screenshots, inspect console errors, failed network requests, CSS styles, React components, performance/Web Vitals, downloads, or record browser flows. Do not use for simple static public page reads that do not need a browser.
---

# BrowserPilot — Real Chrome Automation & DevTools Guide

BrowserPilot controls the user's running Chrome browser (with existing logins, cookies, and tabs) or a Direct CDP Chromium instance via pure CDP with zero per-tab confirmation clicks.

## 1. Choose Mode (MCP vs CLI)

- **If `browser_*` MCP tools are available in this session**: prefer calling them directly (`browser_screenshot` and `browser_labeled_screenshot` return inline image blocks automatically).
- **Otherwise use the `browserpilot` CLI** in the shell.
- If a command reports no browser connected, run `browserpilot doctor` to diagnose (extension not loaded in `chrome://extensions` vs daemon stopped) and tell the user clearly instead of guessing.

## 2. Core Workflow

1. **Discover or open tabs & frames first**:
   ```bash
   browserpilot tabs
   browserpilot frames --tab <id>
   browserpilot open https://example.com --tab-group task
   ```
   Always pass `--tab <id>` (or `tabId` in MCP) when multiple tabs are open so you never act on the wrong tab.
2. **Perceive the page before acting**:
   ```bash
   browserpilot snapshot --tab <id> --search "Sign in|Submit"
   browserpilot snapshot --tab <id> --scope "main" --full
   browserpilot labeled-screenshot ./som.png --tab <id>
   ```
   - `snapshot` returns a compact AXTree with short refs (`e1`, `e2`...) plus viewport/scroll telemetry.
   - Repeated `snapshot` calls return concise diffs by default; pass `--full` (`showDiffSinceLastCall: false`) to force a full snapshot.
   - Use `labeled-screenshot` (Set-of-Mark overlays) when spatial layout or icon-only buttons matter.
3. **Interact & wait with trusted CDP input**:
   ```bash
   browserpilot fill e4 "alice@example.com" --tab <id>
   browserpilot click '.card:has-text("Pro") >> role=button[name="Continue"]' --tab <id>
   browserpilot wait --selector "#spinner" --state hidden --tab <id>
   browserpilot key Enter --tab <id>
   ```
   - Actions: `click` (checks occlusion/stability, reports newly opened popup tabs & JS dialogs; pass `force: true` to override), `check`/`uncheck` (idempotent), `fill`, `fill-form` (text/select/multi-select/checkbox/radio/range/file), `type`, `key` (`down`/`up`/`repeat` + macOS/Chrome `Cmd+a/c/v/z` editing commands), `hover`, `scroll` (smart inner SPA container detection + position telemetry), `drag` (2-point & multi-point `--points` canvas strokes), `select`, `upload` (including custom file-chooser buttons), `wait` (`selector`+`state`, `text`+`gone`, `url`, `response`, `fn`, `popup`, `frame`), `clipboard`, `pdf`, `init-script`, `permissions`, `batch`, `handoff`.
   - Targets accept refs (`e5`), CSS (`#submit`), chained `>>` pipelines (`.card >> has-text=Pro >> button >> first`), Playwright `:has-text(...)` / `:visible` shorthands, `role=`, `label=`, `placeholder=`, `testid=`, `text=`, `xpath=`, cross-iframe (`iframe#pay >> button`), or `pinned`. Visible elements are prioritized automatically.
4. **DevTools Debugging, Codegen & Visual Trace**:
   ```bash
   browserpilot console --level error --since-last --tab <id>
   browserpilot network --failed --tab <id>
   browserpilot styles "#submit-btn" --tab <id>
   browserpilot react "#submit-btn" --tab <id>
   browserpilot perf metrics --tab <id>
   browserpilot codegen https://example.com --format playwright -o flow.spec.ts
   browserpilot trace start --title "Checkout Debug" --tab <id>
   browserpilot trace stop ./trace.html --open --tab <id>
   ```
   - `browser_network_intercept` / sandbox `route()` — mock, fulfill, modify, or abort API responses via CDP `Fetch`.
   - `browser_debugger` / `browser_live_edit` — breakpoints, call frames, live JS/CSS patching.
   - `browser_action_recorder` / `browserpilot codegen` — records clicks, checks, fills, Shadow DOM/iframes, and `Alt+Shift+Click` assertions into Playwright TS, BrowserPilot JS, `browser_batch` JSON, or Agent Skill Markdown.
   - `browser_trace` / `browserpilot trace` / `browserpilot exec --trace report.html` — self-contained interactive HTML Trace Viewer with Before/After screenshots, click reticle, DOM summary, Console logs, and Network response previews.

## 3. Stateful JS Sandbox (`browserpilot exec`)

> **Important:** BrowserPilot is **100% pure CDP** — use the built-in sandbox helpers (`locator()`, `frameLocator()`, `route()`, `waitForFileChooser()`, `trace`, `t.page.*`, `mouse`, `keyboard`, `onResponse`) rather than importing Playwright.

```bash
SID=$(browserpilot session new --tab-group work)
browserpilot exec -s "$SID" --trace ./run-trace.html -e '
  const t = await tabs.open("http://localhost:3000");
  state.tab = t;
  await waitForSelector("#email", { tab: t });
  await fill("#email", "alice@example.com");
  const card = await locator(".card");
  await card.filter({ hasText: "Pro" }).locator("role=button[name=\"Sign in\"]").click();
  console.log(await snapshot({ tab: t }));
'
```

Available sandbox globals: `state`, `tabs` (`list`, `open`, `use`, `current`, `close`), `locator`, `frameLocator`, `click`, `dblclick`, `rightClick`, `hover`, `fill`, `type`, `pressKey`, `check`, `uncheck`, `selectOption`, `uploadFiles`, `waitForFileChooser`, `route`, `unroute`, `scroll`, `drag`, `mouseStroke`, `mouse`, `keyboard`, `fillForm`, `handoff`, `evaluate`, `getLocatorString`, `listFrames`, `snapshot`, `screenshot` (`grid`, `zoom`), `pdf`, `screenshotWithLabels`, `cleanHTML`, `markdown`, `inspect`, `clipboard`, `addInitScript`, `removeInitScript`, `grantPermissions`, `emulate`, `getLatestLogs`, `getNetwork`, `onRequest`, `onResponse`, `getStyles`, `getReactInfo`, `waitForPageLoad`, `waitForSelector` (`state`), `waitForText` (`gone`), `waitForUrl`, `waitForResponse`, `waitForFunction`, `waitForPopup`, `getDebugger`, `getLiveEditor`, `getRecorder`, `getPerformance`, `downloads`, `actionRecorder`, `trace`, `cdp`, `sleep`, `createDemoVideo`.

## 4. Safety & Pitfalls

- **Confirm before irreversible actions**: ask the user before submitting payments, deletions, account/security modifications, or publishing public posts.
- **Human Handoff for CAPTCHAs / 2FA / Manual steps**: never bypass Cloudflare Turnstile, reCAPTCHA, passkeys, or OTP prompts — use `browser_handoff` / `browserpilot handoff "<instruction>"` so an in-page "Your Turn" card appears in Chrome and resumes automatically when the user clicks "Done, Continue AI".
- **Debugger conflict**: if Chrome reports `Another debugger is already attached`, Chrome DevTools or another extension holds that tab — ask the user to close DevTools on that tab or open a fresh tab with `browserpilot open`.
- **Restricted URLs**: Chrome forbids attaching to `chrome://`, `chrome-extension://`, `devtools://`, and Chrome Web Store pages.
- **Profile safety**: never attempt profile-wide cookie/cache wipes (blocked automatically by BrowserPilot); use page-scoped `browser_cookies` instead.

## 5. Detailed Reference

For all 52 MCP tools, full chained/cross-iframe locator grammar, DevTools debugging/live-edit/mocking/codegen/trace workflows, and complete CLI options, read [REFERENCE.md](./REFERENCE.md).
