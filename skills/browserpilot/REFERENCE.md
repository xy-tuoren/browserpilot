# BrowserPilot Complete Reference

## 1. All 51 MCP Tools (`browserpilot mcp`)

| Category | Tools | Key Notes |
| :--- | :--- | :--- |
| **Browser, Tabs & Frames** | `browser_status`, `browser_tabs`, `browser_frames`, `browser_open_tab`, `browser_close_tab`, `browser_select_tab` | `browser_frames` lists main, same-origin, and cross-origin OOPIF frames. `browser_open_tab` normalizes bare domains (`example.com`, `localhost:3000`). |
| **Navigation & Perception** | `browser_navigate`, `browser_history`, `browser_snapshot`, `browser_screenshot`, `browser_labeled_screenshot`, `browser_clean_html`, `browser_markdown`, `browser_inspect_element`, `browser_pinned` | `browser_snapshot` supports `frame`, `scope`, `search`, and incremental diffs. `browser_screenshot` auto-hides overlays and supports `grid` + `zoom`. `browser_inspect_element` returns `recommendedLocator`. |
| **Trusted Interaction & Waits** | `browser_click`, `browser_check`, `browser_fill`, `browser_fill_form`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_scroll`, `browser_drag`, `browser_select_option`, `browser_upload_file`, `browser_handle_dialog`, `browser_wait`, `browser_batch`, `browser_handoff` | `browser_click` checks stability/occlusion & reports newly opened popup tabs + JS dialogs. `browser_check` is idempotent. `browser_select_option` supports multi-select arrays. `browser_drag` supports multi-point `points[]` canvas strokes. `browser_press_key` supports `down`/`up`/`repeat` + native editor commands. `browser_wait` supports `selector`+`state`, `text`+`gone`, `url`, `responseUrl`, `fn`, `popup`, and `frame`. |
| **Context & System Control** | `browser_clipboard`, `browser_pdf`, `browser_init_script`, `browser_permissions`, `browser_emulate`, `browser_cookies`, `browser_storage` | `browser_clipboard` reads/writes plain text & rich HTML. `browser_pdf` exports PDF via CDP `Page.printToPDF`. `browser_init_script` injects scripts before page JS across navigations. `browser_permissions` grants/resets browser permissions. |
| **DevTools Debugging** | `browser_evaluate`, `browser_console`, `browser_network`, `browser_network_intercept`, `browser_styles`, `browser_react_info`, `browser_debugger`, `browser_live_edit`, `browser_performance`, `browser_cdp` | `browser_evaluate` supports `frame` targeting. `browser_network` with `requestId` returns headers, timing, initiator stack, and body. `browser_styles` returns clean author rules with `file:line`. |
| **Downloads, Media & Sandbox** | `browser_downloads`, `browser_action_recorder`, `browser_record`, `browser_exec` | `browser_action_recorder` captures user steps + concurrent XHR/Fetch API calls & dialogs/errors. `browser_exec` exposes fluent `locator()`, `onResponse`, `mouse`, `keyboard`, and DevTools handles. |

---

## 2. Rich & Chained Locator Syntax

Works across `click`, `check`, `fill`, `type`, `hover`, `scroll`, `select_option`, `upload_file`, `wait`, `inspect_element`, `styles`, and `react_info` — automatically prioritizes visible matches over hidden responsive duplicates and pierces Shadow DOM + same-origin & cross-origin OOPIF iframes:

- **Snapshot ref**: `e1`, `e12` (or `@e12`)
- **CSS selector**: `#submit-btn`, `.modal button[type="submit"]`
- **Chained pipeline (`>>`)**: `.card >> has-text="Pro" >> role=button[name="Upgrade"] >> first`
- **Playwright shorthands**: `button:has-text("Save"):visible`, `.card:has-text("Pro") >> button`
- **ARIA role**: `role=button[name="Save"]`, `role=button[name="Save"][exact=true]`, `role=textbox[name="Email"]`
- **Semantic attributes**: `label=Email address`, `placeholder=Search`, `testid=submit-cta`, `alt=Logo`, `title=Close`
- **Text & XPath**: `text=Continue`, `text="Exact Label"`, `text=/^Sign (in|up)$/i`, `xpath=//button[@data-action="buy"]`
- **Filters & indices**: `>> has-text="Pro"`, `>> has=.badge`, `>> visible=true|false`, `>> first`, `>> last`, `>> nth=1` / `>> nth=-1`
- **Cross-iframe piercing**: `iframe#checkout >> role=button[name="Pay"]` (works for both same-origin and cross-origin OOPIF iframes)
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

# Tabs, frames & navigation
browserpilot tabs
browserpilot frames [--tab <id>]
browserpilot open <url> [--tab-group <name>]
browserpilot navigate <url> [--tab <id>]
browserpilot back | forward | reload [--ignore-cache] [--tab <id>]
browserpilot close <tabId>

# Perception, locators & screenshots
browserpilot snapshot [--tab <id>] [--search "<regex>"] [--scope "<css|ref>"] [--frame "<frame>"] [--full]
browserpilot markdown [--search "<regex>"] [--full] [--tab <id>]
browserpilot html [--selector "<css>"] [--search "<regex>"] [--full] [--tab <id>]
browserpilot locator <ref|selector> [--tab <id>]
browserpilot screenshot [outputPath] [--full-page] [--grid] [--zoom x,y,w,h] [--clip x,y,w,h] [--tab <id>]
browserpilot labeled-screenshot [outputPath] [--tab <id>]

# Actions & waits
browserpilot click <ref|locator> [--force] [--double] [--button left|right|middle] [--modifiers Meta,Shift] [--tab <id>]
browserpilot check | uncheck <ref|locator> [--force] [--tab <id>]
browserpilot fill <ref|locator> <value> [--tab <id>]
browserpilot fill-form '<json-fields>' [--tab <id>]
browserpilot select <ref|locator> <val1> [val2...] [--tab <id>]
browserpilot upload <ref|locator> <file1> [file2...] [--tab <id>]
browserpilot type [target] <text> [--tab <id>]
browserpilot key <Enter|Escape|Cmd+a|ArrowDown> [--down|--up] [--repeat <N>] [--tab <id>]
browserpilot hover <ref|locator> [--tab <id>]
browserpilot drag <from> <to> [--steps <N>] | --points "x1,y1;x2,y2;..." [--tab <id>]
browserpilot scroll [down|up|left|right] [--amount <px>] [--target <ref|sel>] [--tab <id>]
browserpilot dialog <accept|dismiss> [--prompt <text>] [--auto] [--tab <id>]
browserpilot wait [--selector "<loc>"] [--state visible|hidden|attached|detached] [--text "<str>"] [--gone] [--url "<pat>"] [--response "<url>"] [--fn "<js>"] [--popup] [--frame "<f>"] [--ms <N>] [--timeout <ms>]
browserpilot handoff "<message>" [--timeout <ms>] [--tab <id>]

# Context, clipboard, PDF & permissions
browserpilot clipboard <read|write> [text] [--html "<html>"] [--tab <id>]
browserpilot pdf [outputPath] [--landscape] [--scale <N>] [--pages "1-2"] [--tab <id>]
browserpilot init-script <add|remove|list> [jsOrId] [--run-now] [--tab <id>]
browserpilot permissions <grant|reset> [clipboard-read,geolocation,...] [--origin <url>] [--tab <id>]

# DevTools & profiling
browserpilot console [--level error|warn|log] [--search <str>] [--since-last] [--tab <id>]
browserpilot network [--failed] [--search <str>] [--request-id <id>] [--since-last] [--tab <id>]
browserpilot styles <ref|locator> [--tab <id>]
browserpilot react <ref|locator> [--tab <id>]
browserpilot eval '<js>' [--frame "<frame>"] [--tab <id>]
browserpilot perf [metrics|heap|trace_start|trace_stop|cpu_start|cpu_stop] [--tab <id>]

# Downloads & action recording
browserpilot downloads [list|wait|clear] [--dir <path>] [--pattern <regex>] [--tab <id>]
browserpilot record-actions [start|stop|status] [--format all|skill|script|batch] [--tab <id>]

# Stateful JS sessions
browserpilot session new [--tab-group <name>] [--tab-group-color <color>]
browserpilot session list | update <id> [--tab-group <name>] [--tab-group-color <color>] | reset <id> | close <id>
browserpilot exec -s <id> -e '<js>' [--tab <id>] [--timeout <ms>]
browserpilot exec -s <id> -f <script.js> [--tab <id>]
```

---

## 4. `browserpilot exec` Sandbox API

Inside `browserpilot exec -s <id> -e '...'` (or MCP `browser_exec`):

- `state`: persistent object kept across calls within the same session ID.
- `tabs`: `list()`, `open(url?)`, `use(tabIdOrUrlSubstring)`, `current()`, `close(tabId?)`.
- **Fluent Locators**:
  - `const card = await locator('.card')`
  - `await card.filter({ hasText: 'Pro', has: '.badge' }).locator('button').first().click()`
  - `const frame = await frameLocator('iframe#pay')` -> `await frame.locator('button').click()`
  - Methods: `.click()`, `.dblclick()`, `.rightClick()`, `.hover()`, `.fill()`, `.type()`, `.check()`, `.uncheck()`, `.selectOption()`, `.uploadFiles()`, `.dragTo()`, `.waitFor({ state })`, `.count()`, `.isVisible()`, `.isEnabled()`, `.isChecked()`, `.textContent()`, `.innerText()`, `.inputValue()`, `.getAttribute()`, `.boundingBox()`, `.getLocatorString()`, `.screenshot()`.
- **Direct Actions & Low-Level Input**:
  - `click`, `dblclick`, `rightClick`, `hover`, `fill`, `type`, `pressKey`, `check`, `uncheck`, `selectOption`, `uploadFiles`, `scroll`, `drag`, `mouseStroke`, `fillForm`, `handoff`, `evaluate(expr, { frame? })`, `getLocatorString`, `listFrames`.
  - `mouse`: `move(x, y, { steps? })`, `down(x, y)`, `up(x, y)`, `click(x, y)`, `wheel(dx, dy)`, `stroke(points)`.
  - `keyboard`: `press(key, { repeat? })`, `down(key)`, `up(key)`, `type(text)`.
- **Waits & Live Network Callbacks**:
  - `waitForPageLoad`, `waitForSelector(sel, { state?, frame? })`, `waitForText(txt, { gone?, frame? })`, `waitForUrl(pattern)`, `waitForResponse({ url, status?, method? })`, `waitForFunction(expr, { frame? })`, `waitForPopup({ action? })`.
  - `const off = await onResponse(async (res) => { if (res.url.includes('/api/')) state.data.push(await res.json()) })` + `onRequest(cb)`.
- **Perception, System Context & DevTools**:
  - `snapshot({ frame?, scope?, search? })`, `screenshot({ grid?, zoom? })`, `pdf(opts)`, `screenshotWithLabels`, `cleanHTML`, `markdown`, `inspect`.
  - `clipboard.read()`, `clipboard.write(text, html?)`, `addInitScript(js, { runNow? })`, `removeInitScript(id)`, `grantPermissions(perms)`, `emulate(opts)`.
  - `getLatestLogs`, `getNetwork`, `getStyles`, `getReactInfo`, `getDebugger()`, `getLiveEditor()`, `getRecorder()`, `getPerformance()`, `downloads`, `actionRecorder`, `cdp(method, params?)`, `sleep(ms)`, `createDemoVideo(opts)`.

---

## 5. Troubleshooting

| Symptom | Cause | Action |
| :--- | :--- | :--- |
| `No browser connected to BrowserPilot daemon` | Chrome is closed or extension not loaded in `chrome://extensions`. | Run `browserpilot doctor`; ask user to verify Chrome is open and BrowserPilot extension is loaded (`~/.browserpilot/extension`). |
| `Another debugger is already attached` | Chrome DevTools or another extension (e.g. Playwriter) is attached to that tab. | Ask user to close DevTools / detach the other extension on that tab, or open a new tab with `browserpilot open`. |
| `Cannot attach chrome.debugger to restricted URL` | Target tab is `chrome://`, `chrome-extension://`, `devtools://`, or Chrome Web Store. | Pass a regular web tab `--tab <id>` or open a new tab. |
| `No changes since last snapshot` | Incremental diff mode detected identical AXTree since previous call. | Pass `--full` (CLI) or `showDiffSinceLastCall: false` (MCP/sandbox). |
| Doctor warns `Version mismatch` | CLI was upgraded while an older daemon is still running. | Run `browserpilot daemon restart`. |
