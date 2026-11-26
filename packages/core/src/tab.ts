import type { ActionFeedback } from '@browserpilot/protocol'
import { ActionRecorder } from './action-recorder.js'
import { TabCDPSession } from './cdp-client.js'
import { ConsoleCollector } from './console-collector.js'
import { DOMExtractor } from './dom-extract.js'
import { DownloadManager } from './downloads.js'
import { JSDebugger, LiveEditor } from './js-debugger.js'
import { Locator } from './locator.js'
import { NetworkInspector } from './network-inspector.js'
import { PageController } from './page-controller.js'
import { PerformanceProfiler } from './performance-profiler.js'
import { getReactComponentInfo } from './react-inspector.js'
import { ScreenRecorder } from './recorder.js'
import { SnapshotEngine } from './snapshot.js'
import { captureLabeledScreenshot } from './som-screenshot.js'
import { StylesInspector } from './styles-inspector.js'
import { TraceRecorder } from './trace-recorder.js'
import type { CDPTransport } from './transport.js'
import { sleep } from './wait.js'

/**
 * Unified per-tab controller bundling automation, perception, debugging,
 * performance profiling, recording, trace viewer capture, and automatic post-action feedback.
 */
export class BrowserPilotTab {
  readonly tabId: number
  readonly session: TabCDPSession
  readonly snapshots: SnapshotEngine
  readonly extractor: DOMExtractor
  readonly page: PageController
  readonly console: ConsoleCollector
  readonly network: NetworkInspector
  readonly styles: StylesInspector
  readonly debugger: JSDebugger
  readonly editor: LiveEditor
  readonly performance: PerformanceProfiler
  readonly recorder: ScreenRecorder
  readonly downloads: DownloadManager
  readonly actionRecorder: ActionRecorder
  readonly trace: TraceRecorder
  private initialized = false

  constructor(transport: CDPTransport, tabId: number) {
    this.tabId = tabId
    this.session = new TabCDPSession(transport, tabId)
    this.snapshots = new SnapshotEngine()
    this.extractor = new DOMExtractor()
    this.page = new PageController(this.session, this.snapshots)
    this.console = new ConsoleCollector(this.session)
    this.network = new NetworkInspector(this.session)
    this.styles = new StylesInspector(this.session)
    this.debugger = new JSDebugger(this.session)
    this.editor = new LiveEditor(this.session, this.debugger)
    this.performance = new PerformanceProfiler(this.session)
    this.recorder = new ScreenRecorder(this.session)
    this.downloads = new DownloadManager(this.session)
    this.actionRecorder = new ActionRecorder(this.session)
    this.trace = new TraceRecorder({
      session: this.session,
      consoleCollector: this.console,
      networkInspector: this.network,
      snapshotEngine: this.snapshots,
    })
    this.page.setTraceHook(this.trace)
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    await this.session.ensureBaseDomains()
    this.initialized = true
  }

  /**
   * Executes an action and returns high-signal post-action feedback
   * (current URL/title, newly thrown console errors, newly failed requests,
   * newly opened popup/blank tabs, and any JS dialogs that appeared).
   */
  async runWithFeedback<T>(
    action: () => Promise<T>,
    options: { settle?: boolean } = {},
  ): Promise<{ result: T; feedback: ActionFeedback }> {
    await this.ensureInitialized()
    const beforeLogId = this.console.getLatestId()
    const beforeTs = Date.now() - 1
    const beforeMeta = await this.page.getUrlAndTitle().catch(() => ({ url: '', title: '' }))
    const beforeTabs = new Set((await this.session.transport.listTabs().catch(() => [])).map((t) => t.tabId))

    let sawNavOrRequest = false
    const offNav = this.session.on('Page.frameNavigated', () => {
      sawNavOrRequest = true
    })
    const offReq = this.session.on('Network.requestWillBeSent', () => {
      sawNavOrRequest = true
    })

    this.recorder.markAction()
    let result: T
    try {
      result = await action()
      if (options.settle !== false) {
        // Brief adaptive settle: if action triggered a route change / XHR / popup, give it a beat to register
        await sleep(30)
        if (sawNavOrRequest) {
          await sleep(80)
        }
      }
    } finally {
      offNav()
      offReq()
    }

    const meta = await this.page.getUrlAndTitle().catch(() => beforeMeta)
    const afterTabs = await this.session.transport.listTabs().catch(() => [])
    const openedTabs = afterTabs
      .filter((t) => !beforeTabs.has(t.tabId))
      .map((t) => ({ tabId: t.tabId, url: t.url, title: t.title }))
    const dialogs = this.session.getDialogsSince(beforeTs).map((d) => ({
      type: d.type,
      message: d.message,
      url: d.url,
      handled: d.handled,
    }))

    return {
      result,
      feedback: {
        url: meta.url,
        title: meta.title,
        newConsoleErrors: this.console.getErrorsSince(beforeLogId),
        newFailedRequests: this.network.getFailedSince(beforeTs),
        ...(openedTabs.length ? { openedTabIds: openedTabs.map((t) => t.tabId), openedTabs } : {}),
        ...(dialogs.length ? { dialogs } : {}),
      },
    }
  }

  locator(selector: string): Locator {
    return new Locator(this.page, selector)
  }

  frameLocator(iframeSelector: string): Locator {
    return new Locator(this.page, iframeSelector)
  }

  async getReactInfo(target: string) {
    await this.ensureInitialized()
    return await getReactComponentInfo(this.session, this.snapshots, target)
  }

  async captureLabeledScreenshot(options?: { path?: string; maxLabels?: number; maxDimension?: number }) {
    await this.ensureInitialized()
    return await captureLabeledScreenshot(this.page, options)
  }

  resetAfterDetach(): void {
    this.initialized = false
    this.session.resetDomains()
  }

  dispose(): void {
    void this.recorder.cancel().catch(() => {})
    this.trace.dispose()
    this.downloads.dispose()
    this.actionRecorder.dispose()
    this.console.dispose()
    this.network.dispose()
    this.styles.dispose()
    this.debugger.dispose()
    this.snapshots.clearTab(this.tabId)
    this.extractor.clearTab(this.tabId)
    this.session.dispose()
  }
}
