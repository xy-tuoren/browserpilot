import type { TabCDPSession } from './cdp-client.js'

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
]

export function isIgnoredAnalyticsUrl(url: string): boolean {
  return IGNORED_ANALYTICS_PATTERNS.some((re) => re.test(url))
}

export interface WaitForPageLoadOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  minWaitMs?: number
  idleMs?: number
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
  const inflight = new Map<string, string>()

  const offReq = session.on('Network.requestWillBeSent', (params) => {
    const id = String(params.requestId ?? '')
    const url = String((params.request as { url?: string } | undefined)?.url ?? '')
    const type = String(params.type ?? '')
    if (!id || !url || url.startsWith('data:') || type === 'EventSource' || type === 'WebSocket') return
    if (isIgnoredAnalyticsUrl(url)) return
    inflight.set(id, url)
  })
  const offFin = session.on('Network.loadingFinished', (params) => {
    inflight.delete(String(params.requestId ?? ''))
  })
  const offFail = session.on('Network.loadingFailed', (params) => {
    inflight.delete(String(params.requestId ?? ''))
  })

  let readyState = 'loading'
  let idleSince: number | null = null

  try {
    if (minWaitMs > 0) {
      await sleep(Math.min(minWaitMs, timeoutMs))
    }

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await session.send<{ result?: { value?: string } }>('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        })
        readyState = res.result?.value ?? 'loading'
      } catch {
        readyState = 'loading'
      }

      if ((readyState === 'complete' || readyState === 'interactive') && inflight.size === 0) {
        if (idleSince === null) idleSince = Date.now()
        if (Date.now() - idleSince >= idleMs || readyState === 'complete') {
          if (Date.now() - idleSince >= Math.min(idleMs, 150)) {
            return {
              success: true,
              readyState,
              pendingRequests: 0,
              waitTimeMs: Date.now() - start,
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

export async function waitForSelector(
  session: TabCDPSession,
  selector: string,
  options: { visible?: boolean; timeoutMs?: number } = {},
): Promise<boolean> {
  const visible = options.visible ?? true
  return await waitForCondition(
    async () => {
      const res = await session.send<{ result?: { value?: boolean } }>('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          if (!${visible}) return true;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })()`,
        returnByValue: true,
      })
      return res.result?.value === true
    },
    { timeoutMs: options.timeoutMs ?? 10_000, description: `selector "${selector}"` },
  )
}

export async function waitForText(
  session: TabCDPSession,
  text: string | RegExp,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const isRegex = text instanceof RegExp
  const source = isRegex ? text.source : text
  const flags = isRegex ? text.flags : ''
  return await waitForCondition(
    async () => {
      const res = await session.send<{ result?: { value?: boolean } }>('Runtime.evaluate', {
        expression: `(() => {
          const body = document.body?.innerText || '';
          return ${isRegex}
            ? new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)}).test(body)
            : body.includes(${JSON.stringify(source)});
        })()`,
        returnByValue: true,
      })
      return res.result?.value === true
    },
    { timeoutMs: options.timeoutMs ?? 10_000, description: `text "${String(text)}"` },
  )
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
