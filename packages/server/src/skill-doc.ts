export const BROWSERPILOT_SKILL_DOC = `# BrowserPilot — Zero-Click Pure-CDP Browser Control & DevTools Guide

BrowserPilot controls your real logged-in Chrome browser (existing cookies, logins, extensions) via pure CDP with **zero manual confirmation clicks**.

## Core Workflow (Fast & Token-Efficient)

1. **Discover tabs**: \`browser_tabs\` (or \`browserpilot tabs\`) — lists all tabs with \`tabId\`, URL, and title.
2. **Navigate or pick existing tab**: \`browser_open_tab\` / \`browser_select_tab\` / \`browser_navigate\`. BrowserPilot auto-attaches \`chrome.debugger\` on demand with zero clicks.
3. **Perceive the page**:
   - Prefer \`browser_snapshot\` (compact AXTree with \`e1\`, \`e2\`... refs + automatic incremental diffs).
   - Use \`scope\` (CSS selector/ref) or \`search\` on large pages to save tokens.
   - Use \`browser_labeled_screenshot\` (Set-of-Mark overlays) when visual layout matters.
4. **Interact with trusted CDP input**:
   - \`browser_click\`, \`browser_fill\`, \`browser_type\`, \`browser_press_key\`, \`browser_select_option\`, \`browser_drag\`, \`browser_upload_file\`.
   - Every action automatically reports newly thrown Console errors and failed Network requests.
5. **Debug like Chrome DevTools**:
   - \`browser_console\` (\`sinceLastCall: true\`) — logs, warnings, uncaught exceptions with stacks.
   - \`browser_network\` (\`failedOnly: true\`, or pass \`requestId\` for headers, timing, JS initiator stack, and response body).
   - \`browser_network_intercept\` — mock/block API responses via CDP \`Fetch\`.
   - \`browser_styles\` — matched/inherited CSS rules with \`file:line\` + forced \`:hover\`/\`:focus\`.
   - \`browser_react_info\` — React Fiber component name, dev source \`file:line\`, hierarchy, props.
   - \`browser_debugger\` — breakpoints, pause/step, local scope variables, evaluate in call frame.
   - \`browser_live_edit\` — grep loaded scripts and live-patch JS/CSS in memory.
   - \`browser_performance\` — Core Web Vitals (LCP/CLS/FCP/TTFB), heap summary, CPU profiler, Tracing insights.
   - \`browser_emulate\` — viewport, mobile, dark mode, CPU throttling, Slow 3G / offline.
   - \`browser_downloads\` — configure download folder, list downloads, or wait for a file download to complete with its local path.
   - \`browser_action_recorder\` — record user clicks/fills/selects/navigations into reusable batch steps, exec JS script, and Agent Skill Markdown.
   - \`browser_record\` — record MP4/WebM screencast video via \`ffmpeg\` (optional \`audio: true\`) and create smart idle-sped-up demo videos.
6. **Multi-step Stateful Sandbox (Playwriter replacement)**:
   - \`browserpilot session new --tab-group docs\` -> returns session ID (e.g. \`1\`)
   - \`browserpilot exec -s 1 -e 'const t = await tabs.open("https://example.com"); console.log(await snapshot({ tab: t }))'\`
   - Available sandbox globals: \`state\`, \`tabs\`, \`snapshot\`, \`screenshot\`, \`screenshotWithLabels\`, \`cleanHTML\`, \`markdown\`, \`inspect\`, \`getLatestLogs\`, \`getNetwork\`, \`getStyles\`, \`getReactInfo\`, \`waitForPageLoad\`, \`waitForSelector\`, \`waitForText\`, \`cdp\`, \`createDemoVideo\`.

## Safety Rules
- Never wipe profile-wide cookies/cache (BrowserPilot blocks \`Network.clearBrowserCookies\` / \`Network.clearBrowserCache\` automatically; use page-scoped \`browser_cookies\`).
- Confirm with the user before irreversible actions (payments, deletions, account/security changes, sending public posts).
`
