import type { ActionFeedback } from '@browserpilot/protocol'
import { ActionRecorder } from './action-recorder.js'
import { TabCDPSession } from './cdp-client.js'
import { ConsoleCollector } from './console-collector.js'
import { DOMExtractor } from './dom-extract.js'
import { DownloadManager } from './downloads.js'
import { JSDebugger, LiveEditor } from './js-debugger.js'
import { NetworkInspector } from './network-inspector.js'
import { PageController } from './page-controller.js'
import { PerformanceProfiler } from './performance-profiler.js'
import { getReactComponentInfo } from './react-inspector.js'
import { ScreenRecorder } from './recorder.js'
import { SnapshotEngine } from './snapshot.js'
import { captureLabeledScreenshot } from './som-screenshot.js'
import { StylesInspector } from './styles-inspector.js'
import type { CDPTransport } from './transport.js'

/**
 * Unified per-tab controller bundling automation, perception, debugging,
 * performance profiling, recording, and automatic post-action feedback.
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
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    await this.session.ensureBaseDomains()
    this.initialized = true
  }

  /**
   * Executes an action and returns high-signal post-action feedback
   * (current URL/title, any newly thrown console errors, any newly failed requests).
   */
  async runWithFeedback<T>(action: () => Promise<T>): Promise<{ result: T; feedback: ActionFeedback }> {
    await this.ensureInitialized()
    const beforeLogId = this.console.getLatestId()
    const beforeTs = Date.now() - 1
    this.recorder.markAction()
    const result = await action()
    const meta = await this.page.getUrlAndTitle().catch(() => ({ url: '', title: '' }))
    return {
      result,
      feedback: {
        url: meta.url,
        title: meta.title,
        newConsoleErrors: this.console.getErrorsSince(beforeLogId),
        newFailedRequests: this.network.getFailedSince(beforeTs),
      },
    }
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
