export const BROWSERPILOT_SKILL_DOC = `# BrowserPilot — Real Chrome Automation & DevTools Guide

BrowserPilot controls the user's running Chrome browser (existing logins, cookies, tabs) or a Direct CDP Chromium instance via pure CDP with zero per-tab confirmation clicks.

## 1. Choose Mode (MCP vs CLI)
- If \`browser_*\` MCP tools are available in this session, prefer calling them directly (screenshots return inline image blocks automatically).
- Otherwise use the \`browserpilot\` CLI in the shell.
- If a command reports no browser connected, run \`browserpilot doctor\` to diagnose and report clearly.

## 2. Core Workflow
1. **Tabs**: \`browser_tabs\` / \`browserpilot tabs\`, or \`browser_open_tab\` / \`browserpilot open <url> --tab-group <name>\`. Always pass \`--tab <id>\` (\`tabId\`) when multiple tabs are open.
2. **Perceive**:
   - \`browser_snapshot\` / \`browserpilot snapshot --tab <id> [--search "<regex>"] [--scope "<css>"] [--full]\`
   - First call returns full AXTree with \`e1\`, \`e2\`... refs + viewport/scroll info; subsequent calls return diffs (pass \`--full\` / \`showDiffSinceLastCall: false\` for full output).
   - Use \`browser_labeled_screenshot\` / \`browserpilot labeled-screenshot <path>\` when spatial layout or icon-only buttons matter.
3. **Act (trusted CDP input)**:
   - \`click\`, \`fill\`, \`type\`, \`press_key\`, \`hover\`, \`scroll\`, \`drag\`, \`select_option\`, \`upload_file\`, \`batch\`.
   - Targets accept refs (\`e5\`), CSS selectors (\`#submit\`), \`role=button[name="Save"]\`, \`label=...\`, \`placeholder=...\`, \`text=...\`, \`>> nth=N\`, or \`pinned\`.
4. **DevTools Debugging**:
   - \`browser_console\` / \`browserpilot console --level error --since-last\`
   - \`browser_network\` / \`browserpilot network --failed\` (pass \`requestId\` for headers, timing, initiator stack, body)
   - \`browser_network_intercept\` — mock/block API responses via CDP \`Fetch\`
   - \`browser_styles\` / \`browserpilot styles <target>\` — clean author CSS rules with \`file:line\` + forced \`:hover\`/\`:focus\`
   - \`browser_react_info\` / \`browserpilot react <target>\` — React Fiber component, source \`file:line\`, props
   - \`browser_debugger\` / \`browser_live_edit\` — breakpoints, call frames, live JS/CSS patching
   - \`browser_performance\` / \`browserpilot perf metrics\` — Web Vitals (LCP/CLS/FCP/TTFB), heap, CPU/trace
   - \`browser_downloads\`, \`browser_action_recorder\`, \`browser_record\` (MP4/WebM + smart idle speedup)

## 3. Stateful JS Sandbox (\`browserpilot exec\`)
> Important: BrowserPilot is **pure CDP, NOT Playwright** — do NOT call \`page.locator(...)\`. Use \`t.page.*\` and built-in helpers.

\`\`\`bash
SID=$(browserpilot session new --tab-group work)
browserpilot exec -s "$SID" -e '
  const t = await tabs.open("http://localhost:3000");
  state.tab = t;
  await waitForSelector("#email", { tab: t });
  await t.page.fill("#email", "alice@example.com");
  await t.page.click("role=button[name=\\"Sign in\\"]");
  console.log(await snapshot({ tab: t }));
'
\`\`\`

Globals: \`state\`, \`tabs\` (\`list\`, \`open\`, \`use\`, \`current\`, \`close\`), \`snapshot\`, \`screenshot\`, \`screenshotWithLabels\`, \`cleanHTML\`, \`markdown\`, \`inspect\`, \`getLatestLogs\`, \`getNetwork\`, \`getStyles\`, \`getReactInfo\`, \`waitForPageLoad\`, \`waitForSelector\`, \`waitForText\`, \`downloads\`, \`actionRecorder\`, \`cdp\`, \`sleep\`, \`createDemoVideo\`.

## 4. Safety & Pitfalls
- Confirm with the user before irreversible actions (payments, deletions, account/security changes, public posts).
- Never bypass CAPTCHAs, Cloudflare Turnstile, or 2FA/Passkey prompts — stop and let the user complete them in Chrome.
- If \`Another debugger is already attached\` appears, ask the user to close DevTools / detach the other extension on that tab, or open a new tab with \`browserpilot open\`.
- Never wipe profile-wide cookies/cache (blocked automatically; use page-scoped \`browser_cookies\`).
`
