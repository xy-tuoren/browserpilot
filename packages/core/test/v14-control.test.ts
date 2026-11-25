import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DirectCDPTransport, SessionManager, splitLocatorChain, waitForFunction, waitForSelector, waitForUrl } from '../src/index.js'

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

describe('@browserpilot/core v1.4.0 browser-control engine', () => {
  it('parses chained locator pipelines while respecting quotes, brackets, and regexes', () => {
    expect(splitLocatorChain('.card >> has-text="Pro >> Plan" >> role=button[name="Buy >> Now"] >> first')).toEqual([
      '.card',
      'has-text="Pro >> Plan"',
      'role=button[name="Buy >> Now"]',
      'first',
    ])
    expect(splitLocatorChain('iframe#pay >> .row >> has-text=/item \\d+/i >> nth=-1')).toEqual([
      'iframe#pay',
      '.row',
      'has-text=/item \\d+/i',
      'nth=-1',
    ])
    expect(splitLocatorChain('div.card:has-text("Pro"):visible >> button:has-text("Buy")')).toEqual([
      'div.card',
      'has-text="Pro"',
      'visible=true',
      'button',
      'has-text="Buy"',
    ])
  })

  let hostServer: http.Server
  let oopifServer: http.Server
  let baseUrl = ''
  let chromeProc: ChildProcess | null = null
  let userDataDir = ''
  let tempUploadFile = ''
  let tempPdfFile = ''
  let transport: DirectCDPTransport | null = null
  let manager: SessionManager | null = null

  beforeAll(async () => {
    const bin = await findChrome()
    if (!bin) return

    const oopifPort = await getFreePort()
    oopifServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>OOPIF Widget</title></head><body style="margin:0;padding:8px;">
        <button id="oopif-btn" onclick="this.textContent='OOPIF Clicked'">OOPIF Frame Btn</button>
      </body></html>`)
    })
    await new Promise<void>((r) => oopifServer.listen(oopifPort, '127.0.0.1', r))

    const hostPort = await getFreePort()
    hostServer = http.createServer((req, res) => {
      const u = req.url || '/'
      if (u.startsWith('/same-frame')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><head><title>Same Origin Frame</title></head><body style="margin:0;padding:8px;">
          <button id="same-btn" onclick="this.textContent='Same Clicked'">Same Frame Btn</button>
        </body></html>`)
        return
      }
      if (u.startsWith('/popup-dest')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><head><title>Popup Destination</title></head><body><h1>Popup Loaded</h1></body></html>`)
        return
      }
      if (u.startsWith('/api/submit')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, plan: 'pro', code: 2026 }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>BrowserPilot v1.4 Control Lab</title>
        <style>
          body { font-family: sans-serif; padding: 16px; }
          .card { border: 1px solid #ccc; padding: 10px; margin: 6px 0; }
          .hidden-mobile { display: none; }
        </style>
      </head>
      <body>
        <!-- Duplicate responsive buttons: first is hidden, second is visible -->
        <button class="dup-responsive hidden-mobile" onclick="window.__dupHit='hidden'">Action CTA</button>
        <button class="dup-responsive" onclick="window.__dupHit='visible'">Action CTA</button>

        <!-- Cards for chained locator filtering -->
        <div class="card">
          <h3>Starter</h3>
          <button onclick="window.__plan='starter'">Choose</button>
        </div>
        <div class="card">
          <h3>Pro</h3>
          <span class="badge">Recommended</span>
          <button data-testid="pro-choose" onclick="window.__plan='pro'">Choose</button>
          <button onclick="window.__plan='pro-details'">Details</button>
        </div>

        <button data-xp="yes" onclick="window.__xpHit=true">XPath Target</button>
        <div class="wide-wrap" style="width:100%"><button id="nested-exact-btn" onclick="window.__nestedHit=true"><span>Nested Exact</span></button></div>

        <!-- Same-origin + Cross-Origin OOPIF iframes -->
        <div style="display:flex;gap:12px;margin:10px 0;">
          <iframe id="same-frame" name="sameFrame" src="/same-frame" width="220" height="60"></iframe>
          <iframe id="oopif-frame" name="oopifFrame" src="http://localhost:${oopifPort}/widget-oopif" width="220" height="60"></iframe>
        </div>

        <!-- Spinner + async trigger for wait primitives -->
        <div id="spinner">Loading...</div>
        <button id="async-btn" onclick="
          setTimeout(() => {
            document.getElementById('spinner').style.display = 'none';
            location.hash = '#done-step';
            window.__readyFlag = 42;
            fetch('/api/submit').then(r => r.json()).then(d => { window.__apiResult = d; });
          }, 120);
        ">Trigger Async</button>

        <!-- Popup link & JS dialog button -->
        <a id="popup-link" href="/popup-dest" target="_blank">Open Popup Tab</a>
        <button id="alert-btn" onclick="alert('Saved successfully!')">Show Alert</button>

        <!-- Rich form controls -->
        <div style="margin:10px 0;">
          <label><input id="chk-opt" type="checkbox" /> Enable Alerts</label>
          <select id="multi-tags" multiple size="3">
            <option value="ts">TypeScript</option>
            <option value="cdp">CDP</option>
            <option value="ai">AI</option>
          </select>
          <input id="vol-range" type="range" min="0" max="100" value="20" />
          <input id="doc-upload" type="file" style="display:none;" />
        </div>

        <!-- Canvas for multi-point stroke + key counter -->
        <canvas id="pad" width="240" height="100" style="border:1px solid #333;"></canvas>
        <div id="key-count">0</div>

        <script>
          window.__strokeMoves = 0;
          window.__strokeEnded = false;
          const pad = document.getElementById('pad');
          pad.addEventListener('mousedown', () => { window.__strokeDown = true; });
          pad.addEventListener('mousemove', (e) => { if (e.buttons & 1) window.__strokeMoves++; });
          pad.addEventListener('mouseup', () => { window.__strokeEnded = true; });
          window.__arrowCount = 0;
          window.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
              window.__arrowCount++;
              document.getElementById('key-count').textContent = String(window.__arrowCount);
            }
          });
        </script>
      </body>
      </html>`)
    })
    await new Promise<void>((r) => hostServer.listen(hostPort, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${hostPort}`

    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-v14-'))
    tempUploadFile = path.join(userDataDir, 'sample.txt')
    tempPdfFile = path.join(userDataDir, 'export.pdf')
    await fs.writeFile(tempUploadFile, 'browserpilot upload test', 'utf8')

    const cdpPort = await getFreePort()
    chromeProc = spawn(
      bin,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--site-per-process',
        '--window-size=1280,900',
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
    if (hostServer) await new Promise<void>((r) => hostServer.close(() => r()))
    if (oopifServer) await new Promise<void>((r) => oopifServer.close(() => r()))
    if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('verifies chained/visibility locators, same-origin & OOPIF iframe control, smart waits, popups/dialogs, rich controls, clipboard/initScript/PDF & fluent sandbox', async () => {
    if (!manager) return
    const tab = await manager.openTab({ url: 'about:blank' })
    await tab.page.navigate(baseUrl, { waitUntil: 'load' })
    await new Promise((r) => setTimeout(r, 250))

    // 1. Visibility-aware default + Chained locators + xpath + testid + reverse getLocatorString
    await tab.page.click('.dup-responsive')
    expect(await tab.page.evaluate('window.__dupHit')).toBe('visible')

    await tab.page.click('.card:has-text("Pro"):visible >> button:has-text("Details")')
    expect(await tab.page.evaluate('window.__plan')).toBe('pro-details')

    await tab.page.click('.card >> has-text="Pro" >> role=button[name="Choose"]')
    expect(await tab.page.evaluate('window.__plan')).toBe('pro')

    // Nested exact text inside a full-width wrapper div must click the <button>, not the wrapper <div>
    await tab.page.click('text="Nested Exact"')
    expect(await tab.page.evaluate('window.__nestedHit')).toBe(true)

    await tab.page.click('.card >> has=.badge >> button >> last')
    expect(await tab.page.evaluate('window.__plan')).toBe('pro-details')

    await tab.page.click('xpath=//button[@data-xp="yes"]')
    expect(await tab.page.evaluate('window.__xpHit')).toBe(true)

    expect(await tab.page.getLocatorString('testid=pro-choose')).toBe('testid=pro-choose')
    const inspected = await tab.extractor.inspectElement(tab.session, tab.snapshots, 'testid=pro-choose')
    expect(inspected.recommendedLocator).toBe('testid=pro-choose')

    // 2. Same-Origin AND Cross-Origin OOPIF iframe piercing, listFrames, single-frame snapshot & frame evaluate
    const frames = await tab.page.listFrames()
    expect(frames.length).toBeGreaterThanOrEqual(3)
    expect(frames.some((f) => f.url.includes('/same-frame'))).toBe(true)
    expect(frames.some((f) => f.crossOrigin && f.url.includes('widget-oopif'))).toBe(true)

    await tab.page.click('iframe#same-frame >> role=button[name="Same Frame Btn"]')
    expect(await tab.page.evaluate('document.getElementById("same-btn").textContent', { frame: '#same-frame' })).toBe('Same Clicked')

    await tab.page.click('iframe#oopif-frame >> role=button[name="OOPIF Frame Btn"]')
    expect(await tab.page.evaluate('document.getElementById("oopif-btn").textContent', { frame: 'widget-oopif' })).toBe('OOPIF Clicked')

    const oopifSnap = await tab.snapshots.capture(tab.session, { frame: 'widget-oopif' })
    expect(oopifSnap.text).toContain('OOPIF Clicked')
    expect(oopifSnap.text).not.toContain('Starter')

    // 3. Smart Waits: waitForSelector(hidden), waitForUrl, waitForResponse, waitForFunction
    const respPromise = tab.network.waitForResponse({ url: /\/api\/submit/, status: 200, timeoutMs: 5000 })
    await tab.page.click('#async-btn')
    await waitForSelector(tab.session, '#spinner', { state: 'hidden', timeoutMs: 5000 })
    const matchedUrl = await waitForUrl(tab.session, /#done-step/, { timeoutMs: 5000 })
    expect(matchedUrl).toContain('#done-step')
    const readyVal = await waitForFunction<number>(tab.session, 'window.__readyFlag === 42 ? window.__readyFlag : false', { timeoutMs: 5000 })
    expect(readyVal).toBe(42)
    const apiRes = await respPromise
    expect(apiRes.status).toBe(200)
    expect(JSON.parse(apiRes.body || '{}')).toEqual({ ok: true, plan: 'pro', code: 2026 })

    // 4. Popup tab auto-detection in ActionFeedback & waitForPopup + JS Dialog capture in ActionFeedback
    const popupClick = await tab.runWithFeedback(() => tab.page.click('#popup-link'))
    expect(popupClick.feedback.openedTabs?.length).toBeGreaterThanOrEqual(1)
    const openedPopupId = popupClick.feedback.openedTabs![0].tabId
    await manager.closeTab(openedPopupId)

    const popupTab = await manager.waitForPopup({
      action: () => tab.page.click('#popup-link'),
      timeoutMs: 5000,
    })
    await new Promise((r) => setTimeout(r, 150))
    expect((await popupTab.page.getUrlAndTitle()).url).toContain('/popup-dest')
    await manager.closeTab(popupTab.tabId)

    tab.session.setAutoDialog({ accept: true })
    const dlgRes = await tab.runWithFeedback(() => tab.page.click('#alert-btn'))
    expect(dlgRes.feedback.dialogs?.some((d) => d.type === 'alert' && d.message.includes('Saved successfully'))).toBe(true)

    // 5. Idempotent check/uncheck, multi-select, range slider + file upload via fillForm, mouseStroke & key repeat
    expect(await tab.page.check('#chk-opt')).toBe(true)
    expect(await tab.page.check('#chk-opt')).toBe(false) // already checked -> idempotent no-op
    expect(await tab.page.uncheck('#chk-opt')).toBe(true)

    const formRes = await tab.page.fillForm([
      { target: '#chk-opt', value: true },
      { target: '#multi-tags', value: ['ts', 'cdp'] },
      { target: '#vol-range', value: 78 },
      { target: '#doc-upload', value: tempUploadFile },
    ])
    expect(formRes.filled).toHaveLength(4)
    expect(
      await tab.page.evaluate(`({
        checked: document.getElementById('chk-opt').checked,
        selected: Array.from(document.getElementById('multi-tags').selectedOptions).map(o => o.value),
        range: document.getElementById('vol-range').value,
        file: document.getElementById('doc-upload').files?.[0]?.name || ''
      })`),
    ).toEqual({
      checked: true,
      selected: ['ts', 'cdp'],
      range: '78',
      file: 'sample.txt',
    })

    const padBox = (await tab.page.resolveElement('#pad')).box
    await tab.page.mouseStroke([
      { x: padBox.x + 15, y: padBox.y + 20 },
      { x: padBox.x + 90, y: padBox.y + 60 },
      { x: padBox.x + 180, y: padBox.y + 30 },
    ], { stepsPerSegment: 4 })
    expect(await tab.page.evaluate<number>('window.__strokeMoves')).toBeGreaterThanOrEqual(4)
    expect(await tab.page.evaluate<boolean>('window.__strokeEnded')).toBe(true)

    await tab.page.pressKey('ArrowDown', { repeat: 3 })
    expect(await tab.page.evaluate<number>('window.__arrowCount')).toBe(3)

    // 6. System controls: clipboard, addInitScript across reload, grantPermissions, printToPDF
    await tab.page.writeClipboard('BrowserPilot Clipboard OK')
    const clip = await tab.page.readClipboard()
    expect(clip.text).toBe('BrowserPilot Clipboard OK')

    await tab.page.grantPermissions(['geolocation'])
    const initEntry = await tab.page.addInitScript('window.__bpInitMarker = "injected-v14";')
    expect(tab.page.listInitScripts().some((s) => s.id === initEntry.id)).toBe(true)
    await tab.page.reload()
    expect(await tab.page.evaluate<string>('window.__bpInitMarker')).toBe('injected-v14')
    await tab.page.removeInitScript(initEntry.id)

    const pdf = await tab.page.printToPDF({ path: tempPdfFile, printBackground: true })
    expect(pdf.sizeBytes).toBeGreaterThan(1000)
    const pdfHead = (await fs.readFile(tempPdfFile)).subarray(0, 5).toString('ascii')
    expect(pdfHead).toBe('%PDF-')

    // 7. Fluent Sandbox exec: locator().filter().click() + real-time onResponse JSON capture
    const sess = manager.createSession({ tabGroup: 'v14test' })
    const execRes = await manager.exec(
      sess.id,
      `
        const cards = await locator('.card');
        await cards.filter({ hasText: 'Starter' }).locator('button').click();
        const plan = await evaluate('window.__plan');
        const seen = [];
        const off = await onResponse(async (res) => {
          if (res.url.includes('/api/submit')) {
            seen.push(await res.json());
          }
        });
        await evaluate('fetch("/api/submit").then(r => r.text())');
        await keyboard.press('ArrowDown', { repeat: 2 });
        const keysAfter = await evaluate('window.__arrowCount');
        await sleep(250);
        off();
        return { plan, seen, keysAfter };
      `,
      { tabId: tab.tabId, timeoutMs: 10_000 },
    )
    expect(execRes.error).toBeUndefined()
    expect(execRes.returnValue).toEqual({
      plan: 'starter',
      seen: [{ ok: true, plan: 'pro', code: 2026 }],
      keysAfter: 2,
    })
  }, 45_000)
})
