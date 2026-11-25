export const BROWSERPILOT_SKILL_DOC = `# BrowserPilot — Real Chrome Automation & DevTools Guide

BrowserPilot controls the user's running Chrome browser (existing logins, cookies, tabs) or a Direct CDP Chromium instance via pure CDP with zero per-tab confirmation clicks.

## 1. Choose Mode (MCP vs CLI)
- If \`browser_*\` MCP tools are available in this session, prefer calling them directly (screenshots return inline image blocks automatically).
- Otherwise use the \`browserpilot\` CLI in the shell.
- If a command reports no browser connected, run \`browserpilot doctor\` to diagnose and report clearly.

## 2. Core Workflow
1. **Tabs & Frames**: \`browser_tabs\` / \`browserpilot tabs\`, \`browser_frames\` / \`browserpilot frames\`, or \`browser_open_tab\` / \`browserpilot open <url> --tab-group <name>\`. Always pass \`--tab <id>\` (\`tabId\`) when multiple tabs are open.
2. **Perceive**:
   - \`browser_snapshot\` / \`browserpilot snapshot --tab <id> [--search "<regex>"] [--scope "<css>"] [--frame "<frame>"] [--full]\`
   - First call returns full AXTree with \`e1\`, \`e2\`... refs + viewport/scroll info; subsequent calls return diffs (pass \`--full\` / \`showDiffSinceLastCall: false\` for full output).
   - Use \`browser_labeled_screenshot\` / \`browserpilot labeled-screenshot <path>\` when spatial layout or icon-only buttons matter.
3. **Act & Wait (trusted CDP input)**:
   - \`click\` (checks occlusion/stability, reports newly opened popup tabs & JS dialogs; pass \`force: true\` to override), \`check\`/\`uncheck\` (idempotent), \`fill\`, \`fill_form\` (text/select/multi-select/checkbox/radio/range/file), \`type\`, \`press_key\` (\`down\`/\`up\`/\`repeat\` + macOS/Chrome \`Cmd+a/c/v/z\` editing commands), \`hover\`, \`scroll\` (smart inner SPA container detection + position telemetry), \`drag\` (2-point & multi-point \`points[]\` canvas strokes), \`select_option\` (single & multi-select), \`upload_file\`, \`wait\` (\`selector\`+\`state: visible|hidden|attached|detached\`, \`text\`+\`gone\`, \`url\`, \`responseUrl\`, \`fn\`, \`popup\`, \`frame\`), \`clipboard\`, \`pdf\`, \`init_script\`, \`permissions\`, \`batch\`, \`handoff\`.
   - Targets accept refs (\`e5\`), CSS (\`#submit\`), chained \`>>\` pipelines (\`.card >> has-text=Pro >> button >> first\`), Playwright \`:has-text(...)\` / \`:visible\` shorthands, \`role=\`, \`label=\`, \`placeholder=\`, \`testid=\`, \`text=\`, \`xpath=\`, cross-iframe (\`iframe#pay >> button\`), or \`pinned\`. Visible matches are prioritized automatically.
4. **DevTools Debugging**:
   - \`browser_console\` / \`browserpilot console --level error --since-last\`
   - \`browser_network\` / \`browserpilot network --failed\` (pass \`requestId\` for headers, timing, initiator stack, body)
   - \`browser_network_intercept\` — mock/block API responses via CDP \`Fetch\`
   - \`browser_styles\` / \`browserpilot styles <target>\` — clean author CSS rules with \`file:line\` + forced \`:hover\`/\`:focus\`
   - \`browser_react_info\` / \`browserpilot react <target>\` — React Fiber component, source \`file:line\`, props
   - \`browser_debugger\` / \`browser_live_edit\` — breakpoints, call frames, live JS/CSS patching
   - \`browser_performance\` / \`browserpilot perf metrics\` — Web Vitals (LCP/CLS/FCP/TTFB), heap, CPU/trace
   - \`browser_downloads\`, \`browser_action_recorder\` (captures steps + API calls & dialogs), \`browser_record\` (MP4/WebM + smart idle speedup)

## 3. Stateful JS Sandbox (\`browserpilot exec\`)
> Pure CDP — use the built-in \`locator()\`, \`frameLocator()\`, \`mouse\`, \`keyboard\`, \`onResponse\`, and \`t.page.*\` helpers rather than importing Playwright.

\`\`\`bash
SID=$(browserpilot session new --tab-group work)
browserpilot exec -s "$SID" -e '
  const t = await tabs.open("http://localhost:3000");
  state.tab = t;
  await waitForSelector("#email", { tab: t });
  await fill("#email", "alice@example.com");
  const card = await locator(".card");
  await card.filter({ hasText: "Pro" }).locator("role=button[name=\\"Sign in\\"]").click();
  console.log(await snapshot({ tab: t }));
'
\`\`\`

Globals: \`state\`, \`tabs\` (\`list\`, \`open\`, \`use\`, \`current\`, \`close\`), \`locator\`, \`frameLocator\`, \`click\`, \`dblclick\`, \`rightClick\`, \`hover\`, \`fill\`, \`type\`, \`pressKey\`, \`check\`, \`uncheck\`, \`selectOption\`, \`uploadFiles\`, \`scroll\`, \`drag\`, \`mouseStroke\`, \`mouse\`, \`keyboard\`, \`fillForm\`, \`handoff\`, \`evaluate\`, \`getLocatorString\`, \`listFrames\`, \`snapshot\`, \`screenshot\`, \`pdf\`, \`screenshotWithLabels\`, \`cleanHTML\`, \`markdown\`, \`inspect\`, \`clipboard\`, \`addInitScript\`, \`removeInitScript\`, \`grantPermissions\`, \`emulate\`, \`getLatestLogs\`, \`getNetwork\`, \`onRequest\`, \`onResponse\`, \`getStyles\`, \`getReactInfo\`, \`waitForPageLoad\`, \`waitForSelector\`, \`waitForText\`, \`waitForUrl\`, \`waitForResponse\`, \`waitForFunction\`, \`waitForPopup\`, \`getDebugger\`, \`getLiveEditor\`, \`getRecorder\`, \`getPerformance\`, \`downloads\`, \`actionRecorder\`, \`cdp\`, \`sleep\`, \`createDemoVideo\`.

## 4. Safety & Pitfalls
- Confirm with the user before irreversible actions (payments, deletions, account/security changes, public posts).
- Never bypass CAPTCHAs, Cloudflare Turnstile, or 2FA/Passkey prompts — stop and let the user complete them in Chrome.
- If \`Another debugger is already attached\` appears, ask the user to close DevTools / detach the other extension on that tab, or open a new tab with \`browserpilot open\`.
- Never wipe profile-wide cookies/cache (blocked automatically; use page-scoped \`browser_cookies\`).
`
