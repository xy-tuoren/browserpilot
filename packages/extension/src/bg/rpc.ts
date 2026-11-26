import {
  compressRecordedSteps,
  DEFAULT_TAB_GROUP_TITLE,
  isBlockedProfileWideCommand,
  isRestrictedUrl,
  type ExtensionConfig,
  type TabGroupColor,
} from '@browserpilot/protocol'
import {
  bgState,
  broadcastUiUpdate,
  getExtensionState,
  listAllTabs,
  logActivity,
  pushControlBanner,
  saveConfig,
} from './state.js'
import { detachTab, ensureAttached, ungroupTabIfManaged } from './tabs.js'

export async function executeBridgeMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
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
          : bgState.config.groupTabs
            ? DEFAULT_TAB_GROUP_TITLE
            : undefined
      const tabGroupColor = params.tabGroupColor as TabGroupColor | undefined
      const tab = await chrome.tabs.create({ url, active })
      if (tab.id === undefined) throw new Error('Failed to create tab')
      if (bgState.config.autoAttach && !isRestrictedUrl(url)) {
        await ensureAttached(tab.id, { tabGroup, tabGroupColor })
      }
      const tabs = await listAllTabs()
      return tabs.find((t) => t.tabId === tab.id) ?? { tabId: tab.id, url, title: tab.title || '', active, attached: true }
    }

    case 'tabs.close': {
      const tabId = Number(params.tabId)
      const rec = bgState.attachedTabs.get(tabId)
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

      if (!bgState.attachedTabs.has(tabId)) {
        if (!bgState.config.autoAttach) {
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

    case 'extension.reload': {
      const attachedCount = bgState.attachedTabs.size
      if (attachedCount > 0 && !params.force) {
        return { reloaded: false, reason: 'busy', attachedTabCount: attachedCount }
      }
      setTimeout(() => {
        try {
          chrome.runtime.reload()
        } catch {}
      }, 80)
      return { reloaded: true }
    }

    case 'extension.highlight': {
      if (!bgState.config.showHighlights) return { ok: true }
      const tabId = Number(params.tabId)
      await chrome.tabs
        .sendMessage(tabId, {
          type: 'browserpilot:highlight',
          box: params.box,
          label: params.label,
        })
        .catch(() => {})
      return { ok: true }
    }

    case 'extension.ghostCursor': {
      if (!bgState.config.showGhostCursor) return { ok: true }
      const tabId = Number(params.tabId)
      await chrome.tabs
        .sendMessage(tabId, {
          type: 'browserpilot:ghost-cursor',
          x: params.x,
          y: params.y,
          clicking: params.clicking,
        })
        .catch(() => {})
      return { ok: true }
    }

    case 'extension.setOverlayVisible': {
      const tabId = Number(params.tabId)
      await chrome.tabs
        .sendMessage(tabId, {
          type: 'browserpilot:set-overlay-visible',
          visible: Boolean(params.visible),
        })
        .catch(() => {})
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
      const rec = bgState.attachedTabs.get(tabId)
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      return rec?.lastPinnedVar ? { globalVar: rec.lastPinnedVar, url: tab?.url } : null
    }

    case 'extension.codegen': {
      const action = String(params.action ?? 'status')
      if (action === 'start') {
        const tabId = Number(params.tabId)
        const tab = await chrome.tabs.get(tabId)
        if (!tab.id || isRestrictedUrl(tab.url)) {
          throw new Error('Cannot start codegen on restricted tab')
        }
        bgState.codegen.active = true
        bgState.codegen.tabId = tab.id
        bgState.codegen.assertMode = false
        bgState.codegen.steps =
          tab.url && tab.url !== 'about:blank'
            ? [{ timestamp: Date.now(), action: 'navigate', url: tab.url }]
            : []
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'browserpilot:set-codegen', active: true, assertMode: false })
        } catch {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-script.js'] }).catch(() => {})
          await chrome.tabs
            .sendMessage(tab.id, { type: 'browserpilot:set-codegen', active: true, assertMode: false })
            .catch(() => {})
        }
        broadcastUiUpdate()
        return { active: true, tabId: tab.id }
      }
      if (action === 'assert') {
        if (bgState.codegen.active && bgState.codegen.tabId !== undefined) {
          bgState.codegen.assertMode = Boolean(params.enabled ?? !bgState.codegen.assertMode)
          await chrome.tabs
            .sendMessage(bgState.codegen.tabId, {
              type: 'browserpilot:set-codegen',
              active: true,
              assertMode: bgState.codegen.assertMode,
            })
            .catch(() => {})
          broadcastUiUpdate()
        }
        return { assertMode: bgState.codegen.assertMode }
      }
      if (action === 'stop') {
        const prevTab = bgState.codegen.tabId
        bgState.codegen.active = false
        bgState.codegen.assertMode = false
        if (prevTab !== undefined) {
          await chrome.tabs
            .sendMessage(prevTab, { type: 'browserpilot:set-codegen', active: false, assertMode: false })
            .catch(() => {})
        }
        broadcastUiUpdate()
        return { active: false, steps: compressRecordedSteps(bgState.codegen.steps) }
      }
      return {
        active: bgState.codegen.active,
        tabId: bgState.codegen.tabId,
        steps: compressRecordedSteps(bgState.codegen.steps),
      }
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
