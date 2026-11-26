import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DirectCDPTransport, SessionManager, waitForText } from '../src/index.js'

const CHROME_BIN =
  process.env.BROWSERPILOT_CHROME_BIN ||
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  )

async function hasChrome(): Promise<boolean> {
  try {
    await fs.access(CHROME_BIN)
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
        const p = addr.port
        srv.close(() => resolve(p))
      } else reject(new Error('port error'))
    })
  })
}

const IFRAME_HTML = `<!doctype html>
<html>
<body style="margin:8px;font-family:sans-serif">
  <input data-testid="iframe-note" placeholder="Iframe note" />
  <button id="iframe-save">Save Frame</button>
  <span id="iframe-out">none</span>
  <script>
    document.getElementById('iframe-save').addEventListener('click', () => {
      document.getElementById('iframe-out').textContent =
        'frame:' + document.querySelector('[data-testid="iframe-note"]').value;
    });
  </script>
</body>
</html>`

const CODEGEN_PAGE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Codegen & Trace Playground</title>
  <style>
    body { font-family: sans-serif; padding: 18px; display: flex; flex-direction: column; gap: 10px; max-width: 680px; }
    .row { display: flex; gap: 10px; align-items: center; }
    iframe { height: 70px; border: 1px solid #cbd5e1; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>Order Console</h1>
  <!-- Dynamic React-style :r1: ID must be ignored in favor of label / placeholder -->
  <label>Customer Email <input id=":r1:" placeholder="Enter email" /></label>
  <input type="password" name="secret_pin" placeholder="Secret PIN" />

  <div class="row">
    <label><input type="checkbox" id="express-ship" /> Express Shipping</label>
    <select data-testid="tier-select">
      <option value="free">Free</option>
      <option value="pro">Pro</option>
      <option value="enterprise">Enterprise</option>
    </select>
  </div>

  <div class="row">
    <button class="tier-btn">Apply Tier</button>
    <button class="tier-btn">Apply Tier</button>
  </div>

  <div id="shadow-host"></div>
  <iframe id="inner-frame" src="/frame"></iframe>

  <input id="quick-search" placeholder="Type & press Enter" />
  <button id="place-order" data-testid="place-order">Place Order</button>
  <div id="summary">idle</div>

  <script>
    // Shadow DOM button
    const host = document.getElementById('shadow-host');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<button class="sh-btn">Verify Coupon</button><span id="sh-msg">unverified</span>';
    let couponOk = false;
    sr.querySelector('.sh-btn').addEventListener('click', () => {
      couponOk = true;
      sr.getElementById('sh-msg').textContent = 'verified';
    });

    let pickedTierIdx = -1;
    document.querySelectorAll('.tier-btn').forEach((btn, idx) => {
      btn.addEventListener('click', () => { pickedTierIdx = idx; });
    });

    let enterTriggered = false;
    document.getElementById('quick-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        enterTriggered = e.target.value === 'instant-enter';
      }
    });

    document.getElementById('place-order').addEventListener('click', async () => {
      console.error('order-audit-warning');
      const email = document.getElementById(':r1:').value;
      const express = document.getElementById('express-ship').checked;
      const tier = document.querySelector('[data-testid="tier-select"]').value;
      const r = await fetch('/api/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, express, tier, pickedTierIdx, couponOk, enterTriggered }),
      });
      const data = await r.json();
      document.getElementById('summary').textContent = data.summary;
    });
  </script>
</body>
</html>`

describe('@browserpilot/core v1.6 Codegen & Interactive Trace Viewer E2E (real Chromium)', () => {
  let httpServer: http.Server
  let baseUrl = ''
  let chromeProc: ChildProcess | null = null
  let transport: DirectCDPTransport | null = null
  let manager: SessionManager | null = null
  let tmpDir = ''
  let available = false

  beforeAll(async () => {
    available = await hasChrome()
    if (!available) return

    const httpPort = await getFreePort()
    httpServer = http.createServer(async (req, res) => {
      if (req.url === '/frame') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(IFRAME_HTML)
        return
      }
      if (req.url === '/api/order' && req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            orderId: 'ORD-9001',
            summary: `${body.email}|express=${body.express}|tier=${body.tier}|btn=${body.pickedTierIdx}|coupon=${body.couponOk}|enter=${body.enterTriggered}`,
          }),
        )
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(CODEGEN_PAGE_HTML)
    })
    await new Promise<void>((r) => httpServer.listen(httpPort, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${httpPort}`

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-v16-'))
    const debugPort = await getFreePort()
    chromeProc = spawn(
      CHROME_BIN,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        ...(process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${path.join(tmpDir, 'profile')}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    )

    const endpoint = `http://127.0.0.1:${debugPort}`
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${endpoint}/json/version`)).ok) break
      } catch {}
      await new Promise((r) => setTimeout(r, 120))
    }

    transport = await DirectCDPTransport.connect(endpoint)
    manager = new SessionManager(transport)
  }, 30_000)

  afterAll(async () => {
    manager?.dispose()
    await transport?.close()
    if (chromeProc) chromeProc.kill('SIGTERM')
    if (httpServer) await new Promise<void>((r) => httpServer.close(() => r()))
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('records complex interactions (dynamic IDs, Shadow DOM, iframe, nth, check, immediate Enter, assertions) and replays generated code zero-edit', async () => {
    if (!available || !manager) return

    const tab = await manager.openTab({ url: baseUrl })
    await tab.page.waitForLocator('#place-order')
    // Ensure same-origin iframe finished loading before starting recorder
    await tab.page.waitForLocator('iframe#inner-frame >> #iframe-save')

    await tab.actionRecorder.start({ maskPasswords: true })

    // Perform user interactions across main DOM, dynamic :r1: ID, password, checkbox, select, duplicate buttons, Shadow DOM, iframe, and immediate Enter!
    await tab.page.fill('placeholder=Enter email', 'buyer@acme.io')
    await tab.page.fill('input[name="secret_pin"]', 'super-secret-999')
    await tab.page.check('#express-ship')
    await tab.page.selectOption('[data-testid="tier-select"]', 'pro')
    await tab.page.click('.tier-btn >> nth=1')
    await tab.page.click('#shadow-host >> button')
    await tab.page.fill('iframe#inner-frame >> [data-testid="iframe-note"]', 'rush-delivery')
    await tab.page.click('iframe#inner-frame >> #iframe-save')

    // Rapid fill + immediate Enter (<20ms) — verifies synchronous pending-input flush before keydown!
    await tab.page.fill('#quick-search', 'instant-enter')
    await tab.page.pressKey('Enter')

    await tab.page.click('[data-testid="place-order"]')
    await waitForText(tab.session, 'buyer@acme.io|express=true|tier=pro|btn=1|coupon=true|enter=true')

    // Arm assertion mode and click #summary to record an assert_text step!
    await tab.actionRecorder.setAssertMode(true)
    await tab.page.click('#summary')

    const recorded = await tab.actionRecorder.stop()

    // 1. Dynamic React `:r1:` ID MUST NOT appear in generated selectors; password MUST be redacted
    expect(recorded.playwrightScript).not.toContain(':r1:')
    expect(recorded.execScript).not.toContain(':r1:')
    expect(recorded.execScript).toContain('<REDACTED_PASSWORD>')
    expect(recorded.execScript).not.toContain('super-secret-999')

    // 2. Verify idiomatic Playwright TS output (getByPlaceholder / getByLabel, getByTestId, nth(1), Shadow DOM, contentFrame, check, expect.toContainText)
    expect(recorded.playwrightScript).toContain('getByTestId("tier-select").selectOption("pro")')
    expect(recorded.playwrightScript).toContain('.nth(1).click()')
    expect(recorded.playwrightScript).toContain('locator("iframe#inner-frame").contentFrame().getByTestId("iframe-note").fill("rush-delivery")')
    expect(recorded.playwrightScript).toContain('locator("#express-ship").check()')
    expect(recorded.playwrightScript).toContain('expect(page.locator("#summary")).toContainText("buyer@acme.io|express=true|tier=pro|btn=1|coupon=true|enter=true")')

    // 3. Zero-edit replay verification: run `recorded.execScript` directly on a brand-new tab via SessionManager.exec!
    const replayTab = await manager.openTab({ url: 'about:blank' })
    const replayRes = await manager.exec('codegen-replay', recorded.execScript, { tabId: replayTab.tabId })
    expect(replayRes.error).toBeUndefined()
    expect(await replayTab.page.evaluate<string>('document.getElementById("summary").textContent')).toBe(
      'buyer@acme.io|express=true|tier=pro|btn=1|coupon=true|enter=true',
    )
    expect(
      await replayTab.page.evaluate<string>('document.getElementById("iframe-out").textContent', { frame: 'inner-frame' }),
    ).toBe('frame:rush-delivery')

    await manager.closeTab(tab.tabId)
    await manager.closeTab(replayTab.tabId)
  }, 35_000)

  it('captures visual execution Trace (screenshots, reticle, network JSON body, console errors, failed steps & XSS-safe HTML viewer) and renders interactively', async () => {
    if (!available || !manager) return

    const tab = await manager.openTab({ url: baseUrl })
    await tab.page.waitForLocator('#place-order')

    await tab.trace.start({ title: 'Checkout Trace Audit' })

    // Include a `</script>` string inside input to verify HTML Trace Viewer XSS / parser safety!
    const trickyEmail = 'qa+</script><script>window.__traceXss=1</script>@acme.io'
    await tab.page.fill('placeholder=Enter email', trickyEmail)
    await tab.page.check('#express-ship')
    await tab.page.selectOption('[data-testid="tier-select"]', 'enterprise')
    await tab.page.click('[data-testid="place-order"]')
    await waitForText(tab.session, 'tier=enterprise')

    // Also trigger an intentional failing step so we verify red error step capture in Trace Viewer
    await expect(tab.page.click('#non-existent-ghost-button', { timeoutMs: 250 })).rejects.toThrow()

    const traceHtmlPath = path.join(tmpDir, 'checkout-trace.html')
    const stopped = await tab.trace.stop({ path: traceHtmlPath })
    expect(stopped.summary.stepCount).toBe(5)
    expect(stopped.summary.networkCount).toBeGreaterThanOrEqual(1)
    expect(stopped.summary.errorCount).toBeGreaterThanOrEqual(2) // 1 console.error + 1 failed step

    // Open the generated standalone single-file HTML report inside real Chromium and inspect its live UI!
    const viewerTab = await manager.openTab({ url: `file://${traceHtmlPath}` })
    await viewerTab.page.waitForLocator('#hdr-title')

    // 1. Verify </script> payload did NOT execute XSS or corrupt the JSON blob!
    expect(await viewerTab.page.evaluate('globalThis.__traceXss')).toBeUndefined()
    expect(await viewerTab.page.evaluate<string>('document.getElementById("hdr-title").textContent')).toBe(
      'Checkout Trace Audit',
    )
    expect(await viewerTab.page.evaluate<number>('document.querySelectorAll(".thumb").length')).toBe(5)

    // 2. Select Step #4 (`click [data-testid="place-order"]`, index 3), switch to Before view, and verify SVG reticle + highlight box + Network response body + Console error!
    await viewerTab.page.click('.step-item >> nth=3')
    await viewerTab.page.click('#vmode-before')
    const overlayStats = await viewerTab.page.evaluate<{ circles: number; rects: number; hasJpeg: boolean }>(`(() => ({
      circles: document.querySelectorAll('.overlay-svg circle').length,
      rects: document.querySelectorAll('.overlay-svg rect').length,
      hasJpeg: Boolean(document.querySelector('.frame-img-box img')?.getAttribute('src')?.startsWith('data:image/jpeg;base64,')),
    }))()`)
    expect(overlayStats.hasJpeg).toBe(true)
    expect(overlayStats.circles).toBeGreaterThanOrEqual(2)
    expect(overlayStats.rects).toBe(1)

    await viewerTab.page.click('#rtab-net')
    const netText = await viewerTab.page.evaluate<string>('document.getElementById("right-body").textContent')
    expect(netText).toContain('POST 200')
    expect(netText).toContain('/api/order')
    expect(netText).toContain('ORD-9001')

    await viewerTab.page.click('#rtab-console')
    expect(await viewerTab.page.evaluate<string>('document.getElementById("right-body").textContent')).toContain(
      'order-audit-warning',
    )

    // 3. Press ArrowRight key to scrub to Step #5 (the failed `#non-existent-ghost-button` click) and verify error details
    await viewerTab.page.click('#rtab-call')
    await viewerTab.page.pressKey('ArrowRight')
    expect(await viewerTab.page.evaluate<string>('document.getElementById("right-body").textContent')).toContain(
      '#non-existent-ghost-button',
    )

    // 4. Switch to English (`#btn-lang`) and Codegen tab (`#ltab-code`)
    await viewerTab.page.click('#btn-lang')
    expect(await viewerTab.page.evaluate<string>('document.getElementById("ltab-steps").textContent')).toBe('Actions')
    await viewerTab.page.click('#ltab-code')
    expect(await viewerTab.page.evaluate<string>('document.querySelector("pre.code-block").textContent')).toContain(
      '@playwright/test',
    )

    // 5. Verify `SessionManager.exec(..., { tracePath })` auto-saves trace even when script throws mid-flight!
    const crashTracePath = path.join(tmpDir, 'crash-trace.html')
    const crashExec = await manager.exec(
      'crash-session',
      `const t = await tabs.current(); await t.page.fill('#quick-search', 'before-crash'); await t.page.click('#missing-btn', { timeoutMs: 200 });`,
      { tabId: tab.tabId, tracePath: crashTracePath },
    )
    expect(crashExec.error).toBeTruthy()
    expect(crashExec.tracePath).toBe(crashTracePath)
    const crashStat = await fs.stat(crashTracePath)
    expect(crashStat.size).toBeGreaterThan(5_000)

    await manager.closeTab(viewerTab.tabId)
    await manager.closeTab(tab.tabId)
  }, 35_000)
})
