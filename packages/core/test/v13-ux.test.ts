import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DirectCDPTransport, SessionManager } from '../src/index.js'

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

const UX_TEST_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>BrowserPilot v1.3 UX Test</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100vh; overflow: hidden; font-family: sans-serif; }
    #scroll-pane { height: 100vh; overflow-y: auto; padding: 24px; box-sizing: border-box; }
    #cookie-overlay {
      position: fixed; left: 20px; top: 20px; width: 240px; height: 90px;
      background: rgba(15, 23, 42, 0.92); color: white; z-index: 50; padding: 12px;
    }
    #covered-btn { position: fixed; left: 40px; top: 40px; width: 140px; height: 40px; z-index: 10; }
    #disabled-btn { margin-top: 120px; }
    .spacer { height: 1200px; background: linear-gradient(#f8fafc, #e2e8f0); margin-top: 16px; }
  </style>
</head>
<body>
  <div id="cookie-overlay" class="cookie-banner">Accept cookies</div>
  <button id="covered-btn">Covered Action</button>
  <main id="scroll-pane">
    <button id="disabled-btn" disabled>Disabled Action</button>
    <div style="margin-top: 20px">
      <input id="f-name" placeholder="Full name" />
      <select id="f-role">
        <option value="dev">Developer</option>
        <option value="lead">Tech Lead</option>
      </select>
      <label><input id="f-agree" type="checkbox" /> Agree terms</label>
    </div>
    <textarea id="editor" style="margin-top: 16px; width: 300px; height: 60px;">Initial draft content</textarea>
    <div id="click-log">none</div>
    <div class="spacer">Scrollable Inner Content</div>
  </main>
  <script>
    document.getElementById('covered-btn').addEventListener('click', () => {
      document.getElementById('click-log').textContent = 'covered-clicked';
    });
  </script>
</body>
</html>`

describe('@browserpilot/core v1.3.0 UX & interaction capabilities (real Chromium)', () => {
  let server: http.Server
  let baseUrl = ''
  let chromeProc: ChildProcess | null = null
  let userDataDir = ''
  let transport: DirectCDPTransport | null = null
  let manager: SessionManager | null = null
  let chromeBin: string | null = null

  beforeAll(async () => {
    chromeBin = await findChrome()
    if (!chromeBin) return

    const httpPort = await getFreePort()
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(UX_TEST_HTML)
    })
    await new Promise<void>((r) => server.listen(httpPort, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${httpPort}`

    const cdpPort = await getFreePort()
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-v13-'))
    chromeProc = spawn(
      chromeBin,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,800',
        ...(process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataDir}`,
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
  }, 30_000)

  afterAll(async () => {
    manager?.dispose()
    await transport?.close()
    if (chromeProc) chromeProc.kill('SIGTERM')
    if (server) await new Promise<void>((r) => server.close(() => r()))
    if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('verifies pre-click occlusion & disabled checks, editor commands, smart inner scroll, zoom+grid shot, fillForm & handoff', async () => {
    if (!manager) return
    const tab = await manager.openTab({ url: baseUrl })
    await tab.page.navigate(baseUrl, { waitUntil: 'load' })

    // 1. Pre-click occlusion & disabled checks
    await expect(tab.page.click('#disabled-btn')).rejects.toThrow(/disabled/i)
    await expect(tab.page.click('#covered-btn')).rejects.toThrow(/occluded.*cookie-overlay/i)

    // force: true bypasses occlusion check without error
    await tab.page.click('#covered-btn', { force: true })

    // Dismiss overlay so normal clicks work
    await tab.page.evaluate('document.getElementById("cookie-overlay").remove(); true')
    await tab.page.click('#covered-btn')
    expect(await tab.page.evaluate('document.getElementById("click-log").textContent')).toBe('covered-clicked')

    // 2. Native CDP editing commands on Meta+a / Control+a + Backspace
    await tab.page.click('#editor')
    await tab.page.pressKey(process.platform === 'darwin' ? 'Cmd+a' : 'Ctrl+a')
    await tab.page.pressKey('Backspace')
    await tab.page.type(null, 'Replaced via CDP commands')
    expect(await tab.page.evaluate('document.getElementById("editor").value')).toBe('Replaced via CDP commands')

    // 3. Batch form filler (text + select + checkbox)
    const formRes = await tab.page.fillForm([
      { target: '#f-name', value: 'Ada Lovelace' },
      { target: '#f-role', value: 'lead' },
      { target: '#f-agree', value: true },
    ])
    expect(formRes.filled).toHaveLength(3)
    expect(await tab.page.evaluate('({ n: document.getElementById("f-name").value, r: document.getElementById("f-role").value, a: document.getElementById("f-agree").checked })')).toEqual({
      n: 'Ada Lovelace',
      r: 'lead',
      a: true,
    })

    // 4. Smart inner-container scroll + telemetry (window is overflow:hidden; #scroll-pane scrolls)
    const scrollRes = await tab.page.scroll({ direction: 'down', amount: 450 })
    expect(scrollRes.scrolled).toBe(true)
    expect(scrollRes.container).toBe('main#scroll-pane')
    expect(scrollRes.scrollY).toBeGreaterThan(100)
    expect(scrollRes.atTop).toBe(false)

    // 5. Zoom-in crop + coordinate grid screenshot (cleans up grid overlay automatically)
    const zoomShot = await tab.page.screenshot({
      zoom: { x: 10, y: 10, width: 220, height: 140, scale: 2 },
      grid: true,
      gridStep: 50,
    })
    expect(zoomShot.base64.length).toBeGreaterThan(500)
    expect(zoomShot.region).toEqual({ x: 10, y: 10, width: 220, height: 140, scale: 2 })
    expect(await tab.page.evaluate('Boolean(document.getElementById("__browserpilot_grid_overlay"))')).toBe(false)

    // 6. Interactive Human Handoff card & resume flow
    const handoffPromise = tab.page.requestHumanHandoff('Please confirm details and click resume', { timeoutMs: 8000 })
    await new Promise((r) => setTimeout(r, 150))
    expect(await tab.page.evaluate('Boolean(document.getElementById("__browserpilot_handoff_host"))')).toBe(true)
    // Simulate user clicking "Done, Continue AI" inside the closed Shadow DOM via the registered binding
    await tab.page.evaluate('globalThis.__browserpilotHandoffDone("resume")')
    const handoffRes = await handoffPromise
    expect(handoffRes.resumed).toBe(true)
    expect(handoffRes.cancelled).toBe(false)
    expect(await tab.page.evaluate('Boolean(document.getElementById("__browserpilot_handoff_host"))')).toBe(false)
  }, 30_000)
})
