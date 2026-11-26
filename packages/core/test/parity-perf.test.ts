import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DirectCDPTransport, encodeAnimatedGif, expandQueryTokens, SessionManager } from '../src/index.js'

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

describe('@browserpilot/core parity & performance suite (fuzzy find, GIF creator, strict-CSP Skia scaling, multi-tab synthesis, trust approval)', () => {
  let mainServer: http.Server
  let oopifServer: http.Server
  let baseUrl = ''
  let oopifOrigin = ''
  let chromeProc: ChildProcess | null = null
  let userDataDir = ''
  let tmpDir = ''
  let transport: DirectCDPTransport | null = null
  let manager: SessionManager | null = null

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-parity-out-'))
    const chromeBin = await findChrome()
    if (!chromeBin) return

    const oopifPort = await getFreePort()
    oopifServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><body>
        <button id="oopif-pay">Proceed to Checkout</button>
        <div id="oopif-out">idle</div>
        <script>document.getElementById('oopif-pay').onclick = () => { document.getElementById('oopif-out').textContent = 'paid'; };</script>
      </body></html>`)
    })
    await new Promise<void>((r) => oopifServer.listen(oopifPort, '127.0.0.1', r))
    oopifOrigin = `http://localhost:${oopifPort}`

    const mainPort = await getFreePort()
    mainServer = http.createServer((req, res) => {
      const u = new URL(req.url || '/', `http://127.0.0.1:${mainPort}`)
      if (u.pathname === '/strict-csp') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
        })
        res.end(`<!doctype html><html><body style="margin:0;background:#0f172a;color:#f8fafc;padding:40px;"><h1>Strict CSP Canvasless Page</h1></body></html>`)
        return
      }
      if (u.pathname === '/docs') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><head><title>API Docs</title></head><body><main><h1>BrowserPilot API Reference</h1><p>Pure CDP automation across tabs.</p></main></body></html>`)
        return
      }
      if (u.pathname === '/dashboard') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><head><title>Revenue Dashboard</title></head><body><main><h1>Q4 Revenue Summary</h1><p>ARR grew 42% quarter over quarter.</p></main></body></html>`)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Parity Lab</title></head><body>
        <header>
          <input id="global-search" type="search" placeholder="Search products..." aria-label="Search catalog" />
          <button id="login-cta">Sign In</button>
          <button id="close-banner" aria-label="Close">×</button>
        </header>
        <div id="shadow-box"></div>
        <div id="status">init</div>
        <iframe id="pay-frame" src="${oopifOrigin}/" width="320" height="120"></iframe>
        <script>
          document.getElementById('login-cta').onclick = () => {
            document.getElementById('status').textContent = 'signed-in:' + document.getElementById('global-search').value;
          };
          document.getElementById('close-banner').onclick = () => {
            document.getElementById('status').textContent = 'closed';
          };
          const sh = document.getElementById('shadow-box').attachShadow({ mode: 'open' });
          sh.innerHTML = '<button id="sh-submit">提交订单</button>';
          sh.getElementById('sh-submit').onclick = () => {
            document.getElementById('status').textContent = 'shadow-order-submitted';
          };
        </script>
      </body></html>`)
    })
    await new Promise<void>((r) => mainServer.listen(mainPort, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${mainPort}`

    const cdpPort = await getFreePort()
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-parity-chrome-'))
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
    if (mainServer) await new Promise<void>((r) => mainServer.close(() => r()))
    if (oopifServer) await new Promise<void>((r) => oopifServer.close(() => r()))
    if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('encodes valid multi-frame GIF89a buffers natively with zero external dependencies and expands bilingual search tokens', () => {
    const tokens = expandQueryTokens('搜索框')
    expect(tokens.expandedTokens).toContain('search')
    expect(tokens.preferredRoles).toContain('textbox')

    const w = 16
    const h = 16
    const f1 = new Uint8Array(w * h * 4).fill(255)
    const f2 = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      f2[i * 4] = 20
      f2[i * 4 + 1] = 184
      f2[i * 4 + 2] = 166
      f2[i * 4 + 3] = 255
    }
    const gif = encodeAnimatedGif(
      [
        { width: w, height: h, rgba: f1, delayMs: 400 },
        { width: w, height: h, rgba: f2, delayMs: 400 },
      ],
      { loop: 0 },
    )
    expect(gif.subarray(0, 6).toString('ascii')).toBe('GIF89a')
    expect(gif.includes(Buffer.from('NETSCAPE2.0'))).toBe(true)
    expect(gif[gif.length - 1]).toBe(0x3b)
    expect(gif.readUInt16LE(6)).toBe(w)
    expect(gif.readUInt16LE(8)).toBe(h)
  })

  it('finds elements by natural-language EN/ZH queries across DOM, Shadow DOM & OOPIF and interacts via live refs', async () => {
    if (!manager) return
    const tab = await manager.openTab({ url: baseUrl })
    await tab.page.navigate(baseUrl, { waitUntil: 'load' })
    await new Promise((r) => setTimeout(r, 250))

    // 1. Chinese natural-language query -> finds English search input and fills via returned live [eN] ref!
    const searchHits = await tab.page.find('搜索框')
    expect(searchHits.length).toBeGreaterThan(0)
    expect(searchHits[0].recommendedLocator).toContain('global-search')
    await tab.page.fill(searchHits[0].ref, 'fuzzy-magic')

    // 2. English query -> finds "Sign In" button and clicks via returned live [eN] ref!
    const loginHits = await tab.page.find('login button')
    expect(loginHits.length).toBeGreaterThan(0)
    expect(loginHits[0].name).toContain('Sign In')
    await tab.page.click(loginHits[0].ref)
    expect(await tab.page.evaluate<string>('document.getElementById("status").textContent')).toBe('signed-in:fuzzy-magic')

    // 3. Shadow DOM Chinese button found by English query ("submit order")!
    const shadowHits = await tab.page.find('submit')
    const shadowMatch = shadowHits.find((h) => h.text.includes('提交订单'))
    expect(shadowMatch).toBeTruthy()
    await tab.page.click(shadowMatch!.ref)
    expect(await tab.page.evaluate<string>('document.getElementById("status").textContent')).toBe('shadow-order-submitted')

    // 4. Close icon button recognized by "关闭"
    const closeHits = await tab.page.find('关闭')
    expect(closeHits[0].recommendedLocator).toContain('close-banner')
    await tab.page.click(closeHits[0].ref)
    expect(await tab.page.evaluate<string>('document.getElementById("status").textContent')).toBe('closed')

    // 5. Cross-origin OOPIF iframe button found by natural-language query ("checkout") and clicked via live ref!
    const oopifHits = await tab.page.find('checkout button')
    const payMatch = oopifHits.find((h) => Boolean(h.frameUrl))
    expect(payMatch).toBeTruthy()
    await tab.page.click(payMatch!.ref)
    expect(await tab.page.evaluate<string>('document.getElementById("oopif-out").textContent', { frame: 'localhost' })).toBe('paid')
  }, 25_000)

  it('records step-by-step actions into a valid animated GIF with click overlays, scales strict-CSP screenshots natively, synthesizes multi-tab context in parallel & supports Trust This Site approval', async () => {
    if (!manager) return
    const tab = await manager.openTab({ url: baseUrl })
    await tab.page.navigate(baseUrl, { waitUntil: 'load' })

    // 1. Step-frame Animated GIF recording & export
    await tab.gif.start()
    await tab.page.fill('#global-search', 'gif-demo')
    await tab.page.click('#login-cta')
    const gifOutPath = path.join(tmpDir, 'workflow.gif')
    const gifRes = await tab.gif.export({ outputPath: gifOutPath, width: 640, delayMs: 600 })
    expect(gifRes.frameCount).toBeGreaterThanOrEqual(3)
    expect(gifRes.sizeBytes).toBeGreaterThan(200)
    const gifHead = (await fs.readFile(gifOutPath)).subarray(0, 6).toString('ascii')
    expect(gifHead).toBe('GIF89a')

    // 2. Native CDP Skia hardware screenshot downscaling works under strict CSP (img-src 'self', script-src 'none')!
    await tab.page.navigate(`${baseUrl}/strict-csp`, { waitUntil: 'load' })
    await tab.page.setViewport(1600, 900, 2, false)
    const shot = await tab.page.screenshot({ maxDimension: 800 })
    const pngBuf = Buffer.from(shot.base64, 'base64')
    const pngW = pngBuf.readUInt32BE(16)
    const pngH = pngBuf.readUInt32BE(20)
    expect(Math.max(pngW, pngH)).toBeLessThanOrEqual(804)
    expect(Math.max(pngW, pngH)).toBeGreaterThanOrEqual(790)

    // 3. Parallel multi-tab context synthesis across 2 extra tabs in a single call
    const docsTab = await manager.openTab({ url: `${baseUrl}/docs`, active: false })
    const dashTab = await manager.openTab({ url: `${baseUrl}/dashboard`, active: false })
    await new Promise((r) => setTimeout(r, 250))

    const ctxSummary = await manager.readTabsContext({
      tabIds: [docsTab.tabId, dashTab.tabId],
      mode: 'summary',
    })
    expect(ctxSummary.tabs).toHaveLength(2)
    expect(ctxSummary.formatted).toContain('BrowserPilot API Reference')
    expect(ctxSummary.formatted).toContain('ARR grew 42%')

    const ctxMd = await manager.readTabsContext({
      tabIds: [docsTab.tabId, dashTab.tabId],
      mode: 'markdown',
    })
    expect(ctxMd.formatted).toContain('Q4 Revenue Summary')

    // 4. 3-button approval card: clicking "Trust This Site" returns { approved: true, trustSite: true, hostname: '127.0.0.1' }
    const approvalPromise = docsTab.page.requestActionApproval({
      action: 'click',
      detail: 'click #delete',
      reason: 'High-risk test',
      timeoutMs: 5_000,
    })
    await new Promise((r) => setTimeout(r, 120))
    await docsTab.page.evaluate(`globalThis.__browserpilotApprovalDecision?.('trust')`)
    const approval = await approvalPromise
    expect(approval.approved).toBe(true)
    expect(approval.trustSite).toBe(true)
    expect(approval.hostname).toBe('127.0.0.1')

    await manager.closeTab(docsTab.tabId)
    await manager.closeTab(dashTab.tabId)
  }, 30_000)
})
