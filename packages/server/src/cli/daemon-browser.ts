import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describeRecordedStep, type RecordedStep, type TabGroupColor } from '@browserpilot/protocol'
import { DaemonClient } from '../client.js'
import { isDaemonReachable, readDaemonConfig } from '../config.js'
import { BrowserPilotDaemon } from '../daemon.js'
import { getExtensionDistPath, printToolOutput, type CliFlags } from './args.js'
import { findChromeBinary } from './setup-doctor.js'

export async function runDaemonCommand(sub: string, flags: CliFlags): Promise<void> {
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
    console.log(
      `BrowserPilot daemon v${h.version} running on http://${client.config.host}:${client.config.port} (clients: ${h.clients.length})`,
    )
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
    console.log(
      `BrowserPilot daemon restarted (v${h.version}) on http://${client.config.host}:${client.config.port} (clients: ${h.clients.length})`,
    )
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

export async function runBrowserStartCommand(flags: CliFlags): Promise<void> {
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
}

export async function runSessionCommand(
  client: DaemonClient,
  positional: string[],
  flags: CliFlags,
): Promise<void> {
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

export async function runExecCommand(
  client: DaemonClient,
  flags: CliFlags,
  opts: { sessionId?: string; tabId?: number },
): Promise<void> {
  let code = typeof flags.e === 'string' ? flags.e : ''
  if (!code && typeof flags.f === 'string') {
    code = await fs.readFile(path.resolve(flags.f), 'utf8')
  }
  if (!code) throw new Error('Provide code with -e "<js>" or -f <file>')
  const res = await client.callTool('browser_exec', {
    code,
    sessionId: opts.sessionId ?? '1',
    tabId: opts.tabId,
    timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) : undefined,
    tracePath: typeof flags.trace === 'string' ? flags.trace : undefined,
  })
  printToolOutput(res)
}

export async function runCodegenCommand(
  client: DaemonClient,
  positional: string[],
  flags: CliFlags,
  opts: { tabId?: number; sessionId?: string; clientId?: string },
): Promise<void> {
  const targetUrl = positional[1]
  const format = typeof flags.format === 'string' ? flags.format : 'playwright'
  const outFile = typeof flags.o === 'string' ? flags.o : typeof flags.output === 'string' ? flags.output : undefined
  const durationSec = typeof flags.duration === 'string' ? Number(flags.duration) : undefined
  const maskPasswords = flags['no-mask-passwords'] ? false : true

  if (targetUrl) {
    await client.callTool('browser_navigate', { url: targetUrl, ...opts })
  }
  await client.callTool('browser_action_recorder', {
    action: 'start',
    maskPasswords,
    ...opts,
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
        .callTool('browser_action_recorder', { action: 'status', ...opts })
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
    ...opts,
  })
  printToolOutput(stopped)
}

export async function runTraceCommand(
  client: DaemonClient,
  positional: string[],
  flags: CliFlags,
  opts: { tabId?: number; sessionId?: string; clientId?: string },
): Promise<void> {
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
      ...opts,
    }),
  )
}
