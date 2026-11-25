import type { ExtensionConfig } from '@browserpilot/protocol'
import {
  connectBridge,
  disconnectTransport,
  resetBridgeBackoff,
  scheduleConnect,
  sendEvent,
  sendToBridge,
  setBridgeRpcExecutor,
} from './bg/bridge.js'
import { executeBridgeMethod } from './bg/rpc.js'
import {
  bgState,
  broadcastUiUpdate,
  CONTEXT_MENU_PIN_ID,
  getExtensionState,
  KEEPALIVE_ALARM,
  loadConfig,
  logActivity,
  pushControlBanner,
  registerStateHooks,
  saveConfig,
  updateBadge,
} from './bg/state.js'
import {
  detachTab,
  ensureAttached,
  persistAttachedTabs,
  restoreAttachedTabsOnBoot,
  ungroupTabIfManaged,
} from './bg/tabs.js'

// Wire state hooks and RPC executor (zero circular runtime dependencies)
registerStateHooks({
  emitEvent: sendEvent,
  onTransportConfigChanged: () => {
    disconnectTransport()
    scheduleConnect(100)
  },
})
setBridgeRpcExecutor(executeBridgeMethod)

// ============================================================================
// Chrome Event Listeners (CDP events, Detach, Popups, Context Menu, Downloads, UI IPC)
// ============================================================================

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId
  if (tabId === undefined) return
  const sessionId = (source as chrome.debugger.DebuggerSession).sessionId
  const p = (params as Record<string, unknown>) ?? {}

  const rec = bgState.attachedTabs.get(tabId)
  if (rec && method === 'Target.attachedToTarget' && typeof p.sessionId === 'string') {
    rec.childSessions.add(p.sessionId)
  } else if (rec && method === 'Target.detachedFromTarget' && typeof p.sessionId === 'string') {
    rec.childSessions.delete(p.sessionId)
  }

  if (method === 'Runtime.consoleAPICalled' && p.type === 'error') {
    const args = (p.args as Array<{ value?: unknown; description?: string }> | undefined) ?? []
    const text = args.map((a) => (a.value !== undefined ? String(a.value) : a.description || '')).join(' ').slice(0, 300)
    bgState.recentErrors.push({ timestamp: Date.now(), tabId, text })
    if (bgState.recentErrors.length > 100) bgState.recentErrors.splice(0, bgState.recentErrors.length - 100)
    broadcastUiUpdate()
  } else if (method === 'Runtime.exceptionThrown') {
    const d = (p.exceptionDetails ?? {}) as { text?: string; url?: string; exception?: { description?: string } }
    bgState.recentErrors.push({
      timestamp: Date.now(),
      tabId,
      text: (d.exception?.description || d.text || 'Uncaught exception').slice(0, 300),
      url: d.url,
    })
    if (bgState.recentErrors.length > 100) bgState.recentErrors.splice(0, bgState.recentErrors.length - 100)
    broadcastUiUpdate()
  } else if (method === 'Network.requestWillBeSent') {
    const req = (p.request ?? {}) as { url?: string; method?: string }
    if (typeof p.requestId === 'string' && req.url) {
      bgState.pendingRequestsByTab.set(`${tabId}:${p.requestId}`, { url: req.url, method: req.method || 'GET' })
      if (bgState.pendingRequestsByTab.size > 500) {
        const firstKey = bgState.pendingRequestsByTab.keys().next().value
        if (firstKey) bgState.pendingRequestsByTab.delete(firstKey)
      }
    }
  } else if (method === 'Network.responseReceived') {
    const res = (p.response ?? {}) as { status?: number; url?: string }
    if (typeof res.status === 'number' && res.status >= 400) {
      const reqInfo = typeof p.requestId === 'string' ? bgState.pendingRequestsByTab.get(`${tabId}:${p.requestId}`) : undefined
      bgState.recentFailedRequests.push({
        timestamp: Date.now(),
        tabId,
        method: reqInfo?.method || 'GET',
        status: res.status,
        url: res.url || reqInfo?.url || '',
      })
      if (bgState.recentFailedRequests.length > 100) bgState.recentFailedRequests.splice(0, bgState.recentFailedRequests.length - 100)
      broadcastUiUpdate()
    }
  } else if (method === 'Network.loadingFailed') {
    const reqInfo = typeof p.requestId === 'string' ? bgState.pendingRequestsByTab.get(`${tabId}:${p.requestId}`) : undefined
    bgState.recentFailedRequests.push({
      timestamp: Date.now(),
      tabId,
      method: reqInfo?.method || 'GET',
      url: reqInfo?.url || '',
      errorText: String(p.errorText || 'Failed'),
    })
    if (bgState.recentFailedRequests.length > 100) bgState.recentFailedRequests.splice(0, bgState.recentFailedRequests.length - 100)
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
  const rec = bgState.attachedTabs.get(tabId)
  bgState.attachedTabs.delete(tabId)
  void persistAttachedTabs()
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
  if (bgState.attachedTabs.has(tabId)) {
    bgState.attachedTabs.delete(tabId)
    void persistAttachedTabs()
    updateBadge()
    broadcastUiUpdate()
  }
  sendEvent('tab.removed', { tabId })
})

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  const opener = bgState.attachedTabs.get(details.sourceTabId)
  if (!opener || !bgState.config.autoAttach || bgState.config.paused) return
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

// Popup, Side Panel & Content Script IPC
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false
  const safeRespond = (payload: unknown): void => {
    try {
      sendResponse(payload)
    } catch {}
  }

  if (msg.type === 'browserpilot:get-tab-banner') {
    const tid = _sender.tab?.id
    const active = Boolean(tid !== undefined && bgState.attachedTabs.has(tid) && bgState.config.showHighlights)
    safeRespond({
      active,
      paused: bgState.config.paused,
      theme: bgState.config.theme,
      language: bgState.config.language ?? 'zh',
      status: (bgState.config.language ?? 'zh') === 'en' ? 'Active' : '运行中',
    })
    return false
  }
  if (msg.type === 'browserpilot:toggle-pause') {
    void saveConfig({ paused: !bgState.config.paused })
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
    void Promise.all(Array.from(bgState.attachedTabs.keys()).map((id) => detachTab(id)))
      .then(() => safeRespond({ ok: true }))
      .catch(() => safeRespond({ ok: false }))
    return true
  }
  if (msg.type === 'browserpilot:reconnect') {
    resetBridgeBackoff()
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
    if (bgState.transportMode === 'disconnected') {
      void connectBridge()
    } else {
      sendToBridge({ type: 'ping', ts: Date.now() })
    }
  }
})

// Boot sequence (restores debugger-attached tabs seamlessly across MV3 SW sleep/wake cycles)
void loadConfig()
  .then(() => restoreAttachedTabsOnBoot())
  .catch(() => {})
  .finally(() => {
    updateBadge()
    void connectBridge()
  })
