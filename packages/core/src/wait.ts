import type { TabCDPSession } from './cdp-client.js'
import { countLocatorMatches } from './locator.js'

const IGNORED_ANALYTICS_PATTERNS = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /doubleclick\.net/i,
  /googlesyndication\.com/i,
  /facebook\.net|connect\.facebook/i,
  /hotjar\.com/i,
  /mixpanel\.com/i,
  /segment\.io|segment\.com/i,
  /sentry\.io/i,
  /amplitude\.com/i,
  /intercom\.io/i,
  /clarity\.ms/i,
  /posthog\.com/i,
  /datadoghq\.com/i,
  /hm\.baidu\.com/i,
  /\/collect\b|\/analytics\b|\/telemetry\b|\/beacon\b/i,
  // Long-polling & real-time push endpoints (Discourse message-bus, Socket.IO, SignalR, SSE)
  /\/message-bus\//i,
  /\/(long-?poll|polling|heartbeat|keepalive)\b/i,
  /socket\.io/i,
  /[?&]EIO=\d/i,
  /\/signalr\//i,
]

export function isIgnoredAnalyticsUrl(url: string): boolean {
  return IGNORED_ANALYTICS_PATTERNS.some((re) => re.test(url))
}

export interface WaitForPageLoadOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  minWaitMs?: number
  idleMs?: number
  /** Ignore transient `about:blank` initial state while a newly opened tab navigates to a real URL. */
  ignoreAboutBlank?: boolean
}

export interface WaitForPageLoadResult {
  success: boolean
  readyState: string
  pendingRequests: number
  waitTimeMs: number
  timedOut: boolean
}

/**
 * Smart page load detection that waits for document.readyState === 'complete'
 * and non-analytics pending network requests to settle.
 */
export async function waitForPageLoad(
  session: TabCDPSession,
  options: WaitForPageLoadOptions = {},
): Promise<WaitForPageLoadResult> {
  const timeoutMs = options.timeoutMs ?? 8_000
  const pollIntervalMs = options.pollIntervalMs ?? 120
  const minWaitMs = options.minWaitMs ?? 150
  const idleMs = options.idleMs ?? 300

  const start = Date.now()
  const inflight = new Map<string, { url: string; startedAt: number }>()

  const offReq = session.on('Network.requestWillBeSent', (params) => {
    const id = String(params.requestId ?? '')
    const url = String((params.request as { url?: string } | undefined)?.url ?? '')
    const type = String(params.type ?? '')
    if (!id || !url || url.startsWith('data:') || type === 'EventSource' || type === 'WebSocket') return
    if (isIgnoredAnalyticsUrl(url)) return
    inflight.set(id, { url, startedAt: Date.now() })
  })
  const offFin = session.on('Network.loadingFinished', (params) => {
    inflight.delete(String(params.requestId ?? ''))
  })
  const offFail = session.on('Network.loadingFailed', (params) => {
    inflight.delete(String(params.requestId ?? ''))
  })

  const countActiveInflight = (now: number, docComplete: boolean): number => {
    if (!docComplete) return inflight.size
    // Once document.readyState === 'complete', ignore hanging long-poll requests open > 2.5s
    let active = 0
    for (const item of inflight.values()) {
      if (now - item.startedAt < 2_500) active++
    }
    return active
  }

  let readyState = 'loading'
  let idleSince: number | null = null

  try {
    if (minWaitMs > 0) {
      await sleep(Math.min(minWaitMs, timeoutMs))
    }

    while (Date.now() - start < timeoutMs) {
      let href = ''
      try {
        const res = await session.send<{ result?: { value?: { readyState?: string; href?: string } } }>('Runtime.evaluate', {
          expression: '({ readyState: document.readyState, href: location.href })',
          returnByValue: true,
        })
        readyState = res.result?.value?.readyState ?? 'loading'
        href = res.result?.value?.href ?? ''
      } catch {
        readyState = 'loading'
      }

      const now = Date.now()
      const stillOnBlank = Boolean(options.ignoreAboutBlank) && (!href || href === 'about:blank')
      const activePending = countActiveInflight(now, readyState === 'complete')
      if (!stillOnBlank && (readyState === 'complete' || readyState === 'interactive') && activePending === 0) {
        if (idleSince === null) idleSince = now
        if (now - idleSince >= idleMs || readyState === 'complete') {
          if (now - idleSince >= Math.min(idleMs, 150)) {
            return {
              success: true,
              readyState,
              pendingRequests: 0,
              waitTimeMs: now - start,
              timedOut: false,
            }
          }
        }
      } else {
        idleSince = null
      }

      await sleep(pollIntervalMs)
    }

    return {
      success: readyState === 'complete',
      readyState,
      pendingRequests: inflight.size,
      waitTimeMs: Date.now() - start,
      timedOut: true,
    }
  } finally {
    offReq()
    offFin()
    offFail()
  }
}

export async function waitForCondition<T>(
  check: () => Promise<T | null | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      const value = await check()
      if (value) return value
      lastError = undefined
    } catch (err) {
      lastError = err
    }
    await sleep(intervalMs)
  }

  const desc = options.description ?? 'condition'
  const extra = lastError instanceof Error ? ` (last error: ${lastError.message})` : ''
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${desc}${extra}`)
}

export type WaitSelectorState = 'visible' | 'hidden' | 'attached' | 'detached'

export async function waitForSelector(
  session: TabCDPSession,
  selector: string,
  options: { visible?: boolean; state?: WaitSelectorState; timeoutMs?: number; frame?: string } = {},
): Promise<boolean> {
  const state: WaitSelectorState = options.state ?? (options.visible === false ? 'attached' : 'visible')
  const frameCtx = options.frame ? await session.resolveFrame(options.frame) : null
  if (options.frame && !frameCtx) {
    throw new Error(`Frame not found: ${options.frame}`)
  }

  return await waitForCondition(
    async () => {
      const visibilityMode = state === 'visible' || state === 'hidden' ? 'visible-only' : 'any'
      const count = await countLocatorMatches(session, selector, {
        visibilityMode,
        sessionId: frameCtx?.sessionId,
        contextId: frameCtx?.contextId,
      })
      if (state === 'visible' || state === 'attached') return count > 0
      return count === 0
    },
    { timeoutMs: options.timeoutMs ?? 10_000, description: `selector "${selector}" (${state})` },
  )
}

export async function waitForText(
  session: TabCDPSession,
  text: string | RegExp,
  options: { timeoutMs?: number; frame?: string; gone?: boolean } = {},
): Promise<boolean> {
  const isRegex = text instanceof RegExp
  const source = isRegex ? text.source : text
  const flags = isRegex ? text.flags : ''
  const frameCtx = options.frame ? await session.resolveFrame(options.frame) : null
  if (options.frame && !frameCtx) {
    throw new Error(`Frame not found: ${options.frame}`)
  }

  return await waitForCondition(
    async () => {
      const evalParams: Record<string, unknown> = {
        expression: `(() => {
          const body = document.body?.innerText || '';
          return ${isRegex}
            ? new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)}).test(body)
            : body.includes(${JSON.stringify(source)});
        })()`,
        returnByValue: true,
      }
      if (frameCtx?.contextId !== undefined && !frameCtx.sessionId) {
        evalParams.contextId = frameCtx.contextId
      }
      const res = await session.send<{ result?: { value?: boolean } }>('Runtime.evaluate', evalParams, {
        sessionId: frameCtx?.sessionId,
      })
      const found = res.result?.value === true
      return options.gone ? !found : found
    },
    {
      timeoutMs: options.timeoutMs ?? 10_000,
      description: `text "${String(text)}"${options.gone ? ' to disappear' : ''}`,
    },
  )
}

export async function waitForUrl(
  session: TabCDPSession,
  pattern: string | RegExp,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<string> {
  const matcher =
    pattern instanceof RegExp
      ? (u: string) => pattern.test(u)
      : (() => {
          let re: RegExp | null = null
          try {
            re = pattern.includes('*')
              ? new RegExp(pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i')
              : new RegExp(pattern, 'i')
          } catch {
            re = null
          }
          return (u: string) => u.includes(pattern) || Boolean(re?.test(u))
        })()

  return await waitForCondition(
    async () => {
      const res = await session
        .send<{ result?: { value?: string } }>('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true,
        })
        .catch(() => null)
      const href = res?.result?.value ?? ''
      return href && matcher(href) ? href : false
    },
    {
      timeoutMs: options.timeoutMs ?? 15_000,
      intervalMs: options.pollIntervalMs ?? 100,
      description: `URL matching ${String(pattern)}`,
    },
  )
}

export async function waitForFunction<T = unknown>(
  session: TabCDPSession,
  expression: string,
  options: { timeoutMs?: number; pollIntervalMs?: number; frame?: string } = {},
): Promise<T> {
  const frameCtx = options.frame ? await session.resolveFrame(options.frame) : null
  if (options.frame && !frameCtx) {
    throw new Error(`Frame not found: ${options.frame}`)
  }
  const wrapped = expression.trim().startsWith('(') || expression.includes('=>') || expression.trim().startsWith('function')
    ? `(() => { const __fn = (${expression}); return typeof __fn === 'function' ? __fn() : __fn; })()`
    : `(() => (${expression}))()`

  return await waitForCondition<T>(
    async () => {
      const evalParams: Record<string, unknown> = {
        expression: wrapped,
        awaitPromise: true,
        returnByValue: true,
      }
      if (frameCtx?.contextId !== undefined && !frameCtx.sessionId) {
        evalParams.contextId = frameCtx.contextId
      }
      const res = await session.send<{ result?: { value?: T }; exceptionDetails?: unknown }>(
        'Runtime.evaluate',
        evalParams,
        { sessionId: frameCtx?.sessionId },
      )
      if (res.exceptionDetails) return false
      const val = res.result?.value
      return val ? val : false
    },
    {
      timeoutMs: options.timeoutMs ?? 10_000,
      intervalMs: options.pollIntervalMs ?? 120,
      description: `function "${expression.slice(0, 60)}"`,
    },
  )
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
