---
name: browserpilot
description: Control, automate, and debug the user's real logged-in Chrome browser (existing cookies, logins, and tabs) via BrowserPilot CLI or MCP. Use when the user asks to open or interact with web pages, click buttons, fill forms, handle JS-heavy or authenticated sites, take screenshots, inspect console errors, failed network requests, CSS styles, React components, performance/Web Vitals, downloads, or record browser flows. Do not use for simple static public page reads that do not need a browser.
---

# BrowserPilot — Real Chrome Automation & DevTools

BrowserPilot controls the user's running Chrome browser (with existing logins, cookies, and tabs) or a Direct CDP Chromium instance via pure CDP with zero per-tab confirmation clicks.

## 1. Choose Mode (MCP vs CLI)

- **If `browser_*` MCP tools are available in this session**: prefer calling them directly (`browser_screenshot` and `browser_labeled_screenshot` return inline image blocks automatically).
- **Otherwise use the `browserpilot` CLI** in the shell.
- If a command reports no browser connected, run `browserpilot doctor` to diagnose (extension not loaded in `chrome://extensions` vs daemon stopped) and tell the user clearly instead of guessing.

## 2. Core Workflow

1. **Discover or open tabs first**:
   ```bash
   browserpilot tabs
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
   - Use `labeled-screenshot` (Set-of-Mark overlays) when visual layout or icon-only buttons matter.
3. **Interact with trusted CDP input**:
   ```bash
   browserpilot fill e4 "alice@example.com" --tab <id>
   browserpilot click e5 --tab <id>
   browserpilot key Enter --tab <id>
   ```
   Targets accept snapshot refs (`e5`), CSS selectors (`#submit`), `role=button[name="Save"]`, `label=Email`, `placeholder=Search`, `text=Continue`, `>> nth=N`, or `pinned`.
4. **Inspect & debug like Chrome DevTools**:
   ```bash
   browserpilot console --level error --since-last --tab <id>
   browserpilot network --failed --tab <id>
   browserpilot styles "#submit-btn" --tab <id>
   browserpilot react "#submit-btn" --tab <id>
   browserpilot perf metrics --tab <id>
   ```

## 3. Stateful JS Sandbox (`browserpilot exec`)

Use `session new` + `exec` when chaining multiple steps or persisting variables across calls.

> **Important:** BrowserPilot is **pure CDP, NOT Playwright** — do **not** call `page.locator(...)` or Playwright APIs. Use `t.page.*` and the built-in helpers below.

```bash
SID=$(browserpilot session new --tab-group work)
browserpilot exec -s "$SID" -e '
  const t = await tabs.open("http://localhost:3000");
  state.tab = t;
  await waitForSelector("#email", { tab: t });
  await t.page.fill("#email", "alice@example.com");
  await t.page.click("role=button[name=\"Sign in\"]");
  console.log(await snapshot({ tab: t }));
'
```

Available sandbox globals: `state`, `tabs` (`list`, `open`, `use`, `current`, `close`), `snapshot`, `screenshot` (supports `grid`, `zoom`), `screenshotWithLabels`, `cleanHTML`, `markdown`, `inspect`, `fillForm`, `handoff`, `getLatestLogs`, `getNetwork`, `getStyles`, `getReactInfo`, `waitForPageLoad`, `waitForSelector`, `waitForText`, `downloads`, `actionRecorder`, `cdp`, `sleep`, `createDemoVideo`.

## 4. Safety & Pitfalls

- **Confirm before irreversible actions**: ask the user before submitting payments, deletions, account/security modifications, or publishing public posts.
- **Human Handoff for CAPTCHAs / 2FA / Manual steps**: never bypass Cloudflare Turnstile, reCAPTCHA, passkeys, or OTP prompts — use `browser_handoff` / `browserpilot handoff "<instruction>"` so an in-page "Your Turn" card appears in Chrome and resumes automatically when the user clicks "Done, Continue AI".
- **Debugger conflict**: if Chrome reports `Another debugger is already attached`, Chrome DevTools or another extension (e.g. Playwriter) holds that tab — ask the user to close DevTools on that tab or open a fresh tab with `browserpilot open`.
- **Restricted URLs**: Chrome forbids attaching to `chrome://`, `chrome-extension://`, `devtools://`, and Chrome Web Store pages.
- **Profile safety**: never attempt profile-wide cookie/cache wipes (blocked by BrowserPilot); use page-scoped `browser_cookies` instead.

## 5. Detailed Reference

For all 43 MCP tools, rich locator syntax, DevTools debugging/live-edit/mocking/recording workflows, and full CLI options, read [REFERENCE.md](./REFERENCE.md).
