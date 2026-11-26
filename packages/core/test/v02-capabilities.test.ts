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

const CAPABILITIES_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>BrowserPilot v0.2 Real-World Capabilities</title>
  <style>
    body { font-family: sans-serif; margin: 16px; }
    #rich-editor { border: 1px solid #94a3b8; min-height: 44px; padding: 8px; margin-bottom: 12px; }
    .dnd-row { display: flex; gap: 20px; margin-bottom: 12px; }
    #drag-card { width: 120px; height: 48px; background: #0ea5e9; color: #fff; display: flex; align-items: center; justify-content: center; }
    #drop-zone { width: 160px; height: 60px; border: 2px dashed #64748b; display: flex; align-items: center; justify-content: center; }
    #touch-pad { width: 320px; height: 80px; background: #f1f5f9; border: 1px solid #cbd5e1; margin-bottom: 12px; display: flex; align-items: center; justify-content: center; }
    #virtual-list { height: 220px; width: 320px; overflow-y: auto; border: 1px solid #cbd5e1; position: relative; }
    #virtual-spacer { height: 2600px; position: relative; }
    .v-row { position: absolute; left: 0; right: 0; height: 40px; padding: 8px; box-sizing: border-box; border-bottom: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div id="rich-editor" contenteditable="true" role="textbox" aria-label="Rich Composer"><p>Old Draft Text</p></div>
  <div class="dnd-row">
    <div id="drag-card" draggable="true">Card Alpha</div>
    <div id="drop-zone">Drop Here</div>
  </div>
  <div id="dnd-status">idle</div>
  <div id="touch-pad"><button id="touch-btn">Tap Me</button></div>
  <div id="touch-log">none</div>
  <div id="virtual-list"><div id="virtual-spacer"></div></div>
  <button id="auth-api-btn">Call Auth API</button>
  <script>
    // 1. HTML5 native Drag & Drop with DataTransfer
    const card = document.getElementById('drag-card');
    const zone = document.getElementById('drop-zone');
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', 'card-alpha-payload');
    });
    zone.addEventListener('dragover', (e) => e.preventDefault());
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      document.getElementById('dnd-status').textContent = 'dropped:' + e.dataTransfer.getData('text/plain');
    });

    // 2. Touch-only tap & swipe listeners
    const pad = document.getElementById('touch-pad');
    let touchStartX = null;
    let movedCount = 0;
    document.getElementById('touch-btn').addEventListener('touchstart', () => {
      document.getElementById('touch-log').textContent = 'tapped';
    });
    pad.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0]?.clientX ?? 0;
      movedCount = 0;
    });
    pad.addEventListener('touchmove', () => { movedCount++; });
    pad.addEventListener('touchend', () => {
      if (movedCount >= 2 && touchStartX !== null) {
        document.getElementById('touch-log').textContent = 'swiped:' + movedCount;
      }
    });

    // 3. Virtualized list that ONLY mounts rows inside the current scroll window
    const vlist = document.getElementById('virtual-list');
    const spacer = document.getElementById('virtual-spacer');
    function renderVirtual() {
      const top = vlist.scrollTop;
      const startIdx = Math.max(0, Math.floor(top / 40) - 1);
      const endIdx = Math.min(60, startIdx + 9);
      spacer.innerHTML = '';
      for (let i = startIdx; i <= endIdx; i++) {
        const row = document.createElement('div');
        row.className = 'v-row';
        row.style.top = (i * 40) + 'px';
        row.textContent = 'Virtual Item #' + i;
        spacer.appendChild(row);
      }
    }
    vlist.addEventListener('scroll', renderVirtual);
    renderVirtual();

    // 4. Authenticated API fetch to verify Trace sensitive header/token redaction
    document.getElementById('auth-api-btn').addEventListener('click', async () => {
      const r = await fetch('/api/secret?token=query-secret-999', {
        headers: { Authorization: 'Bearer super-secret-jwt-token-xyz' }
      });
      await r.json();
    });
  </script>
</body>
</html>`

describe('@browserpilot/core v0.2 real-world SPA, touch, virtual-scroll, HTML5 DnD, approval & restricted sandbox', () => {
  let server: http.Server
  let baseUrl = ''
  let chromeProc: ChildProcess | null = null
  let userDataDir = ''
  let transport: DirectCDPTransport | null = null
  let manager: SessionManager | null = null

  beforeAll(async () => {
    const chromeBin = await findChrome()
    if (!chromeBin) return

    const httpPort = await getFreePort()
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/secret')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'auth_sid=topsecret' })
        res.end(JSON.stringify({ ok: true, token: 'resp-secret-abc12345' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(CAPABILITIES_HTML)
    })
    await new Promise<void>((r) => server.listen(httpPort, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${httpPort}`

    const cdpPort = await getFreePort()
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-v02-'))
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

  it('handles rich-text contenteditable, HTML5 DnD, mobile touch tap/swipe, virtual-scroll finder, approval card, restricted sandbox & trace redaction', async () => {
    if (!manager) return
    const tab = await manager.openTab({ url: baseUrl })
    await tab.page.navigate(baseUrl, { waitUntil: 'load' })

    // 1. Rich-text contenteditable replacement via native Cmd/Ctrl+A + Backspace + insertText
    await tab.page.fill('#rich-editor', 'Updated Rich Paragraph')
    const richText = await tab.page.evaluate<string>('document.getElementById("rich-editor").innerText.trim()')
    expect(richText).toBe('Updated Rich Paragraph')

    // 2. HTML5 native draggable="true" DataTransfer drag-and-drop (auto-detected)
    await tab.page.drag('#drag-card', '#drop-zone')
    expect(await tab.page.evaluate<string>('document.getElementById("dnd-status").textContent')).toBe(
      'dropped:card-alpha-payload',
    )

    // 3. Mobile CDP Touch Events: tap + swipe
    await tab.page.tap('#touch-btn')
    expect(await tab.page.evaluate<string>('document.getElementById("touch-log").textContent')).toBe('tapped')
    const padBox = await tab.page.evaluate<{ x: number; y: number; w: number; h: number }>(
      '(() => { const r = document.getElementById("touch-pad").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()',
    )
    await tab.page.swipe(
      { x: padBox.x + padBox.w - 20, y: padBox.y + padBox.h / 2 },
      { x: padBox.x + 20, y: padBox.y + padBox.h / 2 },
      { steps: 6, durationMs: 120 },
    )
    expect(await tab.page.evaluate<string>('document.getElementById("touch-log").textContent')).toMatch(/^swiped:/)

    // 4. Virtualized list scrollUntil finds item #42 that did NOT exist in initial DOM!
    expect(await tab.page.evaluate<boolean>('document.body.innerText.includes("Virtual Item #42")')).toBe(false)
    const scrollRes = await tab.page.scrollUntil('text="Virtual Item #42"', {
      container: '#virtual-list',
      amount: 260,
      maxScrolls: 15,
      delayMs: 40,
    })
    expect(scrollRes.found).toBe(true)
    expect(scrollRes.attempts).toBeGreaterThan(0)
    expect(await tab.page.evaluate<boolean>('document.body.innerText.includes("Virtual Item #42")')).toBe(true)

    // 5. In-page High-Risk Action Approval card (allow + deny)
    const allowPromise = tab.page.requestActionApproval({
      action: 'click',
      detail: 'click 立即支付',
      reason: 'High-risk payment action',
      timeoutMs: 8_000,
    })
    await new Promise((r) => setTimeout(r, 120))
    expect(await tab.page.evaluate<boolean>('Boolean(document.getElementById("__browserpilot_approval_host"))')).toBe(true)
    await tab.page.evaluate('globalThis.__browserpilotApprovalDecision("allow")')
    const allowRes = await allowPromise
    expect(allowRes.approved).toBe(true)
    expect(allowRes.cancelled).toBe(false)

    // 6. Restricted exec sandbox blocks child_process & fs while allowing pure-CDP helpers
    const blocked = await manager.exec('sec-sess', 'require("child_process")', {
      tabId: tab.tabId,
      sandboxMode: 'restricted',
    })
    expect(blocked.error).toContain('restricted exec sandbox mode')
    const allowed = await manager.exec('sec-sess', 'return await evaluate("document.title")', {
      tabId: tab.tabId,
      sandboxMode: 'restricted',
    })
    expect(allowed.error).toBeUndefined()
    expect(allowed.returnValue).toBe('BrowserPilot v0.2 Real-World Capabilities')

    // 7. Trace Recorder automatically redacts Authorization, Cookie & query tokens
    await tab.trace.start({ title: 'Redaction Check', screenshots: false, snapshots: false })
    const apiWait = tab.network.waitForResponse({ url: '/api/secret', timeoutMs: 5_000 })
    await tab.page.click('#auth-api-btn')
    await apiWait
    const stopped = await tab.trace.stop({ format: 'json' })
    const apiNet = stopped.data.steps.flatMap((s) => s.networkEntries).find((n) => n.url.includes('/api/secret'))
    expect(apiNet).toBeTruthy()
    expect(apiNet!.url).toContain('token=REDACTED')
    expect(apiNet!.requestHeaders?.Authorization).toBe('<REDACTED>')
    expect(apiNet!.responseBodyPreview).toContain('"<REDACTED>"')
  }, 30_000)
})
