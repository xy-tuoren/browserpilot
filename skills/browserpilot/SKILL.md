---
name: browserpilot
description: Control and debug the user's real logged-in Chrome browser via BrowserPilot (zero-click pure-CDP MV3 extension, MCP server, and CLI). Replaces Playwriter and Chrome DevTools MCP with zero per-tab clicks or confirmation popups.
---

# BrowserPilot Browser Control & DevTools Skill

BrowserPilot gives you direct, zero-click control and full DevTools inspection over the user's running Chrome browser (existing logins, cookies, and extensions) or a Direct CDP Chromium instance.

## Quick Reference

### Via MCP (`browserpilot mcp`)
Use the `browser_*` tools directly:
- **Tabs**: `browser_tabs`, `browser_open_tab`, `browser_select_tab`, `browser_close_tab`
- **Perceive**: `browser_snapshot` (AXTree + short `e1`/`e2` refs + automatic diffing), `browser_labeled_screenshot` (Set-of-Mark), `browser_screenshot`, `browser_clean_html`, `browser_markdown`, `browser_inspect_element`
- **Act**: `browser_click`, `browser_fill`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_scroll`, `browser_drag`, `browser_select_option`, `browser_upload_file`, `browser_handle_dialog`, `browser_wait`
- **Debug**: `browser_console`, `browser_network`, `browser_network_intercept`, `browser_styles`, `browser_react_info`, `browser_debugger`, `browser_live_edit`, `browser_performance`, `browser_emulate`, `browser_cookies`, `browser_storage`, `browser_evaluate`, `browser_cdp`
- **Record & Sandbox**: `browser_record`, `browser_exec`

### Via CLI (`browserpilot`)
```bash
# Check connected browser / tabs
browserpilot tabs

# Stateful multi-step sandbox (replaces playwriter -s 1 -e '...')
browserpilot session new --tab-group docs
browserpilot exec -s 1 -e 'const t = await tabs.open("https://example.com"); console.log(await snapshot({ tab: t }))'

# Direct shortcuts
browserpilot open https://example.com
browserpilot snapshot --search "Sign in"
browserpilot click e3
browserpilot fill e4 "hello@example.com"
browserpilot console --level error --since-last
browserpilot network --failed
browserpilot styles "#submit-btn"
browserpilot perf metrics
```

## Best Practices
1. Always start with `browser_tabs` or `browser_snapshot` instead of guessing CSS selectors.
2. Prefer `browser_snapshot` (`scope` / `search` / incremental diffs) over screenshots for text-heavy workflows; use `browser_labeled_screenshot` when spatial layout matters.
3. Check `browser_console` (`sinceLastCall: true`) and `browser_network` (`failedOnly: true`) immediately when debugging frontend bugs.
4. Confirm with the user before submitting irreversible actions (payments, deletions, account/security modifications).
