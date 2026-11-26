import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DaemonClient } from '../client.js'
import { ensureBrowserPilotHome, getBrowserPilotHomeDir } from '../config.js'
import { getExtensionDistPath, type CliFlags } from './args.js'
import { findChromeBinary } from './setup-doctor.js'

export interface ManagedBrowserState {
  pid: number
  port: number
  endpoint: string
  wsEndpoint: string
  chromePath: string
  profileDir: string
  ephemeral: boolean
  headless: boolean
  startedAt: number
  clientId?: string
}

export interface LaunchBrowserOptions {
  headless?: boolean
  port?: number
  profileDir?: string
  ephemeral?: boolean
  url?: string
  windowSize?: string
  chromePath?: string
  loadExtension?: boolean
  extraArgs?: string[]
  detached?: boolean
  timeoutMs?: number
}

export interface LaunchedBrowserHandle extends ManagedBrowserState {
  process: ChildProcess
  close: () => Promise<void>
}

export function getManagedBrowserStatePath(): string {
  return path.join(getBrowserPilotHomeDir(), 'launched-browser.json')
}

async function allocateFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = http.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('Failed to allocate a free local port')))
      }
    })
  })
}

async function waitForCdpVersion(
  endpoint: string,
  proc: ChildProcess,
  stderrBuf: string[],
  timeoutMs: number,
): Promise<{ webSocketDebuggerUrl: string; Browser?: string }> {
  const deadline = Date.now() + timeoutMs
  let exitedCode: number | null = null
  const onExit = (code: number | null) => {
    exitedCode = code ?? 1
  }
  proc.once('exit', onExit)
  try {
    while (Date.now() < deadline) {
      if (exitedCode !== null) {
        const tail = stderrBuf.join('').trim().slice(-400)
        throw new Error(
          `Chrome exited prematurely (code ${exitedCode}) before CDP became ready.${tail ? `\n${tail}` : ''}`,
        )
      }
      try {
        const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(800) })
        if (res.ok) {
          const data = (await res.json()) as { webSocketDebuggerUrl?: string; Browser?: string }
          if (data.webSocketDebuggerUrl) {
            return { webSocketDebuggerUrl: data.webSocketDebuggerUrl, Browser: data.Browser }
          }
        }
      } catch {
        // Chrome still booting
      }
      await new Promise((r) => setTimeout(r, 120))
    }
    throw new Error(`Timed out waiting ${timeoutMs}ms for Chrome CDP at ${endpoint}`)
  } finally {
    proc.off('exit', onExit)
  }
}

export async function launchManagedBrowser(options: LaunchBrowserOptions = {}): Promise<LaunchedBrowserHandle> {
  const chromePath = options.chromePath || (await findChromeBinary())
  if (!chromePath) {
    throw new Error('No Chrome/Chromium binary found. Install Chrome or set BROWSERPILOT_CHROME_BIN.')
  }

  const port = options.port && options.port > 0 ? options.port : await allocateFreePort()
  const headless = options.headless === true
  const ephemeral = options.ephemeral ?? !options.profileDir
  let profileDir: string
  if (options.profileDir) {
    profileDir = path.resolve(options.profileDir)
    await fs.mkdir(profileDir, { recursive: true })
  } else if (ephemeral) {
    profileDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-launch-')))
  } else {
    profileDir = path.join(getBrowserPilotHomeDir(), 'chrome-profile')
    await fs.mkdir(profileDir, { recursive: true })
  }

  const windowSize = (options.windowSize || '1280,800').replace(/x/i, ',')
  const args: string[] = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-renderer-backgrounding',
    `--window-size=${windowSize}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
  ]
  if (headless) {
    args.push('--headless=new', '--disable-gpu')
  }
  const isLinuxRoot = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
  if (process.env.CI || isLinuxRoot) {
    args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage')
  }
  if (options.loadExtension && chromePath.includes('Chrome for Testing')) {
    const extDist = await getExtensionDistPath()
    args.push(`--disable-extensions-except=${extDist}`, `--load-extension=${extDist}`)
  }
  if (options.extraArgs?.length) {
    args.push(...options.extraArgs)
  }
  args.push(options.url || 'about:blank')

  const detached = Boolean(options.detached)
  const proc = spawn(chromePath, args, {
    detached,
    stdio: detached ? 'ignore' : ['ignore', 'ignore', 'pipe'],
  })
  const stderrBuf: string[] = []
  if (!detached && proc.stderr) {
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderrBuf.length < 20) stderrBuf.push(chunk.toString('utf8'))
    })
  }

  const endpoint = `http://127.0.0.1:${port}`
  let versionInfo: { webSocketDebuggerUrl: string; Browser?: string }
  try {
    versionInfo = await waitForCdpVersion(endpoint, proc, stderrBuf, options.timeoutMs ?? 15_000)
  } catch (err) {
    try {
      proc.kill('SIGTERM')
    } catch {}
    if (ephemeral) {
      await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {})
    }
    throw err
  }

  if (detached) {
    proc.unref()
  }

  const state: ManagedBrowserState = {
    pid: proc.pid ?? 0,
    port,
    endpoint,
    wsEndpoint: versionInfo.webSocketDebuggerUrl,
    chromePath,
    profileDir,
    ephemeral,
    headless,
    startedAt: Date.now(),
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    try {
      proc.kill('SIGTERM')
    } catch {}
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.killed) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {}
        resolve()
      }, 2_000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    if (ephemeral) {
      await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return { ...state, process: proc, close }
}

export async function getManagedBrowserStatus(): Promise<{
  running: boolean
  state: ManagedBrowserState | null
  browserVersion?: string
}> {
  const statePath = getManagedBrowserStatePath()
  let saved: ManagedBrowserState | null = null
  try {
    saved = JSON.parse(await fs.readFile(statePath, 'utf8')) as ManagedBrowserState
  } catch {
    return { running: false, state: null }
  }
  try {
    const res = await fetch(`${saved.endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })
    if (res.ok) {
      const data = (await res.json()) as { Browser?: string }
      return { running: true, state: saved, browserVersion: data.Browser }
    }
  } catch {
    // not reachable
  }
  return { running: false, state: saved }
}

export async function stopManagedBrowser(): Promise<{ stopped: boolean; pid?: number; cleanedProfile?: boolean }> {
  const statePath = getManagedBrowserStatePath()
  let saved: ManagedBrowserState | null = null
  try {
    saved = JSON.parse(await fs.readFile(statePath, 'utf8')) as ManagedBrowserState
  } catch {
    return { stopped: false }
  }
  let stopped = false
  if (saved.pid > 0) {
    try {
      process.kill(saved.pid, 'SIGTERM')
      stopped = true
    } catch {
      // Already exited
    }
  }
  let cleanedProfile = false
  if (saved.ephemeral && saved.profileDir) {
    await new Promise((r) => setTimeout(r, 250))
    await fs.rm(saved.profileDir, { recursive: true, force: true }).catch(() => {})
    cleanedProfile = true
  }
  await fs.rm(statePath, { force: true }).catch(() => {})
  return { stopped, pid: saved.pid, cleanedProfile }
}

export async function runLaunchCommand(subOrFlag: string | undefined, flags: CliFlags): Promise<void> {
  const sub = (subOrFlag || '').toLowerCase()
  if (sub === 'status') {
    const status = await getManagedBrowserStatus()
    if (flags.json) {
      console.log(JSON.stringify(status, null, 2))
      return
    }
    if (!status.running || !status.state) {
      console.log('Managed browser: STOPPED')
      return
    }
    console.log(
      `Managed browser: RUNNING (${status.browserVersion || status.state.chromePath})\n  Endpoint : ${status.state.endpoint}\n  PID      : ${status.state.pid}\n  Headless : ${status.state.headless}\n  Profile  : ${status.state.profileDir}`,
    )
    return
  }

  if (sub === 'stop') {
    const res = await stopManagedBrowser()
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }
    console.log(
      res.stopped
        ? `Stopped managed browser (PID ${res.pid})${res.cleanedProfile ? ' and cleaned ephemeral profile' : ''}.`
        : 'No running managed browser found.',
    )
    return
  }

  // Stop any stale managed browser before starting a fresh one if requested or dead
  const existing = await getManagedBrowserStatus()
  if (existing.running && existing.state && !flags.force) {
    if (flags.json) {
      console.log(JSON.stringify({ reused: true, ...existing.state }, null, 2))
    } else {
      console.log(
        `Managed browser already running on ${existing.state.endpoint} (PID ${existing.state.pid}). Use "browserpilot launch stop" or pass --force.`,
      )
    }
    return
  }
  if (existing.running && flags.force) {
    await stopManagedBrowser()
  }

  const port = typeof flags.port === 'string' ? Number(flags.port) : typeof flags['cdp-port'] === 'string' ? Number(flags['cdp-port']) : 0
  const profileDir =
    typeof flags.profile === 'string'
      ? flags.profile
      : typeof flags['user-data-dir'] === 'string'
        ? flags['user-data-dir']
        : undefined
  const ephemeral = Boolean(flags.ephemeral) || !profileDir
  const handle = await launchManagedBrowser({
    headless: Boolean(flags.headless),
    port,
    profileDir,
    ephemeral,
    url: typeof flags.url === 'string' ? flags.url : 'about:blank',
    windowSize: typeof flags['window-size'] === 'string' ? flags['window-size'] : undefined,
    loadExtension: !flags['no-extension'] && !flags.headless,
    detached: true,
  })

  let clientId: string | undefined
  if (!flags['no-connect']) {
    const client = await DaemonClient.connectOrStart()
    const connected = await client.connectDirectCDP(handle.endpoint)
    clientId = connected.clientId
  }

  const persisted: ManagedBrowserState = {
    pid: handle.pid,
    port: handle.port,
    endpoint: handle.endpoint,
    wsEndpoint: handle.wsEndpoint,
    chromePath: handle.chromePath,
    profileDir: handle.profileDir,
    ephemeral: handle.ephemeral,
    headless: handle.headless,
    startedAt: handle.startedAt,
    clientId,
  }
  await ensureBrowserPilotHome()
  await fs.writeFile(getManagedBrowserStatePath(), JSON.stringify(persisted, null, 2) + '\n', 'utf8')

  if (flags.json) {
    console.log(JSON.stringify(persisted, null, 2))
    return
  }
  console.log(
    `Launched managed ${persisted.headless ? 'headless ' : ''}Chrome (PID ${persisted.pid}):\n  Endpoint : ${persisted.endpoint}\n  Profile  : ${persisted.profileDir}${ephemeral ? ' (ephemeral)' : ''}${clientId ? `\n  ClientId : ${clientId}` : ''}`,
  )
}
