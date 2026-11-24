import crypto from 'node:crypto'
import http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  DirectCDPTransport,
  ExtensionBridgeTransport,
  SessionManager,
  type CDPTransport,
  type ExtensionChannel,
} from '@browserpilot/core'
import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  BROWSERPILOT_VERSION,
  type BridgeMessage,
  type BrowserClientInfo,
  type ExtensionHelloMessage,
  type TabGroupColor,
} from '@browserpilot/protocol'
import { loadOrCreateDaemonConfig, writeDaemonRuntimeInfo, type DaemonConfigFile } from './config.js'
import { executeTool, type ToolRuntimeContext } from './tools.js'

interface ConnectedBackend {
  info: BrowserClientInfo
  transport: CDPTransport
  manager: SessionManager
}

export interface DaemonOptions {
  host?: string
  port?: number
  token?: string
  persistRuntime?: boolean
}

/**
 * Local BrowserPilot Daemon managing:
 * - Authenticated Extension WebSocket connections (direct WS or proxied from Native Messaging Host)
 * - Direct CDP browser connections (--remote-debugging-port)
 * - Stateful isolated sessions and unified HTTP API for CLI, MCP & SDK clients
 */
export class BrowserPilotDaemon {
  private httpServer: http.Server | null = null
  private wss: WebSocketServer | null = null
  private backends = new Map<string, ConnectedBackend>()
  private primaryClientId: string | null = null
  private config: DaemonConfigFile | null = null
  private startedAt = 0

  async start(options: DaemonOptions = {}): Promise<DaemonConfigFile> {
    const cfg =
      options.persistRuntime === false
        ? {
            host: options.host ?? DEFAULT_DAEMON_HOST,
            port: options.port ?? DEFAULT_DAEMON_PORT,
            token: options.token ?? crypto.randomBytes(24).toString('hex'),
          }
        : await loadOrCreateDaemonConfig(options)

    this.startedAt = Date.now()
    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res)
    })
    const wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${cfg.host}:${cfg.port}`)
      if (url.pathname !== '/extension') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      const queryToken = url.searchParams.get('token') || ''
      const headerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      const provided = queryToken || headerToken
      if (cfg.token && provided !== cfg.token) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleExtensionSocket(ws, url.searchParams.get('transport') === 'native' ? 'extension-native' : 'extension-ws')
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(cfg.port, cfg.host, () => {
        server.off('error', reject)
        resolve()
      })
    })

    const addr = server.address()
    const actualPort = addr && typeof addr === 'object' ? addr.port : cfg.port
    this.config = { ...cfg, port: actualPort, pid: process.pid, startedAt: this.startedAt }
    this.httpServer = server
    this.wss = wss

    if (options.persistRuntime !== false) {
      await writeDaemonRuntimeInfo(this.config)
    }
    return this.config
  }

  getConfig(): DaemonConfigFile {
    if (!this.config) throw new Error('Daemon not started')
    return this.config
  }

  private handleExtensionSocket(ws: WebSocket, defaultTransport: 'extension-ws' | 'extension-native'): void {
    const clientId = `ext_${crypto.randomBytes(4).toString('hex')}`
    let registered = false

    const channel: ExtensionChannel = {
      send(msg) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
      },
      onMessage(handler) {
        const fn = (raw: Buffer) => {
          try {
            const parsed = JSON.parse(raw.toString('utf8')) as BridgeMessage
            if (parsed.type === 'hello') return
            handler(parsed)
          } catch {}
        }
        ws.on('message', fn)
        return () => ws.off('message', fn)
      },
      onClose(handler) {
        ws.on('close', handler)
        return () => ws.off('close', handler)
      },
      close() {
        ws.close()
      },
    }

    const register = (hello?: Partial<ExtensionHelloMessage>) => {
      if (registered) return
      registered = true
      const transport = new ExtensionBridgeTransport(channel)
      const manager = new SessionManager(transport)
      const now = Date.now()
      const info: BrowserClientInfo = {
        clientId,
        transport: hello?.transport === 'native' ? 'extension-native' : defaultTransport,
        browser: hello?.browser || 'Chrome',
        extensionId: hello?.extensionId,
        extensionVersion: hello?.extensionVersion,
        profileEmail: hello?.profileEmail,
        connectedAt: now,
        lastSeenAt: now,
        attachedTabCount: 0,
      }
      this.backends.set(clientId, { info, transport, manager })
      this.primaryClientId = clientId

      // Confirm end-to-end daemon handshake immediately so extension knows bridge is live
      if (ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'event',
            event: 'bridge.ready',
            params: { version: BROWSERPILOT_VERSION, clientId },
          }),
        )
      }

      ws.on('close', () => {
        manager.dispose()
        this.backends.delete(clientId)
        if (this.primaryClientId === clientId) {
          this.primaryClientId = Array.from(this.backends.keys()).pop() ?? null
        }
      })
    }

    ws.once('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as BridgeMessage
        if (parsed.type === 'hello') {
          register(parsed)
          return
        }
      } catch {}
      register()
    })

    ws.on('message', () => {
      const b = this.backends.get(clientId)
      if (b) b.info.lastSeenAt = Date.now()
    })
  }

  async connectDirectCDP(endpoint: string): Promise<BrowserClientInfo> {
    const transport = await DirectCDPTransport.connect(endpoint)
    const manager = new SessionManager(transport)
    const clientId = `cdp_${crypto.randomBytes(4).toString('hex')}`
    const now = Date.now()
    const info: BrowserClientInfo = {
      clientId,
      transport: 'direct-cdp',
      browser: `Chromium (${endpoint})`,
      connectedAt: now,
      lastSeenAt: now,
      attachedTabCount: 0,
    }
    this.backends.set(clientId, { info, transport, manager })
    this.primaryClientId = clientId
    return info
  }

  listClients(): BrowserClientInfo[] {
    return Array.from(this.backends.values()).map((b) => ({
      ...b.info,
      attachedTabCount: b.manager.getAttachedTabCount(),
    }))
  }

  getManager(clientId?: string): SessionManager {
    const targetId = clientId ?? this.primaryClientId
    if (!targetId) {
      throw new Error(
        'No browser connected to BrowserPilot daemon. Load the BrowserPilot Chrome extension or connect via --cdp <url>.',
      )
    }
    const backend = this.backends.get(targetId)
    if (!backend) throw new Error(`Browser client "${targetId}" is not connected`)
    return backend.manager
  }

  createToolContext(): ToolRuntimeContext {
    return {
      getManager: (clientId?: string) => this.getManager(clientId),
      listClients: () => this.listClients(),
    }
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const cfg = this.config!
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (cfg.token && auth !== cfg.token) {
      this.sendJson(res, 401, { error: 'Unauthorized' })
      return
    }

    const url = new URL(req.url || '/', `http://${cfg.host}:${cfg.port}`)
    const method = req.method || 'GET'

    try {
      if (method === 'GET' && url.pathname === '/api/health') {
        this.sendJson(res, 200, {
          ok: true,
          version: BROWSERPILOT_VERSION,
          pid: process.pid,
          uptimeMs: Date.now() - this.startedAt,
          clients: this.listClients(),
        })
        return
      }

      if (method === 'POST' && url.pathname === '/api/connect-cdp') {
        const body = await this.readJsonBody(req)
        const info = await this.connectDirectCDP(String(body.endpoint ?? 'http://127.0.0.1:9222'))
        this.sendJson(res, 200, { ok: true, client: info })
        return
      }

      if (method === 'POST' && url.pathname === '/api/sessions') {
        const body = await this.readJsonBody(req)
        const mgr = this.getManager(body.clientId as string | undefined)
        const sess = mgr.createSession({
          id: body.id as string | undefined,
          tabGroup: body.tabGroup as string | undefined,
          tabGroupColor: body.tabGroupColor as TabGroupColor | undefined,
        })
        this.sendJson(res, 200, { ok: true, session: sess })
        return
      }

      if (method === 'GET' && url.pathname === '/api/sessions') {
        const mgr = this.getManager(url.searchParams.get('clientId') || undefined)
        this.sendJson(res, 200, { ok: true, sessions: mgr.listSessions() })
        return
      }

      if (method === 'POST' && url.pathname === '/api/sessions/reset') {
        const body = await this.readJsonBody(req)
        const mgr = this.getManager(body.clientId as string | undefined)
        const sess = mgr.resetSession(String(body.id))
        this.sendJson(res, 200, { ok: true, session: sess })
        return
      }

      if (method === 'POST' && url.pathname === '/api/sessions/close') {
        const body = await this.readJsonBody(req)
        const mgr = this.getManager(body.clientId as string | undefined)
        const deleted = mgr.deleteSession(String(body.id))
        this.sendJson(res, 200, { ok: true, deleted })
        return
      }

      if (method === 'POST' && url.pathname === '/api/tool') {
        const body = await this.readJsonBody(req)
        const result = await executeTool(
          this.createToolContext(),
          String(body.name),
          (body.args as Record<string, unknown>) ?? {},
        )
        this.sendJson(res, 200, result)
        return
      }

      if (method === 'POST' && url.pathname === '/api/shutdown') {
        this.sendJson(res, 200, { ok: true })
        setTimeout(() => void this.stop(), 50)
        return
      }

      this.sendJson(res, 404, { error: `Unknown endpoint ${method} ${url.pathname}` })
    } catch (err) {
      this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
  }

  async stop(): Promise<void> {
    for (const b of this.backends.values()) {
      b.manager.dispose()
      await b.transport.close().catch(() => {})
    }
    this.backends.clear()
    this.primaryClientId = null
    this.wss?.close()
    if (this.httpServer) {
      await new Promise<void>((r) => this.httpServer!.close(() => r()))
      this.httpServer = null
    }
  }
}
