import { EventEmitter } from 'node:events'
import type { CDPEventPacket, CDPSendOptions, CDPTransport } from './transport.js'

export interface ChildFrameSession {
  sessionId: string
  targetId: string
  url: string
  type: string
}

export interface DialogEventInfo {
  url: string
  message: string
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  defaultPrompt?: string
}

/**
 * Tab-scoped CDP session wrapper handling domain enablement, OOPIF child sessions,
 * dialog tracking, and typed event subscriptions.
 */
export class TabCDPSession {
  readonly tabId: number
  readonly transport: CDPTransport
  private emitter = new EventEmitter()
  private unsubscribeTransport: () => void
  private enabledDomains = new Set<string>()
  private childSessions = new Map<string, ChildFrameSession>()
  private pendingDialog: DialogEventInfo | null = null
  private autoDialogAction: { accept: boolean; promptText?: string } | null = null

  constructor(transport: CDPTransport, tabId: number) {
    this.transport = transport
    this.tabId = tabId
    this.emitter.setMaxListeners(100)

    this.unsubscribeTransport = transport.onEvent((packet) => {
      if (packet.tabId !== this.tabId && packet.tabId !== 0) return

      if (packet.tabId === this.tabId) {
        if (packet.method === 'Target.attachedToTarget' && packet.params.sessionId) {
          const info = (packet.params.targetInfo ?? {}) as { targetId?: string; url?: string; type?: string }
          const sid = String(packet.params.sessionId)
          if (info.type === 'iframe' || info.type === 'page') {
            this.childSessions.set(sid, {
              sessionId: sid,
              targetId: info.targetId ?? '',
              url: info.url ?? '',
              type: info.type ?? 'iframe',
            })
          }
        } else if (packet.method === 'Target.detachedFromTarget' && packet.params.sessionId) {
          this.childSessions.delete(String(packet.params.sessionId))
        } else if (packet.method === 'Page.javascriptDialogOpening') {
          const dialog: DialogEventInfo = {
            url: String(packet.params.url ?? ''),
            message: String(packet.params.message ?? ''),
            type: (packet.params.type as DialogEventInfo['type']) ?? 'alert',
            defaultPrompt: packet.params.defaultPrompt as string | undefined,
          }
          this.pendingDialog = dialog
          if (this.autoDialogAction) {
            const { accept, promptText } = this.autoDialogAction
            void this.handleDialog(accept, promptText).catch(() => {})
          }
        } else if (packet.method === 'Page.javascriptDialogClosed') {
          this.pendingDialog = null
        }
      }

      this.emitter.emit(packet.method, packet.params, packet.sessionId)
      this.emitter.emit('*', packet)
    })
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options?: CDPSendOptions,
  ): Promise<T> {
    return await this.transport.send<T>(this.tabId, method, params, options)
  }

  async enableDomain(domain: string, params?: Record<string, unknown>): Promise<void> {
    if (this.enabledDomains.has(domain)) return
    await this.send(`${domain}.enable`, params)
    this.enabledDomains.add(domain)
  }

  async ensureBaseDomains(): Promise<void> {
    await Promise.all([
      this.enableDomain('Page'),
      this.enableDomain('Runtime'),
      this.enableDomain('DOM'),
      this.enableDomain('Network'),
      this.enableDomain('Log').catch(() => {}),
    ])
    // Enable OOPIF child frame auto-attach on this tab
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }).catch(() => {})
  }

  on(method: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): () => void {
    this.emitter.on(method, handler)
    return () => this.emitter.off(method, handler)
  }

  onAny(handler: (packet: CDPEventPacket) => void): () => void {
    this.emitter.on('*', handler)
    return () => this.emitter.off('*', handler)
  }

  once(
    method: string,
    predicate?: (params: Record<string, unknown>, sessionId?: string) => boolean,
    timeoutMs: number = 15_000,
  ): Promise<{ params: Record<string, unknown>; sessionId?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for CDP event ${method}`))
      }, timeoutMs)

      const off = this.on(method, (params, sessionId) => {
        if (!predicate || predicate(params, sessionId)) {
          clearTimeout(timer)
          off()
          resolve({ params, sessionId })
        }
      })
    })
  }

  getChildSessions(): ChildFrameSession[] {
    return Array.from(this.childSessions.values())
  }

  getPendingDialog(): DialogEventInfo | null {
    return this.pendingDialog
  }

  setAutoDialog(action: { accept: boolean; promptText?: string } | null): void {
    this.autoDialogAction = action
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    const params: Record<string, unknown> = { accept }
    if (promptText !== undefined) params.promptText = promptText
    await this.send('Page.handleJavaScriptDialog', params)
    this.pendingDialog = null
  }

  resetDomains(): void {
    this.enabledDomains.clear()
    this.childSessions.clear()
  }

  dispose(): void {
    this.unsubscribeTransport()
    this.emitter.removeAllListeners()
  }
}
