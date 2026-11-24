import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildActionRecordingResult,
  computeDemoSegments,
  createDemoVideo,
  DirectCDPTransport,
  SessionManager,
} from '../src/index.js'

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

describe('v1.2.0 unit tests: ActionRecorder compression & Smart Demo Segments', () => {
  it('compresses noisy action events into clean batch steps, JS script, and Skill Markdown', () => {
    const res = buildActionRecordingResult(
      [
        { timestamp: 100, action: 'navigate', url: 'https://app.example.com' },
        { timestamp: 200, action: 'click', url: 'https://app.example.com', target: '#email' },
        { timestamp: 300, action: 'fill', url: 'https://app.example.com', target: '#email', value: 'a' },
        { timestamp: 400, action: 'fill', url: 'https://app.example.com', target: '#email', value: 'alice@example.com' },
        { timestamp: 500, action: 'click', url: 'https://app.example.com', target: '#submit', text: 'Sign In' },
      ],
      4000,
    )
    expect(res.steps).toHaveLength(3)
    expect(res.steps[1]).toMatchObject({ action: 'fill', target: '#email', value: 'alice@example.com' })
    expect(res.batchSteps).toHaveLength(3)
    expect(res.execScript).toContain('await t.page.fill("#email", "alice@example.com")')
    expect(res.skillMarkdown).toContain('# Recorded BrowserPilot Workflow')
    expect(res.skillMarkdown).toContain('Sign In')
  })

  it('splits timeline into active 1x windows and idle speedup segments around action timestamps', () => {
    const segs = computeDemoSegments(10_000, [2_500, 7_500], { paddingMs: 500 })
    expect(segs).toEqual([
      { startSec: 0, endSec: 2, kind: 'idle' },
      { startSec: 2, endSec: 3, kind: 'active' },
      { startSec: 3, endSec: 7, kind: 'idle' },
      { startSec: 7, endSec: 8, kind: 'active' },
      { startSec: 8, endSec: 10, kind: 'idle' },
    ])
  })
})

describe('v1.2.0 real Chromium E2E: Downloads, Action Recorder & Smart Idle/Audio Video Recording', () => {
  let server: http.Server
  let baseUrl = ''
  let chromeProc: ChildProcess | null = null
  let userDataDir = ''
  let transport: DirectCDPTransport | null = null
  let manager: SessionManager | null = null
  let available = false

  beforeAll(async () => {
    const bin = await findChrome()
    if (!bin) return
    available = true

    const httpPort = await getFreePort()
    server = http.createServer((req, res) => {
      if (req.url === '/download/report.csv') {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="report.csv"',
        })
        res.end('id,name,score\n1,BrowserPilot,100\n')
        return
      }
      if (req.url === '/done') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><html><head><title>Done Page</title></head><body><h1>Submitted OK</h1></body></html>')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
      <html>
      <head><meta charset="utf-8" /><title>Parity Lab</title></head>
      <body style="padding:24px;font-family:sans-serif;">
        <h1>Parity v1.2 Lab</h1>
        <a id="dl-link" href="/download/report.csv">Download CSV</a>
        <div style="margin-top:16px;">
          <input id="user" placeholder="User" />
          <input id="pass" type="password" placeholder="Password" />
          <select id="plan">
            <option value="free">Free</option>
            <option value="pro">Pro</option>
          </select>
          <button id="go" onclick="location.href='/done'">Continue</button>
        </div>
        <div id="pulse" style="margin-top:16px;width:80px;height:40px;background:#10b981;"></div>
        <script>
          window.playBeep = function() {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            osc.frequency.value = 440;
            osc.connect(ctx.destination);
            osc.start();
            setTimeout(() => { osc.stop(); }, 250);
          };
          let tick = 0;
          setInterval(() => {
            tick++;
            document.getElementById('pulse').textContent = String(tick);
          }, 80);
        </script>
      </body>
      </html>`)
    })
    await new Promise<void>((r) => server.listen(httpPort, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${httpPort}`

    const debugPort = await getFreePort()
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-v12-e2e-'))
    chromeProc = spawn(
      bin,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--autoplay-policy=no-user-gesture-required',
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
  }, 30_000)

  afterAll(async () => {
    manager?.dispose()
    await transport?.close()
    if (chromeProc) chromeProc.kill('SIGTERM')
    if (server) await new Promise<void>((r) => server.close(() => r()))
    if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('tracks downloads to disk, records multi-step user actions across navigation, and generates smart idle-sped demo videos with audio tap', async () => {
    if (!available || !manager) return

    const tab = await manager.openTab({ url: 'about:blank' })
    await tab.page.navigate(baseUrl, { waitUntil: 'load' })

    // 1. Download tracking & clean filename resolution
    const dlDir = path.join(userDataDir, 'downloads')
    await tab.downloads.configure(dlDir)
    const dlPromise = tab.downloads.waitForDownload({ filenamePattern: 'report.csv', timeoutMs: 10_000 })
    await tab.page.click('#dl-link')
    const dl = await dlPromise
    expect(dl.state).toBe('completed')
    expect(dl.suggestedFilename).toBe('report.csv')
    expect(dl.filePath).toBeTruthy()
    const csvContent = await fs.readFile(dl.filePath!, 'utf8')
    expect(csvContent).toContain('1,BrowserPilot,100')

    // 2. Enhanced Screen Recording (audio tap + actionTimestamps + smart idle-only createDemoVideo)
    const rawVideo = path.join(userDataDir, 'session.mp4')
    await tab.recorder.start({ outputPath: rawVideo, frameRate: 15, audio: true })
    await new Promise((r) => setTimeout(r, 400))
    tab.recorder.markAction()
    await tab.page.evaluate('window.playBeep()')
    await new Promise((r) => setTimeout(r, 600))
    tab.recorder.markAction()
    await new Promise((r) => setTimeout(r, 400))
    const rec = await tab.recorder.stop()
    expect(rec.sizeBytes).toBeGreaterThan(1000)
    expect(rec.actionTimestamps.length).toBeGreaterThanOrEqual(2)

    const demoPath = await createDemoVideo({
      recordingPath: rec.path,
      durationMs: rec.durationMs,
      actionTimestamps: rec.actionTimestamps,
      speed: 6,
      paddingMs: 200,
    })
    const demoStat = await fs.stat(demoPath)
    expect(demoStat.size).toBeGreaterThan(500)

    // 3. Live Action Recorder (fills + password masking + select + navigation surviving reload!)
    await tab.actionRecorder.start({ maskPasswords: true })
    await tab.page.fill('#user', 'bob')
    await tab.page.fill('#pass', 'super-secret-99')
    await tab.page.selectOption('#plan', 'pro')
    await new Promise((r) => setTimeout(r, 450))
    await tab.page.click('#go')
    await new Promise((r) => setTimeout(r, 350))

    const recorded = await tab.actionRecorder.stop()
    expect(recorded.steps.some((s) => s.action === 'fill' && s.target === '#user' && s.value === 'bob')).toBe(true)
    expect(recorded.steps.some((s) => s.action === 'fill' && s.target === '#pass' && s.value === '<REDACTED_PASSWORD>')).toBe(true)
    expect(recorded.steps.some((s) => s.action === 'select_option' && s.target === '#plan' && s.value === 'pro')).toBe(true)
    expect(recorded.steps.some((s) => s.action === 'click' && s.target === '#go')).toBe(true)
    expect(recorded.steps.some((s) => s.action === 'navigate' && s.url.includes('/done'))).toBe(true)
    expect(recorded.execScript).toContain('await t.page.fill("#user", "bob")')
    expect(recorded.skillMarkdown).toContain('# Recorded BrowserPilot Workflow')

    await manager.closeTab(tab.tabId)
  }, 45_000)
})
