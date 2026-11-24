import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DirectCDPTransport,
  formatStylesAsText,
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

async function findChromeBinary(): Promise<string | null> {
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

const APP_JS = `function computePrice(qty) {
  const unit = 10;
  const total = qty * unit;
  return total;
}

window.runCalc = function(q) {
  return computePrice(q);
};

window.triggerApi = async function() {
  const r = await fetch('/api/items');
  return await r.json();
};

window.triggerError = function() {
  console.warn('sample warning');
  console.error('sample console error');
  setTimeout(() => { throw new Error('boom uncaught'); }, 10);
};

window.burnCpu = function() {
  const end = performance.now() + 70;
  let x = 0;
  while (performance.now() < end) { x += Math.sqrt(x + 1); }
  return x;
};

// Simulate React Fiber metadata on #react-btn so React Inspector can be verified cleanly
const rbtn = document.getElementById('react-btn');
if (rbtn) {
  function CheckoutButton() {}
  function CheckoutForm() {}
  const parentFiber = { type: CheckoutForm, memoizedProps: { mode: 'express' }, return: null };
  rbtn['__reactFiber$test'] = {
    type: CheckoutButton,
    memoizedProps: { label: 'Pay Now', amount: 99, onClick: function handlePay() {} },
    _debugSource: { fileName: 'src/components/CheckoutButton.tsx', lineNumber: 42, columnNumber: 7 },
    return: parentFiber,
  };
}
`

const APP_CSS = `
.cta { color: #333333; padding: 10px 18px; border-radius: 6px; }
#react-btn.cta { color: #ffffff; background-color: #16a34a; }
#react-btn:hover { background-color: #15803d; }
`

const DEVTOOLS_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>BrowserPilot DevTools Lab</title>
  <link rel="stylesheet" href="/app.css" />
</head>
<body>
  <h1 id="title">DevTools Suite Lab</h1>
  <button id="react-btn" class="cta" style="font-weight: 700">Pay Now</button>
  <div id="api-out"></div>
  <script src="/app.js"></script>
</body>
</html>`

describe('@browserpilot/core full DevTools, Recorder & Sandbox E2E', () => {
  let server: http.Server
  let baseUrl: string
  let chromeProc: ChildProcess | null = null
  let userDataDir: string
  let transport: DirectCDPTransport | null = null
  let manager: SessionManager | null = null
  let chromeAvailable = false

  beforeAll(async () => {
    const chromeBin = await findChromeBinary()
    if (!chromeBin) return
    chromeAvailable = true

    const httpPort = await getFreePort()
    server = http.createServer((req, res) => {
      if (req.url === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
        res.end(APP_JS)
        return
      }
      if (req.url === '/app.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
        res.end(APP_CSS)
        return
      }
      if (req.url === '/api/items') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ source: 'real-server', items: [1, 2, 3] }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(DEVTOOLS_HTML)
    })
    await new Promise<void>((r) => server.listen(httpPort, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${httpPort}`

    const debugPort = await getFreePort()
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-devtools-e2e-'))
    chromeProc = spawn(
      chromeBin,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
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
    if (server) await new Promise<void>((r) => server.close(() => r()))
    if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('verifies Console, Network, Fetch Mocking, CSS Styles, Live Debugger, Live Editor, React Fiber, Performance/Trace, Recording & Stateful Sandbox', async () => {
    if (!chromeAvailable || !manager) return

    const tab = await manager.openTab({ url: 'about:blank' })
    await tab.page.navigate(baseUrl, { waitUntil: 'load' })

    // 1. Console & uncaught exception capture + sinceLastCall
    await tab.page.evaluate('window.triggerError()')
    await new Promise((r) => setTimeout(r, 100))
    const allLogs = tab.console.getLogs({ cursorKey: 'test' })
    expect(allLogs.some((l) => l.level === 'warn' && l.text.includes('sample warning'))).toBe(true)
    expect(allLogs.some((l) => l.level === 'error' && l.text.includes('sample console error'))).toBe(true)
    expect(allLogs.some((l) => l.level === 'exception' && l.text.includes('boom uncaught'))).toBe(true)
    expect(tab.console.getLogs({ sinceLastCall: true, cursorKey: 'test' })).toHaveLength(0)

    // 2. Network inspector: headers, timing, initiator, response body
    const realApi = await tab.page.evaluate<{ source: string; items: number[] }>('window.triggerApi()')
    expect(realApi.source).toBe('real-server')
    const apiReqs = tab.network.getRequests({ search: '/api/items' })
    expect(apiReqs.length).toBeGreaterThanOrEqual(1)
    const body = await tab.network.getResponseBody(apiReqs[apiReqs.length - 1].requestId)
    expect(JSON.parse(body.body)).toEqual({ source: 'real-server', items: [1, 2, 3] })

    // 3. Fetch Request Interception / Mocking
    const rule = await tab.network.addInterceptRule({
      urlPattern: '*/api/items*',
      action: 'mock',
      status: 200,
      body: JSON.stringify({ source: 'mocked-by-browserpilot', items: [99] }),
    })
    const mockedApi = await tab.page.evaluate<{ source: string; items: number[] }>('window.triggerApi()')
    expect(mockedApi).toEqual({ source: 'mocked-by-browserpilot', items: [99] })
    await tab.network.removeInterceptRule(rule.id)

    // 4. CSS Styles inspector + forced :hover pseudo state
    const styles = await tab.styles.getStyles('#react-btn', tab.snapshots, {
      computedProperties: ['color', 'background-color'],
    })
    const stylesText = formatStylesAsText(styles)
    expect(stylesText).toContain('font-weight: 700')
    expect(stylesText).toContain('#react-btn.cta')
    expect(stylesText).toContain('app.css')

    await tab.styles.forcePseudoState('#react-btn', tab.snapshots, ['hover'])
    const hoveredStyles = await tab.styles.getStyles('#react-btn', tab.snapshots)
    expect(hoveredStyles.matchedRules.some((r) => r.selector.includes(':hover'))).toBe(true)
    await tab.styles.forcePseudoState('#react-btn', tab.snapshots, [])

    // 5. React Fiber Inspector
    const reactInfo = await tab.getReactInfo('#react-btn')
    expect(reactInfo?.componentName).toBe('CheckoutButton')
    expect(reactInfo?.source?.fileName).toBe('src/components/CheckoutButton.tsx')
    expect(reactInfo?.source?.lineNumber).toBe(42)
    expect(reactInfo?.hierarchy).toEqual(['CheckoutButton', 'CheckoutForm'])
    expect(reactInfo?.props.amount).toBe(99)
    expect(reactInfo?.props.onClick).toBe('[Function handlePay]')

    // 6. Live JS Debugger (breakpoint -> pause -> inspect local vars -> evaluate -> resume)
    await tab.debugger.enable()
    const scripts = tab.debugger.listScripts({ search: 'app.js' })
    expect(scripts.length).toBeGreaterThanOrEqual(1)
    const bp = await tab.debugger.setBreakpoint({ url: scripts[0].url, lineNumber: 3 })

    // Trigger function asynchronously (it will pause on line 3 before returning)
    const evalPromise = tab.page.evaluate<number>('window.runCalc(7)')
    const paused = await tab.debugger.waitForPause(5_000)
    expect(paused.paused).toBe(true)
    expect(paused.callFrames[0].functionName).toBe('computePrice')
    const vars = paused.callFrames[0].variables ?? []
    expect(vars.some((v) => v.name === 'qty' && v.value === '7')).toBe(true)
    expect(vars.some((v) => v.name === 'unit' && v.value === '10')).toBe(true)
    const frameEval = await tab.debugger.evaluateOnCallFrame(paused.callFrames[0].callFrameId, 'qty * unit + 5')
    expect(frameEval).toBe(75)
    await tab.debugger.resume()
    expect(await evalPromise).toBe(70)
    await tab.debugger.removeBreakpoint(bp.breakpointId)

    // 7. Live Script & CSS Editor (grep + in-memory live edit without page reload!)
    const hits = await tab.editor.grepScripts(/const unit = 10/)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    await tab.editor.editScript('app.js', 'const unit = 10;', 'const unit = 25;')
    expect(await tab.page.evaluate<number>('window.runCalc(4)')).toBe(100)

    const cssSheet = tab.styles.getStyleSheets().find((s) => s.sourceURL?.includes('app.css'))
    expect(cssSheet).toBeTruthy()
    await tab.editor.editStyleSheet(cssSheet!.styleSheetId, '#16a34a', '#9333ea')
    expect(
      await tab.page.evaluate<string>('getComputedStyle(document.getElementById("react-btn")).backgroundColor'),
    ).toBe('rgb(147, 51, 234)')

    // 8. Performance Metrics, Heap Summary, CPU Profiler & Tracing Insights
    const perfMetrics = await tab.performance.getMetrics()
    expect(perfMetrics.domNodes).toBeGreaterThan(0)
    const heap = await tab.performance.getHeapSummary()
    expect(heap.usedJSHeapSizeMB).toBeGreaterThan(0)

    await tab.performance.startCPUProfile()
    await tab.page.evaluate('window.burnCpu()')
    const cpu = await tab.performance.stopCPUProfile()
    expect(cpu.durationMs).toBeGreaterThan(0)

    await tab.performance.startTrace()
    await tab.page.evaluate('window.burnCpu()')
    const trace = await tab.performance.stopTrace()
    expect(trace.totalEvents).toBeGreaterThan(10)
    expect(trace.longTasks.length).toBeGreaterThanOrEqual(1)

    // 9. Video Screen Recording via CDP screencast + ffmpeg
    const videoPath = path.join(userDataDir, 'demo.mp4')
    await tab.recorder.start({ outputPath: videoPath, frameRate: 15 })
    await tab.page.click('#react-btn')
    await new Promise((r) => setTimeout(r, 300))
    const recResult = await tab.recorder.stop()
    expect(recResult.sizeBytes).toBeGreaterThan(1000)

    // 10. Multi-Session Stateful JS Sandbox
    const s1 = manager.createSession({ tabGroup: 'alpha' })
    const s2 = manager.createSession({ tabGroup: 'beta' })

    const r1 = await manager.exec(
      s1.id,
      `
      state.counter = 41;
      const t = await tabs.use(${tab.tabId});
      console.log('title:', (await t.page.getUrlAndTitle()).title);
      return state.counter + 1;
    `,
    )
    expect(r1.error).toBeUndefined()
    expect(r1.returnValue).toBe(42)
    expect(r1.stdout).toContain('title: BrowserPilot DevTools Lab')

    // State persists in s1, isolated from s2
    const r1b = await manager.exec(s1.id, `return state.counter`)
    const r2 = await manager.exec(s2.id, `return state.counter`)
    expect(r1b.returnValue).toBe(41)
    expect(r2.returnValue).toBeUndefined()

    await manager.closeTab(tab.tabId)
  }, 45_000)
})
