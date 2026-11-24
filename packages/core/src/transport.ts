import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import {
  DEFAULT_CDP_TIMEOUT_MS,
  isBlockedProfileWideCommand,
  type BoundingBox,
  type SomLabelItem,
  type TabGroupColor,
  type TabInfo,
} from '@browserpilot/protocol'

export interface CDPEventPacket {
  tabId: number
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

export interface CDPSendOptions {
  sessionId?: string
  timeoutMs?: number
  allowUnsafeBrowserWide?: boolean
}

export interface CreateTabOptions {
  url?: string
  active?: boolean
  tabGroup?: string
  tabGroupColor?: TabGroupColor
}

export interface AttachTabOptions {
  tabGroup?: string
  tabGroupColor?: TabGroupColor
}

export interface CDPTransport {
  readonly mode: 'direct-cdp' | 'extension'
  send<T = Record<string, unknown>>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    options?: CDPSendOptions,
  ): Promise<T>
  sendBrowser?<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>
  onEvent(listener: (event: CDPEventPacket) => void): () => void
  onTabDetached?(listener: (tabId: number, reason: string) => void): () => void
  onPopupOpened?(listener: (info: { openerTabId: number; tabId: number; url: string }) => void): () => void
  listTabs(): Promise<TabInfo[]>
  createTab(options?: CreateTabOptions): Promise<TabInfo>
  closeTab(tabId: number): Promise<void>
  activateTab(tabId: number): Promise<void>
  attachTab(tabId: number, options?: AttachTabOptions): Promise<TabInfo>
  detachTab(tabId: number): Promise<void>
  highlightElement?(tabId: number, box: BoundingBox, label?: string): Promise<void>
  showSomLabels?(tabId: number, labels: SomLabelItem[]): Promise<void>
  hideSomLabels?(tabId: number): Promise<void>
  moveGhostCursor?(tabId: number, x: number, y: number, clicking?: boolean): Promise<void>
  getPinnedElement?(tabId: number): Promise<{ globalVar?: string; url?: string } | null>
  close(): Promise<void>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

interface DirectTargetRecord {
  tabId: number
  targetId: string
  sessionId: string
  url: string
  title: string
}

/**
 * Pure-CDP Direct WebSocket transport connecting directly to Chrome's
 * --remote-debugging-port (e.g. http://127.0.0.1:9222 or ws://...).
 */
export class DirectCDPTransport implements CDPTransport {
  readonly mode = 'direct-cdp' as const
  private ws: WebSocket | null = null
  private nextId = 1
  private nextTabId = 1
  private pending = new Map<number, PendingRequest>()
  private events = new EventEmitter()
  private targetsByTabId = new Map<number, DirectTargetRecord>()
  private tabIdByTargetId = new Map<string, number>()
  private tabIdBySessionId = new Map<string, number>()
  private childSessionsByParentTab = new Map<number, Set<string>>()
  private activeTabId: number | undefined
  private wsUrl: string

  private constructor(wsUrl: string) {
    this.wsUrl = wsUrl
    this.events.setMaxListeners(100)
  }

  static async connect(endpoint: string): Promise<DirectCDPTransport> {
    const wsUrl = await resolveBrowserWebSocketUrl(endpoint)
    const transport = new DirectCDPTransport(wsUrl)
    await transport.open()
    return transport
  }

  private async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, { perMessageDeflate: false })
      this.ws = ws
      const onError = (err: Error) => {
        ws.off('open', onOpen)
        reject(new Error(`Failed to connect to CDP endpoint ${this.wsUrl}: ${err.message}`))
      }
      const onOpen = () => {
        ws.off('error', onError)
        resolve()
      }
      ws.once('error', onError)
      ws.once('open', onOpen)
      ws.on('message', (raw) => this.handleMessage(raw.toString('utf8')))
      ws.on('close', () => {
        for (const [, req] of this.pending) {
          clearTimeout(req.timer)
          req.reject(new Error(`CDP WebSocket closed while awaiting ${req.method}`))
        }
        this.pending.clear()
      })
    })

    // Discover existing page targets
    await this.sendRaw('Target.setDiscoverTargets', { discover: true })
    await this.syncTargets()
  }

  private handleMessage(raw: string): void {
    let msg: {
      id?: number
      result?: unknown
      error?: { code?: number; message?: string }
      method?: string
      params?: Record<string, unknown>
      sessionId?: string
    }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.error) {
        pending.reject(new Error(`CDP ${pending.method} failed: ${msg.error.message ?? JSON.stringify(msg.error)}`))
      } else {
        pending.resolve(msg.result ?? {})
      }
      return
    }

    if (!msg.method) return
    const params = msg.params ?? {}

    // Track target lifecycle
    if (msg.method === 'Target.targetInfoChanged' && params.targetInfo) {
      const info = params.targetInfo as { targetId: string; url?: string; title?: string; type?: string }
      const tabId = this.tabIdByTargetId.get(info.targetId)
      if (tabId !== undefined) {
        const rec = this.targetsByTabId.get(tabId)
        if (rec) {
          if (typeof info.url === 'string') rec.url = info.url
          if (typeof info.title === 'string') rec.title = info.title
        }
      }
    } else if (msg.method === 'Target.targetDestroyed' && typeof params.targetId === 'string') {
      const tabId = this.tabIdByTargetId.get(params.targetId)
      if (tabId !== undefined) {
        const rec = this.targetsByTabId.get(tabId)
        if (rec) {
          this.tabIdBySessionId.delete(rec.sessionId)
        }
        const children = this.childSessionsByParentTab.get(tabId)
        if (children) {
          for (const sid of children) this.tabIdBySessionId.delete(sid)
          this.childSessionsByParentTab.delete(tabId)
        }
        this.targetsByTabId.delete(tabId)
        this.tabIdByTargetId.delete(params.targetId)
        this.events.emit('tab-detached', tabId, 'target_destroyed')
      }
    } else if (msg.method === 'Target.attachedToTarget' && typeof params.sessionId === 'string') {
      const parentSessionId = msg.sessionId
      const parentTabId = parentSessionId ? this.tabIdBySessionId.get(parentSessionId) : undefined
      if (parentTabId !== undefined) {
        this.tabIdBySessionId.set(params.sessionId, parentTabId)
        let children = this.childSessionsByParentTab.get(parentTabId)
        if (!children) {
          children = new Set()
          this.childSessionsByParentTab.set(parentTabId, children)
        }
        children.add(params.sessionId)
      }
    } else if (msg.method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string') {
      const parentTabId = this.tabIdBySessionId.get(params.sessionId)
      if (parentTabId !== undefined) {
        const rec = this.targetsByTabId.get(parentTabId)
        if (rec && rec.sessionId !== params.sessionId) {
          this.tabIdBySessionId.delete(params.sessionId)
          this.childSessionsByParentTab.get(parentTabId)?.delete(params.sessionId)
        }
      }
    }

    if (msg.sessionId) {
      const tabId = this.tabIdBySessionId.get(msg.sessionId)
      if (tabId !== undefined) {
        const rec = this.targetsByTabId.get(tabId)
        const childSessionId = rec && rec.sessionId !== msg.sessionId ? msg.sessionId : undefined
        this.events.emit('cdp-event', {
          tabId,
          method: msg.method,
          params,
          sessionId: childSessionId,
        } satisfies CDPEventPacket)
      }
    } else {
      // Browser-level event (e.g., Tracing.dataCollected / Tracing.tracingComplete)
      this.events.emit('cdp-event', {
        tabId: 0,
        method: msg.method,
        params,
      } satisfies CDPEventPacket)
    }
  }

  private async sendRaw<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs: number = DEFAULT_CDP_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`CDP WebSocket is not connected (cannot call ${method})`)
    }
    const id = this.nextId++
    const payload: Record<string, unknown> = { id, method }
    if (params && Object.keys(params).length > 0) payload.params = params
    if (sessionId) payload.sessionId = sessionId

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method,
      })
      this.ws!.send(JSON.stringify(payload), (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  private async syncTargets(): Promise<void> {
    const res = await this.sendRaw<{
      targetInfos: Array<{ targetId: string; type: string; title: string; url: string; attached: boolean }>
    }>('Target.getTargets')
    for (const info of res.targetInfos) {
      if (info.type !== 'page') continue
      if (!this.tabIdByTargetId.has(info.targetId)) {
        const tabId = this.nextTabId++
        this.tabIdByTargetId.set(info.targetId, tabId)
        this.targetsByTabId.set(tabId, {
          tabId,
          targetId: info.targetId,
          sessionId: '',
          url: info.url,
          title: info.title,
        })
        if (this.activeTabId === undefined) this.activeTabId = tabId
      } else {
        const tabId = this.tabIdByTargetId.get(info.targetId)!
        const rec = this.targetsByTabId.get(tabId)
        if (rec) {
          rec.url = info.url
          rec.title = info.title
        }
      }
    }
  }

  private async ensureAttached(tabId: number): Promise<DirectTargetRecord> {
    let rec = this.targetsByTabId.get(tabId)
    if (!rec) {
      await this.syncTargets()
      rec = this.targetsByTabId.get(tabId)
    }
    if (!rec) {
      throw new Error(`Tab ${tabId} not found`)
    }
    if (!rec.sessionId) {
      const attached = await this.sendRaw<{ sessionId: string }>('Target.attachToTarget', {
        targetId: rec.targetId,
        flatten: true,
      })
      rec.sessionId = attached.sessionId
      this.tabIdBySessionId.set(rec.sessionId, tabId)
      // Enable OOPIF child frame auto-attach
      await this.sendRaw(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        rec.sessionId,
      ).catch(() => {})
    }
    return rec
  }

  async send<T = Record<string, unknown>>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    options?: CDPSendOptions,
  ): Promise<T> {
    if (!options?.allowUnsafeBrowserWide && isBlockedProfileWideCommand(method)) {
      throw new Error(
        `Blocked destructive profile-wide CDP command "${method}". Use page-scoped cookie deletion instead.`,
      )
    }
    const rec = await this.ensureAttached(tabId)
    const targetSessionId = options?.sessionId ?? rec.sessionId
    return await this.sendRaw<T>(method, params, targetSessionId, options?.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS)
  }

  async sendBrowser<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = DEFAULT_CDP_TIMEOUT_MS,
  ): Promise<T> {
    if (isBlockedProfileWideCommand(method)) {
      throw new Error(`Blocked destructive profile-wide CDP command "${method}".`)
    }
    return await this.sendRaw<T>(method, params, undefined, timeoutMs)
  }

  onEvent(listener: (event: CDPEventPacket) => void): () => void {
    this.events.on('cdp-event', listener)
    return () => this.events.off('cdp-event', listener)
  }

  onTabDetached(listener: (tabId: number, reason: string) => void): () => void {
    this.events.on('tab-detached', listener)
    return () => this.events.off('tab-detached', listener)
  }

  async listTabs(): Promise<TabInfo[]> {
    await this.syncTargets()
    const list: TabInfo[] = []
    for (const rec of this.targetsByTabId.values()) {
      list.push({
        tabId: rec.tabId,
        targetId: rec.targetId,
        url: rec.url,
        title: rec.title,
        active: rec.tabId === this.activeTabId,
        attached: Boolean(rec.sessionId),
      })
    }
    return list
  }

  async createTab(options?: CreateTabOptions): Promise<TabInfo> {
    const url = options?.url || 'about:blank'
    const { targetId } = await this.sendRaw<{ targetId: string }>('Target.createTarget', { url })
    const tabId = this.nextTabId++
    const rec: DirectTargetRecord = {
      tabId,
      targetId,
      sessionId: '',
      url,
      title: '',
    }
    this.targetsByTabId.set(tabId, rec)
    this.tabIdByTargetId.set(targetId, tabId)
    if (options?.active !== false) {
      this.activeTabId = tabId
      await this.sendRaw('Target.activateTarget', { targetId }).catch(() => {})
    }
    await this.ensureAttached(tabId)
    return {
      tabId,
      targetId,
      url: rec.url,
      title: rec.title,
      active: tabId === this.activeTabId,
      attached: true,
    }
  }

  async closeTab(tabId: number): Promise<void> {
    const rec = this.targetsByTabId.get(tabId)
    if (!rec) return
    await this.sendRaw('Target.closeTarget', { targetId: rec.targetId }).catch(() => {})
    if (rec.sessionId) this.tabIdBySessionId.delete(rec.sessionId)
    this.targetsByTabId.delete(tabId)
    this.tabIdByTargetId.delete(rec.targetId)
  }

  async activateTab(tabId: number): Promise<void> {
    const rec = this.targetsByTabId.get(tabId)
    if (!rec) throw new Error(`Tab ${tabId} not found`)
    this.activeTabId = tabId
    await this.sendRaw('Target.activateTarget', { targetId: rec.targetId })
  }

  async attachTab(tabId: number): Promise<TabInfo> {
    const rec = await this.ensureAttached(tabId)
    return {
      tabId: rec.tabId,
      targetId: rec.targetId,
      url: rec.url,
      title: rec.title,
      active: rec.tabId === this.activeTabId,
      attached: true,
    }
  }

  async detachTab(tabId: number): Promise<void> {
    const rec = this.targetsByTabId.get(tabId)
    if (!rec || !rec.sessionId) return
    await this.sendRaw('Target.detachFromTarget', { sessionId: rec.sessionId }).catch(() => {})
    this.tabIdBySessionId.delete(rec.sessionId)
    rec.sessionId = ''
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.events.removeAllListeners()
  }
}

export async function resolveBrowserWebSocketUrl(endpoint: string): Promise<string> {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return trimmed
  }
  const base = trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `http://${trimmed}`
  const res = await fetch(`${base}/json/version`)
  if (!res.ok) {
    throw new Error(`Failed to fetch ${base}/json/version: HTTP ${res.status}`)
  }
  const data = (await res.json()) as { webSocketDebuggerUrl?: string }
  if (!data.webSocketDebuggerUrl) {
    throw new Error(`No webSocketDebuggerUrl returned by ${base}/json/version`)
  }
  return data.webSocketDebuggerUrl
}
