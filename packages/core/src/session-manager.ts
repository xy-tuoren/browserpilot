import { createRequire } from 'node:module'
import util from 'node:util'
import vm from 'node:vm'
import {
  DEFAULT_TAB_GROUP_TITLE,
  isRestrictedUrl,
  TAB_GROUP_COLORS,
  type SessionInfo,
  type TabGroupColor,
  type TabInfo,
} from '@browserpilot/protocol'
import { formatConsoleLogs, type GetConsoleOptions } from './console-collector.js'
import { formatNetworkEntries, type GetNetworkOptions } from './network-inspector.js'
import { createDemoVideo } from './recorder.js'
import { formatStylesAsText } from './styles-inspector.js'
import { BrowserPilotTab } from './tab.js'
import type { CDPTransport } from './transport.js'
import { sleep, waitForPageLoad, waitForSelector, waitForText } from './wait.js'

const requireFromHere = createRequire(import.meta.url)

function colorForGroupName(name: string): TabGroupColor {
  if (name === DEFAULT_TAB_GROUP_TITLE) return 'green'
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return TAB_GROUP_COLORS[hash % TAB_GROUP_COLORS.length]
}

export interface SessionExecResult {
  stdout: string
  returnValue?: unknown
  error?: string
  durationMs: number
  uncaughtBrowserErrors: string[]
}

interface InternalSession {
  id: string
  tabGroup: string
  tabGroupColor: TabGroupColor
  state: Record<string, unknown>
  activeTabId?: number
  createdAt: number
  lastUsedAt: number
}

/**
 * Multi-session manager + isolated stateful JS execution sandbox.
 * Replaces Playwriter's `session new / exec -s <id> -e ...` with pure-CDP helpers.
 */
export class SessionManager {
  private readonly transport: CDPTransport
  private tabs = new Map<number, BrowserPilotTab>()
  private sessions = new Map<string, InternalSession>()
  private nextSessionNum = 1
  private unsubDetach?: () => void

  constructor(transport: CDPTransport) {
    this.transport = transport
    this.unsubDetach = transport.onTabDetached?.((tabId) => {
      const tab = this.tabs.get(tabId)
      if (tab) {
        tab.resetAfterDetach()
      }
    })
  }

  getTransport(): CDPTransport {
    return this.transport
  }

  getAttachedTabCount(): number {
    return this.tabs.size
  }

  async getOrAttachTab(
    tabId: number,
    options?: { tabGroup?: string; tabGroupColor?: TabGroupColor },
  ): Promise<BrowserPilotTab> {
    await this.transport.attachTab(tabId, options)
    let tab = this.tabs.get(tabId)
    if (!tab) {
      tab = new BrowserPilotTab(this.transport, tabId)
      this.tabs.set(tabId, tab)
    }
    await tab.ensureInitialized()
    return tab
  }

  async listTabs(): Promise<TabInfo[]> {
    return await this.transport.listTabs()
  }

  async openTab(options?: {
    url?: string
    active?: boolean
    tabGroup?: string
    tabGroupColor?: TabGroupColor
  }): Promise<BrowserPilotTab> {
    const info = await this.transport.createTab(options)
    return await this.getOrAttachTab(info.tabId, {
      tabGroup: options?.tabGroup,
      tabGroupColor: options?.tabGroupColor,
    })
  }

  async closeTab(tabId: number): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (tab) {
      tab.dispose()
      this.tabs.delete(tabId)
    }
    await this.transport.closeTab(tabId)
    for (const s of this.sessions.values()) {
      if (s.activeTabId === tabId) s.activeTabId = undefined
    }
  }

  /**
   * Resolves the target tab automatically (zero-click!):
   * explicit tabId -> session's activeTabId -> active Chrome tab -> first non-restricted tab -> create new tab.
   */
  async resolveActiveTab(options?: {
    tabId?: number
    sessionId?: string
    createIfNone?: boolean
  }): Promise<BrowserPilotTab> {
    const session = options?.sessionId ? this.sessions.get(options.sessionId) : undefined
    const groupOpts = session
      ? { tabGroup: session.tabGroup, tabGroupColor: session.tabGroupColor }
      : undefined

    if (options?.tabId !== undefined) {
      const tab = await this.getOrAttachTab(options.tabId, groupOpts)
      if (session) session.activeTabId = tab.tabId
      return tab
    }

    if (session?.activeTabId !== undefined) {
      const existingList = await this.listTabs()
      if (existingList.some((t) => t.tabId === session.activeTabId)) {
        return await this.getOrAttachTab(session.activeTabId, groupOpts)
      }
      session.activeTabId = undefined
    }

    const allTabs = await this.listTabs()
    const attachable = allTabs.filter((t) => !isRestrictedUrl(t.url))
    const candidate =
      attachable.find((t) => t.active && /^https?:\/\//i.test(t.url)) ??
      attachable.find((t) => t.active) ??
      attachable.find((t) => /^https?:\/\//i.test(t.url)) ??
      attachable[0]
    if (candidate) {
      const tab = await this.getOrAttachTab(candidate.tabId, groupOpts)
      if (session) session.activeTabId = tab.tabId
      return tab
    }

    if (options?.createIfNone !== false) {
      const created = await this.openTab({ url: 'about:blank', ...groupOpts })
      if (session) session.activeTabId = created.tabId
      return created
    }

    throw new Error('No accessible browser tabs available')
  }

  createSession(options?: { id?: string; tabGroup?: string; tabGroupColor?: TabGroupColor }): SessionInfo {
    const id = options?.id ?? String(this.nextSessionNum++)
    const tabGroup = options?.tabGroup?.trim() || DEFAULT_TAB_GROUP_TITLE
    const tabGroupColor = options?.tabGroupColor ?? colorForGroupName(tabGroup)
    const now = Date.now()
    const sess: InternalSession = {
      id,
      tabGroup,
      tabGroupColor,
      state: {},
      createdAt: now,
      lastUsedAt: now,
    }
    this.sessions.set(id, sess)
    return this.toSessionInfo(sess)
  }

  getOrCreateSession(id: string): InternalSession {
    let sess = this.sessions.get(id)
    if (!sess) {
      this.createSession({ id })
      sess = this.sessions.get(id)!
    }
    sess.lastUsedAt = Date.now()
    return sess
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => this.toSessionInfo(s))
  }

  resetSession(id: string): SessionInfo {
    const prev = this.sessions.get(id)
    const sess: InternalSession = {
      id,
      tabGroup: prev?.tabGroup ?? DEFAULT_TAB_GROUP_TITLE,
      tabGroupColor: prev?.tabGroupColor ?? 'green',
      state: {},
      activeTabId: undefined,
      createdAt: prev?.createdAt ?? Date.now(),
      lastUsedAt: Date.now(),
    }
    this.sessions.set(id, sess)
    return this.toSessionInfo(sess)
  }

  deleteSession(id: string): boolean {
    return this.sessions.delete(id)
  }

  private toSessionInfo(s: InternalSession): SessionInfo {
    return {
      id: s.id,
      tabGroup: s.tabGroup,
      tabGroupColor: s.tabGroupColor,
      stateKeys: Object.keys(s.state),
      activeTabId: s.activeTabId,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
    }
  }

  /**
   * Runs user/agent JavaScript in an isolated stateful session sandbox with full
   * pure-CDP automation and DevTools debugging helpers.
   */
  async exec(
    sessionId: string,
    code: string,
    options: { timeoutMs?: number; tabId?: number } = {},
  ): Promise<SessionExecResult> {
    const start = Date.now()
    const timeoutMs = options.timeoutMs ?? 30_000
    const sess = this.getOrCreateSession(sessionId)

    const logs: string[] = []
    const captureLog = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, maxArrayLength: 50 }))).join(' '))
    }

    const getTab = async (tabOrId?: BrowserPilotTab | number): Promise<BrowserPilotTab> => {
      if (tabOrId instanceof BrowserPilotTab) return tabOrId
      if (typeof tabOrId === 'number') return await this.resolveActiveTab({ tabId: tabOrId, sessionId })
      return await this.resolveActiveTab({ tabId: options.tabId, sessionId })
    }

    // Track initial error cursor on current tab (if any)
    const trackedTab = sess.activeTabId !== undefined ? this.tabs.get(sess.activeTabId) : undefined
    const beforeErrorId = trackedTab?.console.getLatestId() ?? 0

    const helpers = {
      state: sess.state,
      console: {
        log: captureLog,
        info: captureLog,
        warn: (...a: unknown[]) => captureLog('[warn]', ...a),
        error: (...a: unknown[]) => captureLog('[error]', ...a),
      },
      require: requireFromHere,
      setTimeout,
      clearTimeout,
      URL,
      Buffer,
      fetch,
      sleep,

      // Tab lifecycle helpers
      tabs: {
        list: () => this.listTabs(),
        open: async (url?: string) => {
          const t = await this.openTab({ url: url ?? 'about:blank', tabGroup: sess.tabGroup, tabGroupColor: sess.tabGroupColor })
          sess.activeTabId = t.tabId
          return t
        },
        use: async (tabIdOrUrl: number | string) => {
          if (typeof tabIdOrUrl === 'number') {
            const t = await this.resolveActiveTab({ tabId: tabIdOrUrl, sessionId })
            sess.activeTabId = t.tabId
            return t
          }
          const all = await this.listTabs()
          const match = [...all].reverse().find((t) => t.url.includes(tabIdOrUrl) || t.title.includes(tabIdOrUrl))
          if (!match) throw new Error(`No tab matching "${tabIdOrUrl}"`)
          const t = await this.resolveActiveTab({ tabId: match.tabId, sessionId })
          sess.activeTabId = t.tabId
          return t
        },
        current: () => getTab(),
        close: (tabId?: number) => this.closeTab(tabId ?? sess.activeTabId ?? -1),
      },

      // High-level helpers mirroring & expanding Playwriter's sandbox API
      snapshot: async (opts?: { tab?: BrowserPilotTab; search?: string | RegExp; showDiffSinceLastCall?: boolean; scope?: string }) => {
        const t = await getTab(opts?.tab)
        return (await t.snapshots.capture(t.session, opts)).text
      },
      screenshot: async (opts?: {
        tab?: BrowserPilotTab
        path?: string
        fullPage?: boolean
        maxDimension?: number
        grid?: boolean
        gridStep?: number
        zoom?: { x: number; y: number; width: number; height: number; scale?: number }
      }) => {
        const t = await getTab(opts?.tab)
        return await t.page.screenshot(opts)
      },
      handoff: async (message: string, opts?: { tab?: BrowserPilotTab; timeoutMs?: number }) => {
        const t = await getTab(opts?.tab)
        return await t.page.requestHumanHandoff(message, { timeoutMs: opts?.timeoutMs })
      },
      fillForm: async (
        fields: Array<{ target: string; value: string | boolean; type?: 'auto' | 'text' | 'select' | 'checkbox' | 'radio' }>,
        opts?: { tab?: BrowserPilotTab },
      ) => {
        const t = await getTab(opts?.tab)
        return await t.page.fillForm(fields)
      },
      screenshotWithLabels: async (opts?: { tab?: BrowserPilotTab; path?: string; maxLabels?: number }) => {
        const t = await getTab(opts?.tab)
        return await t.captureLabeledScreenshot(opts)
      },
      cleanHTML: async (opts?: { tab?: BrowserPilotTab; selector?: string; search?: string | RegExp; showDiffSinceLastCall?: boolean; includeStyles?: boolean }) => {
        const t = await getTab(opts?.tab)
        return await t.extractor.getCleanHTML(t.session, opts)
      },
      markdown: async (opts?: { tab?: BrowserPilotTab; search?: string | RegExp; showDiffSinceLastCall?: boolean }) => {
        const t = await getTab(opts?.tab)
        return await t.extractor.getPageMarkdown(t.session, opts)
      },
      inspect: async (target: string, opts?: { tab?: BrowserPilotTab; properties?: string[] }) => {
        const t = await getTab(opts?.tab)
        return (await t.extractor.inspectElement(t.session, t.snapshots, target, opts?.properties)).formatted
      },
      getLatestLogs: async (opts?: GetConsoleOptions & { tab?: BrowserPilotTab }) => {
        const t = await getTab(opts?.tab)
        return formatConsoleLogs(t.console.getLogs(opts))
      },
      getNetwork: async (opts?: GetNetworkOptions & { tab?: BrowserPilotTab }) => {
        const t = await getTab(opts?.tab)
        return formatNetworkEntries(t.network.getRequests(opts))
      },
      getStyles: async (target: string, opts?: { tab?: BrowserPilotTab; includeInherited?: boolean; computedProperties?: string[] }) => {
        const t = await getTab(opts?.tab)
        const styles = await t.styles.getStyles(target, t.snapshots, opts)
        return formatStylesAsText(styles)
      },
      getReactInfo: async (target: string, opts?: { tab?: BrowserPilotTab }) => {
        const t = await getTab(opts?.tab)
        return await t.getReactInfo(target)
      },
      waitForPageLoad: async (opts?: { tab?: BrowserPilotTab; timeoutMs?: number }) => {
        const t = await getTab(opts?.tab)
        return await waitForPageLoad(t.session, opts)
      },
      waitForSelector: async (selector: string, opts?: { tab?: BrowserPilotTab; timeoutMs?: number }) => {
        const t = await getTab(opts?.tab)
        return await waitForSelector(t.session, selector, opts)
      },
      waitForText: async (text: string | RegExp, opts?: { tab?: BrowserPilotTab; timeoutMs?: number }) => {
        const t = await getTab(opts?.tab)
        return await waitForText(t.session, text, opts)
      },
      cdp: async (method: string, params?: Record<string, unknown>, tab?: BrowserPilotTab) => {
        const t = await getTab(tab)
        return await t.session.send(method, params)
      },
      downloads: {
        configure: async (downloadDir?: string, tab?: BrowserPilotTab) => (await getTab(tab)).downloads.configure(downloadDir),
        list: async (tab?: BrowserPilotTab) => (await getTab(tab)).downloads.list(),
        waitFor: async (opts?: { timeoutMs?: number; filenamePattern?: string | RegExp; tab?: BrowserPilotTab }) =>
          (await getTab(opts?.tab)).downloads.waitForDownload(opts),
      },
      actionRecorder: {
        start: async (opts?: { maskPasswords?: boolean; tab?: BrowserPilotTab }) =>
          (await getTab(opts?.tab)).actionRecorder.start(opts),
        stop: async (tab?: BrowserPilotTab) => (await getTab(tab)).actionRecorder.stop(),
        steps: async (tab?: BrowserPilotTab) => (await getTab(tab)).actionRecorder.getSteps(),
      },
      createDemoVideo,
    }

    const context = vm.createContext(helpers)
    const wrapped = `(async () => {\n${code}\n})()`

    try {
      const script = new vm.Script(wrapped, { filename: `browserpilot-session-${sessionId}.js` })
      const promise = script.runInContext(context, { timeout: timeoutMs }) as Promise<unknown>
      const returnValue = await Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Execution timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ])

      const activeTabAfter = sess.activeTabId !== undefined ? this.tabs.get(sess.activeTabId) : trackedTab
      const uncaughtBrowserErrors = activeTabAfter
        ? activeTabAfter.console.getErrorsSince(activeTabAfter === trackedTab ? beforeErrorId : 0).map((e) => e.text)
        : []

      return {
        stdout: logs.join('\n'),
        returnValue,
        durationMs: Date.now() - start,
        uncaughtBrowserErrors,
      }
    } catch (err) {
      return {
        stdout: logs.join('\n'),
        error: err instanceof Error ? err.stack || err.message : String(err),
        durationMs: Date.now() - start,
        uncaughtBrowserErrors: [],
      }
    }
  }

  dispose(): void {
    this.unsubDetach?.()
    for (const tab of this.tabs.values()) tab.dispose()
    this.tabs.clear()
    this.sessions.clear()
  }
}
