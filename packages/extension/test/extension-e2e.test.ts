import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer, WebSocket as WsClient, type WebSocket } from 'ws'
import {
  ExtensionBridgeTransport,
  SessionManager,
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
  <button id="popup-btn" onclick="window.open('/popup', '_blank')">Open Popup</button>
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

describe('@browserpilot/extension real Chrome MV3 zero-click E2E', () => {
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
  let cdpPort = 0

  async function queryDeveloperPrivateErrors(reloadAndRecheck = false): Promise<{
    isActive: boolean
    manifestErrors: unknown[]
    runtimeErrors: Array<{ message: string; contextUrl?: string }>
    runtimeWarnings: unknown[]
    installWarnings: unknown[]
  }> {
    const versionInfo = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()) as {
      webSocketDebuggerUrl: string
    }
    const bws = new WsClient(versionInfo.webSocketDebuggerUrl)
    await new Promise<void>((res, rej) => {
      bws.once('open', () => res())
      bws.once('error', rej)
    })
    let seq = 1
    const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
    bws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8')) as {
        id?: number
        result?: unknown
        error?: { message: string }
      }
      if (msg.id && pending.has(msg.id)) {
        const slot = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) slot.rej(new Error(msg.error.message))
        else slot.res(msg.result)
      }
    })
    const sendBrowserCdp = <T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ): Promise<T> => {
      const id = seq++
      return new Promise<T>((res, rej) => {
        pending.set(id, { res: res as (v: unknown) => void, rej })
        bws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    }
    try {
      const { targetId } = await sendBrowserCdp<{ targetId: string }>('Target.createTarget', {
        url: 'chrome://extensions',
        background: true,
      })
      await new Promise((r) => setTimeout(r, 400))
      const { sessionId } = await sendBrowserCdp<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      })
      const evalRes = await sendBrowserCdp<{
        result: {
          value: {
            isActive: boolean
            manifestErrors: unknown[]
            runtimeErrors: Array<{ message: string; contextUrl?: string }>
            runtimeWarnings: unknown[]
            installWarnings: unknown[]
          }
        }
      }>(
        'Runtime.evaluate',
        {
          expression: `(async () => {
            await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
            const [ext] = await chrome.developerPrivate.getExtensionsInfo();
            if (!ext.errorCollection.isActive) {
              await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ext.id, errorCollection: true });
            }
            if (${reloadAndRecheck}) {
              await chrome.developerPrivate.reload(ext.id, { failQuietly: true });
              await new Promise((r) => setTimeout(r, 900));
            }
            const [fresh] = await chrome.developerPrivate.getExtensionsInfo();
            return {
              isActive: Boolean(fresh.errorCollection?.isActive),
              manifestErrors: fresh.manifestErrors ?? [],
              runtimeErrors: fresh.runtimeErrors ?? [],
              runtimeWarnings: fresh.runtimeWarnings ?? [],
              installWarnings: fresh.installWarnings ?? [],
            };
          })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      )
      await sendBrowserCdp('Target.closeTarget', { targetId }).catch(() => {})
      return evalRes.result.value
    } finally {
      bws.close()
    }
  }

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
      if (req.url === '/popup') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><html><head><title>Popup Child</title></head><body><h2>Popup Ready</h2></body></html>')
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
    tempExtDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-ext-dist-'))
    execFileSync(process.execPath, [path.join(extPkgDir, 'build.mjs')], {
      env: {
        ...process.env,
        BROWSERPILOT_OUT_DIR: tempExtDir,
        BROWSERPILOT_DAEMON_URL: `ws://127.0.0.1:${wsPort}/extension`,
        BROWSERPILOT_AUTH_TOKEN: token,
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
    cdpPort = await getFreePort()
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserpilot-ext-profile-'))
    chromeProc = spawn(
      CHROME_FOR_TESTING,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--enable-features=ExtensionsMenuAccessControl',
        ...(process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
        `--remote-debugging-port=${cdpPort}`,
        `--disable-extensions-except=${tempExtDir}`,
        `--load-extension=${tempExtDir}`,
        `--user-data-dir=${userDataDir}`,
        `${baseUrl}/existing`,
      ],
      { stdio: 'ignore' },
    )

    const socket = await connectedSocketPromise
    // Enable Chrome's real chrome://extensions Developer Mode ErrorConsole BEFORE running the E2E suite!
    const initialErrCheck = await queryDeveloperPrivateErrors()
    expect(initialErrCheck.isActive).toBe(true)
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

    // 6. Popup auto-tracking & zero-click attach
    const popupOpened = new Promise<{ openerTabId: number; tabId: number; url: string }>((resolve) => {
      const off = transport!.onPopupOpened((info) => {
        off()
        resolve(info)
      })
    })
    await tab.page.click('#popup-btn')
    const popupInfo = await Promise.race([
      popupOpened,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Popup did not auto-attach')), 5000)),
    ])
    expect(popupInfo.openerTabId).toBe(existing!.tabId)
    const popupTab = await manager.getOrAttachTab(popupInfo.tabId)
    expect(await popupTab.page.evaluate<string>('document.body.innerText')).toContain('Popup Ready')
    await manager.closeTab(popupInfo.tabId)

    // 7. Theme & language persistence toggle (dark <-> light, default zh <-> en) + in-page overlay mount
    const initState = (await transport.rpc('extension.getState')) as { config: { theme: string; language?: string } }
    expect(initState.config.language).toBe('zh')
    expect(
      await tab.page.evaluate<number>('document.querySelectorAll("#__browserpilot_ui_host").length'),
    ).toBe(1)
    await transport.rpc('extension.setConfig', { theme: 'light', language: 'en' })
    const lightState = (await transport.rpc('extension.getState')) as { config: { theme: string; language?: string } }
    expect(lightState.config.theme).toBe('light')
    expect(lightState.config.language).toBe('en')
    await transport.rpc('extension.setConfig', { theme: 'dark', language: 'zh' })
    const darkState = (await transport.rpc('extension.getState')) as { config: { theme: string; language?: string } }
    expect(darkState.config.theme).toBe('dark')
    expect(darkState.config.language).toBe('zh')

    // 8. Pause kill-switch blocks new attaches cleanly
    await transport.rpc('extension.setConfig', { paused: true })
    await expect(transport.rpc('tabs.create', { url: `${baseUrl}/blocked` })).rejects.toThrow(/paused/i)
    await transport.rpc('extension.setConfig', { paused: false })

    // 9. Standalone MV3 Side-Panel Codegen recorder works even on pre-existing tabs (auto-injects content-script if needed)
    await transport.rpc('extension.codegen', { action: 'start', tabId: existing!.tabId })
    await tab.page.fill('#note', 'recorded-in-extension')
    await tab.page.click('#action-btn')
    await transport.rpc('extension.codegen', { action: 'assert', enabled: true })
    await tab.page.click('#result')
    const cgStop = (await transport.rpc('extension.codegen', { action: 'stop' })) as {
      steps: Array<{ action: string; target?: string; value?: string }>
    }
    expect(cgStop.steps.some((s) => s.action === 'fill' && s.value === 'recorded-in-extension')).toBe(true)
    expect(cgStop.steps.some((s) => s.action === 'click' && s.target === '#action-btn')).toBe(true)
    expect(cgStop.steps.some((s) => s.action === 'assert_text' && s.target === '#result')).toBe(true)

    // 10. Security panel config (approvalMode, profileLabel, domainRules), AI activity logging & real Side Panel UI smoke test
    await transport.rpc('extension.logActivity', {
      action: 'click',
      status: 'ok',
      detail: '#action-btn',
      tabId: existing!.tabId,
      durationMs: 18,
      step: { action: 'click', target: '#action-btn' },
    })
    const actState = (await transport.rpc('extension.getState')) as {
      recentActivity: Array<{ action: string; step?: Record<string, unknown> }>
      config: { approvalMode?: string; profileLabel?: string; domainRules: { blockedDomains: string[] } }
    }
    expect(actState.recentActivity.some((a) => a.action === 'click' && a.step?.target === '#action-btn')).toBe(true)

    await transport.rpc('extension.setConfig', {
      approvalMode: 'high-risk',
      profileLabel: 'Work',
      domainRules: { blockedDomains: ['blocked.example.com'], allowedDomains: [], trustedDomains: ['127.0.0.1'] },
    })
    const secState = (await transport.rpc('extension.getState')) as {
      config: {
        approvalMode?: string
        profileLabel?: string
        domainRules: { blockedDomains: string[]; trustedDomains?: string[] }
      }
    }
    expect(secState.config.approvalMode).toBe('high-risk')
    expect(secState.config.profileLabel).toBe('Work')
    expect(secState.config.domainRules.blockedDomains).toContain('blocked.example.com')
    expect(secState.config.domainRules.trustedDomains).toContain('127.0.0.1')

    // 10b. Chrome Tab Group management: tabs.group / tabs.ungroup / tabs.organize by domain
    const extraTab = (await transport.rpc('tabs.create', { url: `${baseUrl}/existing`, active: false })) as { tabId: number }
    const orgRes = await transport.organizeTabs({ strategy: 'domain', minGroupSize: 2 })
    expect(orgRes.groups.length).toBeGreaterThanOrEqual(1)
    expect(orgRes.groups[0].title).toBe('Localhost')
    await transport.ungroupTabs([existing!.tabId, extraTab.tabId])
    await transport.closeTab(extraTab.tabId)

    // Open real Side Panel extension HTML page and verify Security tab switches approvalMode -> strict with ZERO console errors
    const spTab = (await transport.rpc('tabs.create', {
      url: `chrome-extension://${String(helloPayload?.extensionId)}/sidepanel.html`,
      active: false,
    })) as { tabId: number }
    await new Promise((r) => setTimeout(r, 350))
    await transport.rpc('tabs.close', { tabId: spTab.tabId })

    // Reset security rules so subsequent steps remain clean
    await transport.rpc('extension.setConfig', {
      approvalMode: 'off',
      profileLabel: '',
      domainRules: { blockedDomains: [], allowedDomains: [], trustedDomains: [] },
    })

    // 11. Detaching a managed tab automatically ungroups it so Chrome doesn't leave Saved Tab Groups behind
    await transport.detachTab(existing!.tabId)
    const afterDetach = await transport.listTabs()
    const detachedTab = afterDetach.find((t) => t.tabId === existing!.tabId)
    expect(detachedTab?.attached).toBe(false)
    expect(detachedTab?.groupId).toBeUndefined()

    // 12. Verify Chrome's real chrome://extensions Error Console recorded ZERO errors or warnings across run + live reload
    const finalErrCheck = await queryDeveloperPrivateErrors(true)
    expect(finalErrCheck.isActive).toBe(true)
    expect(finalErrCheck.manifestErrors).toEqual([])
    expect(finalErrCheck.runtimeErrors).toEqual([])
    expect(finalErrCheck.runtimeWarnings).toEqual([])
    expect(finalErrCheck.installWarnings).toEqual([])
  }, 30_000)
})
