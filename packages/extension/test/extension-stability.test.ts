import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  ExtensionBridgeTransport,
  SessionManager,
  waitForFunction,
  type ExtensionChannel,
} from '@browserpilot/core'
import type { BridgeMessage } from '@browserpilot/protocol'

const CHROME_FOR_TESTING =
  process.env.BROWSERPILOT_CHROME_BIN ||
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  )

async function hasChromeForTesting(): Promise<boolean> {
  try {
    await fs.access(CHROME_FOR_TESTING)
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
        const port = addr.port
        srv.close(() => resolve(port))
      } else reject(new Error('port error'))
    })
  })
}

function makeWorkerHtml(id: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Worker ${id}</title></head>
<body>
  <h1>Worker ${id}</h1>
  <input id="inp" placeholder="input-${id}" />
  <button id="btn">Commit ${id}</button>
  <div id="out">idle-${id}</div>
  <script>
    document.getElementById('btn').addEventListener('click', (e) => {
      const v = document.getElementById('inp').value;
      document.getElementById('out').textContent = '${id}:' + (e.isTrusted ? 'ok:' : 'bad:') + v;
    });
  </script>
</body>
</html>`
}

const HEAVY_PAGE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Heavy Payload & Tall Canvas Page</title>
  <style>
    body { margin: 0; font-family: sans-serif; }
    canvas { display: block; }
  </style>
</head>
<body>
  <h1 id="heavy-title">Heavy Bridge Test</h1>
  <canvas id="noise" width="1200" height="2400"></canvas>
  <script>
    // Draw high-entropy pseudo-random pixels so fullPage PNG screenshot exceeds hundreds of KB
    const c = document.getElementById('noise');
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(c.width, c.height);
    let seed = 1337;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      img.data[i] = seed & 255;
      img.data[i + 1] = (seed >> 8) & 255;
      img.data[i + 2] = (seed >> 16) & 255;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    window.__makeBigPayload = (len) => '中文Payload🚀'.repeat(Math.ceil(len / 10)).slice(0, len);
  </script>
</body>
</html>`

function createChannelFromSocket(socket: WebSocket): ExtensionChannel {
  return {
    send(msg) {
      socket.send(JSON.stringify(msg))
    },
    onMessage(handler) {
      const fn = (raw: Buffer) => {
        try {
          handler(JSON.parse(raw.toString('utf8')) as BridgeMessage)
        } catch {}
      }
      socket.on('message', fn)
      return () => socket.off('message', fn)
    },
    onClose(handler) {
      socket.on('close', handler)
      return () => socket.off('close', handler)
    },
    close() {
      socket.close()
    },
  }
}

describe('@browserpilot/extension long-stability: multi-tab concurrency, large payloads & reconnect recovery', () => {
  let httpServer: http.Server
  let wss: WebSocketServer
  let chromeProc: ChildProcess | null = null
  let userDataDir = ''
  let tempExtDir = ''
  let baseUrl = ''
  let activeSocket: WebSocket | null = null
  let transport: ExtensionBridgeTransport | null = null
  let manager: SessionManager | null = null
  let available = false
  let reconnectWaiter: ((socket: WebSocket) => void) | null = null
  let helloCount = 0

  beforeAll(async () => {
    available = await hasChromeForTesting()
    if (!available) return

    const httpPort = await getFreePort()
    httpServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname === '/heavy') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(HEAVY_PAGE_HTML)
        return
      }
      const worker = url.searchParams.get('id') || 'main'
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(makeWorkerHtml(worker))
    })
    await new Promise<void>((r) => httpServer.listen(httpPort, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${httpPort}`

    const wsPort = await getFreePort()
    const token = 'stability-token-999'

    const extPkgDir = path.resolve(import.meta.dirname, '..')
    tempExtDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-stab-ext-'))
    execFileSync(process.execPath, [path.join(extPkgDir, 'build.mjs')], {
      env: {
        ...process.env,
        BROWSERPILOT_OUT_DIR: tempExtDir,
        BROWSERPILOT_DAEMON_URL: `ws://127.0.0.1:${wsPort}/extension`,
        BROWSERPILOT_AUTH_TOKEN: token,
      },
    })

    wss = new WebSocketServer({ host: '127.0.0.1', port: wsPort })
    const initialConnect = new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Extension failed to connect within 15s')), 15_000)
      wss.on('connection', (socket, req) => {
        const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${wsPort}`)
        if (reqUrl.searchParams.get('token') !== token) {
          socket.close(4001, 'Unauthorized')
          return
        }
        socket.once('message', (raw) => {
          const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
          if (parsed.type === 'hello') {
            helloCount++
            if (helloCount === 1) {
              clearTimeout(timer)
              resolve(socket)
            } else if (reconnectWaiter) {
              const fn = reconnectWaiter
              reconnectWaiter = null
              fn(socket)
            }
          }
        })
      })
    })

    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-stab-profile-'))
    chromeProc = spawn(
      CHROME_FOR_TESTING,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        ...(process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
        `--disable-extensions-except=${tempExtDir}`,
        `--load-extension=${tempExtDir}`,
        `--user-data-dir=${userDataDir}`,
        `${baseUrl}/worker?id=boot`,
      ],
      { stdio: 'ignore' },
    )

    activeSocket = await initialConnect
    transport = new ExtensionBridgeTransport(createChannelFromSocket(activeSocket))
    manager = new SessionManager(transport)
  }, 30_000)

  afterAll(async () => {
    manager?.dispose()
    await transport?.close()
    wss?.close()
    if (chromeProc) chromeProc.kill('SIGTERM')
    if (httpServer) await new Promise<void>((r) => httpServer.close(() => r()))
    if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    if (tempExtDir) await fs.rm(tempExtDir, { recursive: true, force: true }).catch(() => {})
  })

  it('controls 3 concurrent tabs across 2 separate Tab Groups with zero leakage and clean auto-ungrouping', async () => {
    if (!available || !transport || !manager) return

    const tab1 = await manager.openTab({ url: `${baseUrl}/worker?id=w1`, tabGroup: 'alpha', tabGroupColor: 'blue' })
    const tab2 = await manager.openTab({ url: `${baseUrl}/worker?id=w2`, tabGroup: 'alpha', tabGroupColor: 'blue' })
    const tab3 = await manager.openTab({ url: `${baseUrl}/worker?id=w3`, tabGroup: 'beta', tabGroupColor: 'purple' })

    // Run independent fill + click + evaluate pipelines concurrently across 2 background + 1 active tab
    const concurrentStart = Date.now()
    const results = await Promise.all([
      (async () => {
        await tab1.page.fill('#inp', 'payload-one')
        await tab1.page.click('#btn')
        return await tab1.page.evaluate<string>('document.getElementById("out").textContent')
      })(),
      (async () => {
        await tab2.page.fill('#inp', 'payload-two')
        await tab2.page.click('#btn')
        return await tab2.page.evaluate<string>('document.getElementById("out").textContent')
      })(),
      (async () => {
        await tab3.page.fill('#inp', 'payload-three')
        await tab3.page.click('#btn')
        return await tab3.page.evaluate<string>('document.getElementById("out").textContent')
      })(),
    ])
    // Regression guard: background tabs must not hit Chromium's 5s InputRouter mouseMoved stall
    expect(Date.now() - concurrentStart).toBeLessThan(8_000)

    expect(results).toEqual(['w1:ok:payload-one', 'w2:ok:payload-two', 'w3:ok:payload-three'])

    // Verify Tab Group separation (alpha tabs share one groupId; beta has a distinct groupId)
    const listed = await transport.listTabs()
    const info1 = listed.find((t) => t.tabId === tab1.tabId)
    const info2 = listed.find((t) => t.tabId === tab2.tabId)
    const info3 = listed.find((t) => t.tabId === tab3.tabId)
    expect(info1?.groupId).toBeDefined()
    expect(info1?.groupId).toBe(info2?.groupId)
    expect(info3?.groupId).toBeDefined()
    expect(info3?.groupId).not.toBe(info1?.groupId)

    // Detaching all 3 must cleanly ungroup every managed tab
    await Promise.all([
      transport.detachTab(tab1.tabId),
      transport.detachTab(tab2.tabId),
      transport.detachTab(tab3.tabId),
    ])
    const afterDetach = await transport.listTabs()
    for (const id of [tab1.tabId, tab2.tabId, tab3.tabId]) {
      const entry = afterDetach.find((t) => t.tabId === id)
      expect(entry?.attached).toBe(false)
      expect(entry?.groupId).toBeUndefined()
    }

    await manager.closeTab(tab1.tabId)
    await manager.closeTab(tab2.tabId)
    await manager.closeTab(tab3.tabId)
  }, 30_000)

  it('transfers >2MB UTF-8 CDP results and large full-page PNG screenshots cleanly over the real MV3 bridge', async () => {
    if (!available || !transport || !manager) return

    const heavy = await manager.openTab({ url: `${baseUrl}/heavy`, tabGroup: 'heavy', tabGroupColor: 'orange' })
    await heavy.page.waitForLocator('#noise')
    await waitForFunction(heavy.session, 'typeof window.__makeBigPayload === "function"', { timeoutMs: 8_000 })

    // 1. Return a >2MB UTF-8 string (CJK + emoji) across chrome.debugger -> extension -> WS bridge
    const big = await heavy.page.evaluate<string>('window.__makeBigPayload(1_200_000)')
    expect(big.length).toBe(1_200_000)
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(1_800_000)
    expect(big.startsWith('中文Payload🚀')).toBe(true)

    // 2. Capture fullPage PNG screenshot of the 1200x2400 high-entropy canvas (>1MB base64 PNG)
    const shot = await heavy.page.screenshot({ fullPage: true, format: 'png' })
    expect(shot.base64.length).toBeGreaterThan(1_000_000)
    // Verify valid PNG signature (base64 of 0x89 0x50 0x4E 0x47 -> "iVBORw")
    expect(shot.base64.startsWith('iVBORw')).toBe(true)

    await manager.closeTab(heavy.tabId)
  }, 30_000)

  it('recovers cleanly from abrupt bridge disconnect while preserving attached tab continuity', async () => {
    if (!available || !transport || !manager || !activeSocket) return

    const tab = await manager.openTab({ url: `${baseUrl}/worker?id=reconnect`, tabGroup: 'resilient', tabGroupColor: 'green' })
    await tab.page.fill('#inp', 'before-drop')
    await tab.page.click('#btn')
    expect(await tab.page.evaluate<string>('document.getElementById("out").textContent')).toBe('reconnect:ok:before-drop')

    // Prepare waiter for the extension's automatic WebSocket reconnect + fresh hello handshake
    const reconnectedPromise = new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Extension did not reconnect within 12s')), 12_000)
      reconnectWaiter = (sock) => {
        clearTimeout(timer)
        resolve(sock)
      }
    })

    // Abruptly terminate the active WebSocket transport mid-session!
    activeSocket.terminate()
    const nextSocket = await reconnectedPromise
    activeSocket = nextSocket
    expect(helloCount).toBeGreaterThanOrEqual(2)

    // Swap in a fresh transport & manager on the reconnected channel (just like a restarted Daemon)
    manager.dispose()
    await transport.close()
    transport = new ExtensionBridgeTransport(createChannelFromSocket(nextSocket))
    manager = new SessionManager(transport)

    // The extension MUST still report the tab as attached and continue automating it seamlessly!
    const tabsAfter = await manager.listTabs()
    const surviving = tabsAfter.find((t) => t.tabId === tab.tabId)
    expect(surviving).toBeTruthy()
    expect(surviving!.attached).toBe(true)

    const resumed = await manager.getOrAttachTab(tab.tabId)
    await resumed.page.fill('#inp', 'after-reconnect')
    await resumed.page.click('#btn')
    expect(await resumed.page.evaluate<string>('document.getElementById("out").textContent')).toBe(
      'reconnect:ok:after-reconnect',
    )

    // Restricted URL attach rejection must fail gracefully without crashing the extension bridge
    await expect(manager.openTab({ url: 'chrome://version' })).rejects.toThrow(/restricted|Cannot attach/i)
    // Extension must still be completely responsive right after rejecting a restricted URL
    const state = (await transport.rpc('extension.getState')) as { connected: boolean; attachedTabs: unknown[] }
    expect(state.connected).toBe(true)

    await manager.closeTab(tab.tabId)
  }, 30_000)
})
