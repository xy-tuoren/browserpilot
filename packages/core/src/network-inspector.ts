import {
  MAX_NETWORK_BUFFER,
  type NetworkEntry,
  type NetworkInitiator,
  type NetworkInterceptRule,
  type NetworkTiming,
} from '@browserpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'

export interface GetNetworkOptions {
  count?: number
  search?: string | RegExp
  method?: string
  status?: number
  failedOnly?: boolean
  resourceType?: string
  sinceLastCall?: boolean
  cursorKey?: string
}

function parseTiming(raw?: Record<string, number>): NetworkTiming | undefined {
  if (!raw) return undefined
  const round = (n: number) => (n >= 0 ? Math.round(n * 10) / 10 : undefined)
  const dnsMs = raw.dnsStart >= 0 && raw.dnsEnd >= 0 ? round(raw.dnsEnd - raw.dnsStart) : undefined
  const connectMs = raw.connectStart >= 0 && raw.connectEnd >= 0 ? round(raw.connectEnd - raw.connectStart) : undefined
  const sslMs = raw.sslStart >= 0 && raw.sslEnd >= 0 ? round(raw.sslEnd - raw.sslStart) : undefined
  const ttfbMs = raw.sendEnd >= 0 && raw.receiveHeadersEnd >= 0 ? round(raw.receiveHeadersEnd - raw.sendEnd) : undefined
  return { dnsMs, connectMs, sslMs, ttfbMs }
}

function parseInitiator(raw?: {
  type?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
  stack?: { callFrames?: Array<{ functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }> }
}): NetworkInitiator | undefined {
  if (!raw) return undefined
  const stack = raw.stack?.callFrames
    ?.slice(0, 8)
    .map((f) => `${f.functionName || '(anonymous)'} (${f.url || ''}:${(f.lineNumber ?? 0) + 1})`)
  return {
    type: raw.type ?? 'other',
    url: raw.url,
    lineNumber: raw.lineNumber !== undefined ? raw.lineNumber + 1 : undefined,
    columnNumber: raw.columnNumber !== undefined ? raw.columnNumber + 1 : undefined,
    stack: stack?.length ? stack : undefined,
  }
}

function wildcardMatch(url: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**') return true
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(escaped, 'i').test(url)
}

export interface LiveNetworkResponse {
  requestId: string
  url: string
  method: string
  status?: number
  statusText?: string
  mimeType?: string
  headers?: Record<string, string>
  resourceType?: string
  failed?: boolean
  errorText?: string
  text: () => Promise<string>
  json: <T = unknown>() => Promise<T>
}

export interface WaitForResponseOptions {
  url: string | RegExp
  status?: number
  method?: string
  timeoutMs?: number
  includeBody?: boolean
}

export class NetworkInspector {
  private readonly session: TabCDPSession
  private entries: NetworkEntry[] = []
  private byId = new Map<string, NetworkEntry>()
  private cursors = new Map<string, number>()
  private interceptRules = new Map<string, NetworkInterceptRule>()
  private fetchEnabled = false
  private requestListeners = new Set<(entry: NetworkEntry) => void>()
  private responseListeners = new Set<(res: LiveNetworkResponse) => void>()
  private unsubscribers: Array<() => void> = []

  constructor(session: TabCDPSession) {
    this.session = session

    this.unsubscribers.push(
      session.on('Network.requestWillBeSent', (params) => {
        const requestId = String(params.requestId ?? '')
        const req = (params.request ?? {}) as {
          url?: string
          method?: string
          headers?: Record<string, string>
          postData?: string
        }
        if (!requestId || !req.url) return

        const entry: NetworkEntry = {
          requestId,
          timestamp: Date.now(),
          url: req.url,
          method: req.method ?? 'GET',
          resourceType: params.type as string | undefined,
          requestHeaders: req.headers,
          requestPostData: req.postData?.slice(0, 8000),
          initiator: parseInitiator(params.initiator as Parameters<typeof parseInitiator>[0]),
        }
        this.byId.set(requestId, entry)
        this.entries.push(entry)
        if (this.entries.length > MAX_NETWORK_BUFFER) {
          const removed = this.entries.splice(0, this.entries.length - MAX_NETWORK_BUFFER)
          for (const r of removed) this.byId.delete(r.requestId)
        }
        for (const listener of this.requestListeners) {
          try { listener(entry) } catch {}
        }
      }),
    )

    this.unsubscribers.push(
      session.on('Network.responseReceived', (params) => {
        const requestId = String(params.requestId ?? '')
        const entry = this.byId.get(requestId)
        const res = (params.response ?? {}) as {
          status?: number
          statusText?: string
          mimeType?: string
          headers?: Record<string, string>
          fromDiskCache?: boolean
          fromServiceWorker?: boolean
          timing?: Record<string, number>
        }
        if (!entry) return
        entry.status = res.status
        entry.statusText = res.statusText
        entry.mimeType = res.mimeType
        entry.responseHeaders = res.headers
        entry.fromCache = Boolean(res.fromDiskCache || res.fromServiceWorker)
        entry.timing = parseTiming(res.timing)
        if (typeof res.status === 'number' && res.status >= 400) {
          entry.failed = true
        }
      }),
    )

    this.unsubscribers.push(
      session.on('Network.loadingFinished', (params) => {
        const entry = this.byId.get(String(params.requestId ?? ''))
        if (!entry) return
        entry.encodedDataLength = params.encodedDataLength as number | undefined
        entry.completedAt = Date.now()
        entry.timing = {
          ...entry.timing,
          totalMs: entry.completedAt - entry.timestamp,
        }
        this.emitResponse(entry)
      }),
    )

    this.unsubscribers.push(
      session.on('Network.loadingFailed', (params) => {
        const entry = this.byId.get(String(params.requestId ?? ''))
        if (!entry) return
        entry.failed = true
        entry.errorText = String(params.errorText ?? 'Request failed')
        entry.completedAt = Date.now()
        this.emitResponse(entry)
      }),
    )

    this.unsubscribers.push(
      session.on('Fetch.requestPaused', (params) => {
        void this.handlePausedRequest(params).catch(() => {})
      }),
    )
  }

  private async handlePausedRequest(params: Record<string, unknown>): Promise<void> {
    const requestId = String(params.requestId ?? '')
    const req = (params.request ?? {}) as { url?: string; headers?: Record<string, string> }
    const url = req.url ?? ''
    const resourceType = String(params.resourceType ?? '')

    const rule = Array.from(this.interceptRules.values()).find(
      (r) => wildcardMatch(url, r.urlPattern) && (!r.resourceType || r.resourceType.toLowerCase() === resourceType.toLowerCase()),
    )

    if (!rule) {
      await this.session.send('Fetch.continueRequest', { requestId })
      return
    }

    if (rule.action === 'block') {
      await this.session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
      return
    }

    if (rule.action === 'mock') {
      const headersObj: Record<string, string> = {
        'content-type': rule.contentType ?? 'application/json; charset=utf-8',
        ...(rule.headers ?? {}),
      }
      const responseHeaders = Object.entries(headersObj).map(([name, value]) => ({ name, value }))
      const bodyBase64 = Buffer.from(rule.body ?? '', 'utf8').toString('base64')
      await this.session.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: rule.status ?? 200,
        responseHeaders,
        body: bodyBase64,
      })
      return
    }

    if (rule.action === 'modify-headers') {
      const merged = { ...(req.headers ?? {}), ...(rule.headers ?? {}) }
      const headers = Object.entries(merged).map(([name, value]) => ({ name, value }))
      await this.session.send('Fetch.continueRequest', { requestId, headers })
      return
    }

    await this.session.send('Fetch.continueRequest', { requestId })
  }

  getRequests(options: GetNetworkOptions = {}): NetworkEntry[] {
    const cursorKey = options.cursorKey ?? 'default'
    let list = this.entries

    if (options.sinceLastCall) {
      const lastTs = this.cursors.get(cursorKey) ?? 0
      list = list.filter((e) => e.timestamp > lastTs)
    }
    if (options.method) {
      const m = options.method.toUpperCase()
      list = list.filter((e) => e.method.toUpperCase() === m)
    }
    if (options.status !== undefined) {
      list = list.filter((e) => e.status === options.status)
    }
    if (options.failedOnly) {
      list = list.filter((e) => e.failed || (e.status !== undefined && e.status >= 400))
    }
    if (options.resourceType) {
      const rt = options.resourceType.toLowerCase()
      list = list.filter((e) => e.resourceType?.toLowerCase() === rt)
    }
    if (options.search !== undefined) {
      let regex: RegExp
      if (options.search instanceof RegExp) {
        regex = options.search
      } else {
        try {
          regex = new RegExp(options.search, 'i')
        } catch {
          regex = new RegExp(options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        }
      }
      list = list.filter((e) => regex.test(e.url) || (e.errorText && regex.test(e.errorText)))
    }

    const latestTs = this.entries[this.entries.length - 1]?.timestamp ?? Date.now()
    this.cursors.set(cursorKey, latestTs)

    const count = options.count ?? 50
    return list.slice(-count)
  }

  getFailedSince(sinceTimestamp: number): NetworkEntry[] {
    return this.entries.filter(
      (e) => e.timestamp > sinceTimestamp && (e.failed || (e.status !== undefined && e.status >= 400)),
    )
  }

  async getResponseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    const res = await this.session.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', {
      requestId,
    })
    return { body: res.body ?? '', base64Encoded: Boolean(res.base64Encoded) }
  }

  async addInterceptRule(rule: Omit<NetworkInterceptRule, 'id'> & { id?: string }): Promise<NetworkInterceptRule> {
    const full: NetworkInterceptRule = {
      ...rule,
      id: rule.id ?? `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    }
    this.interceptRules.set(full.id, full)
    await this.syncFetchDomain()
    return full
  }

  async removeInterceptRule(id: string): Promise<boolean> {
    const existed = this.interceptRules.delete(id)
    await this.syncFetchDomain()
    return existed
  }

  async clearInterceptRules(): Promise<void> {
    this.interceptRules.clear()
    await this.syncFetchDomain()
  }

  listInterceptRules(): NetworkInterceptRule[] {
    return Array.from(this.interceptRules.values())
  }

  private async syncFetchDomain(): Promise<void> {
    if (this.interceptRules.size === 0) {
      if (this.fetchEnabled) {
        await this.session.send('Fetch.disable').catch(() => {})
        this.fetchEnabled = false
      }
      return
    }
    const patterns = Array.from(this.interceptRules.values()).map((r) => ({
      urlPattern: r.urlPattern,
      ...(r.resourceType ? { resourceType: r.resourceType } : {}),
    }))
    await this.session.send('Fetch.enable', { patterns })
    this.fetchEnabled = true
  }

  clear(): void {
    this.entries = []
    this.byId.clear()
  }

  private emitResponse(entry: NetworkEntry): void {
    if (this.responseListeners.size === 0) return
    let cachedBody: Promise<string> | null = null
    const readText = (): Promise<string> => {
      if (!cachedBody) {
        cachedBody = this.getResponseBody(entry.requestId)
          .then((r) => (r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body))
          .catch(() => '')
      }
      return cachedBody
    }
    const resObj: LiveNetworkResponse = {
      requestId: entry.requestId,
      url: entry.url,
      method: entry.method,
      status: entry.status,
      statusText: entry.statusText,
      mimeType: entry.mimeType,
      headers: entry.responseHeaders,
      resourceType: entry.resourceType,
      failed: entry.failed,
      errorText: entry.errorText,
      text: readText,
      json: async <T = unknown>() => JSON.parse(await readText()) as T,
    }
    for (const listener of this.responseListeners) {
      try { listener(resObj) } catch {}
    }
  }

  onRequest(listener: (entry: NetworkEntry) => void): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  onResponse(listener: (res: LiveNetworkResponse) => void): () => void {
    this.responseListeners.add(listener)
    return () => this.responseListeners.delete(listener)
  }

  async waitForResponse(options: WaitForResponseOptions): Promise<{
    requestId: string
    url: string
    method: string
    status?: number
    headers?: Record<string, string>
    body?: string
  }> {
    const timeoutMs = options.timeoutMs ?? 15_000
    const urlMatcher =
      options.url instanceof RegExp
        ? (u: string) => (options.url as RegExp).test(u)
        : (() => {
            const raw = options.url
            let re: RegExp | null = null
            try {
              if (raw.includes('*')) {
                re = new RegExp(raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i')
              } else {
                re = new RegExp(raw, 'i')
              }
            } catch {
              re = null
            }
            return (u: string) => u.includes(raw) || Boolean(re?.test(u))
          })()
    const methodFilter = options.method?.toUpperCase()

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for response matching ${String(options.url)}`))
      }, timeoutMs)

      const off = this.onResponse((res) => {
        if (!urlMatcher(res.url)) return
        if (options.status !== undefined && res.status !== options.status) return
        if (methodFilter && res.method.toUpperCase() !== methodFilter) return
        clearTimeout(timer)
        off()
        const finalize = async () => {
          const body = options.includeBody !== false ? await res.text().catch(() => undefined) : undefined
          resolve({
            requestId: res.requestId,
            url: res.url,
            method: res.method,
            status: res.status,
            headers: res.headers,
            body,
          })
        }
        void finalize()
      })
    })
  }

  dispose(): void {
    for (const off of this.unsubscribers) off()
    this.unsubscribers = []
    this.requestListeners.clear()
    this.responseListeners.clear()
  }
}

export function formatNetworkEntries(entries: NetworkEntry[]): string {
  if (!entries.length) return '(no network requests)'
  return entries
    .map((e) => {
      const status = e.failed && !e.status ? `FAILED(${e.errorText ?? 'error'})` : String(e.status ?? 'pending')
      const dur = e.timing?.totalMs !== undefined ? `${e.timing.totalMs}ms` : ''
      const type = e.resourceType ?? ''
      const init = e.initiator?.stack?.[0] ? ` <- ${e.initiator.stack[0]}` : ''
      return `[${e.requestId}] ${e.method} ${status} ${type} ${dur} ${e.url}${init}`.replace(/\s+/g, ' ')
    })
    .join('\n')
}
