import type {
  HeapSummaryResult,
  PerformanceMetricsResult,
  TraceInsightResult,
  WebVitalsResult,
} from '@devpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'

interface RawTraceEvent {
  name?: string
  cat?: string
  ph?: string
  ts?: number
  dur?: number
}

interface CPUProfileNode {
  id: number
  callFrame?: { functionName?: string; url?: string; lineNumber?: number }
  hitCount?: number
  children?: number[]
}

export class PerformanceProfiler {
  private readonly session: TabCDPSession
  private tracingActive = false
  private traceEvents: RawTraceEvent[] = []
  private traceStartTs = 0
  private unsubTraceData: (() => void) | null = null

  constructor(session: TabCDPSession) {
    this.session = session
  }

  async getMetrics(): Promise<PerformanceMetricsResult> {
    await this.session.enableDomain('Performance').catch(() => {})
    const cdpRes = await this.session
      .send<{ metrics?: Array<{ name: string; value: number }> }>('Performance.getMetrics')
      .catch(() => ({ metrics: [] }))

    const cdpMetrics: Record<string, number> = {}
    for (const m of cdpRes.metrics ?? []) {
      cdpMetrics[m.name] = Math.round(m.value * 1000) / 1000
    }

    const pageRes = await this.session.send<{
      result?: { value?: { url: string; webVitals: WebVitalsResult } }
    }>('Runtime.evaluate', {
      returnByValue: true,
      awaitPromise: true,
      expression: `(async () => {
        const nav = performance.getEntriesByType('navigation')[0];
        const paints = performance.getEntriesByType('paint');
        const fcpEntry = paints.find((p) => p.name === 'first-contentful-paint');

        const vitals = {
          ttfbMs: nav ? Math.round(nav.responseStart) : undefined,
          domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : undefined,
          loadEventMs: nav && nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd) : undefined,
          fcpMs: fcpEntry ? Math.round(fcpEntry.startTime) : undefined,
        };

        // Read buffered LCP and CLS entries if supported
        try {
          let lcp = 0;
          const poLcp = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) lcp = entry.startTime;
          });
          poLcp.observe({ type: 'largest-contentful-paint', buffered: true });
          await new Promise((r) => setTimeout(r, 30));
          poLcp.disconnect();
          if (lcp > 0) vitals.lcpMs = Math.round(lcp);
        } catch {}

        try {
          let cls = 0;
          const poCls = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (!entry.hadRecentInput) cls += entry.value || 0;
            }
          });
          poCls.observe({ type: 'layout-shift', buffered: true });
          await new Promise((r) => setTimeout(r, 30));
          poCls.disconnect();
          vitals.cls = Math.round(cls * 10000) / 10000;
        } catch {}

        return { url: location.href, webVitals: vitals };
      })()`,
    })

    const mb = (bytes?: number) => (bytes !== undefined ? Math.round((bytes / (1024 * 1024)) * 100) / 100 : undefined)

    return {
      url: pageRes.result?.value?.url ?? '',
      webVitals: pageRes.result?.value?.webVitals ?? {},
      cdpMetrics,
      heapUsedMB: mb(cdpMetrics.JSHeapUsedSize),
      heapTotalMB: mb(cdpMetrics.JSHeapTotalSize),
      domNodes: cdpMetrics.Nodes,
      jsEventListeners: cdpMetrics.JSEventListeners,
      layoutCount: cdpMetrics.LayoutCount,
      recalcStyleCount: cdpMetrics.RecalcStyleCount,
    }
  }

  async getHeapSummary(): Promise<HeapSummaryResult> {
    const metrics = await this.getMetrics()
    const mem = await this.session.send<{
      result?: { value?: { used?: number; total?: number; limit?: number } }
    }>('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const m = performance.memory;
        return m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit } : {};
      })()`,
    })
    const m = mem.result?.value ?? {}
    const toMB = (bytes?: number) => Math.round(((bytes ?? 0) / (1024 * 1024)) * 100) / 100

    return {
      usedJSHeapSizeMB: metrics.heapUsedMB ?? toMB(m.used),
      totalJSHeapSizeMB: metrics.heapTotalMB ?? toMB(m.total),
      heapSizeLimitMB: toMB(m.limit),
      domNodes: metrics.domNodes ?? 0,
      documents: metrics.cdpMetrics.Documents ?? 0,
      jsEventListeners: metrics.jsEventListeners ?? 0,
    }
  }

  async startCPUProfile(): Promise<void> {
    await this.session.send('Profiler.enable')
    await this.session.send('Profiler.start')
  }

  async stopCPUProfile(): Promise<{
    durationMs: number
    topFunctions: Array<{ name: string; url: string; selfMs: number; hits: number }>
  }> {
    const res = await this.session.send<{
      profile?: { nodes?: CPUProfileNode[]; startTime?: number; endTime?: number; timeDeltas?: number[]; samples?: number[] }
    }>('Profiler.stop')
    await this.session.send('Profiler.disable').catch(() => {})

    const profile = res.profile
    if (!profile?.nodes) {
      return { durationMs: 0, topFunctions: [] }
    }

    const durationMs =
      profile.startTime !== undefined && profile.endTime !== undefined
        ? Math.round((profile.endTime - profile.startTime) / 1000)
        : 0

    const nodeMap = new Map<number, CPUProfileNode>()
    for (const n of profile.nodes) nodeMap.set(n.id, n)

    const selfTimeUs = new Map<number, number>()
    const hitCounts = new Map<number, number>()
    const samples = profile.samples ?? []
    const deltas = profile.timeDeltas ?? []
    for (let i = 0; i < samples.length; i++) {
      const id = samples[i]
      selfTimeUs.set(id, (selfTimeUs.get(id) ?? 0) + (deltas[i] ?? 0))
      hitCounts.set(id, (hitCounts.get(id) ?? 0) + 1)
    }

    const topFunctions = Array.from(selfTimeUs.entries())
      .map(([id, us]) => {
        const cf = nodeMap.get(id)?.callFrame
        return {
          name: cf?.functionName || '(anonymous)',
          url: cf?.url || '',
          selfMs: Math.round((us / 1000) * 10) / 10,
          hits: hitCounts.get(id) ?? 0,
        }
      })
      .filter((f) => f.name !== '(idle)' && f.name !== '(program)')
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 15)

    return { durationMs, topFunctions }
  }

  async startTrace(categories?: string[]): Promise<void> {
    if (this.tracingActive) {
      throw new Error('Performance trace is already running')
    }
    this.traceEvents = []
    this.traceStartTs = Date.now()
    this.unsubTraceData = this.session.on('Tracing.dataCollected', (params) => {
      const chunk = params.value as RawTraceEvent[] | undefined
      if (chunk?.length) this.traceEvents.push(...chunk)
    })

    const cats =
      categories?.join(',') ??
      'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-devtools.timeline'

    try {
      if (this.session.transport.sendBrowser) {
        await this.session.transport.sendBrowser('Tracing.start', {
          categories: cats,
          transferMode: 'ReportEvents',
        })
      } else {
        await this.session.send('Tracing.start', {
          categories: cats,
          transferMode: 'ReportEvents',
        })
      }
      this.tracingActive = true
    } catch (err) {
      this.unsubTraceData?.()
      this.unsubTraceData = null
      throw new Error(
        `Tracing.start failed (note: browser-wide Tracing may be restricted in extension mode; use CPU profile or Direct CDP mode): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async stopTrace(): Promise<TraceInsightResult> {
    if (!this.tracingActive) {
      throw new Error('No active performance trace to stop')
    }
    const completePromise = this.session.once('Tracing.tracingComplete', undefined, 15_000).catch(() => null)
    if (this.session.transport.sendBrowser) {
      await this.session.transport.sendBrowser('Tracing.end')
    } else {
      await this.session.send('Tracing.end')
    }
    await completePromise
    this.unsubTraceData?.()
    this.unsubTraceData = null
    this.tracingActive = false

    const durationMs = Date.now() - this.traceStartTs
    const events = this.traceEvents
    const minTs = events.reduce((min, e) => (e.ts && e.ts < min ? e.ts : min), Number.MAX_SAFE_INTEGER)

    const longTasks: TraceInsightResult['longTasks'] = []
    const categoryBreakdownMs: Record<string, number> = {}

    for (const e of events) {
      if (e.ph !== 'X' || !e.dur) continue
      const durMs = Math.round((e.dur / 1000) * 10) / 10
      const name = e.name ?? 'Unknown'
      if (durMs >= 50 && (name === 'RunTask' || name === 'EvaluateScript' || name === 'FunctionCall' || name === 'Layout' || name === 'UpdateLayoutTree' || name === 'Paint')) {
        longTasks.push({
          name,
          durationMs: durMs,
          startMs: e.ts ? Math.round((e.ts - minTs) / 1000) : 0,
          category: e.cat ?? '',
        })
      }
      if (name === 'EvaluateScript' || name === 'FunctionCall' || name === 'Layout' || name === 'UpdateLayoutTree' || name === 'Paint' || name === 'CompositeLayers' || name === 'MinorGC' || name === 'MajorGC') {
        categoryBreakdownMs[name] = Math.round(((categoryBreakdownMs[name] ?? 0) + durMs) * 10) / 10
      }
    }

    longTasks.sort((a, b) => b.durationMs - a.durationMs)
    const warnings: string[] = []
    if (longTasks.length > 0) {
      warnings.push(`Detected ${longTasks.length} main-thread long task(s) >= 50ms (max ${longTasks[0].durationMs}ms in ${longTasks[0].name}).`)
    }
    if ((categoryBreakdownMs.Layout ?? 0) > 100) {
      warnings.push(`High cumulative Layout time (${categoryBreakdownMs.Layout}ms) — check forced reflows.`)
    }

    return {
      durationMs,
      totalEvents: events.length,
      longTasks: longTasks.slice(0, 20),
      categoryBreakdownMs,
      warnings,
    }
  }
}
