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
  type ExtensionChannel,
} from '@devpilot/core'
import type { BridgeMessage } from '@devpilot/protocol'

const CHROME_FOR_TESTING = path.join(
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

const EXISTING_PAGE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Zero-Click Existing Tab</title>
  <style>
    #action-btn { background: #059669; color: white; padding: 10px 16px; border: none; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>Already Open Tab</h1>
  <input id="note" placeholder="Write note" />
  <button id="action-btn">Run Action</button>
  <div id="result">initial</div>
  <script>
    document.getElementById('action-btn').addEventListener('click', async (e) => {
      console.log('ext-btn-clicked', e.isTrusted);
      const r = await fetch('/api/ping');
      const data = await r.json();
      document.getElementById('result').textContent =
        (e.isTrusted ? 'trusted:' : 'untrusted:') +
        document.getElementById('note').value + ':' + data.pong;
    });
  </script>
</body>
</html>`

describe('@devpilot/extension real Chrome MV3 zero-click E2E', () => {
  let httpServer: http.Server
  let wss: WebSocketServer
  let chromeProc: ChildProcess | null = null
  let userDataDir = ''
  let tempExtDir = ''
  let baseUrl = ''
  let transport: ExtensionBridgeTransport | null = null
  let manager: SessionManager | null = null
  let available = false
  let helloPayload: Record<string, unknown> | null = null

  beforeAll(async () => {
    available = await hasChromeForTesting()
    if (!available) return

    const httpPort = await getFreePort()
    httpServer = http.createServer((req, res) => {
      if (req.url === '/api/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ pong: 'ok-from-extension-e2e' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(EXISTING_PAGE_HTML)
    })
    await new Promise<void>((r) => httpServer.listen(httpPort, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${httpPort}`

    const wsPort = await getFreePort()
    const token = 'test-secret-token-123'

    // Build extension directly into isolated temp dir so shared dist/ is never mutated
    const extPkgDir = path.resolve(import.meta.dirname, '..')
    tempExtDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpilot-ext-dist-'))
    execFileSync(process.execPath, [path.join(extPkgDir, 'build.mjs')], {
      env: {
        ...process.env,
        DEVPILOT_OUT_DIR: tempExtDir,
        DEVPILOT_DAEMON_URL: `ws://127.0.0.1:${wsPort}/extension`,
        DEVPILOT_AUTH_TOKEN: token,
      },
    })

    // Start test WebSocket bridge server waiting for real extension connection
    wss = new WebSocketServer({ host: '127.0.0.1', port: wsPort })
    const connectedSocketPromise = new Promise<WebSocket>((resolve, reject) => {
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
            helloPayload = parsed
            clearTimeout(timer)
            resolve(socket)
          }
        })
      })
    })

    // Launch real Google Chrome for Testing with the compiled MV3 extension loaded and an already-open tab!
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpilot-ext-profile-'))
    chromeProc = spawn(
      CHROME_FOR_TESTING,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        `--disable-extensions-except=${tempExtDir}`,
        `--load-extension=${tempExtDir}`,
        `--user-data-dir=${userDataDir}`,
        `${baseUrl}/existing`,
      ],
      { stdio: 'ignore' },
    )

    const socket = await connectedSocketPromise
    const channel: ExtensionChannel = {
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

    transport = new ExtensionBridgeTransport(channel)
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

  it('auto-attaches to an already-open tab with ZERO user clicks and executes full CDP automation & DevTools debugging', async () => {
    if (!available || !transport || !manager) return

    expect(helloPayload?.type).toBe('hello')
    expect(helloPayload?.extensionId).toBeTruthy()

    // 1. Discover the already-open tab (opened before any command, never clicked!)
    const tabs = await manager.listTabs()
    const existing = tabs.find((t) => t.url.includes('/existing'))
    expect(existing).toBeTruthy()
    expect(existing!.attached).toBe(false)

    // 2. Zero-click auto-attach & snapshot!
    const tab = await manager.getOrAttachTab(existing!.tabId, { tabGroup: 'e2e', tabGroupColor: 'cyan' })
    const snap = await tab.snapshots.capture(tab.session)
    expect(snap.text).toContain('Already Open Tab')

    const inputRef = Object.values(snap.refs).find((r) => r.role === 'textbox')?.ref
    const btnRef = Object.values(snap.refs).find((r) => r.role === 'button' && r.name === 'Run Action')?.ref
    expect(inputRef).toBeTruthy()
    expect(btnRef).toBeTruthy()

    // 3. Trusted CDP fill + click + verify Console & Network capture via real chrome.debugger!
    await tab.page.fill(inputRef!, 'zero-click-works')
    await tab.page.click(btnRef!)
    await new Promise((r) => setTimeout(r, 250))

    expect(await tab.page.evaluate<string>('document.getElementById("result").textContent')).toBe(
      'trusted:zero-click-works:ok-from-extension-e2e',
    )

    const logs = tab.console.getLogs()
    expect(logs.some((l) => l.text.includes('ext-btn-clicked') && l.text.includes('true'))).toBe(true)

    const reqs = tab.network.getRequests({ search: '/api/ping' })
    expect(reqs.length).toBeGreaterThanOrEqual(1)
    const body = await tab.network.getResponseBody(reqs[reqs.length - 1].requestId)
    expect(JSON.parse(body.body)).toEqual({ pong: 'ok-from-extension-e2e' })

    // 4. CSS matched styles via real chrome.debugger
    const styles = await tab.styles.getStyles('#action-btn', tab.snapshots)
    expect(styles.matchedRules.some((r) => r.selector.includes('#action-btn'))).toBe(true)

    // 5. Screenshot via real chrome.debugger
    const shot = await tab.page.screenshot()
    expect(shot.base64.length).toBeGreaterThan(500)

    // 6. Pause kill-switch blocks new attaches cleanly
    await transport.rpc('extension.setConfig', { paused: true })
    await expect(transport.rpc('tabs.create', { url: `${baseUrl}/blocked` })).rejects.toThrow(/paused/i)
    await transport.rpc('extension.setConfig', { paused: false })
  }, 30_000)
})
