#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BROWSERPILOT_VERSION, type TabGroupColor } from '@browserpilot/protocol'
import { DaemonClient } from './client.js'
import { isDaemonReachable, loadOrCreateDaemonConfig, readDaemonConfig } from './config.js'
import { BrowserPilotDaemon } from './daemon.js'
import { startMcpServer } from './mcp.js'
import { installNativeHost, getNativeMessagingHostDirs } from './native-install.js'
import { BROWSERPILOT_SKILL_DOC } from './skill-doc.js'
import { NATIVE_HOST_NAME } from '@browserpilot/protocol'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      } else {
        const key = arg.slice(2)
        const next = argv[i + 1]
        if (next && !next.startsWith('-')) {
          flags[key] = next
          i++
        } else {
          flags[key] = true
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1)
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function printToolOutput(res: { content: Array<{ type: string; text?: string; mimeType?: string }>; isError?: boolean }): void {
  for (const item of res.content) {
    if (item.type === 'text' && item.text) {
      if (res.isError) console.error(item.text)
      else console.log(item.text)
    } else if (item.type === 'image') {
      console.log(`[image ${item.mimeType}]`)
    }
  }
  if (res.isError) process.exitCode = 1
}

async function getExtensionDistPath(): Promise<string> {
  const bundled = path.resolve(__dirname, '..', 'extension')
  try {
    await fs.access(path.join(bundled, 'manifest.json'))
    return bundled
  } catch {
    return path.resolve(__dirname, '..', '..', 'extension', 'dist')
  }
}

async function findChromeBinary(): Promise<string | null> {
  const candidates = [
    process.env.BROWSERPILOT_CHROME_BIN,
    path.join(
      os.homedir(),
      'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean) as string[]

  for (const bin of candidates) {
    try {
      await fs.access(bin)
      return bin
    } catch {}
  }
  return null
}

function printHelp(): void {
  console.log(`BrowserPilot v${BROWSERPILOT_VERSION} — Zero-Click Pure-CDP Browser Control & DevTools CLI

Usage:
  browserpilot setup [--extension-id <id>] [--dry-run]   Install Native Messaging host & print MCP setup
  browserpilot doctor                                    Diagnose extension, Native Messaging, Chrome, ffmpeg & daemon
  browserpilot daemon start | stop | status | run        Manage local authenticated bridge daemon
  browserpilot mcp [--cdp <url>]                         Start MCP stdio server (for Claude/Cursor/Codex/Antigravity)
  browserpilot connect-cdp <url>                         Attach daemon directly to a --remote-debugging-port Chrome
  browserpilot browser start [--headless] [--cdp-port N] Launch Chrome/Chrome for Testing with BrowserPilot ready

Stateful Sessions (Playwriter replacement):
  browserpilot session new [--tab-group <name>] [--tab-group-color <color>]
  browserpilot session list | reset <id> | close <id>
  browserpilot exec -s <id> -e '<js>' | -f <script.js> [--timeout <ms>]

Direct Quick Commands:
  browserpilot tabs
  browserpilot open <url> [--tab-group <name>]
  browserpilot close <tabId>
  browserpilot snapshot [--tab <id>] [--search <regex>] [--scope <css>] [--full]
  browserpilot click <ref|selector> [--tab <id>]
  browserpilot fill <ref|selector> <value> [--tab <id>]
  browserpilot screenshot [outputPath] [--full-page] [--tab <id>]
  browserpilot labeled-screenshot [outputPath] [--tab <id>]
  browserpilot console [--level error] [--search <str>] [--since-last] [--tab <id>]
  browserpilot network [--failed] [--search <str>] [--request-id <id>] [--tab <id>]
  browserpilot styles <ref|selector> [--tab <id>]
  browserpilot react <ref|selector> [--tab <id>]
  browserpilot eval '<js>' [--tab <id>]
  browserpilot perf [metrics|heap|trace_start|trace_stop|cpu_start|cpu_stop] [--tab <id>]
  browserpilot downloads [list|wait|clear] [--dir <path>] [--tab <id>]
  browserpilot record-actions [start|stop|status] [--format all|skill|script|batch] [--tab <id>]
  browserpilot skill                                     Output complete AI agent skill documentation
`)
}

async function main(): Promise<void> {
  const { positional, flags } = parseFlags(process.argv.slice(2))
  const cmd = positional[0]

  if (cmd === 'version' || flags.version || flags.v) {
    console.log(BROWSERPILOT_VERSION)
    return
  }

  if (!cmd || cmd === 'help' || flags.help || flags.h) {
    printHelp()
    return
  }

  if (cmd === 'skill') {
    console.log(BROWSERPILOT_SKILL_DOC)
    return
  }

  if (cmd === 'doctor') {
    const extDist = await getExtensionDistPath()
    let extBuilt = false
    try {
      await fs.access(path.join(extDist, 'manifest.json'))
      await fs.access(path.join(extDist, 'background.js'))
      extBuilt = true
    } catch {}

    const chromeBin = await findChromeBinary()

    let hasFfmpeg = false
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue
      try {
        await fs.access(path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
        hasFfmpeg = true
        break
      } catch {}
    }

    const nativeHosts: Array<{ browser: string; installed: boolean; path: string }> = []
    for (const target of getNativeMessagingHostDirs()) {
      const mp = path.join(target.dir, `${NATIVE_HOST_NAME}.json`)
      let installed = false
      try {
        await fs.access(mp)
        installed = true
      } catch {}
      nativeHosts.push({ browser: target.name, installed, path: mp })
    }

    const cfg = await readDaemonConfig()
    const daemonRunning = cfg ? await isDaemonReachable(cfg) : false
    let connectedClients = 0
    if (daemonRunning && cfg) {
      const h = await new DaemonClient(cfg).health().catch(() => null)
      connectedClients = h?.clients.length ?? 0
    }

    const report = {
      version: BROWSERPILOT_VERSION,
      node: process.version,
      extensionBuilt: extBuilt,
      extensionDistPath: extDist,
      chromeBinary: chromeBin,
      ffmpegAvailable: hasFfmpeg,
      daemonConfigPresent: Boolean(cfg),
      daemonRunning,
      connectedBrowsers: connectedClients,
      nativeMessagingInstalled: nativeHosts.filter((n) => n.installed).map((n) => n.browser),
    }

    if (flags.json) {
      console.log(JSON.stringify(report, null, 2))
      return
    }

    console.log(`BrowserPilot Doctor (v${BROWSERPILOT_VERSION})`)
    console.log(`──────────────────────────────────────────`)
    console.log(`Node.js          : ${report.node}`)
    console.log(`Extension dist/  : ${extBuilt ? 'OK' : 'MISSING (run pnpm build)'} (${extDist})`)
    console.log(`Chrome binary    : ${chromeBin ?? 'Not found (set BROWSERPILOT_CHROME_BIN)'}`)
    console.log(`ffmpeg           : ${hasFfmpeg ? 'OK (video recording ready)' : 'Not found (optional for recording)'}`)
    console.log(`Daemon status    : ${daemonRunning ? `RUNNING (browsers: ${connectedClients})` : 'STOPPED'}`)
    console.log(
      `Native Messaging : ${
        report.nativeMessagingInstalled.length
          ? `Installed (${report.nativeMessagingInstalled.join(', ')})`
          : 'Not installed (run: browserpilot setup --extension-id <id>)'
      }`,
    )
    return
  }

  if (cmd === 'mcp') {
    await startMcpServer({
      cdpEndpoint: typeof flags.cdp === 'string' ? flags.cdp : undefined,
      daemonHost: typeof flags.host === 'string' ? flags.host : undefined,
      daemonPort: typeof flags.port === 'string' ? Number(flags.port) : undefined,
      daemonToken: typeof flags.token === 'string' ? flags.token : undefined,
    })
    return
  }

  if (cmd === 'setup') {
    const cfg = await loadOrCreateDaemonConfig()
    const extDist = await getExtensionDistPath()
    const extId = typeof flags['extension-id'] === 'string' ? flags['extension-id'] : ''
    const dryRun = Boolean(flags['dry-run'])

    console.log(`\nBrowserPilot Setup (v${BROWSERPILOT_VERSION})`)
    console.log(`────────────────────────────────────────────────────`)
    console.log(`1. Unpacked Extension Path:\n   ${extDist}`)
    console.log(`   -> Open chrome://extensions -> Enable "Developer mode" -> "Load unpacked" -> select the path above.`)
    console.log(`\n2. Local Daemon Config (~/.browserpilot/daemon.json):`)
    console.log(`   WebSocket URL : ws://${cfg.host}:${cfg.port}/extension`)
    console.log(`   Auth Token    : ${cfg.token}`)

    if (extId) {
      const res = await installNativeHost({ extensionIds: [extId], dryRun })
      console.log(`\n3. Chrome Native Messaging Host (${dryRun ? 'dry-run' : 'installed'}):`)
      console.log(`   Wrapper: ${res.wrapperPath}`)
      for (const m of res.installedManifests) {
        console.log(`   - ${m.browser}: ${m.manifestPath}`)
      }
    } else {
      console.log(`\n3. Optional (Recommended) Native Messaging Auto-Auth:`)
      console.log(`   After loading the unpacked extension, copy its Extension ID from chrome://extensions and run:`)
      console.log(`   browserpilot setup --extension-id <YOUR_EXTENSION_ID>`)
    }

    const cliBin = path.resolve(__dirname, 'cli.js')
    console.log(`\n4. MCP Server Config (Claude Code / Cursor / Codex / Antigravity):`)
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            browserpilot: {
              command: process.execPath,
              args: [cliBin, 'mcp'],
            },
          },
        },
        null,
        2,
      ),
    )
    return
  }

  if (cmd === 'daemon') {
    const sub = positional[1] || 'status'
    if (sub === 'run') {
      const daemon = new BrowserPilotDaemon()
      const cfg = await daemon.start({
        host: typeof flags.host === 'string' ? flags.host : undefined,
        port: typeof flags.port === 'string' ? Number(flags.port) : undefined,
        token: process.env.BROWSERPILOT_DAEMON_TOKEN || (typeof flags.token === 'string' ? flags.token : undefined),
      })
      console.log(`BrowserPilot daemon listening on http://${cfg.host}:${cfg.port} (WS: /extension)`)
      const shutdown = () => {
        void daemon.stop().then(() => process.exit(0))
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      return
    }
    if (sub === 'start') {
      const client = await DaemonClient.connectOrStart()
      const h = await client.health()
      console.log(`BrowserPilot daemon running on http://${client.config.host}:${client.config.port} (clients: ${h.clients.length})`)
      return
    }
    if (sub === 'stop') {
      const cfg = await readDaemonConfig()
      if (!cfg || !(await isDaemonReachable(cfg))) {
        console.log('BrowserPilot daemon is not running.')
        return
      }
      await new DaemonClient(cfg).shutdown()
      console.log('BrowserPilot daemon stopped.')
      return
    }
    if (sub === 'status') {
      const cfg = await readDaemonConfig()
      if (!cfg || !(await isDaemonReachable(cfg))) {
        console.log('BrowserPilot daemon: STOPPED')
        return
      }
      const h = await new DaemonClient(cfg).health()
      console.log(JSON.stringify({ status: 'RUNNING', host: cfg.host, port: cfg.port, ...h }, null, 2))
      return
    }
    throw new Error(`Unknown daemon subcommand: ${sub}`)
  }

  if (cmd === 'browser' && positional[1] === 'start') {
    const chromeBin = await findChromeBinary()
    if (!chromeBin) throw new Error('No Chrome/Chromium binary found. Set BROWSERPILOT_CHROME_BIN.')
    const cdpPort = typeof flags['cdp-port'] === 'string' ? Number(flags['cdp-port']) : 9222
    const profileDir =
      typeof flags['user-data-dir'] === 'string'
        ? path.resolve(flags['user-data-dir'])
        : path.join(os.homedir(), '.browserpilot', 'chrome-profile')
    await fs.mkdir(profileDir, { recursive: true })

    const args = [
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
    ]
    if (flags.headless) args.push('--headless=new')
    if (flags['silent-debugger']) args.push('--silent-debugger-extension-api')
    const extDist = await getExtensionDistPath()
    if (!flags['no-extension'] && chromeBin.includes('Chrome for Testing')) {
      args.push(`--disable-extensions-except=${extDist}`, `--load-extension=${extDist}`)
    }
    args.push('about:blank')

    const proc = spawn(chromeBin, args, { detached: true, stdio: 'ignore' })
    proc.unref()

    // Wait briefly and attach daemon directly to CDP port
    const endpoint = `http://127.0.0.1:${cdpPort}`
    for (let i = 0; i < 30; i++) {
      try {
        if ((await fetch(`${endpoint}/json/version`)).ok) break
      } catch {}
      await new Promise((r) => setTimeout(r, 150))
    }
    const client = await DaemonClient.connectOrStart()
    const connected = await client.connectDirectCDP(endpoint)
    console.log(`Launched browser (${chromeBin}) and connected via Direct CDP: ${endpoint} (${connected.clientId})`)
    return
  }

  const client = await DaemonClient.connectOrStart()
  const tabId = typeof flags.tab === 'string' ? Number(flags.tab) : undefined
  const sessionId = typeof flags.s === 'string' ? flags.s : typeof flags.session === 'string' ? flags.session : undefined

  if (cmd === 'connect-cdp') {
    const endpoint = positional[1] || 'http://127.0.0.1:9222'
    const info = await client.connectDirectCDP(endpoint)
    console.log(JSON.stringify(info, null, 2))
    return
  }

  if (cmd === 'session') {
    const sub = positional[1] || 'list'
    if (sub === 'new') {
      const sess = await client.createSession({
        id: typeof flags.id === 'string' ? flags.id : undefined,
        tabGroup: typeof flags['tab-group'] === 'string' ? flags['tab-group'] : undefined,
        tabGroupColor: typeof flags['tab-group-color'] === 'string' ? (flags['tab-group-color'] as TabGroupColor) : undefined,
      })
      console.log(sess.id)
      return
    }
    if (sub === 'list') {
      const sessions = await client.listSessions()
      if (!sessions.length) {
        console.log('(no active sessions)')
        return
      }
      console.log('ID\tGroup\tTab\tState Keys')
      for (const s of sessions) {
        console.log(`${s.id}\t${s.tabGroup}\t${s.activeTabId ?? '-'}\t${s.stateKeys.join(', ') || '-'}`)
      }
      return
    }
    if (sub === 'reset') {
      const sess = await client.resetSession(positional[2] || '1')
      console.log(`Reset session ${sess.id}`)
      return
    }
    if (sub === 'close') {
      await client.closeSession(positional[2] || '1')
      console.log(`Closed session ${positional[2] || '1'}`)
      return
    }
    throw new Error(`Unknown session subcommand: ${sub}`)
  }

  if (cmd === 'exec') {
    let code = typeof flags.e === 'string' ? flags.e : ''
    if (!code && typeof flags.f === 'string') {
      code = await fs.readFile(path.resolve(flags.f), 'utf8')
    }
    if (!code) throw new Error('Provide code with -e "<js>" or -f <file>')
    const res = await client.callTool('browser_exec', {
      code,
      sessionId: sessionId ?? '1',
      tabId,
      timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) : undefined,
    })
    printToolOutput(res)
    return
  }

  // Direct subcommand shortcuts mapped cleanly to unified tools
  switch (cmd) {
    case 'tabs':
      printToolOutput(await client.callTool('browser_tabs'))
      return
    case 'open':
      printToolOutput(
        await client.callTool('browser_open_tab', {
          url: positional[1] || 'about:blank',
          tabGroup: typeof flags['tab-group'] === 'string' ? flags['tab-group'] : undefined,
          sessionId,
        }),
      )
      return
    case 'close':
      printToolOutput(await client.callTool('browser_close_tab', { tabId: Number(positional[1]) }))
      return
    case 'navigate':
    case 'goto':
      printToolOutput(await client.callTool('browser_navigate', { url: positional[1], tabId, sessionId }))
      return
    case 'snapshot':
      printToolOutput(
        await client.callTool('browser_snapshot', {
          tabId,
          sessionId,
          search: typeof flags.search === 'string' ? flags.search : undefined,
          scope: typeof flags.scope === 'string' ? flags.scope : undefined,
          showDiffSinceLastCall: flags.full ? false : undefined,
        }),
      )
      return
    case 'click':
      printToolOutput(await client.callTool('browser_click', { target: positional[1], tabId, sessionId }))
      return
    case 'fill':
      printToolOutput(await client.callTool('browser_fill', { target: positional[1], value: positional[2] ?? '', tabId, sessionId }))
      return
    case 'type':
      printToolOutput(await client.callTool('browser_type', { target: positional[2] ? positional[1] : undefined, text: positional[2] ?? positional[1], tabId, sessionId }))
      return
    case 'key':
      printToolOutput(await client.callTool('browser_press_key', { key: positional[1], tabId, sessionId }))
      return
    case 'screenshot':
      printToolOutput(
        await client.callTool('browser_screenshot', {
          path: positional[1] || `browserpilot-shot-${Date.now()}.png`,
          fullPage: Boolean(flags['full-page']),
          tabId,
          sessionId,
        }),
      )
      return
    case 'labeled-screenshot':
      printToolOutput(
        await client.callTool('browser_labeled_screenshot', {
          path: positional[1] || `browserpilot-som-${Date.now()}.png`,
          tabId,
          sessionId,
        }),
      )
      return
    case 'console':
      printToolOutput(
        await client.callTool('browser_console', {
          level: typeof flags.level === 'string' ? flags.level : undefined,
          search: typeof flags.search === 'string' ? flags.search : undefined,
          sinceLastCall: Boolean(flags['since-last']),
          tabId,
          sessionId,
        }),
      )
      return
    case 'network':
      printToolOutput(
        await client.callTool('browser_network', {
          failedOnly: Boolean(flags.failed),
          search: typeof flags.search === 'string' ? flags.search : undefined,
          requestId: typeof flags['request-id'] === 'string' ? flags['request-id'] : undefined,
          sinceLastCall: Boolean(flags['since-last']),
          tabId,
          sessionId,
        }),
      )
      return
    case 'styles':
      printToolOutput(await client.callTool('browser_styles', { target: positional[1], tabId, sessionId }))
      return
    case 'react':
      printToolOutput(await client.callTool('browser_react_info', { target: positional[1], tabId, sessionId }))
      return
    case 'eval':
      printToolOutput(await client.callTool('browser_evaluate', { expression: positional[1], tabId, sessionId }))
      return
    case 'perf':
      printToolOutput(await client.callTool('browser_performance', { action: positional[1] || 'metrics', tabId, sessionId }))
      return
    case 'downloads':
      printToolOutput(
        await client.callTool('browser_downloads', {
          action: positional[1] || 'list',
          downloadDir: typeof flags.dir === 'string' ? flags.dir : undefined,
          filenamePattern: typeof flags.pattern === 'string' ? flags.pattern : undefined,
          timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) : undefined,
          tabId,
          sessionId,
        }),
      )
      return
    case 'record-actions':
      printToolOutput(
        await client.callTool('browser_action_recorder', {
          action: positional[1] || 'status',
          format: typeof flags.format === 'string' ? flags.format : undefined,
          tabId,
          sessionId,
        }),
      )
      return
    default:
      throw new Error(`Unknown command "${cmd}". Run "browserpilot --help" for usage.`)
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
