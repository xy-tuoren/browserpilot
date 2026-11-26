import {
  BROWSERPILOT_VERSION,
  compressRecordedSteps,
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  MAX_ACTIVITY_BUFFER,
  type ActivityLogEntry,
  type ExtensionConfig,
  type ExtensionState,
  type RecordedStep,
  type TabGroupColor,
  type TabInfo,
} from '@browserpilot/protocol'

declare const __BROWSERPILOT_DEFAULT_DAEMON_URL__: string
declare const __BROWSERPILOT_DEFAULT_TOKEN__: string

export const STORAGE_CONFIG_KEY = 'browserpilot_config_v1'
export const STORAGE_ATTACHED_KEY = 'browserpilot_attached_tabs_v1'
export const KEEPALIVE_ALARM = 'browserpilot-keepalive'
export const CONTEXT_MENU_PIN_ID = 'browserpilot-pin-element'

export const DEFAULT_CONFIG: ExtensionConfig = {
  theme: 'dark',
  language: 'zh',
  profileLabel: '',
  approvalMode: 'off',
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

export interface AttachedTabRecord {
  tabId: number
  attachedAt: number
  tabGroup?: string
  tabGroupColor?: TabGroupColor
  groupedByExtension?: boolean
  assignedGroupId?: number
  childSessions: Set<string>
  lastPinnedVar?: string
}

export type TransportMode = 'native' | 'websocket' | 'disconnected'

export const bgState = {
  config: { ...DEFAULT_CONFIG } as ExtensionConfig,
  transportMode: 'disconnected' as TransportMode,
  attachedTabs: new Map<number, AttachedTabRecord>(),
  inFlightAttaches: new Map<number, Promise<AttachedTabRecord>>(),
  recentActivity: [] as ActivityLogEntry[],
  recentErrors: [] as Array<{ timestamp: number; tabId: number; text: string; url?: string }>,
  recentFailedRequests: [] as Array<{
    timestamp: number
    tabId: number
    method: string
    status?: number
    url: string
    errorText?: string
  }>,
  pendingRequestsByTab: new Map<string, { url: string; method: string }>(),
  tabGroupIds: new Map<string, number>(),
  codegen: {
    active: false,
    tabId: undefined as number | undefined,
    assertMode: false,
    steps: [] as RecordedStep[],
  },
}

let eventEmitter: ((event: string, params?: Record<string, unknown>) => void) | null = null
let reconnectTrigger: (() => void) | null = null

export function registerStateHooks(hooks: {
  emitEvent: (event: string, params?: Record<string, unknown>) => void
  onTransportConfigChanged: () => void
}): void {
  eventEmitter = hooks.emitEvent
  reconnectTrigger = hooks.onTransportConfigChanged
}

export async function listAllTabs(): Promise<TabInfo[]> {
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups?.query ? chrome.tabGroups.query({}).catch(() => []) : Promise.resolve([]),
  ])
  const groupTitleById = new Map<number, string>()
  for (const g of groups) {
    if (g.title) groupTitleById.set(g.id, g.title)
  }
  const out: TabInfo[] = []
  for (const t of tabs) {
    if (t.id === undefined) continue
    const rec = bgState.attachedTabs.get(t.id)
    const gid = t.groupId !== undefined && t.groupId >= 0 ? t.groupId : undefined
    out.push({
      tabId: t.id,
      windowId: t.windowId,
      url: t.url || t.pendingUrl || '',
      title: t.title || '',
      active: Boolean(t.active),
      attached: Boolean(rec),
      groupId: gid,
      groupTitle: (gid !== undefined ? groupTitleById.get(gid) : undefined) ?? rec?.tabGroup,
      openerTabId: t.openerTabId,
      status: t.status,
      favIconUrl: t.favIconUrl,
    })
  }
  return out
}

export async function getExtensionState(): Promise<ExtensionState> {
  const tabs = await listAllTabs()
  return {
    connected: bgState.transportMode !== 'disconnected',
    transport: bgState.transportMode,
    extensionId: chrome.runtime.id,
    version: BROWSERPILOT_VERSION,
    config: bgState.config,
    attachedTabs: tabs.filter((t) => t.attached),
    recentActivity: bgState.recentActivity.slice(-80),
    recentErrors: bgState.recentErrors.slice(-50),
    recentFailedRequests: bgState.recentFailedRequests.slice(-50),
    codegen: {
      active: bgState.codegen.active,
      tabId: bgState.codegen.tabId,
      assertMode: bgState.codegen.assertMode,
      steps: compressRecordedSteps(bgState.codegen.steps),
    },
  }
}

let uiBroadcastTimer: ReturnType<typeof setTimeout> | null = null
let uiBroadcastPending = false
let lastUiBroadcastAt = 0

function flushUiBroadcast(): void {
  lastUiBroadcastAt = Date.now()
  uiBroadcastPending = false
  const maybeSend = () => {
    void getExtensionState()
      .then((state) => {
        try {
          void chrome.runtime.sendMessage({ type: 'browserpilot:state-update', state }).catch(() => {})
        } catch {}
      })
      .catch(() => {})
  }

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

export function broadcastUiUpdate(immediate = false): void {
  const now = Date.now()
  if (immediate || now - lastUiBroadcastAt >= 120) {
    if (uiBroadcastTimer) {
      clearTimeout(uiBroadcastTimer)
      uiBroadcastTimer = null
    }
    flushUiBroadcast()
    return
  }
  uiBroadcastPending = true
  if (!uiBroadcastTimer) {
    uiBroadcastTimer = setTimeout(() => {
      uiBroadcastTimer = null
      if (uiBroadcastPending) flushUiBroadcast()
    }, 120)
  }
}

export function logActivity(
  action: string,
  status: ActivityLogEntry['status'],
  detail?: string,
  tabId?: number,
  durationMs?: number,
  step?: Record<string, unknown>,
): void {
  const entry: ActivityLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    tabId,
    action,
    detail,
    status,
    durationMs,
    ...(step ? { step } : {}),
  }
  bgState.recentActivity.push(entry)
  if (bgState.recentActivity.length > MAX_ACTIVITY_BUFFER) {
    bgState.recentActivity.splice(0, bgState.recentActivity.length - MAX_ACTIVITY_BUFFER)
  }
  eventEmitter?.('activity.logged', { entry })
  broadcastUiUpdate()
}

export function updateBadge(): void {
  if (bgState.config.paused) {
    void chrome.action.setBadgeText({ text: 'OFF' }).catch(() => {})
    void chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }).catch(() => {})
    return
  }
  if (bgState.transportMode === 'disconnected') {
    void chrome.action.setBadgeText({ text: '' }).catch(() => {})
    return
  }
  const count = bgState.attachedTabs.size
  void chrome.action.setBadgeText({ text: count > 0 ? String(count) : 'ON' }).catch(() => {})
  void chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#10b981' : '#0ea5e9' }).catch(() => {})
}

export function getContextMenuPinTitle(lang?: ExtensionConfig['language']): string {
  return lang === 'en' ? 'Pin Element for BrowserPilot' : '固定此元素到 BrowserPilot'
}

export function syncContextMenuLanguage(): void {
  if (!chrome.contextMenus?.update) return
  try {
    chrome.contextMenus.update(
      CONTEXT_MENU_PIN_ID,
      { title: getContextMenuPinTitle(bgState.config.language) },
      () => {
        void chrome.runtime.lastError
      },
    )
  } catch {}
}

let configLoaded = false
let configLoadInFlight: Promise<void> | null = null

export function loadConfig(): Promise<void> {
  if (configLoaded) return Promise.resolve()
  if (configLoadInFlight) return configLoadInFlight
  configLoadInFlight = (async () => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_CONFIG_KEY)
      const saved = stored[STORAGE_CONFIG_KEY] as Partial<ExtensionConfig> | undefined
      if (saved) {
        const approvalMode =
          saved.approvalMode === 'high-risk' || saved.approvalMode === 'strict' ? saved.approvalMode : 'off'
        bgState.config = {
          ...DEFAULT_CONFIG,
          ...saved,
          language: saved.language === 'en' ? 'en' : 'zh',
          approvalMode,
          profileLabel: typeof saved.profileLabel === 'string' ? saved.profileLabel : '',
          domainRules: {
            blockedDomains: saved.domainRules?.blockedDomains ?? [],
            allowedDomains: saved.domainRules?.allowedDomains ?? [],
            trustedDomains: saved.domainRules?.trustedDomains ?? [],
          },
        }
      }
      configLoaded = true
    } finally {
      configLoadInFlight = null
    }
  })()
  return configLoadInFlight
}

export function pushControlBanner(
  tabId: number,
  opts: { active: boolean; status?: string; mode?: 'working' | 'handoff' },
): void {
  const show = opts.active && bgState.config.showHighlights
  const payload = {
    type: 'browserpilot:control-banner',
    active: show,
    status: opts.status,
    paused: bgState.config.paused,
    theme: bgState.config.theme,
    language: bgState.config.language === 'en' ? 'en' : 'zh',
    mode: opts.mode ?? 'working',
  }
  void chrome.tabs.sendMessage(tabId, payload).catch(async () => {
    if (!show) {
      await chrome.scripting
        .executeScript({
          target: { tabId },
          func: () => {
            document.getElementById('__browserpilot_ui_host')?.remove()
          },
        })
        .catch(() => {})
      return
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] }).catch(() => {})
    await chrome.tabs.sendMessage(tabId, payload).catch(() => {})
  })
}

export function broadcastBannerToAttachedTabs(): void {
  for (const tabId of bgState.attachedTabs.keys()) {
    pushControlBanner(tabId, { active: true })
  }
}

export async function saveConfig(patch: Partial<ExtensionConfig>): Promise<ExtensionConfig> {
  const prevUrl = bgState.config.daemonUrl
  const prevToken = bgState.config.authToken
  const next = {
    ...bgState.config,
    ...patch,
    domainRules: patch.domainRules
      ? {
          blockedDomains: patch.domainRules.blockedDomains ?? bgState.config.domainRules.blockedDomains,
          allowedDomains: patch.domainRules.allowedDomains ?? bgState.config.domainRules.allowedDomains,
          trustedDomains: patch.domainRules.trustedDomains ?? bgState.config.domainRules.trustedDomains ?? [],
        }
      : bgState.config.domainRules,
  }
  next.language = next.language === 'en' ? 'en' : 'zh'
  next.approvalMode =
    next.approvalMode === 'high-risk' || next.approvalMode === 'strict' ? next.approvalMode : 'off'
  next.profileLabel = typeof next.profileLabel === 'string' ? next.profileLabel.trim() : ''
  bgState.config = next
  await chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: bgState.config })
  updateBadge()
  syncContextMenuLanguage()
  broadcastUiUpdate()
  broadcastBannerToAttachedTabs()
  eventEmitter?.('config.updated', {
    approvalMode: bgState.config.approvalMode,
    profileLabel: bgState.config.profileLabel || undefined,
    paused: bgState.config.paused,
  })

  if (bgState.config.daemonUrl !== prevUrl || bgState.config.authToken !== prevToken) {
    reconnectTrigger?.()
  }
  return bgState.config
}
