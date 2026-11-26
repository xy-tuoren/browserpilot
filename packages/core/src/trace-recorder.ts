import fs from 'node:fs/promises'
import path from 'node:path'
import {
  BROWSERPILOT_VERSION,
  generateBrowserPilotScript,
  generatePlaywrightScript,
  type BoundingBox,
  type RecordedActionType,
  type RecordedStep,
  type TraceData,
  type TraceNetworkEntry,
  type TraceStep,
  type TraceStopResult,
} from '@browserpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'
import type { ConsoleCollector } from './console-collector.js'
import type { NetworkInspector } from './network-inspector.js'
import type { PageActionReadyMeta, PageActionTraceInput, PageTraceHook } from './page/types.js'
import type { SnapshotEngine } from './snapshot.js'
import { renderTraceViewerHtml } from './trace-viewer.js'
import { sleep } from './wait.js'

export interface TraceStartOptions {
  title?: string
  screenshots?: boolean
  snapshots?: boolean
  networkBodies?: boolean
  jpegQuality?: number
}

function toRecordedAction(action: string): RecordedActionType | null {
  switch (action) {
    case 'navigate':
      return 'navigate'
    case 'click':
    case 'rightClick':
    case 'hover':
      return 'click'
    case 'dblclick':
      return 'dblclick'
    case 'check':
      return 'check'
    case 'uncheck':
      return 'uncheck'
    case 'fill':
    case 'type':
      return 'fill'
    case 'selectOption':
      return 'select_option'
    case 'pressKey':
      return 'press_key'
    case 'scroll':
      return 'scroll'
    default:
      return null
  }
}

/**
 * Playwright-style execution Trace Recorder capturing Before/After screenshots,
 * target coordinates & bounding boxes, DOM/AX summaries, Console logs, and
 * correlated Network requests (+ JSON/text response body previews).
 */
export class TraceRecorder implements PageTraceHook {
  private readonly session: TabCDPSession
  private readonly consoleCollector: ConsoleCollector
  private readonly networkInspector: NetworkInspector
  private readonly snapshotEngine: SnapshotEngine

  private active = false
  private startedAt = 0
  private initialUrl = ''
  private title = ''
  private opts: Required<TraceStartOptions> = {
    title: 'BrowserPilot Trace',
    screenshots: true,
    snapshots: true,
    networkBodies: true,
    jpegQuality: 58,
  }
  private steps: TraceStep[] = []
  private seenConsoleIds = new Set<number>()
  private seenNetworkIds = new Set<string>()
  private lastViewport: { width: number; height: number } = { width: 1280, height: 720 }

  constructor(deps: {
    session: TabCDPSession
    consoleCollector: ConsoleCollector
    networkInspector: NetworkInspector
    snapshotEngine: SnapshotEngine
  }) {
    this.session = deps.session
    this.consoleCollector = deps.consoleCollector
    this.networkInspector = deps.networkInspector
    this.snapshotEngine = deps.snapshotEngine
  }

  isActive(): boolean {
    return this.active
  }

  getStatus(): { active: boolean; stepCount: number; startedAt?: number; title?: string } {
    return {
      active: this.active,
      stepCount: this.steps.length,
      ...(this.active ? { startedAt: this.startedAt, title: this.title } : {}),
    }
  }

  async start(options: TraceStartOptions = {}): Promise<{ startedAt: number; url: string; title: string }> {
    if (this.active) {
      throw new Error('Trace recorder is already running on this tab')
    }
    await this.session.ensureBaseDomains()
    this.startedAt = Date.now()
    this.steps = []
    this.seenConsoleIds.clear()
    this.seenNetworkIds.clear()

    // Seed baseline console & network IDs so pre-trace history isn't lumped into Step #1
    for (const c of this.consoleCollector.getLogs({ count: 5000 })) {
      this.seenConsoleIds.add(c.id)
    }
    for (const n of this.networkInspector.getRequests({ count: 2000 })) {
      this.seenNetworkIds.add(n.requestId)
    }

    const meta = await this.readPageMeta()
    this.initialUrl = meta.url
    this.lastViewport = meta.viewport
    this.title = options.title || meta.title || meta.url || `Tab #${this.session.tabId} Trace`
    this.opts = {
      title: this.title,
      screenshots: options.screenshots !== false,
      snapshots: options.snapshots !== false,
      networkBodies: options.networkBodies !== false,
      jpegQuality: options.jpegQuality ?? 58,
    }
    this.active = true
    return { startedAt: this.startedAt, url: this.initialUrl, title: this.title }
  }

  private async readPageMeta(): Promise<{ url: string; title: string; viewport: { width: number; height: number } }> {
    const res = await this.session
      .send<{ result?: { value?: { url: string; title: string; vw: number; vh: number } } }>('Runtime.evaluate', {
        expression:
          '({ url: location.href, title: document.title, vw: window.innerWidth || 1280, vh: window.innerHeight || 720 })',
        returnByValue: true,
      })
      .catch(() => null)
    const v = res?.result?.value
    return {
      url: v?.url ?? '',
      title: v?.title ?? '',
      viewport: { width: v?.vw || 1280, height: v?.vh || 720 },
    }
  }

  private async captureFastScreenshot(): Promise<string | undefined> {
    if (!this.opts.screenshots) return undefined
    const res = await this.session
      .send<{ data?: string }>(
        'Page.captureScreenshot',
        {
          format: 'jpeg',
          quality: this.opts.jpegQuality,
          optimizeForSpeed: true,
        },
        { timeoutMs: 4_000 },
      )
      .catch(() => null)
    return res?.data ? `data:image/jpeg;base64,${res.data}` : undefined
  }

  private async collectStepNetwork(): Promise<TraceNetworkEntry[]> {
    const all = this.networkInspector.getRequests({ count: 2000 })
    const fresh = all.filter((n) => !this.seenNetworkIds.has(n.requestId))
    const out: TraceNetworkEntry[] = []
    for (const item of fresh) {
      this.seenNetworkIds.add(item.requestId)
      const entry: TraceNetworkEntry = { ...item }
      const isApiLike =
        this.opts.networkBodies &&
        !item.failed &&
        (item.resourceType === 'XHR' ||
          item.resourceType === 'Fetch' ||
          (item.mimeType && /json|text|xml|graphql/i.test(item.mimeType)))
      if (isApiLike) {
        const body = await this.networkInspector.getResponseBody(item.requestId).catch(() => null)
        if (body && !body.base64Encoded && body.body) {
          entry.responseBodyPreview = body.body.length > 4096 ? `${body.body.slice(0, 4096)}…` : body.body
        }
      }
      out.push(entry)
    }
    return out
  }

  private collectStepConsole() {
    const all = this.consoleCollector.getLogs({ count: 5000 })
    const fresh = all.filter((c) => !this.seenConsoleIds.has(c.id))
    for (const c of fresh) this.seenConsoleIds.add(c.id)
    return fresh
  }

  async runStep<T>(
    input: PageActionTraceInput,
    fn: (markReady: (meta?: PageActionReadyMeta) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    if (!this.active) {
      return await fn(async () => {})
    }

    const startedAt = Date.now()
    const beforeMeta = await this.readPageMeta()
    this.lastViewport = beforeMeta.viewport

    let beforeScreenshot: string | undefined
    let point: { x: number; y: number } | undefined = input.point
    let box: BoundingBox | undefined = input.box
    let readyCaptured = false

    const markReady = async (meta?: PageActionReadyMeta): Promise<void> => {
      if (meta?.point) point = meta.point
      if (meta?.box) box = meta.box
      if (!readyCaptured) {
        readyCaptured = true
        const m = await this.readPageMeta()
        this.lastViewport = m.viewport
        beforeScreenshot = await this.captureFastScreenshot()
      }
    }

    if (input.captureBeforeImmediately) {
      await markReady()
    }

    let status: 'ok' | 'error' = 'ok'
    let errorText: string | undefined
    try {
      const result = await fn(markReady)
      await sleep(35)
      return result
    } catch (err) {
      status = 'error'
      errorText = err instanceof Error ? err.stack || err.message : String(err)
      if (!readyCaptured) {
        beforeScreenshot = await this.captureFastScreenshot()
      }
      throw err
    } finally {
      const endedAt = Date.now()
      const afterMeta = await this.readPageMeta()
      const afterScreenshot = await this.captureFastScreenshot()
      let domSummary: string | undefined
      if (this.opts.snapshots) {
        const snap = await this.snapshotEngine
          .capture(this.session, { showDiffSinceLastCall: false, maxDepth: 14 })
          .catch(() => null)
        if (snap?.text) {
          domSummary = snap.text.length > 3500 ? `${snap.text.slice(0, 3500)}\n…(truncated)` : snap.text
        }
      }
      const consoleEntries = this.collectStepConsole()
      const networkEntries = await this.collectStepNetwork()

      const maskedValue =
        input.action === 'fill' && input.target && /password|passwd|pwd|secret|token/i.test(input.target)
          ? '<REDACTED>'
          : input.value

      const step: TraceStep = {
        index: this.steps.length,
        id: `step_${this.steps.length + 1}`,
        action: input.action,
        title: input.title,
        startedAt,
        endedAt,
        durationMs: Math.max(1, endedAt - startedAt),
        status,
        ...(errorText ? { error: errorText } : {}),
        urlBefore: beforeMeta.url,
        urlAfter: afterMeta.url,
        pageTitle: afterMeta.title || beforeMeta.title,
        ...(input.target ? { target: input.target } : {}),
        ...(maskedValue !== undefined ? { value: maskedValue } : {}),
        ...(input.key ? { key: input.key } : {}),
        ...(point ? { point } : {}),
        ...(box ? { box } : {}),
        viewport: this.lastViewport,
        ...(beforeScreenshot ? { beforeScreenshot } : {}),
        ...(afterScreenshot ? { afterScreenshot } : {}),
        ...(domSummary ? { domSummary } : {}),
        consoleEntries,
        networkEntries,
      }
      this.steps.push(step)
    }
  }

  async stop(options: { path?: string; format?: 'html' | 'json' } = {}): Promise<{
    data: TraceData
    html: string
    summary: TraceStopResult
  }> {
    if (!this.active) {
      throw new Error('Trace recorder is not running on this tab')
    }
    this.active = false
    const endedAt = Date.now()
    const finalMeta = await this.readPageMeta()

    // Attach any trailing console/network events since the last action onto the last step
    if (this.steps.length > 0) {
      const last = this.steps[this.steps.length - 1]
      last.consoleEntries.push(...this.collectStepConsole())
      last.networkEntries.push(...(await this.collectStepNetwork()))
    }

    const codegenSteps: RecordedStep[] = []
    if (this.initialUrl && this.initialUrl !== 'about:blank') {
      codegenSteps.push({ timestamp: this.startedAt, action: 'navigate', url: this.initialUrl })
    }
    for (const s of this.steps) {
      const mapped = toRecordedAction(s.action)
      if (!mapped) continue
      if (mapped === 'navigate' && codegenSteps.length === 1 && codegenSteps[0].url === s.urlAfter) {
        continue
      }
      codegenSteps.push({
        timestamp: s.startedAt,
        action: mapped,
        url: s.urlAfter || s.urlBefore,
        target: s.target,
        value: s.value,
        key: s.key,
        coordinates: s.point,
      })
    }

    const totalErrors = this.steps.reduce(
      (acc, s) =>
        acc +
        s.consoleEntries.filter((c) => c.level === 'error' || c.level === 'exception' || c.level === 'assert').length,
      0,
    )
    const totalNetworkRequests = this.steps.reduce((acc, s) => acc + s.networkEntries.length, 0)

    const data: TraceData = {
      version: 1,
      browserPilotVersion: BROWSERPILOT_VERSION,
      title: this.title,
      startedAt: this.startedAt,
      endedAt,
      durationMs: Math.max(1, endedAt - this.startedAt),
      initialUrl: this.initialUrl,
      finalUrl: finalMeta.url,
      tabId: this.session.tabId,
      viewport: this.lastViewport,
      steps: this.steps,
      totalErrors,
      totalNetworkRequests,
      playwrightScript: generatePlaywrightScript(codegenSteps, this.title),
      execScript: generateBrowserPilotScript(codegenSteps),
    }

    const html = renderTraceViewerHtml(data)
    const format = options.format ?? (options.path?.endsWith('.json') ? 'json' : 'html')
    const serialized = format === 'json' ? JSON.stringify(data, null, 2) : html
    const sizeBytes = Buffer.byteLength(serialized, 'utf8')

    let savedPath: string | undefined
    if (options.path) {
      savedPath = path.resolve(options.path)
      await fs.mkdir(path.dirname(savedPath), { recursive: true })
      await fs.writeFile(savedPath, serialized, 'utf8')
    }

    return {
      data,
      html,
      summary: {
        ...(savedPath ? { path: savedPath } : {}),
        durationMs: data.durationMs,
        stepCount: data.steps.length,
        errorCount: totalErrors + data.steps.filter((s) => s.status === 'error').length,
        networkCount: totalNetworkRequests,
        sizeBytes,
      },
    }
  }

  dispose(): void {
    this.active = false
    this.steps = []
  }
}
