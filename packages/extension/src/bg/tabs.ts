import {
  CDP_PROTOCOL_VERSION,
  DEFAULT_TAB_GROUP_TITLE,
  isRestrictedUrl,
  isUrlAllowedByDomainRules,
  type TabGroupColor,
} from '@browserpilot/protocol'
import { sendEvent } from './bridge.js'
import {
  bgState,
  broadcastUiUpdate,
  logActivity,
  pushControlBanner,
  STORAGE_ATTACHED_KEY,
  updateBadge,
  type AttachedTabRecord,
} from './state.js'

interface PersistedAttachedTab {
  tabId: number
  attachedAt: number
  tabGroup?: string
  tabGroupColor?: TabGroupColor
  groupedByExtension?: boolean
  assignedGroupId?: number
  lastPinnedVar?: string
}

/**
 * Persists lightweight attached-tab metadata to `chrome.storage.session` so MV3
 * Service Worker restarts preserve Tab Group ownership & pinned state without
 * accidentally claiming tabs owned by Chrome DevTools or another extension.
 */
export async function persistAttachedTabs(): Promise<void> {
  if (!chrome.storage?.session) return
  try {
    const entries: PersistedAttachedTab[] = Array.from(bgState.attachedTabs.values()).map((r) => ({
      tabId: r.tabId,
      attachedAt: r.attachedAt,
      tabGroup: r.tabGroup,
      tabGroupColor: r.tabGroupColor,
      groupedByExtension: r.groupedByExtension,
      assignedGroupId: r.assignedGroupId,
      lastPinnedVar: r.lastPinnedVar,
    }))
    await chrome.storage.session.set({ [STORAGE_ATTACHED_KEY]: entries })
  } catch {
    // Best-effort session storage persistence
  }
}

/**
 * Removes third-party chrome-extension:// iframes before attaching chrome.debugger
 * so password managers do not trigger Chromium's cross-extension attach error.
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

export async function assignTabGroup(
  tabId: number,
  groupTitle?: string,
  groupColor?: TabGroupColor,
): Promise<number | undefined> {
  if (!bgState.config.groupTabs) return undefined
  const title = (groupTitle || DEFAULT_TAB_GROUP_TITLE).trim()
  const color: chrome.tabGroups.ColorEnum = (groupColor || 'green') as chrome.tabGroups.ColorEnum
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    const windowId = tab?.windowId
    const cacheKey = windowId !== undefined ? `${windowId}:${title}` : title
    let existingGroupId = bgState.tabGroupIds.get(cacheKey)

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
    bgState.tabGroupIds.set(cacheKey, groupId)
    await chrome.tabGroups.update(groupId, { title, color })
    return groupId
  } catch {
    return undefined
  }
}

/**
 * Ungroups a tab if BrowserPilot placed it in a managed Tab Group so Chrome dissolves
 * empty groups cleanly instead of persisting leftover Saved Tab Groups capsules.
 */
export async function ungroupTabIfManaged(tabId: number, rec?: AttachedTabRecord): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab || tab.groupId === undefined || tab.groupId < 0) return

    let isManaged = Boolean(rec?.groupedByExtension)
    if (!isManaged) {
      for (const gid of bgState.tabGroupIds.values()) {
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

    if (chrome.tabGroups?.get) {
      const stillExists = await chrome.tabGroups.get(prevGroupId).catch(() => null)
      if (!stillExists) {
        for (const [k, v] of bgState.tabGroupIds.entries()) {
          if (v === prevGroupId) bgState.tabGroupIds.delete(k)
        }
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Rebuilds `attachedTabs` after MV3 Service Worker sleep/wake cycles by reconciling
 * `chrome.storage.session` metadata and `chrome.debugger.getTargets()`, verifying
 * actual ownership via `chrome.debugger.sendCommand` so tabs owned by Chrome DevTools
 * or another extension are never misattributed to BrowserPilot.
 */
export async function restoreAttachedTabsOnBoot(): Promise<void> {
  if (typeof chrome.debugger?.getTargets !== 'function') return
  try {
    const savedByTabId = new Map<number, PersistedAttachedTab>()
    if (chrome.storage?.session) {
      const stored = await chrome.storage.session.get(STORAGE_ATTACHED_KEY).catch(() => ({}))
      const list = (stored as Record<string, unknown>)[STORAGE_ATTACHED_KEY]
      if (Array.isArray(list)) {
        for (const item of list as PersistedAttachedTab[]) {
          if (typeof item?.tabId === 'number') {
            savedByTabId.set(item.tabId, item)
          }
        }
      }
    }

    const targets = await chrome.debugger.getTargets()
    for (const t of targets) {
      if (!t.attached || t.tabId === undefined || bgState.attachedTabs.has(t.tabId)) continue
      // Verify THIS extension owns the debugger lock on t.tabId (rejects DevTools / other extensions)
      const ownedByUs = await chrome.debugger
        .sendCommand({ tabId: t.tabId }, 'Target.getTargetInfo')
        .then(() => true)
        .catch(() => false)
      if (!ownedByUs) continue

      const saved = savedByTabId.get(t.tabId)
      const tab = await chrome.tabs.get(t.tabId).catch(() => null)
      const grp =
        tab && tab.groupId !== undefined && tab.groupId >= 0 && chrome.tabGroups?.get
          ? await chrome.tabGroups.get(tab.groupId).catch(() => null)
          : null

      const tabGroup = saved?.tabGroup ?? grp?.title ?? undefined
      const assignedGroupId = saved?.assignedGroupId ?? grp?.id
      bgState.attachedTabs.set(t.tabId, {
        tabId: t.tabId,
        attachedAt: saved?.attachedAt ?? Date.now(),
        tabGroup,
        tabGroupColor: saved?.tabGroupColor,
        groupedByExtension: saved?.groupedByExtension ?? Boolean(grp?.title),
        assignedGroupId,
        lastPinnedVar: saved?.lastPinnedVar,
        childSessions: new Set(),
      })

      if (tabGroup && assignedGroupId !== undefined) {
        const cacheKey = tab?.windowId !== undefined ? `${tab.windowId}:${tabGroup}` : tabGroup
        bgState.tabGroupIds.set(cacheKey, assignedGroupId)
      }
    }

    await persistAttachedTabs()
  } catch {
    // Best-effort SW state restoration
  }
}

export async function ensureAttached(
  tabId: number,
  options?: { tabGroup?: string; tabGroupColor?: TabGroupColor },
): Promise<AttachedTabRecord> {
  if (bgState.config.paused) {
    throw new Error('BrowserPilot is paused by user in the extension popup.')
  }
  const existing = bgState.attachedTabs.get(tabId)
  if (existing) return existing

  const inflight = bgState.inFlightAttaches.get(tabId)
  if (inflight) return inflight

  const task = (async (): Promise<AttachedTabRecord> => {
    const tab = await chrome.tabs.get(tabId)
    const url = tab.url || tab.pendingUrl || ''
    if (isRestrictedUrl(url)) {
      throw new Error(`Cannot attach chrome.debugger to restricted URL: ${url}`)
    }
    if (url.startsWith('http') && !isUrlAllowedByDomainRules(url, bgState.config.domainRules)) {
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
    bgState.attachedTabs.set(tabId, rec)

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

    await persistAttachedTabs()
    updateBadge()
    broadcastUiUpdate()
    pushControlBanner(tabId, { active: true, status: 'Active' })
    sendEvent('tab.attached', { tabId, url, title: tab.title || '' })
    logActivity('tab.attach', 'ok', `${tab.title || url || `Tab #${tabId}`}`, tabId)
    return rec
  })()

  bgState.inFlightAttaches.set(tabId, task)
  try {
    return await task
  } finally {
    bgState.inFlightAttaches.delete(tabId)
  }
}

export async function detachTab(tabId: number): Promise<void> {
  const rec = bgState.attachedTabs.get(tabId)
  if (!rec) return
  bgState.attachedTabs.delete(tabId)
  void persistAttachedTabs()
  pushControlBanner(tabId, { active: false })
  await ungroupTabIfManaged(tabId, rec)
  await chrome.debugger.detach({ tabId }).catch(() => {})
  updateBadge()
  broadcastUiUpdate()
  sendEvent('tab.detached', { tabId, reason: 'requested' })
  logActivity('tab.detach', 'info', `Detached tab #${tabId}`, tabId)
}
