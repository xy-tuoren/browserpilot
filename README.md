# BrowserPilot

> **Zero-click, 100% pure-CDP Chrome Extension, MCP Server & CLI for AI Agents.**  
> Control, inspect, record, and debug your real logged-in Chrome browser — zero Playwright/Puppeteer runtime bloat, zero per-tab icon clicking, and zero repetitive Chrome `--autoConnect` "Allow" popups.

[![npm version](https://img.shields.io/npm/v/browserpilot-cdp?color=0ea5e9)](https://www.npmjs.com/package/browserpilot-cdp)
[![CI](https://github.com/xy-tuoren/browserpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/xy-tuoren/browserpilot/actions/workflows/ci.yml)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**English** | [简体中文](./README.zh-CN.md)

---

## Why BrowserPilot?

| Capability | Playwriter | Chrome DevTools MCP (`--autoConnect`) | Claude in Chrome | **BrowserPilot** |
| :--- | :---: | :---: | :---: | :---: |
| Uses your real logged-in Chrome (cookies, logins, extensions) | Yes | Yes | Yes | **Yes** |
| Zero clicks to attach to already-open tabs | No (click icon per tab) | No ("Allow" popup per connection) | Partial | **Yes (Zero-Click)** |
| Zero Playwright / Puppeteer runtime dependency | No | No (Puppeteer) | Yes | **Yes (100% Pure CDP)** |
| Low-Token Tiered MCP (`core` 19 tools vs `--full` 53 tools) + Streamable HTTP | Partial (1-tool execute) | No (all tools upfront) | No | **Yes (-60.6% schema tokens + HTTP)** |
| Interactive-Only Snapshot (`snapshot -i`) & Single-Turn Action Diff (`returnDiff`) | No | No | Partial | **Yes (~70% fewer tokens)** |
| Stateful JS Sandbox (`session new` / `exec -s 1 -e`) + Optional Restricted Mode | Yes | No | No | **Yes** |
| Companion Side Panel + Live Codegen + `browserpilot run` Replay + HTML Trace Viewer | Partial | No | Partial | **Yes (Full Record → Replay → Trace loop)** |
| Real-World SPA Hardening (ProseMirror/Slate Rich Text, Virtual-Scroll `scrollUntil`, HTML5 DnD, Mobile Touch) | Partial | Partial | Partial | **Yes (All Built-in)** |
| Built-in Security Guardrails (High-Risk Action Approval, Secret Redaction, Untrusted Content Boundary) | No | No | Partial | **Yes** |
| Direct CDP Mode (`--remote-debugging-port` for CI/Headless) & Windows/macOS/Linux CI | Yes | Yes | No | **Yes** |

### Measured Context & Package Efficiency (Reproducible via `node scripts/agent-eval.mjs`)

| Metric | Baseline | BrowserPilot Optimized | Delta |
| :--- | :---: | :---: | :---: |
| MCP upfront tool schema payload (`tools/list`) | 53 tools (`--full`): `30.1 KB` (~7,711 tokens) | 19-tool `core` default (+ `browser_exec`): `11.9 KB` (~3,038 tokens) | **-60.6% tokens** |
| 11,000-node enterprise admin table snapshot | Full AXTree: `20,517` tokens | `snapshot -i --viewport`: `257` tokens (`scope`: `53` tokens) | **-98.7% tokens** |
| Real public pages (`GitHub` / `Wikipedia` / `MDN`) | Full AXTree: `10.8k` / `22.4k` / `6.0k` tokens | `snapshot -i --viewport`: `1.4k` / `1.7k` / `1.3k` tokens | **-78% to -92% tokens** |
| Post-action page observation round-trips | `click` + separate `snapshot` (2 LLM turns) | `click --diff` / `returnDiff: true` (1 LLM turn, captures status + UI diff) | **-50% turns** |
| Published npm tarball (`browserpilot-cdp`) | `3.2 MB` unpacked | `~930 KB` unpacked (ESM code-split + full `.d.ts` SDK) | **-71% size** |

---

## Architecture

```text
AI Coding Agents (Claude Code / Cursor / Codex / Antigravity / Custom SDK)
        │   MCP stdio or Streamable HTTP (`--http`)  /  CLI (`browserpilot`)  /  TypeScript SDK
        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  @browserpilot/server   Authenticated Local Daemon (127.0.0.1 + 256-bit token)   │
│                     + Multi-Browser Router (--browser / --profile / clients)     │
│                     + Chrome Native Messaging Host (`com.browserpilot.bridge`)   │
│  @browserpilot/core     100% Pure-CDP Engine (Trusted Input, AXTree, DevTools)   │
└──────────────────────────┬───────────────────────────────┬───────────────────┘
                           │ Native Messaging (primary)    │ Direct CDP WS
                           │ or Auth WebSocket (fallback)  │ (--cdp <url>)
                           ▼                               ▼
┌─────────────────────────────────────────────┐   ┌────────────────────────────┐
│  @browserpilot/extension (Manifest V3)      │   │ Chrome / Chromium          │
│  • Zero-click chrome.debugger (CDP v1.3)    │   │ --remote-debugging-port    │
│  • OOPIF iframes & popup Tab Groups         │   └────────────────────────────┘
│  • Closed-Shadow-DOM capsule (简体中文/EN)   │
│  • Companion Side Panel + Live Codegen      │
└─────────────────────────────────────────────┘
```

---

## Quick Start (1 Minute)

### Step 1: Install CLI & Initialize

```bash
npm install -g browserpilot-cdp
browserpilot setup
```

> **Prerequisites:** Node.js >= 22 (`ffmpeg` is optional, only required for video recording).  
> **Non-invasive by design:** `browserpilot setup` only syncs the bundled Chrome extension to `~/.browserpilot/extension`, computes its deterministic Chrome Extension ID, and registers the **Chrome Native Messaging Host** (`com.browserpilot.bridge`) across macOS, Linux, and Windows. It **never** modifies your AI agents' settings or skill folders.  
> **Optional auto-start:** run `browserpilot daemon install-service` (macOS LaunchAgent / Linux `systemd --user` / Windows Startup) if you want the daemon running automatically after login.

### Step 2: Load the Chrome Extension (1-Time)

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select `~/.browserpilot/extension`.
3. It connects automatically via Native Messaging on the first millisecond — **no copying Extension IDs or manual auth tokens required**. Future CLI upgrades automatically hot-reload the idle extension.

*(Skip Step 2 if you only want to drive a separate `--remote-debugging-port` Chromium instance via `browserpilot browser start` or `--cdp`.)*

### Step 3: Connect Only the AI Agent(s) You Want (Choose Option A, B, or C)

- **Option A — Agent Skill + CLI (Lowest context token usage):**
  ```bash
  npx skills add xy-tuoren/browserpilot
  ```
  Or copy `skills/browserpilot/SKILL.md` (or `browserpilot skill`) into a project's `.claude/skills/browserpilot/` or `.agents/skills/browserpilot/`.

- **Option B — MCP Server over stdio (Default 19-tool low-token `core` profile + `browser_exec`; add `"--full"` for all 53 tools or `"--caps=devtools,media"` for specific groups):**
  ```json
  {
    "mcpServers": {
      "browserpilot": {
        "command": "browserpilot",
        "args": ["mcp"]
      }
    }
  }
  ```

- **Option C — MCP Server over Streamable HTTP (Multi-client & remote/tunnel ready, Bearer-token authenticated):**
  ```bash
  browserpilot mcp --http --port 19889
  # Serves http://127.0.0.1:19889/mcp (Authorization: Bearer <token>) and /health
  ```

### Alternative: Build from Source / Direct CDP (No Extension)

```bash
git clone https://github.com/xy-tuoren/browserpilot.git
cd browserpilot
pnpm install && pnpm build
node packages/server/dist/cli.js setup
```

Or connect MCP directly to a `--remote-debugging-port` Chrome without loading the extension:

```json
{
  "mcpServers": {
    "browserpilot": {
      "command": "npx",
      "args": ["-y", "browserpilot-cdp@latest", "mcp", "--cdp", "http://127.0.0.1:9222"]
    }
  }
}
```

---

## CLI Usage & Workflows

### Stateful Multi-Step Sandbox (`browserpilot exec`)
```bash
# Create an isolated session grouped into its own Chrome Tab Group
browserpilot session new --tab-group app --tab-group-color cyan

# Execute stateful JS with full pure-CDP & DevTools helpers (add --restricted-sandbox to block fs/child_process/net)
browserpilot exec -s 1 --trace ./run-trace.html -e '
  const t = await tabs.open("http://localhost:3000");
  state.tab = t;
  console.log(await snapshot({ tab: t, interactiveOnly: true }));
  await fill("#composer", "Hello from pure CDP!");
  await scrollUntil("text=\"Order #42\"", { maxScrolls: 15 });
  await drag("#card-1", "#done-col"); // Auto-detects HTML5 draggable="true" vs pointer drag
  await tap("#mobile-btn");           // Real CDP Input.dispatchTouchEvent
'
```

### Direct One-Liner Shortcuts
```bash
browserpilot clients                                 # List connected browsers/profiles (* = default)
browserpilot daemon use edge                         # Pin default target browser/profile
browserpilot tabs --browser chrome                   # List open tabs in a specific browser
browserpilot open https://example.com                # Open & zero-click attach a tab
browserpilot snapshot -i --viewport                  # Interactive + viewport-only AXTree (-87% to -98.7% tokens)
browserpilot snapshot --scope "#modal" --max-chars 8000 # Shadow-piercing scoped + char-budgeted snapshot
browserpilot click e3 --diff                         # Trusted click + inline post-action page diff
browserpilot fill e4 "hello world" --diff            # Rich-text & SPA-safe input + inline diff
browserpilot scroll down --until 'text="Load More"'  # Virtual-scroll finder
browserpilot drag "#card" "#column" --mode auto      # Pointer or HTML5 DataTransfer drag-and-drop
browserpilot tap "#cta"                              # Mobile CDP touch tap
browserpilot swipe "#slide-1" "#slide-2"             # Mobile CDP touch swipe
browserpilot screenshot ./page.png --full-page       # CSS-scaled screenshot (--grid / --zoom)
browserpilot labeled-screenshot ./som.png            # Vimium-style Set-of-Mark labeled shot
browserpilot console --level error --since-last      # Incremental console errors & exceptions
browserpilot network --failed                        # Failed HTTP requests (sensitive headers auto-redacted)
browserpilot styles "#submit-btn"                    # DevTools Styles cascade (file:line)
browserpilot react "#submit-btn"                     # React Fiber component + _debugSource
browserpilot perf metrics                            # Core Web Vitals + CDP metrics
browserpilot codegen https://example.com --format batch -o flow.json  # Live workflow recorder
browserpilot run flow.json --trace replay.html --open                 # Replay in logged-in Chrome + visual Trace
browserpilot run flow.json --headless --trace ci-replay.html          # Zero-daemon headless CI replay + Trace
browserpilot launch --headless && browserpilot launch status && browserpilot launch stop  # Managed isolated Chrome
browserpilot trace open replay.html                                   # Open single-file HTML Trace Viewer
```

---

## Complete MCP Tool Matrix (53 Tools, Tiered by Profile)

Default `browserpilot mcp` advertises the **19-tool `core` profile** (`--caps` unlocks optional groups; `--full` exposes all 53):

| Profile / Group | Tools |
| :--- | :--- |
| **`core` (Default — 19 tools)** | `browser_status`, `browser_tabs`, `browser_open_tab`, `browser_select_tab`, `browser_close_tab`, `browser_navigate`, `browser_snapshot` (`interactiveOnly`, `wrapUntrusted`, `frame`, `scope`, `search`), `browser_screenshot` (`grid`, `zoom`, `clip`), `browser_labeled_screenshot`, `browser_click` (`returnDiff`), `browser_fill` (`returnDiff`, ProseMirror/Slate safe), `browser_select_option`, `browser_press_key`, `browser_scroll` (`untilTarget` virtual-scroll), `browser_wait`, `browser_handoff`, `browser_console`, `browser_network` (auto-redacted), `browser_exec` (Code Mode + `sandboxMode`) |
| **`interaction`** | `browser_check`, `browser_fill_form`, `browser_type`, `browser_hover`, `browser_drag` (Pointer + HTML5 `DataTransfer` + canvas `points`), `browser_touch` (`tap`/`swipe`), `browser_upload_file`, `browser_handle_dialog`, `browser_batch` |
| **`extraction`** | `browser_frames`, `browser_clean_html`, `browser_markdown`, `browser_inspect_element`, `browser_pinned`, `browser_evaluate` |
| **`devtools`** | `browser_network_intercept`, `browser_styles`, `browser_react_info`, `browser_debugger`, `browser_live_edit`, `browser_performance`, `browser_cdp` |
| **`context`** | `browser_history`, `browser_clipboard`, `browser_pdf`, `browser_init_script`, `browser_permissions`, `browser_emulate`, `browser_cookies`, `browser_storage` |
| **`media`** | `browser_record`, `browser_downloads`, `browser_action_recorder`, `browser_trace` |

---

## Safety & Built-in Guardrails

1. **Action-Level Risk Approval & Side Panel Security Controls**: Configure `Off` / `High-Risk` / `Strict` confirmation mode, Browser Profile Label, and visual Blocked/Allowed Domain chip lists (plus one-click **Block Current Site**) right inside the Chrome Side Panel **`Security`** tab — or via `BROWSERPILOT_APPROVAL_MODE=high-risk|strict`. High-risk financial/destructive actions display a bilingual closed-Shadow-DOM confirmation card (`允许本次` / `拒绝`) before proceeding.
2. **Live AI Activity Timeline & One-Click `flow.json` Export**: Every MCP/CLI action streams cleanly into the Side Panel **`Activity`** tab with timing and one-click `Export flow.json` (both from live AI sessions and recorded Codegen flows) for instant replay via `browserpilot run`.
2. **Automatic Secret Redaction**: `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, password fields, Bearer tokens, and secret query params are redacted by default in HTML Trace reports and `browser_network` detail responses (`includeSensitive: true` to inspect explicitly).
3. **Prompt-Injection Untrusted Content Boundary**: Pass `--wrap-untrusted` (`wrapUntrusted: true` or `BROWSERPILOT_UNTRUSTED_BOUNDARY=1`) on `snapshot` / `markdown` / `html` to wrap external webpage data in `<untrusted_page_content>` boundary tags.
4. **Optional Restricted `exec` Sandbox**: Set `--restricted-sandbox` (`BROWSERPILOT_SANDBOX_MODE=restricted`) to block `child_process`, `fs`, `net`, `http`, and arbitrary module imports inside `browser_exec` while keeping all pure-CDP browser APIs intact.
5. **Profile-Wide Wipe Protection & Domain Rules**: Destructive CDP commands (`Network.clearBrowserCookies`, `Network.clearBrowserCache`) are hard-blocked at both core and extension layers; domain denylists and one-click `Pause` live right in the extension popup.
6. **Zero-Error Chrome MV3 Verification**: Automated CI (`ubuntu-latest`, `macos-latest`, `windows-latest`) verifies Chrome's real `chrome://extensions` Developer Mode Error Console (`chrome.developerPrivate.getExtensionsInfo()`) records **0** `manifestErrors`, `runtimeErrors`, and `runtimeWarnings`.

---

## Packages

- [`packages/protocol`](./packages/protocol) — Shared types, JSON-RPC bridge schema, Native Messaging framing codec (64 MB incoming + chunking), redaction & risk-classification guards.
- [`packages/core`](./packages/core) — 100% pure-CDP automation (rich text, virtual scroll, HTML5 DnD, mobile touch), perception, DevTools debugging suite, ffmpeg recorder, Trace Viewer, and stateful sandbox.
- [`packages/extension`](./packages/extension) — Zero-click Chrome Manifest V3 extension with Simplified Chinese default / English toggle, closed-Shadow-DOM floating capsule, Popup, and Companion Side Panel.
- [`packages/server`](./packages/server) — Publishable npm package `browserpilot-cdp` (authenticated multi-browser Daemon, auto-start service manager, Native Messaging Host installer, stdio & Streamable HTTP MCP Server, CLI, workflow replay runner, and TypeScript SDK).
- [`skills/browserpilot/SKILL.md`](./skills/browserpilot/SKILL.md) — Ready-to-deploy skill instructions for AI coding agents.

## License

[MIT](./LICENSE) — see [CHANGELOG.md](./CHANGELOG.md) for full iteration history.
