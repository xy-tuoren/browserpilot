import {
  BridgeChunkReassembler,
  CDP_PROTOCOL_VERSION,
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  DEFAULT_TAB_GROUP_TITLE,
  BROWSERPILOT_VERSION,
  isBlockedProfileWideCommand,
  isRestrictedUrl,
  isUrlAllowedByDomainRules,
  MAX_ACTIVITY_BUFFER,
  NATIVE_HOST_NAME,
  type ActivityLogEntry,
  type BridgeEvent,
  type BridgeMessage,
  type BridgeRequest,
  type BridgeResponse,
  type ExtensionConfig,
  type ExtensionHelloMessage,
  type ExtensionState,
  type TabGroupColor,
  type TabInfo,
} from '@browserpilot/protocol'

declare const __BROWSERPILOT_DEFAULT_DAEMON_URL__: string
declare const __BROWSERPILOT_DEFAULT_TOKEN__: string

const STORAGE_CONFIG_KEY = 'browserpilot_config_v1'
const KEEPALIVE_ALARM = 'browserpilot-keepalive'
const CONTEXT_MENU_PIN_ID = 'browserpilot-pin-element'

const DEFAULT_CONFIG: ExtensionConfig = {
  theme: 'dark',
  autoAttach: true,
  paused: false,
  showHighlights: true,
  showGhostCursor: true,
  groupTabs: true,
  daemonUrl:
    typeof __BROWSERPILOT_DEFAULT_DAEMON_URL__ === 'string' && __BROWSERPILOT_DEFAULT_DAEMON_URL__
      ? __BROWSERPILOT_DEFAULT_DAEMON_URL__
      : `ws://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}/extension`,
  authToken: typeof __BROWSERPILOT_DEFAULT_TOKEN__ === 'string' ? __BROWSERPILOT_DEFAULT_TOKEN__ : '',
  domainRules: {
    blockedDomains: [],
    allowedDomains: [],
  },
}

interface AttachedTabRecord {
  tabId: number
  attachedAt: number
  tabGroup?: string
  tabGroupColor?: TabGroupColor
  groupedByExtension?: boolean
  assignedGroupId?: number
  childSessions: Set<string>
  lastPinnedVar?: string
}

let config: ExtensionConfig = { ...DEFAULT_CONFIG }
let nativePort: chrome.runtime.Port | null = null
let ws: WebSocket | null = null
let transportMode: 'native' | 'websocket' | 'disconnected' = 'disconnected'
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let nativeRetryAfter = 0
let nativeEverConnected = false
const chunkReassembler = new BridgeChunkReassembler()

const attachedTabs = new Map<number, AttachedTabRecord>()
const inFlightAttaches = new Map<number, Promise<AttachedTabRecord>>()
const recentActivity: ActivityLogEntry[] = []
const recentErrors: Array<{ timestamp: number; tabId: number; text: string; url?: string }> = []
const recentFailedRequests: Array<{
  timestamp: number
  tabId: number
  method: string
  status?: number
  url: string
  errorText?: string
}> = []
const pendingRequestsByTab = new Map<string, { url: string; method: string }>()
const tabGroupIds = new Map<string, number>()

// ============================================================================
// Logging & State Broadcast
// ============================================================================

function logActivity(action: string, status: ActivityLogEntry['status'], detail?: string, tabId?: number, durationMs?: number): void {
  const entry: ActivityLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    tabId,
    action,
    detail,
    status,
    durationMs,
  }
  recentActivity.push(entry)
  if (recentActivity.length > MAX_ACTIVITY_BUFFER) {
    recentActivity.splice(0, recentActivity.length - MAX_ACTIVITY_BUFFER)
  }
  sendEvent('activity.logged', { entry })
  broadcastUiUpdate()
}

async function getExtensionState(): Promise<ExtensionState> {
  const tabs = await listAllTabs()
  return {
    connected: transportMode !== 'disconnected',
    transport: transportMode,
    extensionId: chrome.runtime.id,
    version: BROWSERPILOT_VERSION,
    config,
    attachedTabs: tabs.filter((t) => t.attached),
    recentActivity: recentActivity.slice(-80),
    recentErrors: recentErrors.slice(-50),
    recentFailedRequests: recentFailedRequests.slice(-50),
  }
}

let wsConsecutiveFailures = 0

function broadcastUiUpdate(): void {
  const maybeSend = () => {
    void getExtensionState()
      .then((state) => {
        try {
          void chrome.runtime.sendMessage({ type: 'browserpilot:state-update', state }).catch(() => {})
        } catch {}
      })
      .catch(() => {})
  }

  // Chrome 116+: skip broadcasting state updates when neither Popup nor Side Panel is open
  if (typeof chrome.runtime.getContexts === 'function') {
    void chrome.runtime
      .getContexts({ contextTypes: ['POPUP', 'SIDE_PANEL'] as chrome.runtime.ContextType[] })
      .then((contexts) => {
        if (contexts.length > 0) maybeSend()
      })
      .catch(() => {})
    return
  }
  maybeSend()
}

function updateBadge(): void {
  if (config.paused) {
    void chrome.action.setBadgeText({ text: 'OFF' }).catch(() => {})
    void chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }).catch(() => {})
    return
  }
  if (transportMode === 'disconnected') {
    void chrome.action.setBadgeText({ text: '' }).catch(() => {})
    return
  }
  const count = attachedTabs.size
  void chrome.action.setBadgeText({ text: count > 0 ? String(count) : 'ON' }).catch(() => {})
  void chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#10b981' : '#0ea5e9' }).catch(() => {})
}

// ============================================================================
// Configuration Persistence
// ============================================================================

async function loadConfig(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_CONFIG_KEY)
  const saved = stored[STORAGE_CONFIG_KEY] as Partial<ExtensionConfig> | undefined
  if (saved) {
    config = {
      ...DEFAULT_CONFIG,
      ...saved,
      domainRules: {
        blockedDomains: saved.domainRules?.blockedDomains ?? [],
        allowedDomains: saved.domainRules?.allowedDomains ?? [],
      },
    }
  }
}

function pushControlBanner(
  tabId: number,
  opts: { active: boolean; status?: string; mode?: 'working' | 'handoff' },
): void {
  const show = opts.active && config.showHighlights
  void chrome.tabs
    .sendMessage(tabId, {
      type: 'browserpilot:control-banner',
      active: show,
      status: opts.status,
      paused: config.paused,
      theme: config.theme,
      mode: opts.mode ?? 'working',
    })
    .catch(() => {})
}

function broadcastBannerToAttachedTabs(): void {
  for (const tabId of attachedTabs.keys()) {
    pushControlBanner(tabId, { active: true })
  }
}

async function saveConfig(patch: Partial<ExtensionConfig>): Promise<ExtensionConfig> {
  const prevUrl = config.daemonUrl
  const prevToken = config.authToken
  config = {
    ...config,
    ...patch,
    domainRules: patch.domainRules
      ? {
          blockedDomains: patch.domainRules.blockedDomains ?? config.domainRules.blockedDomains,
          allowedDomains: patch.domainRules.allowedDomains ?? config.domainRules.allowedDomains,
        }
      : config.domainRules,
  }
  await chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: config })
  updateBadge()
  broadcastUiUpdate()
  broadcastBannerToAttachedTabs()

  if (config.daemonUrl !== prevUrl || config.authToken !== prevToken) {
    disconnectTransport()
    scheduleConnect(100)
  }
  return config
}

// ============================================================================
// Dual Transport: Chrome Native Messaging (primary) + Local Authenticated WS
// ============================================================================

function sendToBridge(msg: BridgeMessage): void {
  if (transportMode === 'native' && nativePort) {
    try {
      nativePort.postMessage(msg)
    } catch {
      handleTransportDisconnected('native')
    }
  } else if (transportMode === 'websocket' && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      handleTransportDisconnected('websocket')
    }
  }
}

function sendEvent(event: string, params?: Record<string, unknown>): void {
  if (transportMode === 'disconnected') return
  const msg: BridgeEvent = { type: 'event', event, params }
  sendToBridge(msg)
}

function sendHello(transport: 'native' | 'websocket'): void {
  const hello: ExtensionHelloMessage = {
    type: 'hello',
    token: config.authToken,
    extensionId: chrome.runtime.id,
    extensionVersion: BROWSERPILOT_VERSION,
    browser: navigator.userAgent.includes('Edg/')
      ? 'Edge'
      : navigator.userAgent.includes('Brave')
        ? 'Brave'
        : 'Chrome',
    transport,
  }
  sendToBridge(hello)
}

function startHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => {
    if (transportMode !== 'disconnected') {
      sendToBridge({ type: 'ping', ts: Date.now() })
    }
  }, 18_000)
}

function disconnectTransport(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (nativePort) {
    try {
      nativePort.disconnect()
    } catch {}
    nativePort = null
  }
  if (ws) {
    try {
      ws.close()
    } catch {}
    ws = null
  }
  transportMode = 'disconnected'
  updateBadge()
}

function handleTransportDisconnected(source: 'native' | 'websocket', wsOpened = true): void {
  if (source === 'native') {
    nativePort = null
    // If Native Messaging has worked before (or no WS token is configured), keep retrying native cleanly
    nativeRetryAfter = nativeEverConnected || !hasWebSocketToken() ? 0 : Date.now() + 30_000
  } else {
    ws = null
    if (!wsOpened) {
      wsConsecutiveFailures++
      // Prefer trying Native Messaging again before retrying a failing WS endpoint
      nativeRetryAfter = 0
    } else {
      wsConsecutiveFailures = 0
    }
  }
  if (transportMode === source) {
    transportMode = 'disconnected'
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    updateBadge()
    broadcastUiUpdate()
  }
  const nextDelay =
    source === 'native'
      ? nativeEverConnected
        ? 1_500
        : hasWebSocketToken()
          ? 2_000
          : 5_000
      : wsOpened
        ? 2_000
        : Math.min(30_000, 5_000 * wsConsecutiveFailures)
  scheduleConnect(nextDelay)
}

function scheduleConnect(delayMs: number): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connectBridge()
  }, delayMs)
}

function hasWebSocketToken(): boolean {
  if (config.authToken.trim()) return true
  try {
    const url = new URL(config.daemonUrl)
    return Boolean(url.searchParams.get('token')?.trim())
  } catch {
    return false
  }
}

async function connectBridge(): Promise<void> {
  if (transportMode !== 'disconnected') return

  // 1. Try Native Messaging first (if not in cooldown)
  if (Date.now() >= nativeRetryAfter && typeof chrome.runtime.connectNative === 'function') {
    try {
      const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
      nativePort = port
      transportMode = 'native'

      let receivedValidTraffic = false
      port.onMessage.addListener((msg: unknown) => {
        receivedValidTraffic = true
        nativeEverConnected = true
        wsConsecutiveFailures = 0
        void handleBridgeMessage(msg as BridgeMessage)
      })
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError?.message
        if (!receivedValidTraffic) {
          nativePort = null
          if (transportMode === 'native') transportMode = 'disconnected'
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer)
            heartbeatTimer = null
          }
          updateBadge()
          broadcastUiUpdate()
          const nativeHostMissing = Boolean(err && /not found|forbidden|invalid/i.test(err))
          if (nativeHostMissing && !nativeEverConnected && hasWebSocketToken()) {
            // Native host not installed; fall back to authenticated WebSocket
            nativeRetryAfter = Date.now() + 60_000
            void connectWebSocket()
          } else {
            // Native Messaging mode (or transient host exit): retry native cleanly without WS errors
            const delay = nativeEverConnected ? 1_500 : nativeHostMissing ? 10_000 : 3_000
            nativeRetryAfter = Date.now() + delay
            scheduleConnect(delay)
          }
          return
        }
        handleTransportDisconnected('native')
      })

      sendHello('native')
      startHeartbeat()
      updateBadge()
      broadcastUiUpdate()
      return
    } catch {
      nativeRetryAfter = Date.now() + 60_000
    }
  }

  // 2. Fallback to authenticated local WebSocket daemon (only when an auth token is configured)
  await connectWebSocket()
}

async function connectWebSocket(): Promise<void> {
  if (transportMode !== 'disconnected') return
  if (!config.daemonUrl) return

  let url: URL
  try {
    url = new URL(config.daemonUrl)
  } catch {
    return
  }

  const effectiveToken = config.authToken.trim() || url.searchParams.get('token')?.trim() || ''
  if (!effectiveToken) {
    // Avoid unauthenticated WS requests that cause Chrome 401/403 errors in chrome://extensions
    updateBadge()
    broadcastUiUpdate()
    scheduleConnect(nativeEverConnected ? 1_500 : 10_000)
    return
  }

  try {
    url.searchParams.set('token', effectiveToken)
    const socket = new WebSocket(url.toString())
    ws = socket
    let wsOpened = false

    socket.addEventListener('open', () => {
      if (ws !== socket) return
      wsOpened = true
      wsConsecutiveFailures = 0
      transportMode = 'websocket'
      sendHello('websocket')
      startHeartbeat()
      updateBadge()
      broadcastUiUpdate()
      logActivity('bridge.connect', 'info', `Connected via WebSocket (${config.daemonUrl})`)
    })

    socket.addEventListener('message', (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data)) as BridgeMessage
        void handleBridgeMessage(parsed)
      } catch {
        // ignore malformed message
      }
    })

    socket.addEventListener('close', () => {
      if (ws === socket) {
        handleTransportDisconnected('websocket', wsOpened)
      }
    })

    socket.addEventListener('error', () => {
      // close event will trigger reconnect
    })
  } catch {
    scheduleConnect(5_000)
  }
}

// ============================================================================
// Zero-Click Auto-Attach & Tab Management
// ============================================================================

async function listAllTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({})
  const out: TabInfo[] = []
  for (const t of tabs) {
    if (t.id === undefined) continue
    const rec = attachedTabs.get(t.id)
    out.push({
      tabId: t.id,
      windowId: t.windowId,
      url: t.url || t.pendingUrl || '',
      title: t.title || '',
      active: Boolean(t.active),
      attached: Boolean(rec),
      groupId: t.groupId !== undefined && t.groupId >= 0 ? t.groupId : undefined,
      groupTitle: rec?.tabGroup,
      openerTabId: t.openerTabId,
      status: t.status,
      favIconUrl: t.favIconUrl,
    })
  }
  return out
}

/**
 * Removes third-party chrome-extension:// iframes before attaching chrome.debugger
 * so extensions like password managers do not trigger Chromium's cross-extension attach error.
 */
async function removeForeignExtensionIframes(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (selfOrigin: string) => {
        for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
          const src = iframe.getAttribute('src') || ''
          if (src.startsWith('chrome-extension://') && !src.startsWith(selfOrigin)) {
            iframe.remove()
          }
        }
      },
      args: [chrome.runtime.getURL('')],
    })
  } catch {
    // Expected on blank or restricted pages
  }
}

async function assignTabGroup(
  tabId: number,
  groupTitle?: string,
  groupColor?: TabGroupColor,
): Promise<number | undefined> {
  if (!config.groupTabs) return undefined
  const title = (groupTitle || DEFAULT_TAB_GROUP_TITLE).trim()
  const color: chrome.tabGroups.ColorEnum = (groupColor || 'green') as chrome.tabGroups.ColorEnum
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    const windowId = tab?.windowId
    const cacheKey = windowId !== undefined ? `${windowId}:${title}` : title
    let existingGroupId = tabGroupIds.get(cacheKey)

    if (existingGroupId === undefined && chrome.tabGroups?.query) {
      const groups = await chrome.tabGroups
        .query(windowId !== undefined ? { title, windowId } : { title })
        .catch(() => [])
      if (groups.length > 0) {
        existingGroupId = groups[0].id
      }
    }

    let groupId: number
    if (existingGroupId !== undefined) {
      try {
        await chrome.tabGroups.get(existingGroupId)
        groupId = await chrome.tabs.group({ groupId: existingGroupId, tabIds: [tabId] })
      } catch {
        groupId = await chrome.tabs.group({ tabIds: [tabId] })
      }
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tabId] })
    }
    tabGroupIds.set(cacheKey, groupId)
    await chrome.tabGroups.update(groupId, { title, color })
    return groupId
  } catch {
    // Tab groups may be unsupported in minimal windows
    return undefined
  }
}

/**
 * Ungroups a tab if BrowserPilot placed it in a managed Tab Group.
 * Calling `chrome.tabs.ungroup()` before `chrome.tabs.remove()` (or on detach)
 * ensures modern Chrome dissolves empty groups cleanly instead of persisting
 * leftover "Saved Tab Groups" capsules in the user's bookmark bar.
 */
async function ungroupTabIfManaged(tabId: number, rec?: AttachedTabRecord): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab || tab.groupId === undefined || tab.groupId < 0) return

    let isManaged = Boolean(rec?.groupedByExtension)
    if (!isManaged) {
      for (const gid of tabGroupIds.values()) {
        if (gid === tab.groupId) {
          isManaged = true
          break
        }
      }
    }
    if (!isManaged && chrome.tabGroups?.get) {
      const grp = await chrome.tabGroups.get(tab.groupId).catch(() => null)
      if (grp?.title === DEFAULT_TAB_GROUP_TITLE || (rec?.tabGroup && grp?.title === rec.tabGroup)) {
        isManaged = true
      }
    }
    if (!isManaged) return

    const prevGroupId = tab.groupId
    await chrome.tabs.ungroup(tabId).catch(() => {})

    // Prune cache entry if Chrome dissolved the now-empty group
    if (chrome.tabGroups?.get) {
      const stillExists = await chrome.tabGroups.get(prevGroupId).catch(() => null)
      if (!stillExists) {
        for (const [k, v] of tabGroupIds.entries()) {
          if (v === prevGroupId) tabGroupIds.delete(k)
        }
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

async function ensureAttached(
  tabId: number,
  options?: { tabGroup?: string; tabGroupColor?: TabGroupColor },
): Promise<AttachedTabRecord> {
  if (config.paused) {
    throw new Error('BrowserPilot is paused by user in the extension popup.')
  }
  const existing = attachedTabs.get(tabId)
  if (existing) return existing

  const inflight = inFlightAttaches.get(tabId)
  if (inflight) return inflight

  const task = (async (): Promise<AttachedTabRecord> => {
    const tab = await chrome.tabs.get(tabId)
    const url = tab.url || tab.pendingUrl || ''
    if (isRestrictedUrl(url)) {
      throw new Error(`Cannot attach chrome.debugger to restricted URL: ${url}`)
    }
    if (url.startsWith('http') && !isUrlAllowedByDomainRules(url, config.domainRules)) {
      throw new Error(`Domain blocked by BrowserPilot domain rules: ${url}`)
    }

    await removeForeignExtensionIframes(tabId)

    try {
      await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/another debugger is already attached/i.test(msg)) {
        throw new Error(
          `Another debugger (Chrome DevTools or another extension such as Playwriter) is already attached to tab #${tabId}. Close DevTools / detach the other extension on that tab, or open a new tab.`,
        )
      }
      if (!/already attached/i.test(msg)) {
        throw err
      }
    }

    const rec: AttachedTabRecord = {
      tabId,
      attachedAt: Date.now(),
      tabGroup: options?.tabGroup,
      tabGroupColor: options?.tabGroupColor,
      childSessions: new Set(),
    }
    attachedTabs.set(tabId, rec)

    // Enable OOPIF child frame auto-attach immediately
    await chrome.debugger
      .sendCommand({ tabId }, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => {})

    if (options?.tabGroup) {
      const gid = await assignTabGroup(tabId, options.tabGroup, options.tabGroupColor)
      if (gid !== undefined) {
        rec.groupedByExtension = true
        rec.assignedGroupId = gid
      }
    }

    updateBadge()
    broadcastUiUpdate()
    pushControlBanner(tabId, { active: true, status: 'Active' })
    sendEvent('tab.attached', { tabId, url, title: tab.title || '' })
    logActivity('tab.attach', 'ok', `${tab.title || url || `Tab #${tabId}`}`, tabId)
    return rec
  })()

  inFlightAttaches.set(tabId, task)
  try {
    return await task
  } finally {
    inFlightAttaches.delete(tabId)
  }
}

async function detachTab(tabId: number): Promise<void> {
  const rec = attachedTabs.get(tabId)
  if (!rec) return
  attachedTabs.delete(tabId)
  pushControlBanner(tabId, { active: false })
  await ungroupTabIfManaged(tabId, rec)
  await chrome.debugger.detach({ tabId }).catch(() => {})
  updateBadge()
  broadcastUiUpdate()
  sendEvent('tab.detached', { tabId, reason: 'requested' })
  logActivity('tab.detach', 'info', `Detached tab #${tabId}`, tabId)
}

// ============================================================================
// Bridge RPC Dispatcher
// ============================================================================

async function handleBridgeMessage(msg: BridgeMessage): Promise<void> {
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'chunk') {
    let assembled: BridgeMessage | null = null
    try {
      assembled = chunkReassembler.push(msg)
    } catch {
      return
    }
    if (assembled) {
      await handleBridgeMessage(assembled)
    }
    return
  }

  if (msg.type === 'ping') {
    sendToBridge({ type: 'pong', ts: msg.ts })
    return
  }
  if (msg.type === 'pong') return
  if (msg.type === 'event') {
    if (msg.event === 'bridge.ready') {
      const ver = typeof msg.params?.version === 'string' ? ` (daemon v${msg.params.version})` : ''
      logActivity('bridge.ready', 'ok', `Connected via ${transportMode === 'native' ? 'Native Messaging' : 'WebSocket'}${ver}`)
      updateBadge()
      broadcastUiUpdate()
    }
    return
  }
  if (msg.type !== 'request') return

  const req = msg as BridgeRequest
  const start = Date.now()
  let response: BridgeResponse

  try {
    const result = await executeBridgeMethod(req.method, req.params ?? {})
    response = { type: 'response', id: req.id, ok: true, result }
    if (req.method !== 'cdp.send' && req.method !== 'tabs.list' && req.method !== 'extension.getState') {
      logActivity(req.method, 'ok', undefined, req.params?.tabId as number | undefined, Date.now() - start)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    response = {
      type: 'response',
      id: req.id,
      ok: false,
      error: { code: 'EXTENSION_ERROR', message },
    }
    logActivity(req.method, 'error', message, req.params?.tabId as number | undefined, Date.now() - start)
  }

  sendToBridge(response)
}

async function executeBridgeMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'tabs.list': {
      return { tabs: await listAllTabs() }
    }

    case 'tabs.create': {
      const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank'
      const active = params.active !== false
      const tabGroup =
        typeof params.tabGroup === 'string' && params.tabGroup.trim()
          ? params.tabGroup
          : config.groupTabs
            ? DEFAULT_TAB_GROUP_TITLE
            : undefined
      const tabGroupColor = params.tabGroupColor as TabGroupColor | undefined
      const tab = await chrome.tabs.create({ url, active })
      if (tab.id === undefined) throw new Error('Failed to create tab')
      if (config.autoAttach && !isRestrictedUrl(url)) {
        await ensureAttached(tab.id, { tabGroup, tabGroupColor })
      }
      const tabs = await listAllTabs()
      return tabs.find((t) => t.tabId === tab.id) ?? { tabId: tab.id, url, title: tab.title || '', active, attached: true }
    }

    case 'tabs.close': {
      const tabId = Number(params.tabId)
      const rec = attachedTabs.get(tabId)
      if (rec) {
        await detachTab(tabId)
      } else {
        await ungroupTabIfManaged(tabId)
      }
      await chrome.tabs.remove(tabId).catch(() => {})
      return { closed: true }
    }

    case 'tabs.activate': {
      const tabId = Number(params.tabId)
      const tab = await chrome.tabs.update(tabId, { active: true })
      if (tab?.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
      }
      return { activated: true }
    }

    case 'tabs.attach': {
      const tabId = Number(params.tabId)
      await ensureAttached(tabId, {
        tabGroup: params.tabGroup as string | undefined,
        tabGroupColor: params.tabGroupColor as TabGroupColor | undefined,
      })
      const tabs = await listAllTabs()
      return tabs.find((t) => t.tabId === tabId)
    }

    case 'tabs.detach': {
      await detachTab(Number(params.tabId))
      return { detached: true }
    }

    case 'cdp.send': {
      const tabId = Number(params.tabId)
      const cdpMethod = String(params.method ?? '')
      const cdpParams = (params.params as Record<string, unknown> | undefined) ?? undefined
      const sessionId = params.sessionId as string | undefined

      if (!cdpMethod) throw new Error('Missing CDP method')
      if (!params.allowUnsafeBrowserWide && isBlockedProfileWideCommand(cdpMethod)) {
        throw new Error(`Blocked destructive profile-wide CDP command: ${cdpMethod}`)
      }

      // Zero-click auto-attach!
      if (!attachedTabs.has(tabId)) {
        if (!config.autoAttach) {
          throw new Error(`Tab ${tabId} is not attached and autoAttach is disabled`)
        }
        await ensureAttached(tabId)
      }

      const target: chrome.debugger.DebuggerSession = sessionId ? { tabId, sessionId } : { tabId }
      const result = await chrome.debugger.sendCommand(target, cdpMethod, cdpParams)
      if (
        cdpMethod === 'Page.navigate' ||
        cdpMethod === 'Input.dispatchMouseEvent' ||
        cdpMethod === 'Input.insertText' ||
        cdpMethod === 'Runtime.evaluate'
      ) {
        logActivity(cdpMethod, 'ok', cdpMethod === 'Page.navigate' ? String(cdpParams?.url ?? '') : undefined, tabId)
      }
      return result ?? {}
    }

    case 'extension.getState': {
      return await getExtensionState()
    }

    case 'extension.setConfig': {
      return await saveConfig(params as Partial<ExtensionConfig>)
    }

    case 'extension.highlight': {
      if (!config.showHighlights) return { ok: true }
      const tabId = Number(params.tabId)
      await chrome.tabs.sendMessage(tabId, {
        type: 'browserpilot:highlight',
        box: params.box,
        label: params.label,
      }).catch(() => {})
      return { ok: true }
    }

    case 'extension.ghostCursor': {
      if (!config.showGhostCursor) return { ok: true }
      const tabId = Number(params.tabId)
      await chrome.tabs.sendMessage(tabId, {
        type: 'browserpilot:ghost-cursor',
        x: params.x,
        y: params.y,
        clicking: params.clicking,
      }).catch(() => {})
      return { ok: true }
    }

    case 'extension.setOverlayVisible': {
      const tabId = Number(params.tabId)
      await chrome.tabs.sendMessage(tabId, {
        type: 'browserpilot:set-overlay-visible',
        visible: Boolean(params.visible),
      }).catch(() => {})
      return { ok: true }
    }

    case 'extension.setControlBanner': {
      const tabId = Number(params.tabId)
      pushControlBanner(tabId, {
        active: Boolean(params.active),
        status: typeof params.status === 'string' ? params.status : undefined,
        mode: params.mode === 'handoff' ? 'handoff' : 'working',
      })
      return { ok: true }
    }

    case 'extension.getPinnedElement': {
      const tabId = Number(params.tabId)
      const rec = attachedTabs.get(tabId)
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      return rec?.lastPinnedVar ? { globalVar: rec.lastPinnedVar, url: tab?.url } : null
    }

    case 'downloads.list': {
      if (!chrome.downloads?.search) return { downloads: [] }
      const items = await chrome.downloads.search({ limit: 50, orderBy: ['-startTime'] })
      const downloads = items.map((d) => ({
        id: String(d.id),
        url: d.finalUrl || d.url || '',
        suggestedFilename: d.filename ? d.filename.split(/[\\/]/).pop() || d.filename : 'download.bin',
        filePath: d.filename || undefined,
        state: d.state === 'complete' ? 'completed' : d.state === 'interrupted' ? 'canceled' : 'in_progress',
        receivedBytes: d.bytesReceived ?? 0,
        totalBytes: d.totalBytes && d.totalBytes > 0 ? d.totalBytes : undefined,
        startedAt: d.startTime ? Date.parse(d.startTime) : Date.now(),
        completedAt: d.endTime ? Date.parse(d.endTime) : undefined,
      }))
      return { downloads }
    }

    default:
      throw new Error(`Unknown extension RPC method: ${method}`)
  }
}

// ============================================================================
// Chrome Event Listeners (CDP events, Detach, Popups, Context Menu, UI IPC)
// ============================================================================

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId
  if (tabId === undefined) return
  const sessionId = (source as chrome.debugger.DebuggerSession).sessionId
  const p = (params as Record<string, unknown>) ?? {}

  const rec = attachedTabs.get(tabId)
  if (rec && method === 'Target.attachedToTarget' && typeof p.sessionId === 'string') {
    rec.childSessions.add(p.sessionId)
  } else if (rec && method === 'Target.detachedFromTarget' && typeof p.sessionId === 'string') {
    rec.childSessions.delete(p.sessionId)
  }

  // Capture live errors & failed requests for the Companion Side Panel
  if (method === 'Runtime.consoleAPICalled' && p.type === 'error') {
    const args = (p.args as Array<{ value?: unknown; description?: string }> | undefined) ?? []
    const text = args.map((a) => (a.value !== undefined ? String(a.value) : a.description || '')).join(' ').slice(0, 300)
    recentErrors.push({ timestamp: Date.now(), tabId, text })
    if (recentErrors.length > 100) recentErrors.splice(0, recentErrors.length - 100)
    broadcastUiUpdate()
  } else if (method === 'Runtime.exceptionThrown') {
    const d = (p.exceptionDetails ?? {}) as { text?: string; url?: string; exception?: { description?: string } }
    recentErrors.push({
      timestamp: Date.now(),
      tabId,
      text: (d.exception?.description || d.text || 'Uncaught exception').slice(0, 300),
      url: d.url,
    })
    if (recentErrors.length > 100) recentErrors.splice(0, recentErrors.length - 100)
    broadcastUiUpdate()
  } else if (method === 'Network.requestWillBeSent') {
    const req = (p.request ?? {}) as { url?: string; method?: string }
    if (typeof p.requestId === 'string' && req.url) {
      pendingRequestsByTab.set(`${tabId}:${p.requestId}`, { url: req.url, method: req.method || 'GET' })
      if (pendingRequestsByTab.size > 500) {
        const firstKey = pendingRequestsByTab.keys().next().value
        if (firstKey) pendingRequestsByTab.delete(firstKey)
      }
    }
  } else if (method === 'Network.responseReceived') {
    const res = (p.response ?? {}) as { status?: number; url?: string }
    if (typeof res.status === 'number' && res.status >= 400) {
      const reqInfo = typeof p.requestId === 'string' ? pendingRequestsByTab.get(`${tabId}:${p.requestId}`) : undefined
      recentFailedRequests.push({
        timestamp: Date.now(),
        tabId,
        method: reqInfo?.method || 'GET',
        status: res.status,
        url: res.url || reqInfo?.url || '',
      })
      if (recentFailedRequests.length > 100) recentFailedRequests.splice(0, recentFailedRequests.length - 100)
      broadcastUiUpdate()
    }
  } else if (method === 'Network.loadingFailed') {
    const reqInfo = typeof p.requestId === 'string' ? pendingRequestsByTab.get(`${tabId}:${p.requestId}`) : undefined
    recentFailedRequests.push({
      timestamp: Date.now(),
      tabId,
      method: reqInfo?.method || 'GET',
      url: reqInfo?.url || '',
      errorText: String(p.errorText || 'Failed'),
    })
    if (recentFailedRequests.length > 100) recentFailedRequests.splice(0, recentFailedRequests.length - 100)
    broadcastUiUpdate()
  }

  sendEvent('cdp.event', {
    tabId,
    method,
    params: p,
    ...(sessionId ? { sessionId } : {}),
  })
})

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId
  if (tabId === undefined) return
  const rec = attachedTabs.get(tabId)
  attachedTabs.delete(tabId)
  if (reason !== 'target_closed') {
    pushControlBanner(tabId, { active: false })
    void ungroupTabIfManaged(tabId, rec)
  }
  updateBadge()
  broadcastUiUpdate()
  sendEvent('tab.detached', { tabId, reason })
  logActivity('tab.detached', 'info', `Tab #${tabId} detached (${reason})`, tabId)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (attachedTabs.has(tabId)) {
    attachedTabs.delete(tabId)
    updateBadge()
    broadcastUiUpdate()
  }
  sendEvent('tab.removed', { tabId })
})

// Auto-track popups opened by controlled tabs & keep them in the same tab group
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  const opener = attachedTabs.get(details.sourceTabId)
  if (!opener || !config.autoAttach || config.paused) return
  void ensureAttached(details.tabId, {
    tabGroup: opener.tabGroup,
    tabGroupColor: opener.tabGroupColor,
  })
    .then(() => {
      sendEvent('popup.opened', {
        openerTabId: details.sourceTabId,
        tabId: details.tabId,
        url: details.url,
      })
    })
    .catch(() => {})
})

// Right-click "Pin Element for BrowserPilot" context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_PIN_ID,
        title: 'Pin Element for BrowserPilot',
        contexts: ['all'],
      },
      () => {
        void chrome.runtime.lastError
      },
    )
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_PIN_ID || !tab?.id) return
  const tabId = tab.id
  void (async () => {
    const resp = (await chrome.tabs.sendMessage(tabId, { type: 'browserpilot:pin-last-right-clicked' }).catch(() => null)) as {
      globalVar?: string
      selector?: string
    } | null
    if (resp?.globalVar) {
      const rec = await ensureAttached(tabId).catch(() => null)
      if (rec) rec.lastPinnedVar = resp.globalVar
      logActivity('element.pin', 'ok', `${resp.globalVar} (${resp.selector ?? ''})`, tabId)
      sendEvent('element.pinned', { tabId, ...resp, url: tab.url })
    }
  })()
})

// Track browser downloads via chrome.downloads API and forward updates over the bridge
if (chrome.downloads?.onCreated) {
  const toDownloadEntry = (d: chrome.downloads.DownloadItem) => ({
    id: String(d.id),
    url: d.finalUrl || d.url || '',
    suggestedFilename: d.filename ? d.filename.split(/[\\/]/).pop() || d.filename : 'download.bin',
    filePath: d.filename || undefined,
    state: d.state === 'complete' ? 'completed' : d.state === 'interrupted' ? 'canceled' : 'in_progress',
    receivedBytes: d.bytesReceived ?? 0,
    totalBytes: d.totalBytes && d.totalBytes > 0 ? d.totalBytes : undefined,
    startedAt: d.startTime ? Date.parse(d.startTime) : Date.now(),
    completedAt: d.endTime ? Date.parse(d.endTime) : undefined,
  })

  chrome.downloads.onCreated.addListener((item) => {
    sendEvent('download.updated', { download: toDownloadEntry(item) })
  })

  chrome.downloads.onChanged.addListener((delta) => {
    void chrome.downloads
      .search({ id: delta.id })
      .then(([item]) => {
        if (item) {
          sendEvent('download.updated', { download: toDownloadEntry(item) })
          if (item.state === 'complete') {
            logActivity('download.complete', 'ok', item.filename || item.url)
          }
        }
      })
      .catch(() => {})
  })
}

// Popup & Side Panel IPC
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false
  const safeRespond = (payload: unknown): void => {
    try {
      sendResponse(payload)
    } catch {
      // Sender tab/popup already closed
    }
  }

  if (msg.type === 'browserpilot:get-tab-banner') {
    const tid = _sender.tab?.id
    const active = Boolean(tid !== undefined && attachedTabs.has(tid) && config.showHighlights)
    safeRespond({
      active,
      paused: config.paused,
      theme: config.theme,
      status: 'Active',
    })
    return false
  }
  if (msg.type === 'browserpilot:toggle-pause') {
    void saveConfig({ paused: !config.paused })
      .then((cfg) => safeRespond({ ok: true, config: cfg }))
      .catch(() => safeRespond({ ok: false }))
    return true
  }
  if (msg.type === 'browserpilot:stop-this-tab') {
    const tid = _sender.tab?.id
    if (tid !== undefined) {
      void detachTab(tid)
        .then(() => safeRespond({ ok: true }))
        .catch(() => safeRespond({ ok: false }))
      return true
    }
    safeRespond({ ok: false })
    return false
  }
  if (msg.type === 'browserpilot:get-state') {
    void getExtensionState()
      .then((st) => safeRespond(st))
      .catch(() => safeRespond(null))
    return true
  }
  if (msg.type === 'browserpilot:update-config') {
    void saveConfig(msg.patch as Partial<ExtensionConfig>)
      .then((cfg) => safeRespond({ ok: true, config: cfg }))
      .catch(() => safeRespond({ ok: false }))
    return true
  }
  if (msg.type === 'browserpilot:detach-tab') {
    void detachTab(Number(msg.tabId))
      .then(() => safeRespond({ ok: true }))
      .catch(() => safeRespond({ ok: false }))
    return true
  }
  if (msg.type === 'browserpilot:detach-all') {
    void Promise.all(Array.from(attachedTabs.keys()).map((id) => detachTab(id)))
      .then(() => safeRespond({ ok: true }))
      .catch(() => safeRespond({ ok: false }))
    return true
  }
  if (msg.type === 'browserpilot:reconnect') {
    nativeRetryAfter = 0
    wsConsecutiveFailures = 0
    disconnectTransport()
    void connectBridge()
      .then(() => safeRespond({ ok: true }))
      .catch(() => safeRespond({ ok: false }))
    return true
  }
  if (msg.type === 'browserpilot:open-sidepanel') {
    void chrome.windows
      .getCurrent()
      .then((win) => {
        if (win.id !== undefined && chrome.sidePanel?.open) {
          return chrome.sidePanel.open({ windowId: win.id })
        }
      })
      .then(() => safeRespond({ ok: true }))
      .catch(() => safeRespond({ ok: false }))
    return true
  }
  if (msg.type === 'browserpilot:start-picker') {
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (tab?.id) {
          return chrome.tabs.sendMessage(tab.id, { type: 'browserpilot:start-picker' })
        }
      })
      .then(() => safeRespond({ ok: true }))
      .catch(() => safeRespond({ ok: false }))
    return true
  }
  if (msg.type === 'browserpilot:picked-element') {
    logActivity('element.picked', 'ok', `${msg.selector} (${msg.text ?? ''})`, _sender.tab?.id)
    sendEvent('element.picked', { tabId: _sender.tab?.id, ...msg })
    safeRespond({ ok: true })
    return false
  }
  return false
})

// MV3 Keepalive Alarm (Chrome 120+ enforces >= 0.5 min minimum period)
void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }).catch(() => {})
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (transportMode === 'disconnected') {
      void connectBridge()
    } else {
      sendToBridge({ type: 'ping', ts: Date.now() })
    }
  }
})

// Boot sequence
void loadConfig()
  .then(() => {
    updateBadge()
    void connectBridge()
  })
  .catch(() => {
    updateBadge()
    void connectBridge()
  })
