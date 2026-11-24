# BrowserPilot Complete Reference

## 1. All 43 MCP Tools (`browserpilot mcp`)

| Category | Tools | Key Notes |
| :--- | :--- | :--- |
| **Browser & Tabs** | `browser_status`, `browser_tabs`, `browser_open_tab`, `browser_close_tab`, `browser_select_tab` | `browser_open_tab` normalizes bare domains (`example.com`, `localhost:3000`) and waits for initial load. |
| **Navigation & Perception** | `browser_navigate`, `browser_history`, `browser_snapshot`, `browser_screenshot`, `browser_labeled_screenshot`, `browser_clean_html`, `browser_markdown`, `browser_inspect_element`, `browser_pinned` | `search` accepts case-insensitive regex (falls back to literal on invalid regex). `browser_pinned` inspects the element right-clicked with "Pin Element for BrowserPilot". |
| **Trusted Interaction** | `browser_click`, `browser_fill`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_scroll`, `browser_drag`, `browser_select_option`, `browser_upload_file`, `browser_handle_dialog`, `browser_wait`, `browser_batch` | All mouse/keyboard events dispatch real CDP `isTrusted=true` events and report newly thrown console errors + failed requests. `browser_batch` runs multiple steps in one round-trip. |
| **DevTools Debugging** | `browser_evaluate`, `browser_console`, `browser_network`, `browser_network_intercept`, `browser_styles`, `browser_react_info`, `browser_debugger`, `browser_live_edit`, `browser_performance`, `browser_emulate`, `browser_cookies`, `browser_storage`, `browser_cdp` | `browser_network` with `requestId` returns full headers, timing, JS initiator stack, and response body. `browser_styles` returns clean author-written rules with `file:line` and supports `forcePseudoStates`. |
| **Downloads, Media & Sandbox** | `browser_downloads`, `browser_action_recorder`, `browser_record`, `browser_exec` | `browser_action_recorder` exports `batch` JSON, replayable `exec` JS, and Agent Skill Markdown (auto-masking passwords). `browser_record` creates MP4/WebM videos (optional `audio: true`) and smart idle-sped-up demos. |

---

## 2. Rich Locator Syntax

Works in `click`, `fill`, `type`, `hover`, `scroll`, `select_option`, `upload_file`, `inspect_element`, `styles`, and `react_info` (pierces Shadow DOM and cross-origin OOPIF iframes):

- **Snapshot ref**: `e1`, `e12` (or `@e12`)
- **CSS selector**: `#submit-btn`, `.modal button[type="submit"]`
- **ARIA role**: `role=button[name="Save"]`, `role=link[name="Sign in"i]`, `role=textbox[name="Email"]`
- **Form label**: `label=Email address`
- **Placeholder**: `placeholder=Search packages`
- **Visible text**: `text=Continue`
- **Nth match disambiguation**: `role=button[name="Delete"] >> nth=1` (0-based)
- **User-pinned element**: `pinned` (element pinned via right-click context menu in Chrome)

---

## 3. CLI Command Reference

```bash
# Diagnostics & daemon lifecycle
browserpilot doctor [--json]
browserpilot status
browserpilot daemon start | stop | restart | status
browserpilot browser start [--headless] [--cdp-port 9222]
browserpilot connect-cdp http://127.0.0.1:9222

# Tabs & navigation
browserpilot tabs
browserpilot open <url> [--tab-group <name>]
browserpilot navigate <url> [--tab <id>]
browserpilot close <tabId>

# Perception & screenshots
browserpilot snapshot [--tab <id>] [--search "<regex>"] [--scope "<css|ref>"] [--full]
browserpilot screenshot [outputPath] [--full-page] [--tab <id>]
browserpilot labeled-screenshot [outputPath] [--tab <id>]

# Actions
browserpilot click <ref|locator> [--tab <id>]
browserpilot fill <ref|locator> <value> [--tab <id>]
browserpilot type [target] <text> [--tab <id>]
browserpilot key <Enter|Escape|Tab|...> [--tab <id>]

# DevTools & profiling
browserpilot console [--level error|warn|log] [--search <str>] [--since-last] [--tab <id>]
browserpilot network [--failed] [--search <str>] [--request-id <id>] [--since-last] [--tab <id>]
browserpilot styles <ref|locator> [--tab <id>]
browserpilot react <ref|locator> [--tab <id>]
browserpilot eval '<js>' [--tab <id>]
browserpilot perf [metrics|heap|trace_start|trace_stop|cpu_start|cpu_stop] [--tab <id>]

# Downloads & action recording
browserpilot downloads [list|wait|clear] [--dir <path>] [--pattern <regex>] [--tab <id>]
browserpilot record-actions [start|stop|status] [--format all|skill|script|batch] [--tab <id>]

# Stateful JS sessions
browserpilot session new [--tab-group <name>] [--tab-group-color <color>]
browserpilot session list | reset <id> | close <id>
browserpilot exec -s <id> -e '<js>' [--tab <id>] [--timeout <ms>]
browserpilot exec -s <id> -f <script.js> [--tab <id>]
```

---

## 4. `browserpilot exec` Sandbox API

Inside `browserpilot exec -s <id> -e '...'` (or MCP `browser_exec`):

- `state`: persistent object kept across calls within the same session ID.
- `tabs`:
  - `await tabs.list()` -> `TabInfo[]`
  - `await tabs.open(url?)` -> `BrowserPilotTab` (grouped in the session's tab group)
  - `await tabs.use(tabIdOrUrlSubstring)` -> `BrowserPilotTab`
  - `await tabs.current()` -> `BrowserPilotTab`
  - `await tabs.close(tabId?)`
- `BrowserPilotTab` (`t`):
  - `t.tabId`
  - `t.page.navigate(url, { waitUntil? })`, `t.page.reload()`, `t.page.goBack()`, `t.page.goForward()`
  - `t.page.click(target, opts?)`, `t.page.fill(target, value)`, `t.page.type(target, text)`, `t.page.pressKey(key)`
  - `t.page.hover(target)`, `t.page.scroll(opts)`, `t.page.drag(from, to)`, `t.page.selectOption(target, val)`, `t.page.uploadFiles(target, files)`
  - `t.page.evaluate(expression)`, `t.page.getUrlAndTitle()`, `t.page.screenshot(opts?)`
- Top-level helpers (all accept optional `tab: t`, defaulting to the session's active tab):
  - `await snapshot({ tab?, search?, scope?, showDiffSinceLastCall? })`
  - `await screenshot({ tab?, path?, fullPage?, maxDimension? })`
  - `await screenshotWithLabels({ tab?, path?, maxLabels? })`
  - `await cleanHTML({ tab?, selector?, search?, showDiffSinceLastCall?, includeStyles? })`
  - `await markdown({ tab?, search?, showDiffSinceLastCall? })`
  - `await inspect(target, { tab?, properties? })`
  - `await getLatestLogs({ tab?, level?, search?, sinceLastCall? })`
  - `await getNetwork({ tab?, failedOnly?, search?, sinceLastCall? })`
  - `await getStyles(target, { tab?, includeInherited?, computedProperties? })`
  - `await getReactInfo(target, { tab? })`
  - `await waitForPageLoad({ tab?, timeoutMs? })`, `await waitForSelector(selector, { tab?, timeoutMs? })`, `await waitForText(textOrRegex, { tab?, timeoutMs? })`
  - `downloads.configure(dir?)`, `downloads.list()`, `downloads.waitFor({ timeoutMs?, filenamePattern? })`
  - `actionRecorder.start({ maskPasswords? })`, `actionRecorder.stop()`, `actionRecorder.steps()`
  - `await cdp(method, params?, tab?)` — raw CDP escape hatch
  - `await sleep(ms)`, `createDemoVideo(opts)`

---

## 5. Troubleshooting

| Symptom | Cause | Action |
| :--- | :--- | :--- |
| `No browser connected to BrowserPilot daemon` | Chrome is closed or extension not loaded in `chrome://extensions`. | Run `browserpilot doctor`; ask user to verify Chrome is open and BrowserPilot extension is loaded (`~/.browserpilot/extension`). |
| `Another debugger is already attached` | Chrome DevTools or another extension (e.g. Playwriter) is attached to that tab. | Ask user to close DevTools / detach the other extension on that tab, or open a new tab with `browserpilot open`. |
| `Cannot attach chrome.debugger to restricted URL` | Target tab is `chrome://`, `chrome-extension://`, `devtools://`, or Chrome Web Store. | Pass a regular web tab `--tab <id>` or open a new tab. |
| `No changes since last snapshot` | Incremental diff mode detected identical AXTree since previous call. | Pass `--full` (CLI) or `showDiffSinceLastCall: false` (MCP/sandbox). |
| Doctor warns `Version mismatch` | CLI was upgraded while an older daemon is still running. | Run `browserpilot daemon restart`. |
