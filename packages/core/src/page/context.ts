import type { TabCDPSession } from '../cdp-client.js'
import { sleep } from '../wait.js'
import type {
  EmulateOptions,
  InitScriptEntry,
  ResolvedElement,
  ScrollResult,
  ScrollUntilOptions,
  ScrollUntilResult,
} from './types.js'

export async function evaluateInPage<T = unknown>(
  session: TabCDPSession,
  expression: string,
  options: { frame?: string } = {},
): Promise<T> {
  let sessionId: string | undefined
  let contextId: number | undefined
  if (options.frame) {
    const frameCtx = await session.resolveFrame(options.frame)
    if (!frameCtx) throw new Error(`Frame not found: ${options.frame}`)
    sessionId = frameCtx.sessionId
    contextId = frameCtx.contextId
  }
  const evalParams: Record<string, unknown> = {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }
  if (contextId !== undefined && !sessionId) evalParams.contextId = contextId

  const res = await session.send<{
    result?: { value?: T; description?: string; type?: string }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }>('Runtime.evaluate', evalParams, { sessionId })
  if (res.exceptionDetails) {
    const msg = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'Evaluation error'
    throw new Error(msg)
  }
  return res.result?.value as T
}

export async function probeAndScrollPage(
  deps: {
    session: TabCDPSession
    tabId: number
    evaluate: <T = unknown>(expression: string) => Promise<T>
    resolveElement: (target: string) => Promise<ResolvedElement>
    wheel: (deltaX: number, deltaY: number, pos?: { x: number; y: number }) => Promise<void>
  },
  options: {
    target?: string
    deltaX?: number
    deltaY?: number
    direction?: 'up' | 'down' | 'left' | 'right'
    amount?: number
  },
): Promise<ScrollResult> {
  const amount = options.amount ?? 500
  let dx = options.deltaX ?? 0
  let dy = options.deltaY ?? 0
  if (options.direction === 'down') dy = amount
  else if (options.direction === 'up') dy = -amount
  else if (options.direction === 'right') dx = amount
  else if (options.direction === 'left') dx = -amount

  await deps.session.transport
    .setControlBanner?.(deps.tabId, {
      active: true,
      status: `Scrolling ${options.direction ?? (dy >= 0 ? 'down' : 'up')}`,
      mode: 'working',
    })
    .catch(() => {})

  const probeMainScrollContainer = async () => {
    return await deps.evaluate<{
      x: number
      y: number
      scrollX: number
      scrollY: number
      maxScrollY: number
      container: string
    }>(`(() => {
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;
      const docEl = document.scrollingElement || document.documentElement;
      const docMaxY = Math.max(0, (docEl?.scrollHeight || 0) - vh);
      if (docMaxY > 24) {
        return {
          x: Math.round(vw / 2),
          y: Math.round(vh / 2),
          scrollX: Math.round(window.scrollX || docEl.scrollLeft || 0),
          scrollY: Math.round(window.scrollY || docEl.scrollTop || 0),
          maxScrollY: Math.round(docMaxY),
          container: 'window',
        };
      }
      let best = null;
      let bestArea = 0;
      for (const el of document.querySelectorAll('main, [role="main"], section, article, div')) {
        const st = getComputedStyle(el);
        if (!/(auto|scroll|overlay)/.test(st.overflowY)) continue;
        const maxY = el.scrollHeight - el.clientHeight;
        if (maxY <= 24) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 160 || r.height < 160) continue;
        const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        const area = visW * visH;
        if (area > bestArea) {
          bestArea = area;
          const id = el.id ? '#' + el.id : '';
          best = {
            x: Math.round(Math.max(r.left, 0) + visW / 2),
            y: Math.round(Math.max(r.top, 0) + visH / 2),
            scrollX: Math.round(el.scrollLeft),
            scrollY: Math.round(el.scrollTop),
            maxScrollY: Math.round(maxY),
            container: el.tagName.toLowerCase() + id,
          };
        }
      }
      return best || {
        x: Math.round(vw / 2),
        y: Math.round(vh / 2),
        scrollX: Math.round(window.scrollX || 0),
        scrollY: Math.round(window.scrollY || 0),
        maxScrollY: Math.round(docMaxY),
        container: 'window',
      };
    })()`)
  }

  const before = await probeMainScrollContainer()
  if (options.target) {
    const el = await deps.resolveElement(options.target)
    if (dx !== 0 || dy !== 0) {
      await deps.wheel(dx, dy, el.center)
      await sleep(120)
    }
  } else {
    await deps.wheel(dx, dy, { x: before.x, y: before.y })
    await sleep(120)
  }

  const after = await probeMainScrollContainer()
  const percentY = after.maxScrollY > 0 ? Math.min(100, Math.round((after.scrollY / after.maxScrollY) * 100)) : 100
  return {
    scrolled: after.scrollY !== before.scrollY || after.scrollX !== before.scrollX,
    scrollX: after.scrollX,
    scrollY: after.scrollY,
    maxScrollY: after.maxScrollY,
    percentY,
    atTop: after.scrollY <= 1,
    atBottom: after.maxScrollY <= 1 || after.scrollY >= after.maxScrollY - 2,
    container: after.container,
  }
}

export async function scrollPageUntilTarget(
  deps: {
    resolveTargetNow: (target: string) => Promise<ResolvedElement | null>
    scroll: (opts: {
      target?: string
      direction?: 'up' | 'down' | 'left' | 'right'
      amount?: number
    }) => Promise<ScrollResult>
  },
  target: string,
  options: ScrollUntilOptions = {},
): Promise<ScrollUntilResult> {
  const direction = options.direction ?? 'down'
  const amount = options.amount ?? 550
  const maxScrolls = Math.max(1, Math.min(100, options.maxScrolls ?? 20))
  const delayMs = Math.max(20, options.delayMs ?? 150)

  if (await deps.resolveTargetNow(target)) {
    return { found: true, attempts: 0 }
  }

  let lastScroll: ScrollResult | undefined
  let stalledCount = 0
  for (let i = 1; i <= maxScrolls; i++) {
    lastScroll = await deps.scroll({
      target: options.container,
      direction,
      amount,
    })
    await sleep(delayMs)

    if (await deps.resolveTargetNow(target)) {
      return { found: true, attempts: i, lastScroll }
    }

    const hitEdge =
      !lastScroll.scrolled ||
      (direction === 'down' && lastScroll.atBottom) ||
      (direction === 'up' && lastScroll.atTop)
    if (hitEdge) {
      stalledCount++
      // Allow one extra settle scroll for infinite-scroll / virtualized feeds fetching the next page
      if (stalledCount >= 2) {
        return { found: false, attempts: i, lastScroll }
      }
      await sleep(Math.max(delayMs, 250))
      if (await deps.resolveTargetNow(target)) {
        return { found: true, attempts: i, lastScroll }
      }
    } else {
      stalledCount = 0
    }
  }
  return { found: false, attempts: maxScrolls, lastScroll }
}

export async function grantBrowserPermissions(
  session: TabCDPSession,
  evaluate: <T = unknown>(expression: string) => Promise<T>,
  permissions: string[],
  origin?: string,
): Promise<void> {
  const targetOrigin = origin ?? (await evaluate<string>('location.origin').catch(() => ''))
  const map: Record<string, string> = {
    'clipboard-read': 'clipboardReadWrite',
    'clipboard-write': 'clipboardSanitizedWrite',
    camera: 'videoCapture',
    microphone: 'audioCapture',
  }
  const normalized = permissions.map((p) => map[p] ?? p)
  const params: Record<string, unknown> = { permissions: normalized }
  if (targetOrigin && targetOrigin !== 'null') params.origin = targetOrigin
  if (session.transport.sendBrowser) {
    await session.transport.sendBrowser('Browser.grantPermissions', params)
  } else {
    await session.send('Browser.grantPermissions', params)
  }
}

export async function resetBrowserPermissions(session: TabCDPSession): Promise<void> {
  if (session.transport.sendBrowser) {
    await session.transport.sendBrowser('Browser.resetPermissions', {})
  } else {
    await session.send('Browser.resetPermissions', {})
  }
}

export async function readPageClipboard(
  session: TabCDPSession,
  evaluate: <T = unknown>(expression: string) => Promise<T>,
): Promise<{ text: string; html?: string }> {
  await grantBrowserPermissions(session, evaluate, ['clipboardReadWrite']).catch(() => {})
  return await evaluate<{ text: string; html?: string }>(`(async () => {
    if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
      try {
        const items = await navigator.clipboard.read();
        let text = '';
        let html;
        for (const item of items) {
          if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
          if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        }
        if (text || html) return html ? { text, html } : { text };
      } catch {}
    }
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      return { text: await navigator.clipboard.readText() };
    }
    throw new Error('Clipboard API unavailable on this origin (requires HTTPS or localhost)');
  })()`)
}

export async function writePageClipboard(
  session: TabCDPSession,
  evaluate: <T = unknown>(expression: string) => Promise<T>,
  text: string,
  html?: string,
): Promise<void> {
  await grantBrowserPermissions(session, evaluate, ['clipboardReadWrite', 'clipboardSanitizedWrite']).catch(() => {})
  await evaluate(`(async () => {
    const plain = ${JSON.stringify(text)};
    const rich = ${html !== undefined ? JSON.stringify(html) : 'null'};
    if (rich && navigator.clipboard && typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard.write === 'function') {
      try {
        const item = new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([rich], { type: 'text/html' }),
        });
        await navigator.clipboard.write([item]);
        return true;
      } catch {}
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(plain);
        return true;
      } catch {}
    }
    const ta = document.createElement('textarea');
    ta.value = plain;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return true;
  })()`)
}

export class PageInitScriptRegistry {
  private readonly session: TabCDPSession
  private readonly evaluate: <T = unknown>(expression: string) => Promise<T>
  private entries: InitScriptEntry[] = []

  constructor(session: TabCDPSession, evaluate: <T = unknown>(expression: string) => Promise<T>) {
    this.session = session
    this.evaluate = evaluate
  }

  async add(script: string, options: { runNow?: boolean } = {}): Promise<InitScriptEntry> {
    await this.session.ensureBaseDomains()
    const res = await this.session.send<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', {
      source: script,
    })
    const entry: InitScriptEntry = {
      id: res.identifier,
      preview: script.replace(/\s+/g, ' ').trim().slice(0, 100),
      createdAt: Date.now(),
    }
    this.entries.push(entry)
    if (options.runNow) await this.evaluate(script).catch(() => {})
    return entry
  }

  async remove(id: string): Promise<boolean> {
    await this.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id })
    const before = this.entries.length
    this.entries = this.entries.filter((s) => s.id !== id)
    return this.entries.length < before
  }

  list(): InitScriptEntry[] {
    return [...this.entries]
  }
}

export async function setPageViewport(
  session: TabCDPSession,
  width: number,
  height: number,
  deviceScaleFactor = 1,
  mobile = false,
): Promise<void> {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor,
    mobile,
  })
}

export async function emulatePageEnvironment(session: TabCDPSession, options: EmulateOptions): Promise<void> {
  if (options.width && options.height) {
    await setPageViewport(session, options.width, options.height, options.deviceScaleFactor ?? 1, options.mobile ?? false)
  }
  if (options.userAgent) {
    await session.send('Emulation.setUserAgentOverride', { userAgent: options.userAgent })
  }
  if (options.colorScheme) {
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: options.colorScheme }],
    })
  }
  if (options.cpuThrottlingRate !== undefined) {
    await session.send('Emulation.setCPUThrottlingRate', { rate: options.cpuThrottlingRate })
  }
  if (options.networkPreset) {
    await session.enableDomain('Network')
    const presets: Record<string, { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }> = {
      online: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
      'slow-3g': { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
      'fast-3g': { offline: false, latency: 562, downloadThroughput: 180_000, uploadThroughput: 84_000 },
      '4g': { offline: false, latency: 170, downloadThroughput: 1_500_000, uploadThroughput: 750_000 },
    }
    const cfg = presets[options.networkPreset]
    if (cfg) await session.send('Network.emulateNetworkConditions', cfg)
  }
  if (options.timezone) {
    await session.send('Emulation.setTimezoneOverride', { timezoneId: options.timezone })
  }
  if (options.locale) {
    await session.send('Emulation.setLocaleOverride', { locale: options.locale })
  }
  if (options.geolocation) {
    await session.send('Emulation.setGeolocationOverride', {
      latitude: options.geolocation.latitude,
      longitude: options.geolocation.longitude,
      accuracy: options.geolocation.accuracy ?? 50,
    })
  }
}

export async function getPageCookies(
  session: TabCDPSession,
  getUrlAndTitle: () => Promise<{ url: string; title: string }>,
  urls?: string[],
): Promise<Array<Record<string, unknown>>> {
  const targetUrls = urls ?? [(await getUrlAndTitle()).url].filter((u) => u.startsWith('http'))
  const res = await session.send<{ cookies: Array<Record<string, unknown>> }>('Network.getCookies', {
    urls: targetUrls,
  })
  return res.cookies ?? []
}

export async function setPageCookie(
  session: TabCDPSession,
  getUrlAndTitle: () => Promise<{ url: string; title: string }>,
  cookie: {
    name: string
    value: string
    url?: string
    domain?: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
    expires?: number
  },
): Promise<boolean> {
  const params: Record<string, unknown> = { ...cookie }
  if (!params.url && !params.domain) params.url = (await getUrlAndTitle()).url
  const res = await session.send<{ success?: boolean }>('Network.setCookie', params)
  return res.success !== false
}

export async function deletePageCookies(
  session: TabCDPSession,
  getUrlAndTitle: () => Promise<{ url: string; title: string }>,
  name: string,
  options: { url?: string; domain?: string; path?: string } = {},
): Promise<void> {
  const params: Record<string, unknown> = { name, ...options }
  if (!params.url && !params.domain) params.url = (await getUrlAndTitle()).url
  await session.send('Network.deleteCookies', params)
}

export async function getWebStorage(
  evaluate: <T = unknown>(expression: string) => Promise<T>,
  kind: 'local' | 'session',
): Promise<Record<string, string>> {
  const api = kind === 'local' ? 'localStorage' : 'sessionStorage'
  return await evaluate<Record<string, string>>(`(() => {
    const out = {};
    for (let i = 0; i < ${api}.length; i++) {
      const k = ${api}.key(i);
      if (k !== null) out[k] = ${api}.getItem(k) ?? '';
    }
    return out;
  })()`)
}

export async function setWebStorage(
  evaluate: <T = unknown>(expression: string) => Promise<T>,
  kind: 'local' | 'session',
  key: string,
  value: string,
): Promise<void> {
  const api = kind === 'local' ? 'localStorage' : 'sessionStorage'
  await evaluate(`${api}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
}

export async function clearWebStorage(
  evaluate: <T = unknown>(expression: string) => Promise<T>,
  kind: 'local' | 'session',
): Promise<void> {
  const api = kind === 'local' ? 'localStorage' : 'sessionStorage'
  await evaluate(`${api}.clear()`)
}
