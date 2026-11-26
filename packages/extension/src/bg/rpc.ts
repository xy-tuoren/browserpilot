import {
  compressRecordedSteps,
  DEFAULT_TAB_GROUP_TITLE,
  isBlockedProfileWideCommand,
  isRestrictedUrl,
  TAB_GROUP_COLORS,
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

    case 'tabs.group': {
      const rawIds = Array.isArray(params.tabIds) ? (params.tabIds as unknown[]).map(Number).filter(Number.isFinite) : []
      if (!rawIds.length) throw new Error('tabs.group requires a non-empty tabIds array')
      const title = typeof params.title === 'string' && params.title.trim() ? params.title.trim() : undefined
      const color = (typeof params.color === 'string' ? params.color : undefined) as chrome.tabGroups.ColorEnum | undefined
      const collapsed = typeof params.collapsed === 'boolean' ? params.collapsed : undefined
      const groupId = await chrome.tabs.group({ tabIds: rawIds as [number, ...number[]] })
      if (chrome.tabGroups?.update && (title !== undefined || color !== undefined || collapsed !== undefined)) {
        await chrome.tabGroups.update(groupId, {
          ...(title !== undefined ? { title } : {}),
          ...(color !== undefined ? { color } : {}),
          ...(collapsed !== undefined ? { collapsed } : {}),
        })
      }
      broadcastUiUpdate()
      return { groupId, title, color, tabIds: rawIds }
    }

    case 'tabs.ungroup': {
      const rawIds = Array.isArray(params.tabIds) ? (params.tabIds as unknown[]).map(Number).filter(Number.isFinite) : []
      if (!rawIds.length) return { ungrouped: [] }
      await chrome.tabs.ungroup(rawIds as [number, ...number[]])
      broadcastUiUpdate()
      return { ungrouped: rawIds }
    }

    case 'tabs.organize': {
      const strategy = params.strategy === 'topic' ? 'topic' : 'domain'
      const minGroupSize = Math.max(1, Number(params.minGroupSize ?? 2))
      const collapseOthers = Boolean(params.collapseOthers)
      const explicitIds = Array.isArray(params.tabIds)
        ? new Set((params.tabIds as unknown[]).map(Number).filter(Number.isFinite))
        : null

      const allTabs = await chrome.tabs.query({})
      const activeTab = allTabs.find((t) => t.active)
      const targetWindowId = activeTab?.windowId

      const candidates = allTabs.filter((t) => {
        if (t.id === undefined || t.pinned) return false
        if (explicitIds) return explicitIds.has(t.id)
        if (targetWindowId !== undefined && t.windowId !== targetWindowId) return false
        const u = t.url || t.pendingUrl || ''
        return !isRestrictedUrl(u) && u !== 'about:blank' && u.length > 0
      })

      const classifyBucket = (rawUrl: string): string => {
        let host = ''
        try {
          host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '')
        } catch {
          return 'Other'
        }
        if (strategy === 'topic') {
          if (/(github|gitlab|stackoverflow|npmjs|vercel|cloudflare|developer\.mozilla|localhost|127\.0\.0\.1|linear\.app|sentry\.io|datadog)/.test(host)) {
            return 'Dev'
          }
          if (/(chatgpt|openai|claude\.ai|anthropic|gemini\.google|huggingface|perplexity)/.test(host)) {
            return 'AI'
          }
          if (/(docs\.google|notion\.so|feishu\.cn|larksuite|figma\.com|confluence|miro\.com|airtable)/.test(host)) {
            return 'Docs'
          }
          if (/(youtube|bilibili|twitter|x\.com|reddit|zhihu|weibo|xiaohongshu|tiktok)/.test(host)) {
            return 'Social'
          }
          if (/(mail\.google|outlook|slack\.com|discord\.com|teams\.microsoft|telegram)/.test(host)) {
            return 'Chat & Mail'
          }
          if (/(amazon|taobao|tmall|jd\.com|shopify|ebay|stripe)/.test(host)) {
            return 'Shopping'
          }
        }
        // Clean human-friendly domain label (e.g. docs.github.com -> github.com, 127.0.0.1 -> localhost)
        if (host === '127.0.0.1' || host === 'localhost') return 'Localhost'
        const parts = host.split('.')
        return parts.length >= 2 ? parts.slice(-2).join('.') : host || 'Other'
      }

      const buckets = new Map<string, chrome.tabs.Tab[]>()
      for (const t of candidates) {
        const key = classifyBucket(t.url || t.pendingUrl || '')
        const list = buckets.get(key) ?? []
        list.push(t)
        buckets.set(key, list)
      }

      const createdGroups: Array<{ groupId: number; title: string; color: TabGroupColor; tabIds: number[] }> = []
      let ungroupedCount = 0
      let colorIdx = 0

      for (const [title, groupTabs] of buckets.entries()) {
        if (groupTabs.length < minGroupSize) {
          ungroupedCount += groupTabs.length
          continue
        }
        const ids = groupTabs.map((t) => t.id!).filter((id) => Number.isFinite(id))
        if (!ids.length) continue
        const color = TAB_GROUP_COLORS[colorIdx++ % TAB_GROUP_COLORS.length]
        const groupId = await chrome.tabs.group({ tabIds: ids as [number, ...number[]] })
        const hasActive = groupTabs.some((t) => t.active)
        if (chrome.tabGroups?.update) {
          await chrome.tabGroups.update(groupId, {
            title,
            color: color as chrome.tabGroups.ColorEnum,
            ...(collapseOthers && !hasActive ? { collapsed: true } : {}),
          })
        }
        createdGroups.push({ groupId, title, color, tabIds: ids })
      }

      broadcastUiUpdate()
      return { groups: createdGroups, ungroupedCount }
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
      // Avoid flooding Side Panel IPC on low-level Runtime.evaluate / Input.dispatchMouseEvent calls;
      // high-level tool steps stream cleanly via extension.logActivity.
      if (cdpMethod === 'Page.navigate') {
        logActivity(cdpMethod, 'ok', String(cdpParams?.url ?? ''), tabId)
      }
      return result ?? {}
    }

    case 'extension.getState': {
      return await getExtensionState()
    }

    case 'extension.setConfig': {
      return await saveConfig(params as Partial<ExtensionConfig>)
    }

    case 'extension.logActivity': {
      const action = typeof params.action === 'string' && params.action ? params.action : 'tool'
      const status = params.status === 'error' ? 'error' : params.status === 'info' ? 'info' : 'ok'
      const detail = typeof params.detail === 'string' ? params.detail : undefined
      const tabId = typeof params.tabId === 'number' ? params.tabId : undefined
      const durationMs = typeof params.durationMs === 'number' ? params.durationMs : undefined
      const step =
        params.step && typeof params.step === 'object' ? (params.step as Record<string, unknown>) : undefined
      logActivity(action, status, detail, tabId, durationMs, step)
      return { ok: true }
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
      const payload = {
        type: 'browserpilot:highlight',
        box: params.box,
        label: params.label,
        language: bgState.config.language === 'en' ? 'en' : 'zh',
      }
      await chrome.tabs.sendMessage(tabId, payload).catch(async () => {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] }).catch(() => {})
        await chrome.tabs.sendMessage(tabId, payload).catch(() => {})
      })
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
        // Flush pending inputs and allow any in-flight recorded-step messages from the
        // content script to arrive BEFORE flipping bgState.codegen.active to false.
        if (prevTab !== undefined) {
          await chrome.tabs
            .sendMessage(prevTab, { type: 'browserpilot:set-codegen', active: false, assertMode: false })
            .catch(() => {})
          await new Promise((r) => setTimeout(r, 25))
        }
        bgState.codegen.active = false
        bgState.codegen.assertMode = false
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
