import { EventEmitter } from 'node:events'
import type { FrameInfo } from '@browserpilot/protocol'
import type { CDPEventPacket, CDPSendOptions, CDPTransport } from './transport.js'

export interface ChildFrameSession {
  sessionId: string
  targetId: string
  url: string
  type: string
  parentSessionId?: string
}

export interface DialogEventInfo {
  url: string
  message: string
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  defaultPrompt?: string
  timestamp?: number
  handled?: boolean
}

export interface ResolvedFrameContext {
  frameId?: string
  sessionId?: string
  contextId?: number
  url?: string
  crossOrigin: boolean
}

/**
 * Tab-scoped CDP session wrapper handling domain enablement, OOPIF child sessions,
 * same-origin frame execution contexts, dialog tracking, and typed event subscriptions.
 */
export class TabCDPSession {
  readonly tabId: number
  readonly transport: CDPTransport
  private emitter = new EventEmitter()
  private unsubscribeTransport: () => void
  private enabledDomains = new Set<string>()
  private baseDomainsReady = false
  private baseDomainsPromise: Promise<void> | null = null
  private childAxEnabled = new Set<string>()
  private childSessions = new Map<string, ChildFrameSession>()
  private frameExecutionContexts = new Map<string, number>()
  private pendingDialog: DialogEventInfo | null = null
  private dialogHistory: Array<DialogEventInfo & { timestamp: number; handled?: boolean }> = []
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
              ...(packet.sessionId ? { parentSessionId: packet.sessionId } : {}),
            })
            // Enable recursive OOPIF auto-attach inside child iframe targets (2+ level cross-origin frames)
            void this.send(
              'Target.setAutoAttach',
              { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
              { sessionId: sid },
            ).catch(() => {})
          }
        } else if (packet.method === 'Target.targetInfoChanged' && packet.params.targetInfo) {
          const info = packet.params.targetInfo as { targetId?: string; url?: string }
          if (info.targetId) {
            for (const child of this.childSessions.values()) {
              if (child.targetId === info.targetId && info.url) {
                child.url = info.url
              }
            }
          }
        } else if (packet.method === 'Target.detachedFromTarget' && packet.params.sessionId) {
          const detachedSid = String(packet.params.sessionId)
          this.childSessions.delete(detachedSid)
          this.childAxEnabled.delete(detachedSid)
        } else if (packet.method === 'Runtime.executionContextCreated' && !packet.sessionId) {
          const ctx = packet.params.context as {
            id?: number
            auxData?: { frameId?: string; isDefault?: boolean }
          } | undefined
          if (ctx?.id && ctx.auxData?.frameId && ctx.auxData.isDefault !== false) {
            this.frameExecutionContexts.set(ctx.auxData.frameId, ctx.id)
          }
        } else if (packet.method === 'Runtime.executionContextDestroyed' && !packet.sessionId) {
          const id = packet.params.executionContextId as number | undefined
          if (id !== undefined) {
            for (const [fid, cid] of this.frameExecutionContexts.entries()) {
              if (cid === id) this.frameExecutionContexts.delete(fid)
            }
          }
        } else if (packet.method === 'Runtime.executionContextsCleared' && !packet.sessionId) {
          this.frameExecutionContexts.clear()
        } else if (packet.method === 'Page.javascriptDialogOpening') {
          const dialog: DialogEventInfo & { timestamp: number; handled?: boolean } = {
            url: String(packet.params.url ?? ''),
            message: String(packet.params.message ?? ''),
            type: (packet.params.type as DialogEventInfo['type']) ?? 'alert',
            defaultPrompt: packet.params.defaultPrompt as string | undefined,
            timestamp: Date.now(),
            handled: Boolean(this.autoDialogAction),
          }
          this.pendingDialog = dialog
          this.dialogHistory.push(dialog)
          if (this.dialogHistory.length > 100) this.dialogHistory.shift()
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
    if (this.baseDomainsReady) return
    if (this.baseDomainsPromise) return await this.baseDomainsPromise
    this.baseDomainsPromise = (async () => {
      await Promise.all([
        this.enableDomain('Page'),
        this.enableDomain('Runtime'),
        this.enableDomain('DOM'),
        this.enableDomain('Network'),
        this.enableDomain('Log').catch(() => {}),
        // Emulate page focus so background tabs do not stall 5s per Input.dispatchMouseEvent('mouseMoved')
        // in Chromium's InputRouter compositor queue — without stealing the user's active tab/window focus.
        this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {}),
        // Enable OOPIF child frame auto-attach on this tab
        this.send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        }).catch(() => {}),
      ])
      this.baseDomainsReady = true
    })().finally(() => {
      this.baseDomainsPromise = null
    })
    return await this.baseDomainsPromise
  }

  async ensureChildAccessibility(childSessionId: string): Promise<void> {
    if (this.childAxEnabled.has(childSessionId)) return
    await this.send('Accessibility.enable', {}, { sessionId: childSessionId }).catch(() => {})
    this.childAxEnabled.add(childSessionId)
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

  getExecutionContextForFrame(frameId: string): number | undefined {
    return this.frameExecutionContexts.get(frameId)
  }

  /**
   * Lists all frames in this tab (main frame, same-origin subframes, and cross-origin OOPIF frames).
   */
  async listFrames(): Promise<FrameInfo[]> {
    await this.ensureBaseDomains()
    const frames: FrameInfo[] = []
    const seenIds = new Set<string>()
    const children = this.getChildSessions()

    // Ensure child OOPIF URLs are up-to-date even if Target.attachedToTarget fired before navigation settled
    for (const c of children) {
      if (!c.url || c.url === 'about:blank') {
        const hrefRes = await this.send<{ result?: { value?: string } }>(
          'Runtime.evaluate',
          { expression: 'location.href', returnByValue: true },
          { sessionId: c.sessionId },
        ).catch(() => null)
        if (hrefRes?.result?.value) c.url = hrefRes.result.value
      }
    }

    const childByTarget = new Map(children.map((c) => [c.targetId, c]))
    const childByUrl = new Map(children.filter((c) => c.url).map((c) => [c.url, c]))
    const originOf = (u: string): string => {
      try { return new URL(u).origin } catch { return '' }
    }
    let mainOrigin = ''

    try {
      const treeRes = await this.send<{
        frameTree?: {
          frame: { id: string; parentId?: string; url: string; name?: string }
          childFrames?: Array<unknown>
        }
      }>('Page.getFrameTree')

      if (treeRes.frameTree?.frame?.url) {
        mainOrigin = originOf(treeRes.frameTree.frame.url)
      }

      const walk = (node: { frame?: { id: string; parentId?: string; url: string; name?: string }; childFrames?: Array<unknown> } | undefined) => {
        if (!node?.frame) return
        const f = node.frame
        const childSession = childByTarget.get(f.id) ?? (f.url ? childByUrl.get(f.url) : undefined)
        const resolvedUrl = f.url || childSession?.url || ''
        const fOrigin = originOf(resolvedUrl)
        const diffOrigin = Boolean(f.parentId && mainOrigin && fOrigin && fOrigin !== 'null' && fOrigin !== mainOrigin)
        seenIds.add(f.id)
        if (childSession?.targetId) seenIds.add(childSession.targetId)
        frames.push({
          frameId: f.id,
          parentId: f.parentId,
          url: resolvedUrl,
          name: f.name || undefined,
          sessionId: childSession?.sessionId,
          crossOrigin: Boolean(childSession) || diffOrigin,
        })
        for (const sub of node.childFrames ?? []) {
          walk(sub as typeof node)
        }
      }
      walk(treeRes.frameTree)
    } catch {
      // Fallback to child sessions only
    }

    for (const c of children) {
      if (!seenIds.has(c.targetId)) {
        frames.push({
          frameId: c.targetId || c.sessionId,
          url: c.url,
          sessionId: c.sessionId,
          crossOrigin: true,
        })
      }
    }
    return frames
  }

  /**
   * Resolves a frame specifier (frameId, sessionId, iframe CSS selector, frame name, or URL substring/regex)
   * into an executable frame context (either OOPIF `sessionId` or same-origin `contextId` + `frameId`).
   */
  async resolveFrame(frameQuery: string): Promise<ResolvedFrameContext | null> {
    const query = frameQuery.trim()
    if (!query) return null

    const frames = await this.listFrames()
    // 1. Direct ID / sessionId / name match
    const direct = frames.find((f) => f.frameId === query || f.sessionId === query || (f.name && f.name === query))
    if (direct) {
      return await this.materializeFrameContext(direct)
    }

    // 2. If query looks like a CSS selector matching an <iframe>, inspect its src/name/frameId
    if (/^[.#\[]|^iframe\b/i.test(query)) {
      const iframeMeta = await this.send<{
        result?: { value?: { src: string; name: string; id: string } | null }
      }>('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(query)});
          if (!el || el.tagName !== 'IFRAME') return null;
          return { src: el.src || el.getAttribute('src') || '', name: el.name || '', id: el.id || '' };
        })()`,
        returnByValue: true,
      }).catch(() => null)
      const meta = iframeMeta?.result?.value
      if (meta) {
        const byDom = frames.find(
          (f) =>
            f.parentId !== undefined &&
            ((meta.src && (f.url === meta.src || f.url.startsWith(meta.src) || meta.src.startsWith(f.url))) ||
              (meta.name && f.name === meta.name)),
        )
        if (byDom) return await this.materializeFrameContext(byDom)
      }
    }

    // 3. Substring / regex URL match (prefer subframes over main frame)
    let regex: RegExp | null = null
    try {
      regex = new RegExp(query, 'i')
    } catch {
      regex = null
    }
    const subframes = frames.filter((f) => f.parentId !== undefined || f.crossOrigin)
    const matchedSub = subframes.find(
      (f) => f.url.toLowerCase().includes(query.toLowerCase()) || (regex && regex.test(f.url)) || (f.name && f.name.toLowerCase().includes(query.toLowerCase())),
    )
    if (matchedSub) return await this.materializeFrameContext(matchedSub)

    const matchedAny = frames.find(
      (f) => f.url.toLowerCase().includes(query.toLowerCase()) || (regex && regex.test(f.url)),
    )
    if (matchedAny) return await this.materializeFrameContext(matchedAny)

    return null
  }

  private async materializeFrameContext(frame: FrameInfo): Promise<ResolvedFrameContext> {
    if (frame.sessionId) {
      await this.send('Runtime.enable', {}, { sessionId: frame.sessionId }).catch(() => {})
      return {
        frameId: frame.frameId,
        sessionId: frame.sessionId,
        url: frame.url,
        crossOrigin: true,
      }
    }
    let contextId = this.frameExecutionContexts.get(frame.frameId)
    if (contextId === undefined) {
      // Fallback: create a dedicated world for this same-origin frame if default context wasn't observed yet
      const world = await this.send<{ executionContextId?: number }>('Page.createIsolatedWorld', {
        frameId: frame.frameId,
        worldName: 'browserpilot-frame',
        grantUniversalAccess: true,
      }).catch(() => null)
      contextId = world?.executionContextId
    }
    return {
      frameId: frame.frameId,
      contextId,
      url: frame.url,
      crossOrigin: false,
    }
  }

  getPendingDialog(): DialogEventInfo | null {
    return this.pendingDialog
  }

  getDialogsSince(sinceTimestamp: number): Array<DialogEventInfo & { timestamp: number; handled?: boolean }> {
    return this.dialogHistory.filter((d) => d.timestamp > sinceTimestamp)
  }

  setAutoDialog(action: { accept: boolean; promptText?: string } | null): void {
    this.autoDialogAction = action
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    const params: Record<string, unknown> = { accept }
    if (promptText !== undefined) params.promptText = promptText
    await this.send('Page.handleJavaScriptDialog', params)
    if (this.pendingDialog) {
      const latest = this.dialogHistory[this.dialogHistory.length - 1]
      if (latest && latest.message === this.pendingDialog.message) latest.handled = true
    }
    this.pendingDialog = null
  }

  resetDomains(): void {
    this.enabledDomains.clear()
    this.baseDomainsReady = false
    this.baseDomainsPromise = null
    this.childAxEnabled.clear()
    this.childSessions.clear()
    this.frameExecutionContexts.clear()
  }

  dispose(): void {
    this.unsubscribeTransport()
    this.emitter.removeAllListeners()
  }
}
