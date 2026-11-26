#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BROWSERPILOT_VERSION,
  describeRecordedStep,
  type RecordedStep,
  type TabGroupColor,
} from '@browserpilot/protocol'
import { DaemonClient } from './client.js'
import { isDaemonReachable, loadOrCreateDaemonConfig, readDaemonConfig } from './config.js'
import { BrowserPilotDaemon } from './daemon.js'
import { startMcpServer } from './mcp.js'
import { TOOL_DEFINITIONS } from './tools.js'
import {
  computeChromeExtensionId,
  discoverInstalledExtensionIds,
  getStableExtensionDir,
  installNativeHost,
  readInstalledNativeHosts,
  syncExtensionToHome,
} from './native-install.js'
import { BROWSERPILOT_SKILL_DOC } from './skill-doc.js'

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

async function findDynamicCachedChrome(): Promise<string[]> {
  const found: string[] = []
  const home = os.homedir()
  const searchRoots = [
    path.join(home, '.cache', 'browserpilot-chrome', 'chrome'),
    path.join(home, 'Library', 'Caches', 'ms-playwright'),
    path.join(home, '.cache', 'ms-playwright'),
  ]
  for (const root of searchRoots) {
    let entries: string[]
    try {
      entries = (await fs.readdir(root)).sort().reverse()
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.startsWith('chromium-') && !entry.startsWith('mac') && !entry.startsWith('linux')) continue
      const candidates = [
        path.join(root, entry, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(root, entry, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(root, entry, 'chrome-linux64', 'chrome'),
        path.join(root, entry, 'chrome-linux', 'chrome'),
      ]
      for (const c of candidates) {
        try {
          await fs.access(c)
          found.push(c)
        } catch {}
      }
    }
  }
  return found
}

async function findChromeBinary(): Promise<string | null> {
  const staticCandidates = [
    process.env.BROWSERPILOT_CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean) as string[]

  for (const bin of staticCandidates) {
    try {
      await fs.access(bin)
      return bin
    } catch {}
  }

  const cached = await findDynamicCachedChrome()
  return cached[0] ?? null
}

function printHelp(): void {
  console.log(`BrowserPilot v${BROWSERPILOT_VERSION} — Zero-Click Pure-CDP Browser Control & DevTools CLI

Usage:
  browserpilot setup [--extension-id <id>] [--dry-run]   Sync extension, auto-install Native Messaging & print MCP config
  browserpilot doctor [--json]                           Diagnose extension, Native Messaging, Chrome, ffmpeg & daemon
  browserpilot daemon start | stop | restart | status | run  Manage local authenticated bridge daemon
  browserpilot mcp [--cdp <url>]                         Start MCP stdio server (for Claude/Cursor/Codex/Antigravity)
  browserpilot connect-cdp <url>                         Attach daemon directly to a --remote-debugging-port Chrome
  browserpilot browser start [--headless] [--cdp-port N] Launch Chrome/Chrome for Testing with BrowserPilot ready

Stateful Sessions, Codegen & Visual Trace:
  browserpilot session new [--tab-group <name>] [--tab-group-color <color>]
  browserpilot session list | update <id> [--tab-group <name>] [--tab-group-color <color>] | reset <id> | close <id>
  browserpilot exec -s <id> -e '<js>' | -f <script.js> [--timeout <ms>] [--trace <report.html>]
  browserpilot codegen [url] [--format playwright|browserpilot|skill|batch] [-o <file>] [--duration <sec>] [--tab <id>]
  browserpilot trace <start|stop|status|open> [path] [--title <str>] [--open] [--json] [--tab <id>]

Direct Quick Commands:
  browserpilot status
  browserpilot tabs | frames [--tab <id>]
  browserpilot open <url> [--tab-group <name>]
  browserpilot close <tabId>
  browserpilot navigate <url> [--tab <id>]
  browserpilot back | forward | reload [--ignore-cache] [--tab <id>]
  browserpilot snapshot [--tab <id>] [--search <regex>] [--scope <css>] [--frame <frame>] [--full]
  browserpilot markdown [--search <regex>] [--full] [--tab <id>]
  browserpilot html [--selector <css>] [--search <regex>] [--full] [--tab <id>]
  browserpilot click <ref|locator> [--force] [--double] [--button left|right|middle] [--modifiers Meta,Shift] [--tab <id>]
  browserpilot check | uncheck <ref|locator> [--force] [--tab <id>]
  browserpilot fill <ref|locator> <value> [--tab <id>]
  browserpilot fill-form '<json-fields>' [--tab <id>]
  browserpilot select <ref|locator> <val1> [val2...] [--tab <id>]
  browserpilot upload <ref|locator> <file1> [file2...] [--tab <id>]
  browserpilot key <combo> [--down|--up] [--repeat <N>] [--tab <id>]
  browserpilot hover <ref|locator> [--tab <id>]
  browserpilot drag <from> <to> [--steps <N>] | --points "x1,y1;x2,y2;..." [--tab <id>]
  browserpilot scroll [down|up|left|right] [--amount <px>] [--target <ref|sel>] [--tab <id>]
  browserpilot dialog <accept|dismiss> [--prompt <text>] [--auto] [--tab <id>]
  browserpilot wait [--selector <loc>] [--state visible|hidden|attached|detached] [--text <str>] [--gone] [--url <pat>] [--response <url>] [--fn <js>] [--popup] [--frame <f>] [--ms <N>] [--timeout <ms>]
  browserpilot handoff "<message>" [--timeout <ms>] [--tab <id>]
  browserpilot clipboard <read|write> [text] [--html <html>] [--tab <id>]
  browserpilot pdf [outputPath] [--landscape] [--scale <N>] [--pages <range>] [--tab <id>]
  browserpilot init-script <add|remove|list> [jsOrId] [--run-now] [--tab <id>]
  browserpilot permissions <grant|reset> [perm1,perm2...] [--origin <url>] [--tab <id>]
  browserpilot locator <ref|selector> [--tab <id>]
  browserpilot screenshot [outputPath] [--full-page] [--grid] [--zoom x,y,w,h] [--clip x,y,w,h] [--tab <id>]
  browserpilot labeled-screenshot [outputPath] [--tab <id>]
  browserpilot console [--level error] [--search <str>] [--since-last] [--tab <id>]
  browserpilot network [--failed] [--search <str>] [--request-id <id>] [--tab <id>]
  browserpilot styles <ref|selector> [--tab <id>]
  browserpilot react <ref|selector> [--tab <id>]
  browserpilot eval '<js>' [--frame <frame>] [--tab <id>]
  browserpilot perf [metrics|heap|trace_start|trace_stop|cpu_start|cpu_stop] [--tab <id>]
  browserpilot downloads [list|wait|clear] [--dir <path>] [--tab <id>]
  browserpilot record-actions [start|stop|status|clear|assert_next] [--format all|playwright|browserpilot|skill|batch] [-o <file>] [--tab <id>]
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

    const stableExtDir = getStableExtensionDir()
    let stableExtVersion: string | null = null
    try {
      const m = JSON.parse(await fs.readFile(path.join(stableExtDir, 'manifest.json'), 'utf8')) as { version?: string }
      stableExtVersion = m.version ?? null
    } catch {}
    const expectedStableExtId = computeChromeExtensionId(await fs.realpath(stableExtDir).catch(() => stableExtDir))

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

    const nativeHosts = await readInstalledNativeHosts()
    const discoveredExts = await discoverInstalledExtensionIds()

    const cfg = await readDaemonConfig()
    const daemonRunning = cfg ? await isDaemonReachable(cfg) : false
    let health: Awaited<ReturnType<DaemonClient['health']>> | null = null
    if (daemonRunning && cfg) {
      health = await new DaemonClient(cfg).health().catch(() => null)
    }
    const connectedClients = health?.clients ?? []
    const versionMismatch = Boolean(health?.version && health.version !== BROWSERPILOT_VERSION)

    const report = {
      version: BROWSERPILOT_VERSION,
      node: process.version,
      extensionBuilt: extBuilt,
      extensionDistPath: extDist,
      stableExtensionDir: stableExtDir,
      stableExtensionVersion: stableExtVersion,
      expectedExtensionId: expectedStableExtId,
      discoveredChromeExtensions: discoveredExts,
      chromeBinary: chromeBin,
      ffmpegAvailable: hasFfmpeg,
      daemonConfigPresent: Boolean(cfg),
      daemonRunning,
      daemonVersion: health?.version ?? null,
      daemonPid: health?.pid ?? cfg?.pid ?? null,
      daemonAddress: cfg ? `${cfg.host}:${cfg.port}` : null,
      daemonVersionMismatch: versionMismatch,
      connectedBrowsers: connectedClients.length,
      clients: connectedClients,
      nativeMessagingInstalled: nativeHosts.filter((n) => n.installed).map((n) => n.browser),
      nativeMessagingHosts: nativeHosts.filter((n) => n.installed),
    }

    if (flags.json) {
      console.log(JSON.stringify(report, null, 2))
      return
    }

    console.log(`BrowserPilot Doctor (v${BROWSERPILOT_VERSION})`)
    console.log(`──────────────────────────────────────────────────`)
    console.log(`Node.js          : ${report.node}`)
    console.log(`Extension dist/  : ${extBuilt ? 'OK' : 'MISSING (run pnpm build)'} (${extDist})`)
    console.log(
      `Stable ext copy  : ${
        stableExtVersion
          ? `v${stableExtVersion} (${stableExtDir}, id: ${expectedStableExtId})`
          : `Not synced yet (run: browserpilot setup)`
      }`,
    )
    console.log(
      `Chrome loaded    : ${
        discoveredExts.length
          ? discoveredExts.map((e) => `${e.browser}/${e.profile} (${e.extensionId})`).join(', ')
          : 'Not detected yet (load ~/.browserpilot/extension in chrome://extensions)'
      }`,
    )
    console.log(`Chrome binary    : ${chromeBin ?? 'Not found (set BROWSERPILOT_CHROME_BIN)'}`)
    console.log(`ffmpeg           : ${hasFfmpeg ? 'OK (video recording ready)' : 'Not found (optional for recording)'}`)
    console.log(
      `Daemon status    : ${
        daemonRunning
          ? `RUNNING v${health?.version ?? '?'} @ ${cfg?.host}:${cfg?.port} (pid: ${health?.pid ?? cfg?.pid ?? '?'}, browsers: ${connectedClients.length})`
          : 'STOPPED'
      }`,
    )
    if (versionMismatch) {
      console.log(
        `  ⚠ Version mismatch: CLI is v${BROWSERPILOT_VERSION}, running daemon is v${health?.version}. Run: browserpilot daemon restart`,
      )
    }
    for (const c of connectedClients) {
      console.log(
        `  • ${c.browser} [${c.transport}]${c.extensionVersion ? ` ext v${c.extensionVersion}` : ''}${c.extensionId ? ` (${c.extensionId})` : ''} — attached tabs: ${c.attachedTabCount}`,
      )
    }
    console.log(
      `Native Messaging : ${
        report.nativeMessagingInstalled.length
          ? `Installed (${report.nativeMessagingInstalled.join(', ')})`
          : 'Not installed (run: browserpilot setup)'
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
    const explicitExtId = typeof flags['extension-id'] === 'string' ? flags['extension-id'] : ''
    const dryRun = Boolean(flags['dry-run'])
    const skipNative = Boolean(flags['no-native-host'])

    const synced = await syncExtensionToHome(extDist, { dryRun })
    const discovered = await discoverInstalledExtensionIds()
    const bundledReal = await fs.realpath(extDist).catch(() => path.resolve(extDist))
    const bundledExtId = computeChromeExtensionId(bundledReal)

    const allExtIds = Array.from(
      new Set(
        [
          synced.extensionId,
          bundledExtId,
          ...discovered.map((d) => d.extensionId),
          ...explicitExtId.split(',').map((s) => s.trim()),
        ].filter(Boolean),
      ),
    )

    console.log(`\nBrowserPilot Setup (v${BROWSERPILOT_VERSION})`)
    console.log(`────────────────────────────────────────────────────`)
    console.log(`1. Stable Unpacked Extension Path (upgrade-safe):`)
    console.log(`   ${synced.extensionDir}`)
    console.log(`   Expected Chrome Extension ID : ${synced.extensionId}`)
    if (discovered.length > 0) {
      console.log(
        `   Already detected in Chrome   : ${discovered.map((d) => `${d.browser}/${d.profile} (${d.extensionId})`).join(', ')}`,
      )
    } else {
      console.log(`   -> Open chrome://extensions -> Enable "Developer mode" -> "Load unpacked" -> select the path above.`)
    }

    console.log(`\n2. Local Daemon Config (~/.browserpilot/daemon.json):`)
    console.log(`   WebSocket URL : ws://${cfg.host}:${cfg.port}/extension`)
    console.log(`   Auth Token    : ${cfg.token}`)

    if (!skipNative) {
      const res = await installNativeHost({ extensionIds: allExtIds, dryRun })
      console.log(`\n3. Chrome Native Messaging Host (${dryRun ? 'dry-run' : 'installed automatically'}):`)
      console.log(`   Wrapper : ${res.wrapperPath}`)
      console.log(`   Allowed : ${allExtIds.join(', ')}`)
      for (const m of res.installedManifests) {
        console.log(`   - ${m.browser}: ${m.manifestPath}`)
      }
      console.log(`   -> Zero manual token entry or --extension-id needed! Extension connects automatically once loaded.`)
    }

    const cliBin = path.resolve(__dirname, 'cli.js')
    console.log(`\n4. Connect Your AI Agent (Choose Option A or B — setup never modifies your agent configs):`)
    console.log(`\n   Option A — Agent Skill + CLI (install only where you want):`)
    console.log(`     npx skills add xy-tuoren/browserpilot`)
    console.log(`     (or print skill instructions with: browserpilot skill)`)
    console.log(`\n   Option B — MCP Server (${TOOL_DEFINITIONS.length} native tools + direct screenshot images):`)
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
      console.log(`BrowserPilot daemon v${h.version} running on http://${client.config.host}:${client.config.port} (clients: ${h.clients.length})`)
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
    if (sub === 'restart') {
      const cfg = await readDaemonConfig()
      if (cfg && (await isDaemonReachable(cfg))) {
        await new DaemonClient(cfg).shutdown()
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 100))
          if (!(await isDaemonReachable(cfg))) break
        }
      }
      const client = await DaemonClient.connectOrStart()
      const h = await client.health()
      console.log(`BrowserPilot daemon restarted (v${h.version}) on http://${client.config.host}:${client.config.port} (clients: ${h.clients.length})`)
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
      '--window-size=1280,800',
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
  const clientId = typeof flags.client === 'string' ? flags.client : undefined
  const tabId = typeof flags.tab === 'string' ? Number(flags.tab) : undefined
  const sessionId = typeof flags.s === 'string' ? flags.s : typeof flags.session === 'string' ? flags.session : undefined

  const parseRect = (raw: unknown): { x: number; y: number; width: number; height: number } | undefined => {
    if (typeof raw !== 'string') return undefined
    const nums = raw.split(',').map((s) => Number(s.trim()))
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
      throw new Error(`Expected x,y,width,height numeric tuple, got "${raw}"`)
    }
    return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] }
  }

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
    if (sub === 'update') {
      const sess = await client.updateSession(positional[2] || '1', {
        tabGroup: typeof flags['tab-group'] === 'string' ? flags['tab-group'] : undefined,
        tabGroupColor: typeof flags['tab-group-color'] === 'string' ? (flags['tab-group-color'] as TabGroupColor) : undefined,
      })
      console.log(`Updated session ${sess.id}: group=${sess.tabGroup} (${sess.tabGroupColor})`)
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
      tracePath: typeof flags.trace === 'string' ? flags.trace : undefined,
    })
    printToolOutput(res)
    return
  }

  if (cmd === 'codegen') {
    const targetUrl = positional[1]
    const format = typeof flags.format === 'string' ? flags.format : 'playwright'
    const outFile = typeof flags.o === 'string' ? flags.o : typeof flags.output === 'string' ? flags.output : undefined
    const durationSec = typeof flags.duration === 'string' ? Number(flags.duration) : undefined
    const maskPasswords = flags['no-mask-passwords'] ? false : true

    if (targetUrl) {
      await client.callTool('browser_navigate', { url: targetUrl, tabId, sessionId, clientId })
    }
    await client.callTool('browser_action_recorder', {
      action: 'start',
      maskPasswords,
      tabId,
      sessionId,
      clientId,
    })

    console.error(
      `Recording browser interactions (format=${format}${outFile ? `, output=${outFile}` : ''}). Tip: Alt+Shift+Click any element to record an assertion. Press Ctrl+C to finish…`,
    )

    let printedSteps = 0
    let finished = false
    await new Promise<void>((resolve) => {
      const finish = () => {
        if (finished) return
        finished = true
        clearInterval(poller)
        if (durationTimer) clearTimeout(durationTimer)
        process.off('SIGINT', finish)
        process.off('SIGTERM', finish)
        resolve()
      }

      process.on('SIGINT', finish)
      process.on('SIGTERM', finish)

      const durationTimer =
        durationSec && Number.isFinite(durationSec) && durationSec > 0
          ? setTimeout(finish, durationSec * 1000)
          : null

      const poller = setInterval(() => {
        void client
          .callTool('browser_action_recorder', { action: 'status', tabId, sessionId, clientId })
          .then((st) => {
            const steps = (st.meta?.steps as RecordedStep[] | undefined) ?? []
            while (printedSteps < steps.length) {
              const s = steps[printedSteps]
              console.error(`  ${printedSteps + 1}. ${describeRecordedStep(s)}`)
              printedSteps++
            }
          })
          .catch(() => {})
      }, 350)
    })

    const stopped = await client.callTool('browser_action_recorder', {
      action: 'stop',
      format,
      outputPath: outFile,
      tabId,
      sessionId,
      clientId,
    })
    printToolOutput(stopped)
    return
  }

  if (cmd === 'trace') {
    const sub = (positional[1] || 'status').toLowerCase()
    const pathArg =
      positional[2] ||
      (typeof flags.o === 'string' ? flags.o : typeof flags.output === 'string' ? flags.output : undefined)
    printToolOutput(
      await client.callTool('browser_trace', {
        action: sub,
        path: pathArg,
        title: typeof flags.title === 'string' ? flags.title : undefined,
        format: flags.json ? 'json' : undefined,
        screenshots: flags['no-screenshots'] ? false : undefined,
        snapshots: flags['no-snapshots'] ? false : undefined,
        networkBodies: flags['no-network-bodies'] ? false : undefined,
        openViewer: Boolean(flags.open),
        tabId,
        sessionId,
        clientId,
      }),
    )
    return
  }

  // Direct subcommand shortcuts mapped cleanly to unified tools
  switch (cmd) {
    case 'status':
      printToolOutput(await client.callTool('browser_status'))
      return
    case 'tabs':
      printToolOutput(await client.callTool('browser_tabs', { clientId }))
      return
    case 'frames':
      printToolOutput(await client.callTool('browser_frames', { tabId, sessionId, clientId }))
      return
    case 'open':
      printToolOutput(
        await client.callTool('browser_open_tab', {
          url: positional[1] || 'about:blank',
          tabGroup: typeof flags['tab-group'] === 'string' ? flags['tab-group'] : undefined,
          sessionId,
          clientId,
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
    case 'back':
      printToolOutput(await client.callTool('browser_history', { action: 'back', tabId, sessionId }))
      return
    case 'forward':
      printToolOutput(await client.callTool('browser_history', { action: 'forward', tabId, sessionId }))
      return
    case 'reload':
      printToolOutput(
        await client.callTool('browser_history', {
          action: 'reload',
          ignoreCache: Boolean(flags['ignore-cache']),
          tabId,
          sessionId,
        }),
      )
      return
    case 'snapshot':
      printToolOutput(
        await client.callTool('browser_snapshot', {
          tabId,
          sessionId,
          clientId,
          search: typeof flags.search === 'string' ? flags.search : undefined,
          scope: typeof flags.scope === 'string' ? flags.scope : undefined,
          frame: typeof flags.frame === 'string' ? flags.frame : undefined,
          showDiffSinceLastCall: flags.full ? false : undefined,
        }),
      )
      return
    case 'markdown':
      printToolOutput(
        await client.callTool('browser_markdown', {
          tabId,
          sessionId,
          search: typeof flags.search === 'string' ? flags.search : undefined,
          showDiffSinceLastCall: flags.full ? false : undefined,
        }),
      )
      return
    case 'html':
      printToolOutput(
        await client.callTool('browser_clean_html', {
          tabId,
          sessionId,
          selector: typeof flags.selector === 'string' ? flags.selector : undefined,
          search: typeof flags.search === 'string' ? flags.search : undefined,
          showDiffSinceLastCall: flags.full ? false : undefined,
          includeStyles: Boolean(flags['include-styles']),
        }),
      )
      return
    case 'click': {
      const rawMods = typeof flags.modifiers === 'string'
        ? flags.modifiers.split(',').map((s) => {
            const l = s.trim().toLowerCase()
            if (l === 'cmd' || l === 'meta' || l === 'command') return 'Meta'
            if (l === 'ctrl' || l === 'control') return 'Control'
            if (l === 'alt' || l === 'option') return 'Alt'
            if (l === 'shift') return 'Shift'
            return s.trim()
          })
        : undefined
      printToolOutput(
        await client.callTool('browser_click', {
          target: positional[1],
          button: typeof flags.button === 'string' ? flags.button : undefined,
          clickCount: flags.double ? 2 : typeof flags['click-count'] === 'string' ? Number(flags['click-count']) : undefined,
          modifiers: rawMods,
          force: Boolean(flags.force),
          strict: Boolean(flags.strict),
          timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'check':
    case 'uncheck':
      printToolOutput(
        await client.callTool('browser_check', {
          target: positional[1],
          checked: cmd === 'check',
          force: Boolean(flags.force),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    case 'select': {
      const values = positional.slice(2)
      if (!positional[1] || !values.length) throw new Error('Usage: browserpilot select <target> <value> [value2...]')
      printToolOutput(
        await client.callTool('browser_select_option', {
          target: positional[1],
          value: values.length === 1 ? values[0] : undefined,
          values: values.length > 1 ? values : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'upload': {
      const files = positional.slice(2)
      if (!positional[1] || !files.length) throw new Error('Usage: browserpilot upload <target> <file1> [file2...]')
      printToolOutput(
        await client.callTool('browser_upload_file', {
          target: positional[1],
          files,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'drag': {
      if (typeof flags.points === 'string') {
        const points = flags.points.split(';').map((pair) => {
          const [x, y] = pair.split(',').map((n) => Number(n.trim()))
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Invalid point "${pair}" in --points`)
          return { x, y }
        })
        printToolOutput(
          await client.callTool('browser_drag', {
            points,
            steps: typeof flags.steps === 'string' ? Number(flags.steps) : undefined,
            tabId,
            sessionId,
            clientId,
          }),
        )
        return
      }
      printToolOutput(
        await client.callTool('browser_drag', {
          fromTarget: positional[1],
          toTarget: positional[2],
          steps: typeof flags.steps === 'string' ? Number(flags.steps) : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'dialog': {
      const action = (positional[1] || 'accept').toLowerCase()
      printToolOutput(
        await client.callTool('browser_handle_dialog', {
          accept: action !== 'dismiss' && action !== 'cancel',
          promptText: typeof flags.prompt === 'string' ? flags.prompt : undefined,
          auto: Boolean(flags.auto),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'clipboard': {
      const action = (positional[1] || 'read').toLowerCase()
      printToolOutput(
        await client.callTool('browser_clipboard', {
          action,
          text: positional.slice(2).join(' ') || undefined,
          html: typeof flags.html === 'string' ? flags.html : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'pdf':
      printToolOutput(
        await client.callTool('browser_pdf', {
          path: positional[1] || `browserpilot-page-${Date.now()}.pdf`,
          landscape: Boolean(flags.landscape),
          printBackground: flags['no-background'] ? false : true,
          scale: typeof flags.scale === 'string' ? Number(flags.scale) : undefined,
          pageRanges: typeof flags.pages === 'string' ? flags.pages : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    case 'init-script': {
      const action = (positional[1] || 'list').toLowerCase()
      printToolOutput(
        await client.callTool('browser_init_script', {
          action,
          script: action === 'add' ? positional[2] : undefined,
          id: action === 'remove' ? positional[2] : undefined,
          runNow: Boolean(flags['run-now']),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'permissions': {
      const action = (positional[1] || 'grant').toLowerCase()
      const perms = positional[2] ? positional[2].split(',').map((s) => s.trim()).filter(Boolean) : []
      printToolOutput(
        await client.callTool('browser_permissions', {
          action,
          permissions: perms,
          origin: typeof flags.origin === 'string' ? flags.origin : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'locator': {
      const res = await client.callTool('browser_inspect_element', {
        target: positional[1],
        tabId,
        sessionId,
        clientId,
      })
      const rec = (res.meta?.info as { recommendedLocator?: string } | undefined)?.recommendedLocator
      if (rec) console.log(rec)
      else printToolOutput(res)
      return
    }
    case 'fill-form': {
      const rawFields = positional[1]
      if (!rawFields) throw new Error('Provide JSON array of fields: browserpilot fill-form \'[{"target":"#name","value":"Alice"}]\'')
      const fields = JSON.parse(rawFields) as unknown[]
      printToolOutput(await client.callTool('browser_fill_form', { fields, tabId, sessionId, clientId }))
      return
    }
    case 'handoff':
      printToolOutput(
        await client.callTool('browser_handoff', {
          message: positional[1] || 'Please complete this step in Chrome, then click "Done, Continue AI".',
          timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    case 'hover':
      printToolOutput(await client.callTool('browser_hover', { target: positional[1], tabId, sessionId }))
      return
    case 'scroll': {
      const dir = positional[1]
      const direction =
        dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right' ? dir : 'down'
      printToolOutput(
        await client.callTool('browser_scroll', {
          direction,
          amount: typeof flags.amount === 'string' ? Number(flags.amount) : undefined,
          target: typeof flags.target === 'string' ? flags.target : undefined,
          tabId,
          sessionId,
        }),
      )
      return
    }
    case 'wait':
      printToolOutput(
        await client.callTool('browser_wait', {
          selector: typeof flags.selector === 'string' ? flags.selector : undefined,
          state: typeof flags.state === 'string' ? flags.state : undefined,
          text: typeof flags.text === 'string' ? flags.text : undefined,
          gone: Boolean(flags.gone),
          url: typeof flags.url === 'string' ? flags.url : undefined,
          responseUrl: typeof flags.response === 'string' ? flags.response : undefined,
          responseStatus: typeof flags.status === 'string' ? Number(flags.status) : undefined,
          responseMethod: typeof flags.method === 'string' ? flags.method : undefined,
          fn: typeof flags.fn === 'string' ? flags.fn : undefined,
          popup: Boolean(flags.popup),
          frame: typeof flags.frame === 'string' ? flags.frame : undefined,
          ms: typeof flags.ms === 'string' ? Number(flags.ms) : undefined,
          timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    case 'fill':
      printToolOutput(await client.callTool('browser_fill', { target: positional[1], value: positional[2] ?? '', tabId, sessionId, clientId }))
      return
    case 'type':
      printToolOutput(await client.callTool('browser_type', { target: positional[2] ? positional[1] : undefined, text: positional[2] ?? positional[1], tabId, sessionId, clientId }))
      return
    case 'key':
      printToolOutput(
        await client.callTool('browser_press_key', {
          key: positional[1],
          action: flags.down ? 'down' : flags.up ? 'up' : 'press',
          repeat: typeof flags.repeat === 'string' ? Number(flags.repeat) : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    case 'screenshot': {
      const zoomRect = parseRect(flags.zoom)
      const clipRect = parseRect(flags.clip)
      printToolOutput(
        await client.callTool('browser_screenshot', {
          path: positional[1] || `browserpilot-shot-${Date.now()}.png`,
          fullPage: Boolean(flags['full-page']),
          grid: Boolean(flags.grid),
          gridStep: typeof flags['grid-step'] === 'string' ? Number(flags['grid-step']) : undefined,
          clip: clipRect,
          zoom: zoomRect
            ? { ...zoomRect, scale: typeof flags.scale === 'string' ? Number(flags.scale) : 2 }
            : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
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
      printToolOutput(
        await client.callTool('browser_evaluate', {
          expression: positional[1],
          frame: typeof flags.frame === 'string' ? flags.frame : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
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
          outputPath: typeof flags.o === 'string' ? flags.o : typeof flags.output === 'string' ? flags.output : undefined,
          tabId,
          sessionId,
          clientId,
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
