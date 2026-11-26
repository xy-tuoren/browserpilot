# BrowserPilot

> **零点击、100% 纯 CDP 驱动的 Chrome 扩展、MCP Server 与 CLI 工具，专为 AI Agent 打造。**  
> 直接控制、检查、录制和调试你正在登录使用的真实 Chrome 浏览器——零 Playwright/Puppeteer 运行时依赖，无需为每个标签页手动点图标授权，也没有 Chrome `--autoConnect` 反复弹出的「允许」确认框。

[![npm version](https://img.shields.io/npm/v/browserpilot-cdp?color=0ea5e9)](https://www.npmjs.com/package/browserpilot-cdp)
[![CI](https://github.com/xy-tuoren/browserpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/xy-tuoren/browserpilot/actions/workflows/ci.yml)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[English](./README.md) | **简体中文**

---

## 为什么选择 BrowserPilot？

| 能力 | Playwriter | Chrome DevTools MCP (`--autoConnect`) | Claude in Chrome | **BrowserPilot** |
| :--- | :---: | :---: | :---: | :---: |
| 复用真实已登录 Chrome（Cookie / 登录态 / 扩展） | 是 | 是 | 是 | **是** |
| 零点击接管已打开的标签页 | 否（需逐页点图标） | 否（每次连接弹「允许」框） | 部分 | **是（真正零点击）** |
| 零 Playwright / Puppeteer 运行时依赖 | 否 | 否（Puppeteer） | 是 | **是（100% 纯 CDP）** |
| 低 Token 分级 MCP（默认 19 核心工具 / `--full` 53 工具）+ Streamable HTTP | 部分（单工具执行） | 否（全量暴露） | 否 | **是（直降 60.6% Schema Token + HTTP）** |
| 精简交互快照（`snapshot -i`）+ 动作后单轮增量返回（`returnDiff`） | 否 | 否 | 部分 | **是（约省 70% Token）** |
| 有状态 JS 多步沙盒（`exec -s 1 -e`）+ 可选安全受限模式 | 是 | 否 | 否 | **是** |
| 侧边栏录制（Codegen）→ `browserpilot run` 回放 → 单文件 HTML Trace 查看器 | 否 | 否 | 否 | **完整闭环（原生内置）** |
| 复杂真站适配（ProseMirror/Slate 富文本、虚拟滚动 `scrollUntil`、HTML5 拖拽、移动端 Touch 手势） | 部分 | 部分 | 部分 | **全部内置** |
| 安全护栏（高危操作页内确认、敏感头/密码自动脱敏、网页 Prompt Injection 边界隔离） | 否 | 否 | 部分 | **全部内置** |
| Direct CDP 直连模式 & macOS / Linux / Windows 三端 CI 验证 | 是 | 是 | 否 | **是** |

### 实测效率与体积数据

| 指标 | 优化前 / 全量基线 | BrowserPilot 默认配置 | 降幅 |
| :--- | :---: | :---: | :---: |
| MCP 启动加载的工具 Schema（`tools/list`） | 53 工具（`--full`）：`30.8 KB`（约 7,711 tokens） | 19 核心工具（含 `browser_exec`）：`12.2 KB`（约 3,038 tokens） | **-60.6% Token** |
| 复杂内容页 AXTree 感知 | 全量无障碍树快照 | `snapshot -i` 精简交互快照 + 增量 Diff | **约省 65%–75% Token** |
| 点击/填表后的状态确认轮次 | `click` + 单独 `snapshot`（2 轮对话） | `click --diff` / `returnDiff: true`（单轮返回） | **-50% 往返轮次** |
| npm 安装包解压体积（`browserpilot-cdp`） | `3.2 MB` | `~840 KB`（ESM 拆包 + 完整 `.d.ts` TypeScript SDK） | **-74% 体积** |

---

## 架构概览

```text
AI Coding Agents (Claude Code / Cursor / Codex / Antigravity / 自定义 SDK)
        │   MCP stdio 或 Streamable HTTP (`--http`)  /  CLI (`browserpilot`)  /  TypeScript SDK
        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  @browserpilot/server   本地鉴权守护进程 (127.0.0.1 + 256-bit Token)          │
│                         + 多浏览器/多 Profile 路由 (--browser / clients)       │
│                         + Chrome Native Messaging Host (`com.browserpilot.bridge`) │
│  @browserpilot/core     100% 纯 CDP 引擎（可信输入、AXTree、全套 DevTools）     │
└──────────────────────────┬───────────────────────────────┬───────────────────┘
                           │ Native Messaging（首选，64MB） │ Direct CDP WS
                           │ 或本地鉴权 WebSocket（回退）    │ (--cdp <url>)
                           ▼                               ▼
┌─────────────────────────────────────────────┐   ┌────────────────────────────┐
│  @browserpilot/extension (Manifest V3)      │   │ Chrome / Chromium          │
│  • 零点击 chrome.debugger (CDP v1.3)         │   │ --remote-debugging-port    │
│  • 跨域 OOPIF iframe 与弹窗 Tab Group 分组   │   └────────────────────────────┘
│  • 默认简体中文悬浮控制条 / 弹窗 / 侧边栏     │
│  • 实时录制 Codegen + 高危操作页内确认卡片   │
└─────────────────────────────────────────────┘
```

---

## 快速上手（1 分钟）

### 第 1 步：安装 CLI 并初始化

```bash
npm install -g browserpilot-cdp
browserpilot setup
```

> **前置环境：** Node.js >= 22（`ffmpeg` 为可选依赖，仅视频录屏时需要）。  
> **无侵入设计：** `browserpilot setup` 只会把内置扩展同步到 `~/.browserpilot/extension`，预算固定扩展 ID 并注册跨平台 **Chrome Native Messaging Host**（macOS / Linux / Windows）。它**绝不会**修改你的任何 AI Agent 配置或 skills 目录。  
> **可选开机自启：** 如需守护进程随登录自启，运行 `browserpilot daemon install-service`（支持 macOS LaunchAgent / Linux `systemd --user` / Windows 启动项；`uninstall-service` 可一键卸载）。

### 第 2 步：在 Chrome 加载扩展（一次性）

1. 打开 Chrome 地址栏输入 `chrome://extensions`，开启右上角 **开发者模式（Developer mode）**。
2. 点击 **加载已解压的扩展程序（Load unpacked）**，选择 `~/.browserpilot/extension`。
   > macOS 选文件弹窗内可按 `Cmd + Shift + G` 直接输入 `~/.browserpilot/extension`。
3. 加载后通过 Native Messaging 秒级自动连接——**无需复制扩展 ID、无需手填 Token**，以后升级 CLI 后扩展会在空闲时自动热重载。

*(如果你只想驱动带 `--remote-debugging-port` 的独立测试 Chrome，可直接跳过第 2 步，使用 `browserpilot browser start` 或 `--cdp` 模式。)*

### 第 3 步：在你需要的 AI Agent 中按需接入（三选一）

- **方式 A — Agent Skill + CLI（最省上下文 Token）：**
  ```bash
  npx skills add xy-tuoren/browserpilot
  ```
  或将 `skills/browserpilot/SKILL.md`（或 `browserpilot skill` 的输出）放到指定项目的 `.claude/skills/browserpilot/`、`.agents/skills/browserpilot/` 目录即可。

- **方式 B — MCP Server stdio 模式（默认 19 个低 Token 核心工具 + `browser_exec`；加 `"--full"` 展开全部 53 工具，或 `"--caps=devtools,media"` 按需启用分组）：**
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

- **方式 C — Streamable HTTP MCP 模式（支持多客户端共享与远程隧道，Bearer Token 鉴权）：**
  ```bash
  browserpilot mcp --http --port 19889
  # 暴露 http://127.0.0.1:19889/mcp（需携带 Authorization: Bearer <token>）与 /health
  ```

### 备选：源码构建 / 无扩展直连 CDP

```bash
git clone https://github.com/xy-tuoren/browserpilot.git
cd browserpilot
pnpm install && pnpm build
node packages/server/dist/cli.js setup
```

或不装扩展，直接把 MCP 连接到已开启 `--remote-debugging-port` 的 Chrome：

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

## 常用 CLI 示例

### 有状态多步沙盒（`browserpilot exec`）

```bash
# 创建一个隔离会话，自动归入指定颜色的 Chrome 标签组
browserpilot session new --tab-group app --tab-group-color cyan

# 执行多步纯 CDP 脚本（加 --restricted-sandbox 可禁用 fs/child_process/net）
browserpilot exec -s 1 --trace ./run-trace.html -e '
  const t = await tabs.open("http://localhost:3000");
  state.tab = t;
  console.log(await snapshot({ tab: t, interactiveOnly: true }));
  await fill("#composer", "支持 ProseMirror / Slate 富文本编辑器的可信输入");
  await scrollUntil("text=\"订单 #42\"", { maxScrolls: 15 });
  await drag("#card-1", "#done-col"); // 自动识别 HTML5 draggable="true" 或 Pointer 拖拽
  await tap("#mobile-btn");           // 真实 CDP Touch 事件
'
```

### 一行快捷命令

```bash
browserpilot doctor                                  # 诊断扩展版本、Native Messaging、Chrome、ffmpeg 与守护进程
browserpilot clients                                 # 查看所有已连接的浏览器/Profile（* 表示当前默认目标）
browserpilot daemon use edge                         # 固定默认路由到指定浏览器或 Profile
browserpilot tabs --browser chrome                   # 指定浏览器列出已打开标签页
browserpilot open example.com                        # 打开标签页并零点击自动附加
browserpilot snapshot -i                             # 精简交互无障碍树快照（约省 70% Token）
browserpilot click e3 --diff                         # 可信点击并单轮附带页面精简变化 Diff
browserpilot fill e4 "hello world" --diff            # 富文本 & SPA 安全输入并附带 Diff
browserpilot scroll down --until 'text="加载更多"'   # 虚拟滚动列表自动边滚边找目标
browserpilot drag "#card" "#column" --mode auto      # Pointer 或 HTML5 DataTransfer 拖拽
browserpilot tap "#cta"                              # 移动端 Touch 点击
browserpilot swipe "#slide-1" "#slide-2"             # 移动端 Touch 滑动
browserpilot screenshot ./page.png --full-page       # CSS 像素缩放截图（支持 --grid / --zoom）
browserpilot labeled-screenshot ./som.png            # Vimium 风格 Set-of-Mark 标号截图
browserpilot console --level error --since-last      # 增量查看控制台报错与未捕获异常
browserpilot network --failed                        # 查看失败 HTTP 请求（默认对敏感 Header/Token 脱敏）
browserpilot styles "#submit-btn"                    # 查看 DevTools 命中样式级联（含 file:line）
browserpilot react "#submit-btn"                     # 检查 React Fiber 组件名与源码位置
browserpilot perf metrics                            # 采集 Core Web Vitals（LCP/CLS/FCP/TTFB）与内存指标
browserpilot codegen example.com --format batch -o flow.json  # 实时录制操作步骤为 JSON
browserpilot run flow.json --trace replay.html --open         # 一键回放录制脚本并自动生成可视化 Trace
browserpilot trace open replay.html                           # 在 Chrome 中直接打开交互式 Trace 查看器
```

---

## 完整 MCP 工具矩阵（共 53 个工具，按需分级暴露）

默认 `browserpilot mcp` 暴露 **19 个低 Token 核心工具**（传 `--caps=interaction,extraction,devtools,context,media` 按需开启，传 `--full` 展开全部 53 个）：

| 分组 | 工具列表 |
| :--- | :--- |
| **`core`（默认 — 19 个）** | `browser_status`, `browser_tabs`, `browser_open_tab`, `browser_select_tab`, `browser_close_tab`, `browser_navigate`, `browser_snapshot`（`interactiveOnly` / `wrapUntrusted` / `frame` / `scope` / `search`）, `browser_screenshot`（`grid` / `zoom` / `clip`）, `browser_labeled_screenshot`, `browser_click`（`returnDiff`）, `browser_fill`（`returnDiff` + 富文本增强）, `browser_select_option`, `browser_press_key`, `browser_scroll`（`untilTarget` 虚拟滚动查找）, `browser_wait`, `browser_handoff`, `browser_console`, `browser_network`（默认脱敏）, `browser_exec`（代码沙盒 + `sandboxMode`） |
| **`interaction`** | `browser_check`, `browser_fill_form`, `browser_type`, `browser_hover`, `browser_drag`（Pointer + HTML5 `DataTransfer` + 多点绘制）, `browser_touch`（`tap`/`swipe`）, `browser_upload_file`, `browser_handle_dialog`, `browser_batch` |
| **`extraction`** | `browser_frames`, `browser_clean_html`, `browser_markdown`, `browser_inspect_element`, `browser_pinned`, `browser_evaluate` |
| **`devtools`** | `browser_network_intercept`, `browser_styles`, `browser_react_info`, `browser_debugger`, `browser_live_edit`, `browser_performance`, `browser_cdp` |
| **`context`** | `browser_history`, `browser_clipboard`, `browser_pdf`, `browser_init_script`, `browser_permissions`, `browser_emulate`, `browser_cookies`, `browser_storage` |
| **`media`** | `browser_record`, `browser_downloads`, `browser_action_recorder`, `browser_trace` |

---

## 安全与内置护栏

1. **高危动作页内确认（`BROWSERPILOT_APPROVAL_MODE=high-risk|strict`）**：自动识别付款、转账、下单、删除账号、发布、支付/网银域名等高危操作，在页面底部弹出红色确认卡片（**「允许本次」 / 「拒绝」**），用户点头后才继续执行。
2. **敏感信息默认脱敏**：HTML Trace 报告与 `browser_network` 详情接口默认自动对 `Authorization`、`Cookie`、`Set-Cookie`、`X-API-Key`、密码字段、Bearer Token 和 URL 中的敏感参数做 `<REDACTED>` 脱敏（确需排障时可显式传 `includeSensitive: true`）。
3. **网页 Prompt Injection 边界隔离**：在 `snapshot` / `markdown` / `html` 传 `--wrap-untrusted`（或设置 `BROWSERPILOT_UNTRUSTED_BOUNDARY=1`），即可将不可信外部网页数据包裹在 `<untrusted_page_content>` 边界标签中。
4. **可选受限沙盒（`--restricted-sandbox` / `BROWSERPILOT_SANDBOX_MODE=restricted`）**：在 `browser_exec` 中拦截 `child_process`、`fs`、`net`、`http` 等系统级模块，同时保留全部纯 CDP 浏览器能力。
5. **禁止全配置清空 & 域名护栏**：双层拦截 `Network.clearBrowserCookies` / `Network.clearBrowserCache`，扩展弹窗内置禁止域名列表、一键暂停与默认简体中文 / EN 切换。
6. **Chrome 扩展错误面板零报错自动化门禁**：macOS / Linux / Windows 三端 CI 自动开启真实 Chrome 开发者模式 `ErrorConsole`（`chrome.developerPrivate.getExtensionsInfo()`），强制断言全流程及热重载后 `manifestErrors`、`runtimeErrors`、`runtimeWarnings` 全为 `0`。

---

## Monorepo 包结构

- [`packages/protocol`](./packages/protocol) — 共享协议类型、JSON-RPC 桥 Schema、Native Messaging 64 MB 分片编解码、敏感信息脱敏与风险分级规则。
- [`packages/core`](./packages/core) — 100% 纯 CDP 引擎（富文本/虚拟滚动/HTML5 拖拽/Touch 手势、AXTree 快照、全套 DevTools、录屏、单文件 Trace 查看器与有状态沙盒）。
- [`packages/extension`](./packages/extension) — 零点击 Chrome Manifest V3 扩展（默认简体中文悬浮条/弹窗/侧边栏、实时录制、无报错自检门禁）。
- [`packages/server`](./packages/server) — npm 包 `browserpilot-cdp`（多浏览器路由守护进程、系统自启托管、Native Messaging 安装器、stdio & Streamable HTTP MCP、CLI、工作流回放器与 TypeScript SDK）。
- [`skills/browserpilot/SKILL.md`](./skills/browserpilot/SKILL.md) — 供 AI Agent 按需安装的标准化 Skill 文档。

## 开源协议

[MIT](./LICENSE) — 完整迭代日志请见 [CHANGELOG.md](./CHANGELOG.md)。
