import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  captureLabeledScreenshot,
  DirectCDPTransport,
  DOMExtractor,
  PageController,
  SnapshotEngine,
  TabCDPSession,
  waitForPageLoad,
} from '../src/index.js'

const CHROME_CANDIDATES = [
  process.env.DEVPILOT_CHROME_BIN,
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean) as string[]

async function findChromeBinary(): Promise<string | null> {
  for (const bin of CHROME_CANDIDATES) {
    try {
      await fs.access(bin)
      return bin
    } catch {
      // try next
    }
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
      } else {
        reject(new Error('Failed to get free port'))
      }
    })
  })
}

const TEST_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="description" content="DevPilot E2E verification playground" />
  <title>DevPilot Playground</title>
  <style>
    body { font-family: sans-serif; padding: 24px; margin: 0; }
    .card { border: 1px solid #ccc; padding: 16px; border-radius: 8px; max-width: 600px; }
    .primary-btn { background: #2563eb; color: #fff; padding: 8px 16px; border: 0; border-radius: 6px; cursor: pointer; }
    #drag-box { width: 120px; height: 60px; background: #e2e8f0; margin-top: 12px; }
  </style>
</head>
<body>
  <main>
    <article class="card">
      <h1>DevPilot Core Test Page</h1>
      <p>Pure CDP automation & DevTools debugging verification suite with rich semantic content.</p>
      <form id="demo-form">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" placeholder="Enter username" />
        <label for="role-select">Role</label>
        <select id="role-select">
          <option value="dev">Developer</option>
          <option value="admin">Administrator</option>
        </select>
        <input id="file-input" type="file" />
        <button id="submit-btn" type="button" class="primary-btn">Save Profile</button>
        <button id="dialog-btn" type="button">Trigger Confirm</button>
      </form>
      <div id="status" aria-live="polite">idle</div>
      <div id="trusted-log">untrusted</div>
      <div id="shadow-host"></div>
      <div id="drag-box">Drag Surface</div>
      <iframe id="child-frame" src="/frame" width="300" height="80"></iframe>
    </article>
  </main>
  <script>
    const btn = document.getElementById('submit-btn');
    const input = document.getElementById('username');
    const select = document.getElementById('role-select');
    const status = document.getElementById('status');
    const trusted = document.getElementById('trusted-log');
    btn.addEventListener('click', (e) => {
      trusted.textContent = e.isTrusted ? 'trusted-click' : 'untrusted-click';
      status.textContent = 'saved:' + input.value + ':' + select.value;
    });
    document.getElementById('dialog-btn').addEventListener('click', () => {
      const ok = confirm('Proceed with action?');
      status.textContent = ok ? 'dialog-accepted' : 'dialog-dismissed';
    });
    const drag = document.getElementById('drag-box');
    let dragPoints = 0;
    drag.addEventListener('mousedown', () => { dragPoints = 1; });
    drag.addEventListener('mousemove', () => { if (dragPoints > 0) dragPoints++; });
    drag.addEventListener('mouseup', () => { if (dragPoints > 2) status.textContent = 'dragged:' + dragPoints; });

    // Open Shadow DOM button
    const host = document.getElementById('shadow-host');
    const sr = host.attachShadow({ mode: 'open' });
    const sbtn = document.createElement('button');
    sbtn.id = 'shadow-btn';
    sbtn.textContent = 'Shadow Action';
    sbtn.addEventListener('click', () => { status.textContent = 'shadow-clicked'; });
    sr.appendChild(sbtn);
  </script>
</body>
</html>`

const FRAME_HTML = `<!doctype html><html><body><button id="frame-btn" onclick="this.textContent='Frame Clicked'">Inside Iframe</button></body></html>`

describe('@devpilot/core real Chromium E2E', () => {
  let server: http.Server
  let baseUrl: string
  let chromeProc: ChildProcess | null = null
  let userDataDir: string
  let transport: DirectCDPTransport | null = null
  let chromeAvailable = false

  beforeAll(async () => {
    const chromeBin = await findChromeBinary()
    if (!chromeBin) return
    chromeAvailable = true

    const httpPort = await getFreePort()
    server = http.createServer((req, res) => {
      if (req.url === '/frame') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(FRAME_HTML)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(TEST_HTML)
    })
    await new Promise<void>((r) => server.listen(httpPort, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${httpPort}`

    const debugPort = await getFreePort()
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpilot-core-e2e-'))
    chromeProc = spawn(
      chromeBin,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        ...(process.env.CI ? ['--no-sandbox'] : []),
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${userDataDir}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    )

    // Wait for CDP endpoint
    const endpoint = `http://127.0.0.1:${debugPort}`
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`${endpoint}/json/version`)
        if (res.ok) break
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 150))
    }

    transport = await DirectCDPTransport.connect(endpoint)
  }, 25_000)

  afterAll(async () => {
    await transport?.close()
    if (chromeProc) {
      chromeProc.kill('SIGTERM')
    }
    if (server) {
      await new Promise<void>((r) => server.close(() => r()))
    }
    if (userDataDir) {
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('drives navigation, AXTree snapshot/diff, trusted input, Shadow DOM, dialogs, uploads, screenshots, DOM extraction, and safe cookies', async () => {
    if (!chromeAvailable || !transport) return

    const tab = await transport.createTab({ url: 'about:blank' })
    const session = new TabCDPSession(transport, tab.tabId)
    const snapshots = new SnapshotEngine()
    const extractor = new DOMExtractor()
    const page = new PageController(session, snapshots)

    // 1. Navigate + smart wait
    const meta = await page.navigate(baseUrl)
    expect(meta.title).toBe('DevPilot Playground')
    const loadState = await waitForPageLoad(session)
    expect(loadState.success).toBe(true)

    // 2. Full Accessibility Snapshot + ref discovery
    const snap1 = await snapshots.capture(session)
    expect(snap1.isDiff).toBe(false)
    expect(snap1.text).toContain('DevPilot Core Test Page')
    expect(snap1.totalRefs).toBeGreaterThan(3)

    const usernameRef = Object.values(snap1.refs).find((r) => r.role === 'textbox' && r.name === 'Username')?.ref
    const saveBtnRef = Object.values(snap1.refs).find((r) => r.role === 'button' && r.name === 'Save Profile')?.ref
    expect(usernameRef).toBeTruthy()
    expect(saveBtnRef).toBeTruthy()

    // Unchanged snapshot returns concise diff
    const snapSame = await snapshots.capture(session)
    expect(snapSame.isDiff).toBe(true)
    expect(snapSame.text).toContain('No changes since last snapshot')

    // 3. Fill input via ref, select option, click Save with REAL trusted CDP mouse event
    await page.fill(usernameRef!, 'Alice')
    await page.selectOption('#role-select', 'Administrator')
    await page.click(saveBtnRef!)

    expect(await page.evaluate<string>('document.getElementById("trusted-log").textContent')).toBe('trusted-click')
    expect(await page.evaluate<string>('document.getElementById("status").textContent')).toBe('saved:Alice:admin')

    // Diff snapshot reflects the updated state
    const snapDiff = await snapshots.capture(session)
    expect(snapDiff.text).toContain('saved:Alice:admin')

    // 4. Shadow DOM click
    await page.click('#shadow-btn')
    expect(await page.evaluate<string>('document.getElementById("status").textContent')).toBe('shadow-clicked')

    // 5. JS Dialog handling (auto-accept confirm)
    session.setAutoDialog({ accept: true })
    await page.click('#dialog-btn')
    await new Promise((r) => setTimeout(r, 150))
    expect(await page.evaluate<string>('document.getElementById("status").textContent')).toBe('dialog-accepted')
    session.setAutoDialog(null)

    // 6. File upload via DOM.setFileInputFiles
    const tmpFile = path.join(userDataDir, 'sample.txt')
    await fs.writeFile(tmpFile, 'hello devpilot')
    await page.uploadFiles('#file-input', [tmpFile])
    expect(await page.evaluate<string>('document.getElementById("file-input").files[0]?.name')).toBe('sample.txt')

    // 7. Drag gesture across element
    const dragEl = await page.resolveElement('#drag-box')
    await page.drag(
      { x: dragEl.box.x + 10, y: dragEl.box.y + 20 },
      { x: dragEl.box.x + 100, y: dragEl.box.y + 40 },
      { steps: 6 },
    )
    expect(await page.evaluate<string>('document.getElementById("status").textContent')).toMatch(/^dragged:/)

    // 8. Inspect element, Clean HTML, Readability Markdown
    const inspected = await extractor.inspectElement(session, snapshots, '#submit-btn')
    expect(inspected.tag).toBe('button')
    expect(inspected.formatted).toContain('Element: button#submit-btn.primary-btn')

    const cleanHtml = await extractor.getCleanHTML(session, { showDiffSinceLastCall: false })
    expect(cleanHtml).toContain('Save Profile')
    expect(cleanHtml).not.toContain('<script')

    const md = await extractor.getPageMarkdown(session, { showDiffSinceLastCall: false })
    expect(md).toContain('# DevPilot Playground')
    expect(md).toContain('Pure CDP automation')

    // 9. Normal screenshot + Set-of-Mark labeled screenshot
    const shot = await page.screenshot({ format: 'png' })
    expect(shot.base64.length).toBeGreaterThan(500)
    const som = await captureLabeledScreenshot(page)
    expect(som.labelsCount).toBeGreaterThan(2)
    expect(som.base64.length).toBeGreaterThan(500)
    // Overlay must be cleanly removed after capture
    expect(await page.evaluate<boolean>('!!document.getElementById("__devpilot_som_overlay")')).toBe(false)

    // 10. Page-scoped cookies + safety guard against profile-wide clearBrowserCookies
    await page.setCookie({ name: 'dp_token', value: 'xyz123' })
    const cookies = await page.getCookies()
    expect(cookies.some((c) => c.name === 'dp_token' && c.value === 'xyz123')).toBe(true)
    await page.deleteCookies('dp_token')
    const afterDelete = await page.getCookies()
    expect(afterDelete.some((c) => c.name === 'dp_token')).toBe(false)

    await expect(session.send('Network.clearBrowserCookies')).rejects.toThrow(/Blocked destructive/)

    // 11. localStorage
    await page.setStorage('local', 'theme', 'dark')
    expect((await page.getStorage('local')).theme).toBe('dark')

    session.dispose()
    await transport.closeTab(tab.tabId)
  }, 30_000)
})
