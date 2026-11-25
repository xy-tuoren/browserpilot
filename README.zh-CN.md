# BrowserPilot

> **零点击、100% 纯 CDP 驱动的 Chrome 扩展、MCP Server 与 CLI 工具，专为 AI Agent 打造。**  
> 直接控制、检查和调试你正在登录使用的真实 Chrome 浏览器——无需 Playwright/Puppeteer 运行时依赖，无需为每个标签页手动点图标授权，也没有 Chrome `--autoConnect` 反复弹出的「允许」确认框。

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
| Chrome Native Messaging 自动鉴权 + 本地守护进程 | 否 | 否 | 是 | **是（双传输通道）** |
| 有状态 JS 多步沙盒（`session new` / `exec -s 1 -e`） | 是 | 否 | 否 | **是** |
| 原生 MCP Server（51 个工具 + 多模态截图直出） | 部分（单工具执行） | 是 | 是 | **是** |
| 侧边栏诊断面板 + 操作高亮 + 幽灵光标 | 部分 | 否 | 是 | **是** |
| 全套 DevTools（Console / Network / Fetch Mock / CSS / 断点调试 / 热改代码 / React Fiber / Web Vitals / Tracing / 录屏 / 下载 / 动作录制） | 大部分 | 大部分 | 部分 | **全部内置** |
| Direct CDP 直连模式（`--remote-debugging-port`，适合 CI/无头） | 是 | 是 | 否 | **是** |

---

## 架构概览

```text
AI Coding Agents (Claude Code / Cursor / Codex / Antigravity / 自定义 SDK)
        │   MCP stdio (51 个工具 + 图像块)  /  CLI (`browserpilot`)  /  TypeScript SDK
        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  @browserpilot/server   本地鉴权守护进程 (127.0.0.1 + 256-bit Token)          │
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
│  • Closed-Shadow-DOM 高亮、光标与右键固定    │
│  • 伴随侧边栏（活动/报错/失败请求）+ 域名护栏 │
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
> **无侵入设计：** `browserpilot setup` 只会把内置扩展同步到升级不丢路径的 `~/.browserpilot/extension`，自动预算 Chrome 扩展 ID 并注册 **Chrome Native Messaging Host**（`com.browserpilot.bridge`）。它**绝不会**修改或篡改你任何 AI Agent 的配置文件或 skills 目录。

### 第 2 步：在 Chrome 加载扩展（一次性）

1. 打开 Chrome 地址栏输入 `chrome://extensions`，开启右上角 **开发者模式（Developer mode）**。
2. 点击 **加载已解压的扩展程序（Load unpacked）**，选择 `~/.browserpilot/extension`。
   > macOS 选文件弹窗内可按 `Cmd + Shift + G` 直接输入 `~/.browserpilot/extension`。
3. 加载后即通过 Native Messaging 秒级自动连上——**无需复制扩展 ID、无需手填 Token**，以后升级包也会保持相同路径和 ID。

*(如果你只想驱动带 `--remote-debugging-port` 的独立测试 Chrome，可直接跳过第 2 步，使用 `browserpilot browser start` 或 `--cdp` 模式。)*

### 第 3 步：在你需要的 AI Agent 中按需接入（二选一）

- **方式 A — 安装 Agent Skill + CLI（最轻量、最省上下文 Token）：**  
  只在你想用的 Agent 或单个项目里安装 [`skills/browserpilot/SKILL.md`](./skills/browserpilot/SKILL.md)：
  ```bash
  npx skills add xy-tuoren/browserpilot
  ```
  或将 `skills/browserpilot/SKILL.md`（或 `browserpilot skill` 的输出）放到指定项目的 `.claude/skills/browserpilot/`、`.agents/skills/browserpilot/` 目录即可，无需配置 MCP。

- **方式 B — 配置 MCP Server（51 个原生 `browser_*` 工具 + 截图直出给模型看）：**  
  将下面配置加入你想启用的 Agent 的 MCP 配置文件（Claude Code / Cursor / Codex / Antigravity）：
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

### 备选：源码构建 / 无扩展直连 CDP

```bash
git clone https://github.com/xy-tuoren/browserpilot.git
cd browserpilot
pnpm install
pnpm build
node packages/server/dist/cli.js setup
```

或者不装扩展，直接把 MCP 连接到已开启 `--remote-debugging-port` 的 Chrome：

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

### 有状态多步沙盒（Playwriter 替代方案）

```bash
# 创建一个隔离会话，并自动将打开的标签页归入指定颜色的 Chrome 标签组
browserpilot session new --tab-group app --tab-group-color cyan
# => 1

# 在持久沙盒中执行多步纯 CDP 自动化与 DevTools 辅助函数
browserpilot exec -s 1 -e '
  const t = await tabs.open("http://localhost:3000");
  state.tab = t;
  console.log(await snapshot({ tab: t }));
'

# 跨调用复用 state 状态
browserpilot exec -s 1 -e '
  await state.tab.page.fill("e3", "alice@example.com");
  await state.tab.page.click("e4");
  console.log(await getLatestLogs({ tab: state.tab, sinceLastCall: true }));
'
```

### 一行快捷命令

```bash
browserpilot doctor                                  # 诊断扩展、Native Messaging、Chrome、ffmpeg 与守护进程
browserpilot tabs                                    # 列出 Chrome 所有已打开标签页
browserpilot open example.com                        # 打开标签页并零点击自动附加（裸域名自动补协议）
browserpilot snapshot --search "Sign in|Login"       # 语义无障碍树快照（带 e1/e2 编号 + 正则检索 + 增量 Diff）
browserpilot click e3                                # 浏览器级可信鼠标点击（isTrusted=true）
browserpilot fill e4 "hello world"                   # 兼容 React/Vue 等 SPA 的可信文本输入
browserpilot screenshot ./page.png --full-page       # CSS 像素缩放截图
browserpilot labeled-screenshot ./som.png            # Vimium 风格 Set-of-Mark 标号截图
browserpilot console --level error --since-last      # 增量查看控制台报错与未捕获异常
browserpilot network --failed                        # 查看失败 HTTP 请求及发起调用栈
browserpilot styles "#submit-btn"                    # 查看 DevTools 命中样式级联（含 file:line）
browserpilot react "#submit-btn"                     # 检查 React Fiber 组件名与源码位置
browserpilot perf metrics                            # 采集 Core Web Vitals（LCP/CLS/FCP/TTFB）与内存指标
browserpilot downloads list                          # 查看或等待浏览器文件下载
browserpilot record-actions start                    # 录制人工操作并导出可复用脚本 / Agent Skill Markdown
browserpilot skill                                   # 打印完整 Agent Skill 使用文档
```

---

## 完整 MCP 工具矩阵（共 51 个工具）

| 分类 | 工具列表 |
| :--- | :--- |
| **浏览器、标签页与 Frame** | `browser_status`, `browser_tabs`, `browser_frames`, `browser_open_tab`, `browser_close_tab`, `browser_select_tab` |
| **导航与页面感知** | `browser_navigate`, `browser_history`, `browser_snapshot`（支持 `frame` / `scope` / `search`）, `browser_screenshot`（支持 `grid` 网格与 `zoom` 放大）, `browser_labeled_screenshot`, `browser_clean_html`, `browser_markdown`, `browser_inspect_element`（含推荐稳定定位器）, `browser_pinned` |
| **可信交互与智能等待** | `browser_click`（含遮挡/稳定性自检 + 新开弹窗与弹窗文案反馈）, `browser_check`（幂等勾选）, `browser_fill`, `browser_fill_form`（文本/单多选/复选/单选/滑块/文件）, `browser_type`, `browser_press_key`（`down`/`up`/`repeat` + 原生编辑指令）, `browser_hover`, `browser_scroll`, `browser_drag`（两点拖拽 & 多点 `points` 轨迹绘制）, `browser_select_option`, `browser_upload_file`, `browser_handle_dialog`, `browser_wait`（`selector`+`state` / `text`+`gone` / `url` / `responseUrl` / `fn` / `popup`）, `browser_batch`, `browser_handoff`（页内人工接管卡片） |
| **系统与上下文控制** | `browser_clipboard`（剪贴板读写）, `browser_pdf`（导出 PDF）, `browser_init_script`（持久化前置注入脚本）, `browser_permissions`（授予/重置权限）, `browser_emulate`, `browser_cookies`, `browser_storage` |
| **DevTools 深度调试** | `browser_evaluate`（支持 `frame`）, `browser_console`, `browser_network`, `browser_network_intercept`, `browser_styles`, `browser_react_info`, `browser_debugger`, `browser_live_edit`, `browser_performance`, `browser_cdp` |
| **下载、录屏与沙盒** | `browser_downloads`, `browser_action_recorder`（含 API 与报错记录）, `browser_record`, `browser_exec`（链式 `locator()`、`onResponse`、`mouse`/`keyboard`） |

---

## 安全与内置护栏

1. **禁止清除全配置文件数据**：核心引擎与扩展双层拦截 `Network.clearBrowserCookies` / `Network.clearBrowserCache`，防止 Agent 意外登出你所有网站（按单页清理请使用 `browser_cookies`）。
2. **域名黑白名单**：在扩展弹窗中可直接配置禁止接管的敏感域名（例如 `*.bank.com`），支持浅色 / 深色主题切换。
3. **一键急停开关**：在扩展弹窗或侧边栏点一下 `Pause`，立即暂停全部自动附加与 CDP 指令。
4. **仅本机鉴权通信**：守护进程严格绑定 `127.0.0.1` 并校验 256-bit 随机 Token（存放在权限 `0600` 的 `~/.browserpilot/daemon.json`），首选按扩展 ID 锁定的 Chrome Native Messaging 通道。
5. **透明可控**：遵循 Chrome 官方 `chrome.debugger` 机制，调试时浏览器顶部会显示标准提示条（本地独立开发测试也可用 `browserpilot browser start --silent-debugger` 启动）。

---

## Monorepo 包结构

- [`packages/protocol`](./packages/protocol) — 共享协议类型、JSON-RPC 桥 Schema、Native Messaging 分帧/分片编解码（64 MB 入站 + 自动分片）与安全守卫。
- [`packages/core`](./packages/core) — 100% 纯 CDP 引擎（可信输入、AXTree 快照、Set-of-Mark 截图、全套 DevTools 调试器、ffmpeg 智能录屏、下载管理、动作录制器与有状态沙盒）。
- [`packages/extension`](./packages/extension) — 零点击 Chrome Manifest V3 扩展（Closed-Shadow-DOM 高亮与幽灵光标、弹窗设置、伴随侧边栏实时错误/网络面板）。
- [`packages/server`](./packages/server) — 发布为 npm 包 `browserpilot-cdp`（内置本地鉴权守护进程、Native Messaging Host 与安装器、51 工具 MCP Server、CLI 与 SDK）。
- [`skills/browserpilot/SKILL.md`](./skills/browserpilot/SKILL.md) — 供 AI Agent 按需安装的标准化 Skill 文件。

## 开源协议

[MIT](./LICENSE) — 完整迭代日志请见 [CHANGELOG.md](./CHANGELOG.md)。
