# DevPilot

> **Zero-click, pure-CDP Chrome Extension, MCP Server & CLI for AI Agents.**  
> Control, inspect, and debug your real logged-in Chrome browser — no Playwright/Puppeteer runtime bloat, no per-tab icon clicking, and no repetitive Chrome `--autoConnect` "Allow" confirmation popups.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## Why DevPilot?

| Capability | Playwriter | Chrome DevTools MCP (`--autoConnect`) | Claude in Chrome | **DevPilot** |
| :--- | :---: | :---: | :---: | :---: |
| Uses your real logged-in Chrome (cookies, logins, extensions) | Yes | Yes | Yes | **Yes** |
| Zero clicks to attach to already-open tabs | No (click icon per tab) | No ("Allow" popup per connection) | Partial | **Yes (Zero-Click)** |
| Zero Playwright / Puppeteer runtime dependency | No | No (Puppeteer) | Yes | **Yes (100% Pure CDP)** |
| Chrome Native Messaging + Auth Token Daemon | No | No | Yes | **Yes (Dual Transport)** |
| Stateful JS Sandbox (`session new` / `exec -s 1 -e`) | Yes | No | No | **Yes** |
| First-class MCP Server (39 tools + image blocks) | Partial (1-tool execute) | Yes | Yes | **Yes** |
| Companion Side Panel + Action Highlights + Ghost Cursor | Partial | No | Yes | **Yes** |
| Deep DevTools (Console, Network, Fetch Mock, CSS Rules, Debugger, Live Edit, React Fiber, Web Vitals, Tracing, Video Recording) | Yes (most) | Yes (most) | Partial | **Yes (All Built-in)** |
| Direct CDP Mode (`--remote-debugging-port` for CI/Headless) | Yes | Yes | No | **Yes** |

---

## Architecture

```text
AI Coding Agents (Claude Code / Cursor / Codex / Antigravity / Custom SDK)
        │   MCP stdio (39 tools + images)   /   CLI (`devpilot`)   /   TypeScript SDK
        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  @devpilot/server   Authenticated Local Daemon (127.0.0.1 + 256-bit token)   │
│                     + Chrome Native Messaging Host (`com.devpilot.bridge`)   │
│  @devpilot/core     100% Pure-CDP Engine (Trusted Input, AXTree, DevTools)   │
└──────────────────────────┬───────────────────────────────┬───────────────────┘
                           │ Native Messaging (primary)    │ Direct CDP WS
                           │ or Auth WebSocket (fallback)  │ (--cdp <url>)
                           ▼                               ▼
┌─────────────────────────────────────────────┐   ┌────────────────────────────┐
│  @devpilot/extension (Manifest V3)          │   │ Chrome / Chromium          │
│  • Zero-click chrome.debugger (CDP v1.3)    │   │ --remote-debugging-port    │
│  • OOPIF iframes & popup Tab Groups         │   └────────────────────────────┘
│  • Closed-Shadow-DOM highlight & cursor     │
│  • Companion Side Panel + Domain Safety     │
└─────────────────────────────────────────────┘
```

---

## Quick Start (2 Minutes)

### 1. Clone & Build

```bash
git clone https://github.com/xy-tuoren/devpilot.git
cd devpilot
pnpm install
pnpm build
```

### 2. Load the Chrome Extension (Unpacked)

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select:
   ```text
   /path/to/devpilot/packages/extension/dist
   ```
4. Copy the generated **Extension ID** shown on the DevPilot card.

### 3. Run Setup (Installs Native Messaging Auto-Auth + Prints MCP Config)

```bash
node packages/server/dist/cli.js setup --extension-id <YOUR_EXTENSION_ID>
```

That registers `com.devpilot.bridge` in Chrome's `NativeMessagingHosts` directory so the extension connects to your local daemon automatically with **extension-ID-bound security** and **zero manual token copy-pasting**.

*(Optional)* Link the CLI globally:
```bash
cd packages/server && npm link
devpilot --help
```

### 4. Connect Your AI Agent via MCP

Add to your MCP config (Claude Code, Cursor, Codex, Antigravity):

```json
{
  "mcpServers": {
    "devpilot": {
      "command": "node",
      "args": ["/absolute/path/to/devpilot/packages/server/dist/cli.js", "mcp"]
    }
  }
}
```

Or connect directly to a `--remote-debugging-port` Chrome without an extension:

```json
{
  "mcpServers": {
    "devpilot": {
      "command": "node",
      "args": [
        "/absolute/path/to/devpilot/packages/server/dist/cli.js",
        "mcp",
        "--cdp",
        "http://127.0.0.1:9222"
      ]
    }
  }
}
```

---

## CLI Usage (Drop-in Playwriter Replacement)

### Stateful Multi-Step Sandbox
```bash
# Create an isolated session grouped into its own Chrome Tab Group
devpilot session new --tab-group app --tab-group-color cyan
# => 1

# Execute stateful JS with full pure-CDP & DevTools helpers
devpilot exec -s 1 -e '
  const t = await tabs.open("http://localhost:3000");
  state.tab = t;
  console.log(await snapshot({ tab: t }));
'

# Reuse state across calls
devpilot exec -s 1 -e '
  await state.tab.page.fill("e3", "alice@example.com");
  await state.tab.page.click("e4");
  console.log(await getLatestLogs({ tab: state.tab, sinceLastCall: true }));
'
```

### Direct One-Liner Shortcuts
```bash
devpilot tabs                                    # List all open Chrome tabs
devpilot open https://example.com                # Open & auto-attach a tab
devpilot snapshot --search "Sign in"             # Semantic AXTree with refs + auto-diff
devpilot click e3                                # Trusted CDP mouse click (isTrusted=true)
devpilot fill e4 "hello world"                   # SPA-safe trusted text input
devpilot screenshot ./page.png --full-page       # CSS-scaled screenshot
devpilot labeled-screenshot ./som.png            # Vimium-style Set-of-Mark labeled shot
devpilot console --level error --since-last      # Incremental console errors & exceptions
devpilot network --failed                        # Failed HTTP requests + initiator stack
devpilot styles "#submit-btn"                    # DevTools Styles cascade (file:line)
devpilot react "#submit-btn"                     # React Fiber component + _debugSource
devpilot perf metrics                            # Core Web Vitals + CDP metrics
devpilot skill                                   # Print full Agent Skill instructions
```

---

## Complete MCP Tool Matrix (39 Tools)

| Category | Tools |
| :--- | :--- |
| **Browser & Tabs** | `browser_status`, `browser_tabs`, `browser_open_tab`, `browser_close_tab`, `browser_select_tab` |
| **Navigation & Perception** | `browser_navigate`, `browser_history`, `browser_snapshot`, `browser_screenshot`, `browser_labeled_screenshot`, `browser_clean_html`, `browser_markdown`, `browser_inspect_element` |
| **Trusted Interaction** | `browser_click`, `browser_fill`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_scroll`, `browser_drag`, `browser_select_option`, `browser_upload_file`, `browser_handle_dialog`, `browser_wait` |
| **DevTools Debugging** | `browser_evaluate`, `browser_console`, `browser_network`, `browser_network_intercept`, `browser_styles`, `browser_react_info`, `browser_debugger`, `browser_live_edit`, `browser_performance`, `browser_emulate`, `browser_cookies`, `browser_storage`, `browser_cdp` |
| **Media & Sandbox** | `browser_record`, `browser_exec` |

---

## Safety & Built-in Guards

1. **Profile-Wide Wipe Protection**: Destructive CDP commands (`Network.clearBrowserCookies`, `Network.clearBrowserCache`) are blocked at both the core engine and extension layers so an agent can never log you out of your browser profile.
2. **Domain Allowlist / Denylist**: Configure blocked domains (e.g., `*.bank.com`) directly in the extension popup.
3. **Instant Pause Kill-Switch**: One click in the popup or Side Panel immediately pauses all auto-attach and CDP execution.
4. **Local-Only Authenticated Bridge**: Binds strictly to `127.0.0.1` with a 256-bit random token stored in `~/.devpilot/daemon.json` (`0600`), or uses extension-ID-locked Chrome Native Messaging.
5. **Chrome Transparency**: Because DevPilot uses Chrome's documented `chrome.debugger` API, Chrome displays its standard debugging infobar while attached (or launch a dedicated local dev Chrome with `--silent-debugger-extension-api` / `devpilot browser start`).

---

## Packages

- [`packages/protocol`](./packages/protocol) — Shared types, JSON-RPC bridge schema, Native Messaging framing codec, and security guards.
- [`packages/core`](./packages/core) — 100% pure-CDP automation, perception, DevTools debugging suite, ffmpeg recorder, and stateful sandbox.
- [`packages/extension`](./packages/extension) — Zero-click Chrome Manifest V3 extension with closed-Shadow-DOM overlays, Popup, and Companion Side Panel.
- [`packages/server`](./packages/server) — Authenticated Local Daemon, Chrome Native Messaging Host & installer, MCP Server, CLI, and TypeScript SDK.
- [`skills/devpilot/SKILL.md`](./skills/devpilot/SKILL.md) — Ready-to-deploy skill instructions for AI coding agents.

## License

[MIT](./LICENSE) — see [CHANGELOG.md](./CHANGELOG.md) for full iteration history.
