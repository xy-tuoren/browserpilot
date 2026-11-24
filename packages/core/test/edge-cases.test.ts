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
  '/usr/bin/chromium-browser',
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

describe('@browserpilot/core edge cases: Cross-Origin OOPIF Iframe, Rich Locators & Scroll Telemetry', () => {
  let hostServer: http.Server
  let frameServer: http.Server
  let hostUrl = ''
  let chromeProc: ChildProcess | null = null
  let userDataDir = ''
  let transport: DirectCDPTransport | null = null
  let manager: SessionManager | null = null
  let available = false

  beforeAll(async () => {
    const bin = await findChrome()
    if (!bin) return
    available = true

    // Second origin server (localhost vs 127.0.0.1 triggers real Chromium OOPIF!)
    const framePort = await getFreePort()
    frameServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><body style="margin:0;padding:12px;">
        <button id="xorigin-btn" onclick="this.textContent='Cross-Origin Clicked!'">Cross-Origin Action</button>
      </body></html>`)
    })
    await new Promise<void>((r) => frameServer.listen(framePort, '127.0.0.1', r))

    const hostPort = await getFreePort()
    hostServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
      <html>
      <head><meta charset="utf-8" /><title>Edge Cases Lab</title></head>
      <body style="padding: 20px; min-height: 2000px;">
        <h1>Rich Locators &amp; OOPIF</h1>
        <label for="email-input">Work Email</label>
        <input id="email-input" type="email" />
        <input id="code-input" placeholder="Enter invite code" />
        <button class="dup-btn" onclick="document.getElementById('out').textContent='first'">Dup Action</button>
        <button class="dup-btn" onclick="document.getElementById('out').textContent='second'">Dup Action</button>
        <button onclick="document.getElementById('out').textContent='saved:' + document.getElementById('email-input').value + ':' + document.getElementById('code-input').value">Save Settings</button>
        <div id="out">none</div>
        <div style="margin-top: 24px;">
          <iframe id="oopif" src="http://localhost:${framePort}/widget" width="320" height="90" style="border:1px solid #999;"></iframe>
        </div>
      </body>
      </html>`)
    })
    await new Promise<void>((r) => hostServer.listen(hostPort, '127.0.0.1', r))
    hostUrl = `http://127.0.0.1:${hostPort}`

    const debugPort = await getFreePort()
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-edge-e2e-'))
    chromeProc = spawn(
      bin,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--site-per-process',
        ...(process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${userDataDir}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    )

    const endpoint = `http://127.0.0.1:${debugPort}`
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${endpoint}/json/version`)).ok) break
      } catch {}
      await new Promise((r) => setTimeout(r, 150))
    }

    transport = await DirectCDPTransport.connect(endpoint)
    manager = new SessionManager(transport)
  }, 25_000)

  afterAll(async () => {
    manager?.dispose()
    await transport?.close()
    if (chromeProc) chromeProc.kill('SIGTERM')
    if (hostServer) await new Promise<void>((r) => hostServer.close(() => r()))
    if (frameServer) await new Promise<void>((r) => frameServer.close(() => r()))
    if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('handles viewport/scroll context, role/label/placeholder/nth/pinned locators, and real cross-origin OOPIF iframe clicks', async () => {
    if (!available || !manager) return

    const tab = await manager.openTab({ url: 'about:blank' })
    await tab.page.setViewport(1024, 600)
    await tab.page.navigate(hostUrl, { waitUntil: 'load' })
    await new Promise((r) => setTimeout(r, 300))

    // 1. Snapshot includes viewport + scroll percentage AND cross-origin OOPIF iframe button!
    const snap = await tab.snapshots.capture(tab.session, { showDiffSinceLastCall: false })
    expect(snap.text).toContain('Viewport: 1024x600')
    expect(snap.text).toContain('Scroll:')
    expect(snap.text).toContain('Cross-Origin Action')

    // 2. Rich locators: label=, placeholder=, >> nth=1, role=button[name="..."]
    await tab.page.fill('label=Work Email', 'eng@browserpilot.dev')
    await tab.page.fill('placeholder=Enter invite code', 'DP-2026')
    await tab.page.click('.dup-btn >> nth=1')
    expect(await tab.page.evaluate<string>('document.getElementById("out").textContent')).toBe('second')

    await tab.page.click('role=button[name="Save Settings"]')
    expect(await tab.page.evaluate<string>('document.getElementById("out").textContent')).toBe(
      'saved:eng@browserpilot.dev:DP-2026',
    )

    // 3. Pinned element lookup
    await tab.page.evaluate('globalThis.__browserpilotPinned1 = document.querySelector(".dup-btn")')
    await tab.page.click('pinned')
    expect(await tab.page.evaluate<string>('document.getElementById("out").textContent')).toBe('first')

    // 4. Real Cross-Origin OOPIF iframe click via snapshot ref!
    const oopifRef = Object.values(snap.refs).find(
      (r) => r.role === 'button' && r.name.includes('Cross-Origin Action'),
    )
    expect(oopifRef).toBeTruthy()
    expect(oopifRef!.sessionId).toBeTruthy()
    await tab.page.click(oopifRef!.ref)
    await new Promise((r) => setTimeout(r, 150))

    const snapAfter = await tab.snapshots.capture(tab.session, { showDiffSinceLastCall: false })
    expect(snapAfter.text).toContain('Cross-Origin Clicked!')

    await manager.closeTab(tab.tabId)
  }, 30_000)
})
