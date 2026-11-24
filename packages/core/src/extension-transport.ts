import { EventEmitter } from 'node:events'
import {
  DEFAULT_CDP_TIMEOUT_MS,
  isBlockedProfileWideCommand,
  type BoundingBox,
  type BridgeEvent,
  type BridgeMessage,
  type BridgeRequest,
  type BridgeResponse,
  type DownloadEntry,
  type TabInfo,
} from '@browserpilot/protocol'
import type { AttachTabOptions, CDPEventPacket, CDPSendOptions, CDPTransport, CreateTabOptions } from './transport.js'

export interface ExtensionChannel {
  send(message: BridgeMessage): void
  onMessage(handler: (message: BridgeMessage) => void): () => void
  onClose(handler: () => void): () => void
  close(): void
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

/**
 * CDPTransport implementation communicating with the BrowserPilot Chrome MV3 Extension
 * over either Chrome Native Messaging or Authenticated Local WebSocket.
 */
export class ExtensionBridgeTransport implements CDPTransport {
  readonly mode = 'extension' as const
  private channel: ExtensionChannel
  private nextId = 1
  private pending = new Map<string, PendingRpc>()
  private events = new EventEmitter()
  private unsubMsg: () => void
  private unsubClose: () => void

  constructor(channel: ExtensionChannel) {
    this.channel = channel
    this.events.setMaxListeners(100)

    this.unsubMsg = channel.onMessage((msg) => this.handleMessage(msg))
    this.unsubClose = channel.onClose(() => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`Extension bridge closed while awaiting ${p.method}`))
      }
      this.pending.clear()
      this.events.emit('closed')
    })
  }

  private handleMessage(msg: BridgeMessage): void {
    if (msg.type === 'ping') {
      this.channel.send({ type: 'pong', ts: msg.ts })
      return
    }
    if (msg.type === 'response') {
      const res = msg as BridgeResponse
      const p = this.pending.get(res.id)
      if (!p) return
      this.pending.delete(res.id)
      clearTimeout(p.timer)
      if (res.ok) p.resolve(res.result)
      else p.reject(new Error(res.error?.message || `Extension RPC ${p.method} failed`))
      return
    }
    if (msg.type === 'event') {
      const ev = msg as BridgeEvent
      const params = ev.params ?? {}
      if (ev.event === 'cdp.event') {
        this.events.emit('cdp-event', {
          tabId: Number(params.tabId),
          method: String(params.method),
          params: (params.params as Record<string, unknown>) ?? {},
          sessionId: params.sessionId as string | undefined,
        } satisfies CDPEventPacket)
      } else if (ev.event === 'tab.detached') {
        this.events.emit('tab-detached', Number(params.tabId), String(params.reason ?? 'detached'))
      } else if (ev.event === 'popup.opened') {
        this.events.emit('popup-opened', {
          openerTabId: Number(params.openerTabId),
          tabId: Number(params.tabId),
          url: String(params.url ?? ''),
        })
      } else if (ev.event === 'download.updated' && params.download) {
        this.events.emit('download-event', params.download as DownloadEntry)
      }
      this.events.emit('extension-event', ev)
    }
  }

  async rpc<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = DEFAULT_CDP_TIMEOUT_MS): Promise<T> {
    const id = `rpc_${this.nextId++}`
    const req: BridgeRequest = { type: 'request', id, method, params }

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Extension RPC "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method,
      })
      try {
        this.channel.send(req)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
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
    return await this.rpc<T>(
      'cdp.send',
      {
        tabId,
        method,
        params,
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options?.allowUnsafeBrowserWide ? { allowUnsafeBrowserWide: true } : {}),
      },
      options?.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS,
    )
  }

  onEvent(listener: (event: CDPEventPacket) => void): () => void {
    this.events.on('cdp-event', listener)
    return () => this.events.off('cdp-event', listener)
  }

  onTabDetached(listener: (tabId: number, reason: string) => void): () => void {
    this.events.on('tab-detached', listener)
    return () => this.events.off('tab-detached', listener)
  }

  onPopupOpened(listener: (info: { openerTabId: number; tabId: number; url: string }) => void): () => void {
    this.events.on('popup-opened', listener)
    return () => this.events.off('popup-opened', listener)
  }

  onDownloadEvent(listener: (entry: DownloadEntry) => void): () => void {
    this.events.on('download-event', listener)
    return () => this.events.off('download-event', listener)
  }

  async listDownloads(): Promise<DownloadEntry[]> {
    const res = await this.rpc<{ downloads: DownloadEntry[] }>('downloads.list')
    return res.downloads ?? []
  }

  onClose(listener: () => void): () => void {
    this.events.on('closed', listener)
    return () => this.events.off('closed', listener)
  }

  async listTabs(): Promise<TabInfo[]> {
    const res = await this.rpc<{ tabs: TabInfo[] }>('tabs.list')
    return res.tabs ?? []
  }

  async createTab(options?: CreateTabOptions): Promise<TabInfo> {
    return await this.rpc<TabInfo>('tabs.create', options as Record<string, unknown>)
  }

  async closeTab(tabId: number): Promise<void> {
    await this.rpc('tabs.close', { tabId })
  }

  async activateTab(tabId: number): Promise<void> {
    await this.rpc('tabs.activate', { tabId })
  }

  async attachTab(tabId: number, options?: AttachTabOptions): Promise<TabInfo> {
    return await this.rpc<TabInfo>('tabs.attach', { tabId, ...options })
  }

  async detachTab(tabId: number): Promise<void> {
    await this.rpc('tabs.detach', { tabId })
  }

  async highlightElement(tabId: number, box: BoundingBox, label?: string): Promise<void> {
    await this.rpc('extension.highlight', { tabId, box, label }).catch(() => {})
  }

  async moveGhostCursor(tabId: number, x: number, y: number, clicking?: boolean): Promise<void> {
    await this.rpc('extension.ghostCursor', { tabId, x, y, clicking }).catch(() => {})
  }

  async getPinnedElement(tabId: number): Promise<{ globalVar?: string; url?: string } | null> {
    return await this.rpc<{ globalVar?: string; url?: string } | null>('extension.getPinnedElement', { tabId })
  }

  async close(): Promise<void> {
    this.unsubMsg()
    this.unsubClose()
    this.channel.close()
    this.events.removeAllListeners()
  }
}
