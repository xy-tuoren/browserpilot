import {
  compressRecordedSteps,
  isRestrictedUrl,
  type ExtensionConfig,
  type RecordedStep,
} from '@browserpilot/protocol'
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
  broadcastBannerToAttachedTabs,
  broadcastUiUpdate,
  CONTEXT_MENU_PIN_ID,
  getContextMenuPinTitle,
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

/**
 * Resolves the best target content tab (preferring the active tab in the last focused window,
 * skipping chrome:// or chrome-extension:// pages when Side Panel is open in its own tab/pane).
 */
async function resolveTargetContentTab(): Promise<chrome.tabs.Tab | undefined> {
  const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [])
  const primary = focused.find((t) => t.id !== undefined && !isRestrictedUrl(t.url))
  if (primary) return primary
  const all = await chrome.tabs.query({}).catch(() => [])
  return (
    all.find((t) => t.active && t.id !== undefined && !isRestrictedUrl(t.url)) ??
    all.find((t) => t.id !== undefined && !isRestrictedUrl(t.url))
  )
}

/**
 * Sends a message to a tab's content script, automatically injecting `content-script.js`
 * on the fly if the tab was already open before the extension was installed or reloaded.
 */
async function sendTabMessageEnsureInjected(tabId: number, payload: Record<string, unknown>): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, payload)
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] }).catch(() => {})
    await chrome.tabs.sendMessage(tabId, payload).catch(() => {})
  }
}

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
  if (bgState.codegen.active && bgState.codegen.tabId === tabId) {
    bgState.codegen.active = false
    bgState.codegen.assertMode = false
    broadcastUiUpdate()
  }
  sendEvent('tab.removed', { tabId })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!bgState.codegen.active || bgState.codegen.tabId !== tabId) return
  if (changeInfo.url && !isRestrictedUrl(changeInfo.url) && changeInfo.url !== 'about:blank') {
    bgState.codegen.steps.push({
      timestamp: Date.now(),
      action: 'navigate',
      url: changeInfo.url,
    })
    broadcastUiUpdate()
  }
  if (changeInfo.status === 'complete' && tab.url && !isRestrictedUrl(tab.url)) {
    void chrome.tabs
      .sendMessage(tabId, {
        type: 'browserpilot:set-codegen',
        active: true,
        assertMode: bgState.codegen.assertMode,
      })
      .catch(() => {})
  }
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
  void loadConfig()
    .catch(() => {})
    .finally(() => {
      chrome.contextMenus.removeAll(() => {
        void chrome.runtime.lastError
        chrome.contextMenus.create(
          {
            id: CONTEXT_MENU_PIN_ID,
            title: getContextMenuPinTitle(bgState.config.language),
            contexts: ['all'],
          },
          () => {
            void chrome.runtime.lastError
          },
        )
      })
    })

  // Remove any orphaned #__browserpilot_ui_host capsules left in active loaded http(s) tabs before extension reload
  // without waking discarded Memory-Saver tabs or injecting full scripts into unrelated pages
  void chrome.tabs
    .query({ url: ['http://*/*', 'https://*/*'] })
    .then(async (tabs) => {
      for (const t of tabs) {
        if (t.id !== undefined && !t.discarded && t.status === 'complete' && !isRestrictedUrl(t.url)) {
          await chrome.scripting
            .executeScript({
              target: { tabId: t.id },
              func: () => {
                document.getElementById('__browserpilot_ui_host')?.remove()
              },
            })
            .catch(() => {})
        }
      }
      broadcastBannerToAttachedTabs()
    })
    .catch(() => {})
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_PIN_ID || !tab?.id) return
  const tabId = tab.id
  void (async () => {
    const lang = bgState.config.language === 'en' ? 'en' : 'zh'
    const resp = (await chrome.tabs
      .sendMessage(tabId, { type: 'browserpilot:pin-last-right-clicked', language: lang })
      .catch(async () => {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] }).catch(() => {})
        return (await chrome.tabs
          .sendMessage(tabId, { type: 'browserpilot:pin-last-right-clicked', language: lang })
          .catch(() => null)) as { globalVar?: string; selector?: string } | null
      })) as {
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
    const isCodegenTab = Boolean(tid !== undefined && bgState.codegen.active && bgState.codegen.tabId === tid)
    safeRespond({
      active,
      paused: bgState.config.paused,
      theme: bgState.config.theme,
      language: bgState.config.language ?? 'zh',
      status: (bgState.config.language ?? 'zh') === 'en' ? 'Active' : '运行中',
      codegenActive: isCodegenTab,
      codegenAssertMode: isCodegenTab ? bgState.codegen.assertMode : false,
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
    const lang = bgState.config.language === 'en' ? 'en' : 'zh'
    void resolveTargetContentTab()
      .then((tab) => {
        if (tab?.id !== undefined) {
          return sendTabMessageEnsureInjected(tab.id, { type: 'browserpilot:start-picker', language: lang })
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
  if (msg.type === 'browserpilot:codegen-start') {
    void resolveTargetContentTab()
      .then(async (tab) => {
        if (!tab?.id || isRestrictedUrl(tab.url)) {
          safeRespond({ ok: false, error: 'Cannot record on restricted page' })
          return
        }
        bgState.codegen.active = true
        bgState.codegen.tabId = tab.id
        bgState.codegen.assertMode = false
        bgState.codegen.steps =
          tab.url && tab.url !== 'about:blank'
            ? [{ timestamp: Date.now(), action: 'navigate', url: tab.url }]
            : []
        await sendTabMessageEnsureInjected(tab.id, { type: 'browserpilot:set-codegen', active: true, assertMode: false })
        logActivity('codegen.start', 'info', tab.title || tab.url, tab.id)
        broadcastUiUpdate()
        safeRespond({ ok: true, tabId: tab.id })
      })
      .catch(() => safeRespond({ ok: false }))
    return true
  }
  if (msg.type === 'browserpilot:codegen-stop') {
    const prevTabId = bgState.codegen.tabId
    void (async () => {
      if (prevTabId !== undefined) {
        await chrome.tabs
          .sendMessage(prevTabId, { type: 'browserpilot:set-codegen', active: false, assertMode: false })
          .catch(() => {})
        await new Promise((r) => setTimeout(r, 25))
      }
      bgState.codegen.active = false
      bgState.codegen.assertMode = false
      logActivity('codegen.stop', 'ok', `${compressRecordedSteps(bgState.codegen.steps).length} steps`, prevTabId)
      broadcastUiUpdate()
      safeRespond({ ok: true })
    })()
    return true
  }
  if (msg.type === 'browserpilot:codegen-assert') {
    if (bgState.codegen.active && bgState.codegen.tabId !== undefined) {
      bgState.codegen.assertMode = !bgState.codegen.assertMode
      void chrome.tabs
        .sendMessage(bgState.codegen.tabId, {
          type: 'browserpilot:set-codegen',
          active: true,
          assertMode: bgState.codegen.assertMode,
        })
        .catch(() => {})
      broadcastUiUpdate()
    }
    safeRespond({ ok: true, assertMode: bgState.codegen.assertMode })
    return false
  }
  if (msg.type === 'browserpilot:codegen-delete-step') {
    const idx = Number(msg.index)
    const compressed = compressRecordedSteps(bgState.codegen.steps)
    if (Number.isInteger(idx) && idx >= 0 && idx < compressed.length) {
      compressed.splice(idx, 1)
      bgState.codegen.steps = compressed
      broadcastUiUpdate()
    }
    safeRespond({ ok: true })
    return false
  }
  if (msg.type === 'browserpilot:codegen-clear') {
    bgState.codegen.steps = []
    bgState.codegen.assertMode = false
    broadcastUiUpdate()
    safeRespond({ ok: true })
    return false
  }
  if (msg.type === 'browserpilot:clear-activity') {
    bgState.recentActivity = []
    broadcastUiUpdate()
    safeRespond({ ok: true })
    return false
  }
  if (msg.type === 'browserpilot:get-active-domain') {
    void resolveTargetContentTab()
      .then((tab) => {
        if (!tab?.url) {
          safeRespond({ hostname: null })
          return
        }
        try {
          safeRespond({ hostname: new URL(tab.url).hostname.toLowerCase() })
        } catch {
          safeRespond({ hostname: null })
        }
      })
      .catch(() => safeRespond({ hostname: null }))
    return true
  }
  if (msg.type === 'browserpilot:organize-tabs') {
    void executeBridgeMethod('tabs.organize', {
      strategy: msg.strategy === 'topic' ? 'topic' : 'domain',
      minGroupSize: typeof msg.minGroupSize === 'number' ? msg.minGroupSize : 2,
    })
      .then((res) => safeRespond({ ok: true, ...(res as Record<string, unknown>) }))
      .catch((err) => safeRespond({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    return true
  }
  if (msg.type === 'browserpilot:recorded-step' && msg.step) {
    const tid = _sender.tab?.id
    if (bgState.codegen.active && tid !== undefined && tid === bgState.codegen.tabId) {
      const step = msg.step as RecordedStep
      bgState.codegen.steps.push(step)
      if (String(step.action).startsWith('assert_')) {
        bgState.codegen.assertMode = false
      }
      broadcastUiUpdate()
    }
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
    broadcastBannerToAttachedTabs()
    void connectBridge()
  })
