import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'

const execFileAsync = promisify(execFile)
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeNativeMessage, NativeMessageDecoder } from '@browserpilot/protocol'
import {
  DaemonClient,
  BrowserPilotDaemon,
  computeChromeExtensionId,
  installNativeHost,
  normalizeNavigationUrl,
  TOOL_DEFINITIONS,
} from '../src/index.js'

const CHROME_FOR_TESTING =
  process.env.BROWSERPILOT_CHROME_BIN ||
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  )

async function hasChrome(): Promise<boolean> {
  try {
    await fs.access(CHROME_FOR_TESTING)
    return true
  } catch {
    return false
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else reject(new Error('port error'))
    })
  })
}

const SERVER_TEST_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>BrowserPilot Full Stack Test</title>
  <style>.hero-btn { background: #2563eb; color: #fff; padding: 8px 14px; }</style>
</head>
<body>
  <h1>BrowserPilot Full Stack</h1>
  <input id="query" placeholder="Search term" />
  <button id="go-btn" class="hero-btn">Search Now</button>
  <div id="out">ready</div>
  <script>
    document.getElementById('go-btn').addEventListener('click', async (e) => {
      console.error('simulated-ui-error');
      const r = await fetch('/api/search?q=' + encodeURIComponent(document.getElementById('query').value));
      const j = await r.json();
      document.getElementById('out').textContent = (e.isTrusted ? 'ok:' : 'bad:') + j.echo;
    });
  </script>
</body>
</html>`

describe('@browserpilot/server full stack: Daemon, Native Host, MCP stdio, CLI & Real Extension', () => {
  let httpServer: http.Server
  let baseUrl = ''
  let daemon: BrowserPilotDaemon
  let daemonPort = 0
  let daemonToken = 'e2e-secret-token-xyz'
  let chromeDirectProc: ChildProcess | null = null
  let chromeExtProc: ChildProcess | null = null
  let directEndpoint = ''
  let tmpDirs: string[] = []
  let chromeOk = false

  beforeAll(async () => {
    chromeOk = await hasChrome()
    if (!chromeOk) return

    const httpPort = await getFreePort()
    httpServer = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/search')) {
        const u = new URL(req.url, 'http://127.0.0.1')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ echo: u.searchParams.get('q') ?? '' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(SERVER_TEST_HTML)
    })
    await new Promise<void>((r) => httpServer.listen(httpPort, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${httpPort}`

    // 1. Start local BrowserPilot Daemon on a free port
    daemonPort = await getFreePort()
    daemon = new BrowserPilotDaemon()
    await daemon.start({
      host: '127.0.0.1',
      port: daemonPort,
      token: daemonToken,
      persistRuntime: false,
    })

    // 2. Start headless Chrome with --remote-debugging-port for MCP Direct CDP tests
    const debugPort = await getFreePort()
    const directDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-srv-direct-'))
    tmpDirs.push(directDir)
    chromeDirectProc = spawn(
      CHROME_FOR_TESTING,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        ...(process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${directDir}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    )
    directEndpoint = `http://127.0.0.1:${debugPort}`
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${directEndpoint}/json/version`)).ok) break
      } catch {}
      await new Promise((r) => setTimeout(r, 150))
    }
  }, 30_000)

  afterAll(async () => {
    await daemon?.stop()
    if (chromeDirectProc) chromeDirectProc.kill('SIGTERM')
    if (chromeExtProc) chromeExtProc.kill('SIGTERM')
    if (httpServer) await new Promise<void>((r) => httpServer.close(() => r()))
    for (const d of tmpDirs) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('computes deterministic Chrome unpacked extension IDs and normalizes bare navigation URLs', () => {
    const extId = computeChromeExtensionId('/Users/xy/code/GeoPerch/extensions/session-export')
    expect(extId).toBe('ijmnhnbofbelbelnekloahnfjdecbpcm')
    expect(extId).toMatch(/^[a-p]{32}$/)

    expect(normalizeNavigationUrl('example.com')).toBe('https://example.com')
    expect(normalizeNavigationUrl('localhost:3000/app')).toBe('http://localhost:3000/app')
    expect(normalizeNavigationUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(normalizeNavigationUrl('https://github.com')).toBe('https://github.com')
    expect(normalizeNavigationUrl('')).toBe('about:blank')
  })

  it('replays cached hello metadata when native-host reconnects after a daemon restart', async () => {
    const restartPort = await getFreePort()
    const restartToken = 'restart-secret-token'
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-restart-'))
    tmpDirs.push(fakeHome)
    await fs.writeFile(
      path.join(fakeHome, 'daemon.json'),
      JSON.stringify({ host: '127.0.0.1', port: restartPort, token: restartToken }),
    )

    let d1: BrowserPilotDaemon | null = new BrowserPilotDaemon()
    let d2: BrowserPilotDaemon | null = null
    let proc: ChildProcess | null = null

    try {
      await d1.start({ host: '127.0.0.1', port: restartPort, token: restartToken, persistRuntime: false })
      const nativeHostBin = path.resolve(import.meta.dirname, '..', 'dist', 'native-host.js')
      proc = spawn(process.execPath, [nativeHostBin], {
        env: { ...process.env, BROWSERPILOT_HOME: fakeHome },
        stdio: ['pipe', 'pipe', 'ignore'],
      })

      proc.stdin!.write(
        encodeNativeMessage({
          type: 'hello',
          token: '',
          extensionId: 'reconnect-test-ext-id',
          extensionVersion: '1.2.1',
          browser: 'Chrome',
          transport: 'native',
        }),
      )

      // Wait for registration on d1
      const c1 = new DaemonClient({ host: '127.0.0.1', port: restartPort, token: restartToken })
      let reg1 = false
      for (let i = 0; i < 30; i++) {
        const h = await c1.health()
        if (h.clients.some((c) => c.extensionId === 'reconnect-test-ext-id')) {
          reg1 = true
          break
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(reg1).toBe(true)

      // Restart daemon on the same port — native-host must auto-reconnect & replay cached hello!
      await d1.stop()
      d1 = null
      d2 = new BrowserPilotDaemon()
      await d2.start({ host: '127.0.0.1', port: restartPort, token: restartToken, persistRuntime: false })

      let reg2 = false
      for (let i = 0; i < 40; i++) {
        const h = await c1.health()
        if (h.clients.some((c) => c.extensionId === 'reconnect-test-ext-id' && c.transport === 'extension-native')) {
          reg2 = true
          break
        }
        await new Promise((r) => setTimeout(r, 150))
      }
      expect(reg2).toBe(true)
    } finally {
      if (proc) {
        proc.stdin?.end()
        proc.kill('SIGTERM')
      }
      await d1?.stop()
      await d2?.stop()
    }
  }, 20_000)

  it('enforces Bearer token authentication on Daemon HTTP endpoints', async () => {
    if (!chromeOk) return
    const unauth = await fetch(`http://127.0.0.1:${daemonPort}/api/health`)
    expect(unauth.status).toBe(401)

    const auth = await fetch(`http://127.0.0.1:${daemonPort}/api/health`, {
      headers: { Authorization: `Bearer ${daemonToken}` },
    })
    expect(auth.status).toBe(200)
    const body = (await auth.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('generates valid Native Messaging host manifest in dry-run and bridges real stdio native frames', async () => {
    if (!chromeOk) return
    const dry = await installNativeHost({ extensionIds: ['abcdefghijklmnopabcdefghijklmnop'], dryRun: true })
    expect(dry.manifestJson.name).toBe('com.browserpilot.bridge')
    expect(dry.manifestJson.allowed_origins).toEqual(['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'])
    expect(dry.installedManifests.length).toBeGreaterThan(0)

    // Test real native-host.js binary framing with an isolated BROWSERPILOT_HOME pointing to our test daemon
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-home-'))
    tmpDirs.push(fakeHome)
    await fs.writeFile(
      path.join(fakeHome, 'daemon.json'),
      JSON.stringify({ host: '127.0.0.1', port: daemonPort, token: daemonToken }),
    )

    const nativeHostBin = path.resolve(import.meta.dirname, '..', 'dist', 'native-host.js')
    const proc = spawn(process.execPath, [nativeHostBin], {
      env: { ...process.env, BROWSERPILOT_HOME: fakeHome },
      stdio: ['pipe', 'pipe', 'ignore'],
    })

    const decoder = new NativeMessageDecoder()
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native host did not reply with pong')), 8_000)
      proc.stdout.on('data', (chunk: Buffer) => {
        for (const msg of decoder.push(chunk) as Array<Record<string, unknown>>) {
          if (msg.type === 'pong') {
            clearTimeout(timer)
            resolve(msg)
          }
        }
      })
    })

    proc.stdin.write(
      encodeNativeMessage({
        type: 'hello',
        token: '',
        extensionId: 'native-test-ext',
        extensionVersion: '0.5.0',
        browser: 'Chrome',
        transport: 'native',
      }),
    )
    proc.stdin.write(encodeNativeMessage({ type: 'ping', ts: 424242 }))

    const pong = await received
    expect(pong.ts).toBe(424242)
    proc.stdin.end()
    await new Promise<void>((r) => proc.once('close', () => r()))
  }, 15_000)

  it('exposes all 52 tools over real MCP stdio server and executes full browser workflow + v1.6 trace/codegen tools + screenshot image blocks', async () => {
    if (!chromeOk) return

    const cliBin = path.resolve(import.meta.dirname, '..', 'dist', 'cli.js')
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliBin, 'mcp', '--cdp', directEndpoint],
    })
    const client = new Client({ name: 'browserpilot-test-client', version: '1.0.0' })
    await client.connect(transport)

    try {
      const { tools } = await client.listTools()
      expect(tools.length).toBe(TOOL_DEFINITIONS.length)
      expect(tools.length).toBe(52)
      expect(tools.some((t) => t.name === 'browser_snapshot')).toBe(true)
      expect(tools.some((t) => t.name === 'browser_debugger')).toBe(true)
      expect(tools.some((t) => t.name === 'browser_exec')).toBe(true)
      expect(tools.some((t) => t.name === 'browser_trace')).toBe(true)
      expect(tools.some((t) => t.name === 'browser_frames')).toBe(true)
      expect(tools.some((t) => t.name === 'browser_check')).toBe(true)
      expect(tools.some((t) => t.name === 'browser_clipboard')).toBe(true)
      expect(tools.some((t) => t.name === 'browser_pdf')).toBe(true)
      expect(tools.some((t) => t.name === 'browser_init_script')).toBe(true)
      expect(tools.some((t) => t.name === 'browser_permissions')).toBe(true)

      // Open tab & navigate
      await client.callTool({ name: 'browser_open_tab', arguments: { url: baseUrl } })
      await client.callTool({ name: 'browser_wait', arguments: { selector: '#go-btn' } })

      // Snapshot -> find refs -> fill + click -> verify post-action feedback includes simulated console error!
      const snapRes = await client.callTool({ name: 'browser_snapshot', arguments: { showDiffSinceLastCall: false } })
      const snapText = (snapRes.content as Array<{ text?: string }>)[0]?.text ?? ''
      expect(snapText).toContain('BrowserPilot Full Stack')

      await client.callTool({ name: 'browser_fill', arguments: { target: '#query', value: 'mcp-power' } })
      const clickRes = await client.callTool({ name: 'browser_click', arguments: { target: '#go-btn' } })
      const clickText = (clickRes.content as Array<{ text?: string }>)[0]?.text ?? ''
      expect(clickText).toContain('simulated-ui-error')

      await new Promise((r) => setTimeout(r, 150))
      const evalRes = await client.callTool({
        name: 'browser_evaluate',
        arguments: { expression: 'document.getElementById("out").textContent' },
      })
      expect((evalRes.content as Array<{ text?: string }>)[0]?.text).toBe('ok:mcp-power')

      // Network & Styles via MCP
      const netRes = await client.callTool({ name: 'browser_network', arguments: { search: '/api/search' } })
      expect((netRes.content as Array<{ text?: string }>)[0]?.text).toContain('/api/search?q=mcp-power')

      const styleRes = await client.callTool({ name: 'browser_styles', arguments: { target: '#go-btn' } })
      expect((styleRes.content as Array<{ text?: string }>)[0]?.text).toContain('.hero-btn')

      // Multimodal Screenshot & Labeled Screenshot return real MCP image blocks!
      const shotRes = await client.callTool({ name: 'browser_screenshot', arguments: {} })
      const shotContent = shotRes.content as Array<{ type: string; data?: string; mimeType?: string }>
      expect(shotContent.some((c) => c.type === 'image' && c.mimeType === 'image/png' && (c.data?.length ?? 0) > 500)).toBe(true)

      const somRes = await client.callTool({ name: 'browser_labeled_screenshot', arguments: {} })
      const somContent = somRes.content as Array<{ type: string; text?: string; data?: string }>
      expect(somContent.some((c) => c.type === 'image' && (c.data?.length ?? 0) > 500)).toBe(true)

      // Performance metrics via MCP
      const perfRes = await client.callTool({ name: 'browser_performance', arguments: { action: 'metrics' } })
      expect((perfRes.content as Array<{ text?: string }>)[0]?.text).toContain('domNodes')

      // Stateful Sandbox exec via MCP
      const execRes = await client.callTool({
        name: 'browser_exec',
        arguments: { sessionId: 'mcp1', code: 'state.val = 123; console.log("hi from sandbox"); return state.val' },
      })
      const execText = (execRes.content as Array<{ text?: string }>)[0]?.text ?? ''
      expect(execText).toContain('hi from sandbox')
      expect(execText).toContain('123')

      // Compound batch tool (fill + click + wait + post-batch snapshot in 1 MCP round-trip!)
      const batchRes = await client.callTool({
        name: 'browser_batch',
        arguments: {
          steps: [
            { action: 'fill', target: '#query', value: 'batch-win' },
            { action: 'click', target: '#go-btn' },
            { action: 'wait', ms: 150 },
          ],
          returnSnapshot: true,
        },
      })
      const batchText = (batchRes.content as Array<{ text?: string }>)[0]?.text ?? ''
      expect(batchText).toContain('Completed 3 batch steps')
      expect(batchText).toContain('ok:batch-win')

      // Pinned element inspection tool
      await client.callTool({
        name: 'browser_evaluate',
        arguments: { expression: 'globalThis.__browserpilotPinned1 = document.getElementById("go-btn"); true' },
      })
      const pinnedRes = await client.callTool({ name: 'browser_pinned', arguments: {} })
      expect((pinnedRes.content as Array<{ text?: string }>)[0]?.text).toContain('Search Now')

      // v1.4.0 MCP browser-control tools: frames, wait(fn), clipboard, init_script, pdf
      const framesRes = await client.callTool({ name: 'browser_frames', arguments: {} })
      expect((framesRes.content as Array<{ text?: string }>)[0]?.text).toContain('(main)')

      const waitFnRes = await client.callTool({
        name: 'browser_wait',
        arguments: { fn: 'document.getElementById("out").textContent === "ok:batch-win"' },
      })
      expect((waitFnRes.content as Array<{ text?: string }>)[0]?.text).toContain('Condition truthy')

      await client.callTool({ name: 'browser_clipboard', arguments: { action: 'write', text: 'mcp-clip-14' } })
      const clipRes = await client.callTool({ name: 'browser_clipboard', arguments: { action: 'read' } })
      expect((clipRes.content as Array<{ text?: string }>)[0]?.text).toContain('mcp-clip-14')

      const initAddRes = await client.callTool({
        name: 'browser_init_script',
        arguments: { action: 'add', script: 'window.__mcpInit = 14;', runNow: true },
      })
      expect((initAddRes.content as Array<{ text?: string }>)[0]?.text).toContain('Added init script')

      const pdfRes = await client.callTool({ name: 'browser_pdf', arguments: {} })
      expect((pdfRes.content as Array<{ text?: string }>)[0]?.text).toContain('Generated PDF')

      // v1.6 browser_trace over MCP
      const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-mcp-trace-'))
      tmpDirs.push(traceDir)
      const traceFile = path.join(traceDir, 'mcp-trace.html')
      await client.callTool({ name: 'browser_trace', arguments: { action: 'start', title: 'MCP Trace Check' } })
      await client.callTool({ name: 'browser_fill', arguments: { target: '#query', value: 'traced-mcp' } })
      await client.callTool({ name: 'browser_click', arguments: { target: '#go-btn' } })
      const traceStopRes = await client.callTool({ name: 'browser_trace', arguments: { action: 'stop', path: traceFile } })
      expect((traceStopRes.content as Array<{ text?: string }>)[0]?.text).toContain('Saved Trace report')
      expect((await fs.stat(traceFile)).size).toBeGreaterThan(5_000)
    } finally {
      await client.close()
    }
  }, 30_000)

  it('connects real loaded MV3 Extension to Daemon and executes CLI commands end-to-end', async () => {
    if (!chromeOk) return

    // Build extension directly into isolated temp dir pointed at our running Daemon WS port + token
    const extPkgDir = path.resolve(import.meta.dirname, '..', '..', 'extension')
    const tempExtDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-srv-ext-'))
    tmpDirs.push(tempExtDir)
    execFileSync(process.execPath, [path.join(extPkgDir, 'build.mjs')], {
      env: {
        ...process.env,
        BROWSERPILOT_OUT_DIR: tempExtDir,
        BROWSERPILOT_DAEMON_URL: `ws://127.0.0.1:${daemonPort}/extension`,
        BROWSERPILOT_AUTH_TOKEN: daemonToken,
      },
    })

    const extProfile = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-srv-profile-'))
    tmpDirs.push(extProfile)
    chromeExtProc = spawn(
      CHROME_FOR_TESTING,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        ...(process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
        `--disable-extensions-except=${tempExtDir}`,
        `--load-extension=${tempExtDir}`,
        `--user-data-dir=${extProfile}`,
        baseUrl,
      ],
      { stdio: 'ignore' },
    )

    // Wait for real MV3 extension to register with Daemon
    const client = new DaemonClient({ host: '127.0.0.1', port: daemonPort, token: daemonToken })
    let connected = false
    for (let i = 0; i < 40; i++) {
      const h = await client.health()
      if (h.clients.some((c) => c.transport === 'extension-ws')) {
        connected = true
        break
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    expect(connected).toBe(true)

    // Run real CLI binary against the daemon using isolated BROWSERPILOT_HOME
    const cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-cli-home-'))
    tmpDirs.push(cliHome)
    await fs.writeFile(
      path.join(cliHome, 'daemon.json'),
      JSON.stringify({ host: '127.0.0.1', port: daemonPort, token: daemonToken }),
    )
    const cliBin = path.resolve(import.meta.dirname, '..', 'dist', 'cli.js')
    const runCli = async (...args: string[]) => {
      const { stdout } = await execFileAsync(process.execPath, [cliBin, ...args], {
        env: { ...process.env, BROWSERPILOT_HOME: cliHome },
        encoding: 'utf8',
      })
      return stdout
    }

    const tabsOut = await runCli('tabs')
    expect(tabsOut).toContain('BrowserPilot Full Stack Test')

    const sid = (await runCli('session', 'new', '--tab-group', 'cli-e2e')).trim()
    expect(sid).toBeTruthy()

    const execOut = await runCli(
      'exec',
      '-s',
      sid,
      '-e',
      `const t = await tabs.use('127.0.0.1'); await t.page.fill('#query', 'cli-zero-click'); await t.page.click('#go-btn'); await waitForText('ok:cli-zero-click', { tab: t, timeoutMs: 5000 }); console.log(await t.page.evaluate('document.getElementById("out").textContent'))`,
    )
    expect(execOut.trim()).toContain('ok:cli-zero-click')

    const locOut = await runCli('locator', 'button:has-text("Search Now")')
    expect(locOut.trim()).toBe('#go-btn')

    const framesOut = await runCli('frames')
    expect(framesOut).toContain('(main)')

    const updOut = await runCli('session', 'update', sid, '--tab-group', 'cli-renamed', '--tab-group-color', 'cyan')
    expect(updOut).toContain('group=cli-renamed (cyan)')

    const skillOut = await runCli('skill')
    expect(skillOut).toContain('BrowserPilot')

    const doctorOut = await runCli('doctor', '--json')
    const doctor = JSON.parse(doctorOut) as { extensionBuilt: boolean; daemonRunning: boolean; connectedBrowsers: number }
    expect(doctor.extensionBuilt).toBe(true)
    expect(doctor.daemonRunning).toBe(true)
    expect(doctor.connectedBrowsers).toBeGreaterThanOrEqual(1)

    const setupOut = await runCli('setup', '--dry-run')
    expect(setupOut).toContain('com.browserpilot.bridge')
    expect(setupOut).toContain('Expected Chrome Extension ID')
    expect(setupOut).toContain('mcpServers')

    // v1.6 CLI trace + Daemon capability-URL Trace Viewer hosting verification
    const cliTraceFile = path.join(cliHome, 'cli-e2e-trace.html')
    const execTraceOut = await runCli(
      'exec',
      '-s',
      sid,
      '--trace',
      cliTraceFile,
      '-e',
      `const t = await tabs.current(); await t.page.fill('#query', 'cli-traced'); await t.page.click('#go-btn'); await waitForText('ok:cli-traced', { tab: t, timeoutMs: 5000 });`,
    )
    expect(execTraceOut).toContain('Saved Trace report')
    expect((await fs.stat(cliTraceFile)).size).toBeGreaterThan(5_000)

    const traceOpenOut = await runCli('trace', 'open', cliTraceFile)
    const viewerUrlMatch = /http:\/\/127\.0\.0\.1:\d+\/trace\/[0-9a-f]{32}/.exec(traceOpenOut)
    expect(viewerUrlMatch).toBeTruthy()
    // Capability URL serves HTML directly without Bearer header, while invalid token 404s
    const viewerResp = await fetch(viewerUrlMatch![0])
    expect(viewerResp.status).toBe(200)
    expect(await viewerResp.text()).toContain('BrowserPilot Trace Viewer')
    const badResp = await fetch(`http://127.0.0.1:${daemonPort}/trace/00000000000000000000000000000000`)
    expect(badResp.status).toBe(404)
  }, 35_000)
})
