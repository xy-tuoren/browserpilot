import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BROWSERPILOT_VERSION } from '@browserpilot/protocol'
import { DaemonClient } from '../client.js'
import { isDaemonReachable, loadOrCreateDaemonConfig, readDaemonConfig } from '../config.js'
import {
  computeChromeExtensionId,
  discoverInstalledExtensionIds,
  getStableExtensionDir,
  installNativeHost,
  readInstalledNativeHosts,
  syncExtensionToHome,
} from '../native-install.js'
import { CORE_MCP_TOOL_NAMES } from '../mcp.js'
import { TOOL_DEFINITIONS } from '../tools.js'
import { getExtensionDistPath, resolveServerEntryDir, type CliFlags } from './args.js'

async function findDynamicCachedChrome(): Promise<string[]> {
  const found: string[] = []
  const home = os.homedir()
  const searchRoots = [
    path.join(home, '.cache', 'browserpilot-chrome', 'chrome'),
    path.join(home, 'Library', 'Caches', 'ms-playwright'),
    path.join(home, '.cache', 'ms-playwright'),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'ms-playwright')] : []),
  ]
  for (const root of searchRoots) {
    let entries: string[]
    try {
      entries = (await fs.readdir(root)).sort().reverse()
    } catch {
      continue
    }
    for (const entry of entries) {
      if (
        !entry.startsWith('chromium-') &&
        !entry.startsWith('mac') &&
        !entry.startsWith('linux') &&
        !entry.startsWith('win')
      ) {
        continue
      }
      const candidates = [
        path.join(root, entry, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(root, entry, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(root, entry, 'chrome-linux64', 'chrome'),
        path.join(root, entry, 'chrome-linux', 'chrome'),
        path.join(root, entry, 'chrome-win', 'chrome.exe'),
        path.join(root, entry, 'chrome-win64', 'chrome.exe'),
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

export async function findChromeBinary(): Promise<string | null> {
  const winProgramFiles = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA,
  ].filter(Boolean) as string[]

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
    ...winProgramFiles.flatMap((base) => [
      path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ]),
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

export async function runDoctorCommand(flags: CliFlags): Promise<void> {
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
  const staleExtensionClients = connectedClients.filter(
    (c) => Boolean(c.extensionVersion && c.extensionVersion !== BROWSERPILOT_VERSION),
  )

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
    extensionVersionMismatch: staleExtensionClients.length > 0,
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
    const extVerNote = c.extensionVersion
      ? ` ext v${c.extensionVersion}${c.extensionVersion !== BROWSERPILOT_VERSION ? ` (⚠ stale, CLI is v${BROWSERPILOT_VERSION})` : ''}`
      : ''
    console.log(
      `  • ${c.browser} [${c.transport}]${extVerNote}${c.extensionId ? ` (${c.extensionId})` : ''} — attached tabs: ${c.attachedTabCount}`,
    )
  }
  if (staleExtensionClients.length > 0) {
    console.log(
      `  ⚠ Loaded Chrome extension is on an older build than v${BROWSERPILOT_VERSION}. Click Reload once in chrome://extensions (future idle updates auto-reload automatically).`,
    )
  }
  console.log(
    `Native Messaging : ${
      report.nativeMessagingInstalled.length
        ? `Installed (${report.nativeMessagingInstalled.join(', ')})`
        : 'Not installed (run: browserpilot setup)'
    }`,
  )
}

export async function runSetupCommand(flags: CliFlags): Promise<void> {
  const cfg = await loadOrCreateDaemonConfig()
  const extDist = await getExtensionDistPath()
  const explicitExtId = typeof flags['extension-id'] === 'string' ? flags['extension-id'] : ''
  const dryRun = Boolean(flags['dry-run'])
  const skipNative = Boolean(flags['no-native-host'])

  const synced = await syncExtensionToHome(extDist, { dryRun })
  if (!dryRun && synced.synced && (await isDaemonReachable(cfg))) {
    await new DaemonClient(cfg).reloadExtensions(false).catch(() => {})
  }
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
      console.log(`   - ${m.browser}: ${m.manifestPath}${m.registryKey ? ` (reg: ${m.registryKey})` : ''}`)
    }
    console.log(`   -> Zero manual token entry or --extension-id needed! Extension connects automatically once loaded.`)
  }

  const cliBin = path.resolve(resolveServerEntryDir(import.meta.url), 'cli.js')
  console.log(`\n4. Connect Your AI Agent (Choose Option A or B — setup never modifies your agent configs):`)
  console.log(`\n   Option A — Agent Skill + CLI (install only where you want):`)
  console.log(`     npx skills add xy-tuoren/browserpilot`)
  console.log(`     (or print skill instructions with: browserpilot skill)`)
  console.log(
    `\n   Option B — MCP Server (${CORE_MCP_TOOL_NAMES.size} low-token core tools + Code Mode by default; pass "--full" for all ${TOOL_DEFINITIONS.length} tools):`,
  )
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
}
