import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DirectCDPTransport, SessionManager } from '@browserpilot/core'
import {
  BrowserPilotDaemon,
  executeTool,
  parseIntervalMs,
  type ToolRuntimeContext,
} from '../src/index.js'

const CHROME_CANDIDATES = [
  process.env.BROWSERPILOT_CHROME_BIN,
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean) as string[]

async function findChrome(): Promise<string | null> {
  for (const bin of CHROME_CANDIDATES) {
    try {
      await fs.access(bin)
      return bin
    } catch {}
  }
  return null
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

describe('@browserpilot/server parity features: shortcuts, scheduler, local site memory, trust-this-site & MCP find/gif/tabs_context', () => {
  const prevHome = process.env.BROWSERPILOT_HOME
  const prevApproval = process.env.BROWSERPILOT_APPROVAL_MODE
  let fakeHome = ''
  let httpServer: http.Server
  let baseUrl = ''
  let chromeProc: ChildProcess | null = null
  let chromeDir = ''
  let transport: DirectCDPTransport | null = null
  let manager: SessionManager | null = null
  let runtimeCtx: ToolRuntimeContext | null = null

  beforeAll(async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-parity-home-'))
    process.env.BROWSERPILOT_HOME = fakeHome

    const port = await getFreePort()
    httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>Server Parity</title></head><body>
        <input id="q" placeholder="Search items" />
        <button id="delete-btn">Delete Item</button>
        <div id="out">idle</div>
        <script>
          let n = 0;
          document.getElementById('delete-btn').onclick = () => {
            n++;
            document.getElementById('out').textContent = 'deleted:' + n + ':' + document.getElementById('q').value;
          };
        </script>
      </body></html>`)
    })
    await new Promise<void>((r) => httpServer.listen(port, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${port}`

    const chromeBin = await findChrome()
    if (!chromeBin) return

    const cdpPort = await getFreePort()
    chromeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-srv-parity-chrome-'))
    chromeProc = spawn(
      chromeBin,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        ...(process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${chromeDir}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    )
    const endpoint = `http://127.0.0.1:${cdpPort}`
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${endpoint}/json/version`)).ok) break
      } catch {}
      await new Promise((r) => setTimeout(r, 150))
    }
    transport = await DirectCDPTransport.connect(endpoint)
    manager = new SessionManager(transport)
    runtimeCtx = {
      getManager: () => manager!,
      listClients: () => [
        {
          clientId: 'parity-cdp',
          transport: 'direct-cdp',
          browser: 'Chrome',
          connectedAt: Date.now(),
          lastSeenAt: Date.now(),
          attachedTabCount: manager!.getAttachedTabCount(),
        },
      ],
    }
  }, 30_000)

  afterAll(async () => {
    if (prevHome === undefined) delete process.env.BROWSERPILOT_HOME
    else process.env.BROWSERPILOT_HOME = prevHome
    if (prevApproval === undefined) delete process.env.BROWSERPILOT_APPROVAL_MODE
    else process.env.BROWSERPILOT_APPROVAL_MODE = prevApproval

    manager?.dispose()
    await transport?.close()
    if (chromeProc) chromeProc.kill('SIGTERM')
    if (httpServer) await new Promise<void>((r) => httpServer.close(() => r()))
    if (chromeDir) await fs.rm(chromeDir, { recursive: true, force: true }).catch(() => {})
    if (fakeHome) await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => {})
  })

  it('manages local site memory & saved shortcuts without needing a browser and parses schedule intervals', async () => {
    expect(parseIntervalMs('30s')).toBe(30_000)
    expect(parseIntervalMs('15m')).toBe(900_000)
    expect(parseIntervalMs('2h')).toBe(7_200_000)
    expect(parseIntervalMs('1d')).toBe(86_400_000)
    expect(() => parseIntervalMs('invalid')).toThrow(/Invalid interval/i)

    const noBrowserCtx: ToolRuntimeContext = {
      getManager: () => {
        throw new Error('No browser connected')
      },
      listClients: () => [],
    }

    // Local-first site memory CRUD (works even before any browser connects!)
    const setRes = await executeTool(noBrowserCtx, 'browser_memory', {
      action: 'set',
      domain: 'https://app.github.com/pulls',
      key: 'merge_button',
      value: 'button:has-text("Squash and merge")',
      note: 'Always use squash merge in this repo',
    })
    expect(setRes.isError).toBeUndefined()
    expect(setRes.content[0].text).toContain('app.github.com')

    const getRes = await executeTool(noBrowserCtx, 'browser_memory', {
      action: 'get',
      domain: 'app.github.com',
    })
    expect(getRes.content[0].text).toContain('Squash and merge')

    const listRes = await executeTool(noBrowserCtx, 'browser_memory', { action: 'list' })
    expect(listRes.content[0].text).toContain('app.github.com: merge_button')

    await executeTool(noBrowserCtx, 'browser_memory', { action: 'delete', domain: 'app.github.com', key: 'merge_button' })
    const afterDel = await executeTool(noBrowserCtx, 'browser_memory', { action: 'list' })
    expect(afterDel.content[0].text).toContain('no site memories')
  })

  it('executes saved shortcuts, Daemon schedules (HTTP API + headless run_now), Trust-This-Site persistence, and MCP find/gif/tabs_context', async () => {
    if (!runtimeCtx || !manager) return

    const tab = await manager.openTab({ url: baseUrl })
    await tab.page.navigate(baseUrl, { waitUntil: 'load' })

    // 1. Save & run workflow shortcut via MCP tool
    const saveSc = await executeTool(runtimeCtx, 'browser_shortcuts', {
      action: 'save',
      name: '/quick-search',
      description: 'Fill query and trigger button',
      steps: [
        { action: 'fill', target: '#q', value: 'from-shortcut' },
        { action: 'click', target: '#delete-btn' },
      ],
    })
    expect(saveSc.isError).toBeUndefined()
    const runSc = await executeTool(runtimeCtx, 'browser_shortcuts', {
      action: 'run',
      name: 'quick-search',
      tabId: tab.tabId,
    })
    expect(runSc.isError).toBeUndefined()
    expect(await tab.page.evaluate<string>('document.getElementById("out").textContent')).toBe('deleted:1:from-shortcut')

    // 2. Schedule recurring task (linked to saved shortcut!) & run_now in headless Chrome via Daemon HTTP API
    const dPort = await getFreePort()
    const daemon = new BrowserPilotDaemon()
    await daemon.start({ host: '127.0.0.1', port: dPort, token: 'sched-tok', persistRuntime: false })
    try {
      const flowPath = path.join(fakeHome, 'sched-flow.json')
      await fs.writeFile(
        flowPath,
        JSON.stringify({
          name: 'Scheduled Health Check',
          steps: [
            { action: 'navigate', url: baseUrl },
            { action: 'fill', target: '#q', value: 'cron-ok' },
            { action: 'click', target: '#delete-btn' },
            { action: 'assert_text', target: '#out', value: 'deleted:1:cron-ok' },
          ],
        }),
      )

      const addResp = await fetch(`http://127.0.0.1:${dPort}/api/schedules`, {
        method: 'POST',
        headers: { Authorization: 'Bearer sched-tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'hourly-smoke', every: '1h', flowPath, headless: true }),
      })
      expect(addResp.status).toBe(200)

      const runResp = await fetch(`http://127.0.0.1:${dPort}/api/schedules/run`, {
        method: 'POST',
        headers: { Authorization: 'Bearer sched-tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'hourly-smoke' }),
      })
      const runJson = (await runResp.json()) as { ok: boolean; report: { ok: boolean; output: string } }
      expect(runJson.ok).toBe(true)
      expect(runJson.report.output).toContain('Completed 4 step(s)')

      const listResp = await fetch(`http://127.0.0.1:${dPort}/api/schedules`, {
        headers: { Authorization: 'Bearer sched-tok' },
      })
      const listJson = (await listResp.json()) as { schedules: Array<{ name: string; runCount: number; lastStatus: string }> }
      expect(listJson.schedules[0].runCount).toBe(1)
      expect(listJson.schedules[0].lastStatus).toBe('ok')

      await fetch(`http://127.0.0.1:${dPort}/api/schedules?name=hourly-smoke`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer sched-tok' },
      })
    } finally {
      await daemon.stop()
    }

    // 3. Per-site Trust-This-Site approval persistence under strict mode:
    //    First click prompts -> user clicks "Trust This Site" -> second click executes with ZERO prompt!
    process.env.BROWSERPILOT_APPROVAL_MODE = 'strict'
    const firstClickPromise = executeTool(runtimeCtx, 'browser_click', { target: '#delete-btn', tabId: tab.tabId })
    await new Promise((r) => setTimeout(r, 150))
    await tab.page.evaluate(`globalThis.__browserpilotApprovalDecision?.('trust')`)
    const firstRes = await firstClickPromise
    expect(firstRes.isError).toBeUndefined()

    // Second click on same domain MUST succeed immediately without blocking on approval!
    const secondRes = await executeTool(runtimeCtx, 'browser_click', { target: '#delete-btn', tabId: tab.tabId })
    expect(secondRes.isError).toBeUndefined()
    expect(await tab.page.evaluate<string>('document.getElementById("out").textContent')).toContain('deleted:3:')
    delete process.env.BROWSERPILOT_APPROVAL_MODE

    // 4. MCP browser_find + browser_gif + browser_tabs_context
    const findRes = await executeTool(runtimeCtx, 'browser_find', { query: 'delete button', tabId: tab.tabId })
    expect(findRes.isError).toBeUndefined()
    expect(findRes.content[0].text).toContain('Delete Item')

    await executeTool(runtimeCtx, 'browser_gif', { action: 'start', tabId: tab.tabId })
    await executeTool(runtimeCtx, 'browser_fill', { target: '#q', value: 'mcp-gif', tabId: tab.tabId })
    const gifFile = path.join(fakeHome, 'mcp-demo.gif')
    const gifExport = await executeTool(runtimeCtx, 'browser_gif', {
      action: 'export',
      outputPath: gifFile,
      tabId: tab.tabId,
    })
    expect(gifExport.isError).toBeUndefined()
    expect((await fs.readFile(gifFile)).subarray(0, 6).toString('ascii')).toBe('GIF89a')

    const ctxRes = await executeTool(runtimeCtx, 'browser_tabs_context', {
      action: 'read_all',
      tabIds: [tab.tabId],
    })
    expect(ctxRes.isError).toBeUndefined()
    expect(ctxRes.content[0].text).toContain('Server Parity')
  }, 45_000)
})
