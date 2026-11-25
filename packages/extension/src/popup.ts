import type { ExtensionLanguage, ExtensionState } from '@browserpilot/protocol'
import { MESSAGES, resolveLang } from './i18n.js'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let currentState: ExtensionState | null = null
let currentWindowId: number | undefined
let saveFeedbackTimer: ReturnType<typeof setTimeout> | null = null
let copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null

void chrome.windows
  ?.getCurrent()
  .then((win) => {
    currentWindowId = win?.id
  })
  .catch(() => {})

function safeSendMessage<T = unknown>(message: unknown): Promise<T | null> {
  try {
    return Promise.resolve(chrome.runtime.sendMessage(message) as Promise<T>).catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}

function applyLabels(lang: ExtensionLanguage, isDark: boolean): void {
  const t = MESSAGES[lang]
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'

  const langBtn = $('btn-lang')
  langBtn.textContent = lang === 'zh' ? 'EN' : '中文'
  langBtn.title = t.langToggleTitle

  const themeBtn = $('btn-theme')
  themeBtn.textContent = isDark ? t.themeDark : t.themeLight
  themeBtn.title = t.themeTitle

  $('btn-sidepanel').textContent = t.sidePanel
  $('btn-reconnect').textContent = t.reconnect
  $('lbl-settings').textContent = t.settingsTitle

  $('lbl-auto-attach').textContent = t.autoAttach
  $('row-auto-attach').title = t.autoAttachTip
  $('lbl-highlights').textContent = t.highlights
  $('row-highlights').title = t.highlightsTip
  $('lbl-cursor').textContent = t.ghostCursor
  $('row-cursor').title = t.ghostCursorTip
  $('lbl-groups').textContent = t.groupTabs
  $('row-groups').title = t.groupTabsTip

  $('lbl-attached-tabs').textContent = t.attachedTabs
  $('btn-detach-all').textContent = t.detachAll
  $('lbl-advanced').textContent = t.advancedTitle
  $('lbl-blocked-domains').textContent = t.blockedDomainsLabel
  $<HTMLInputElement>('inp-blocked-domains').placeholder = t.blockedDomainsPlaceholder
  $('lbl-daemon-url').textContent = t.daemonUrlLabel
  $('lbl-auth-token').textContent = t.authTokenLabel
  $<HTMLInputElement>('inp-auth-token').placeholder = t.authTokenPlaceholder
  if (!saveFeedbackTimer) {
    $('btn-save-settings').textContent = t.save
  }
  if (!copyFeedbackTimer) {
    $('lbl-ext-id').textContent = t.extIdLabel
  }
}

function render(state: ExtensionState): void {
  currentState = state
  const lang = resolveLang(state.config.language)
  const t = MESSAGES[lang]
  const isDark = state.config.theme !== 'light'
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
  applyLabels(lang, isDark)

  const dot = $('status-dot')
  const badge = $('status-badge')
  const btnPause = $<HTMLButtonElement>('btn-pause')

  if (state.config.paused) {
    dot.className = 'dot paused'
    badge.className = 'badge paused'
    badge.textContent = t.statusPaused
    btnPause.textContent = t.resume
    btnPause.className = 'warn'
  } else if (state.connected) {
    dot.className = 'dot on'
    badge.className = 'badge on'
    badge.textContent = state.transport === 'native' ? t.statusNative : t.statusWs
    btnPause.textContent = t.pause
    btnPause.className = ''
  } else {
    dot.className = 'dot'
    badge.className = 'badge'
    badge.textContent = t.statusOffline
    btnPause.textContent = t.pause
    btnPause.className = ''
  }

  $<HTMLInputElement>('opt-auto-attach').checked = state.config.autoAttach
  $<HTMLInputElement>('opt-highlights').checked = state.config.showHighlights
  $<HTMLInputElement>('opt-cursor').checked = state.config.showGhostCursor
  $<HTMLInputElement>('opt-groups').checked = state.config.groupTabs

  const urlInput = $<HTMLInputElement>('inp-daemon-url')
  const tokenInput = $<HTMLInputElement>('inp-auth-token')
  const blockedInput = $<HTMLInputElement>('inp-blocked-domains')
  if (document.activeElement !== urlInput) urlInput.value = state.config.daemonUrl
  if (document.activeElement !== tokenInput) tokenInput.value = state.config.authToken
  if (document.activeElement !== blockedInput) {
    blockedInput.value = state.config.domainRules.blockedDomains.join(', ')
  }

  $('ext-id').textContent = state.extensionId
  $('tab-count').textContent = String(state.attachedTabs.length)
  $('btn-detach-all').style.display = state.attachedTabs.length > 0 ? '' : 'none'

  const list = $('tab-list')
  list.innerHTML = ''
  if (state.attachedTabs.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'muted'
    empty.textContent = t.noAttachedTabs
    list.appendChild(empty)
  } else {
    for (const tab of state.attachedTabs) {
      const item = document.createElement('div')
      item.className = 'tab-item'
      const meta = document.createElement('div')
      meta.className = 'tab-meta'
      meta.textContent = tab.title || tab.url || `${t.tabPrefix}${tab.tabId}`
      meta.title = tab.url
      const btn = document.createElement('button')
      btn.className = 'sm'
      btn.textContent = t.detach
      btn.addEventListener('click', () => {
        void safeSendMessage({ type: 'browserpilot:detach-tab', tabId: tab.tabId })
      })
      item.appendChild(meta)
      item.appendChild(btn)
      list.appendChild(item)
    }
  }
}

async function refresh(): Promise<void> {
  const state = await safeSendMessage<ExtensionState>({ type: 'browserpilot:get-state' })
  if (state) render(state)
}

function updateConfig(patch: Record<string, unknown>): void {
  void safeSendMessage({ type: 'browserpilot:update-config', patch }).then(() => refresh())
}

$('btn-lang').addEventListener('click', () => {
  const curr = resolveLang(currentState?.config.language)
  const next: ExtensionLanguage = curr === 'zh' ? 'en' : 'zh'
  updateConfig({ language: next })
})

$('btn-theme').addEventListener('click', () => {
  const isDark = (currentState?.config.theme ?? 'dark') !== 'light'
  const nextTheme = isDark ? 'light' : 'dark'
  document.documentElement.dataset.theme = nextTheme
  updateConfig({ theme: nextTheme })
})

$('btn-pause').addEventListener('click', () => {
  if (!currentState) return
  updateConfig({ paused: !currentState.config.paused })
})

$('btn-sidepanel').addEventListener('click', () => {
  if (chrome.sidePanel?.open && currentWindowId !== undefined) {
    void chrome.sidePanel.open({ windowId: currentWindowId }).catch(() => {})
    return
  }
  void safeSendMessage({ type: 'browserpilot:open-sidepanel' })
})

$('btn-reconnect').addEventListener('click', () => {
  void safeSendMessage({ type: 'browserpilot:reconnect' }).then(() => setTimeout(refresh, 400))
})

$('btn-detach-all').addEventListener('click', () => {
  void safeSendMessage({ type: 'browserpilot:detach-all' }).then(() => refresh())
})

$('opt-auto-attach').addEventListener('change', (e) => {
  updateConfig({ autoAttach: (e.target as HTMLInputElement).checked })
})
$('opt-highlights').addEventListener('change', (e) => {
  updateConfig({ showHighlights: (e.target as HTMLInputElement).checked })
})
$('opt-cursor').addEventListener('change', (e) => {
  updateConfig({ showGhostCursor: (e.target as HTMLInputElement).checked })
})
$('opt-groups').addEventListener('change', (e) => {
  updateConfig({ groupTabs: (e.target as HTMLInputElement).checked })
})

$('btn-save-settings').addEventListener('click', () => {
  const daemonUrl = $<HTMLInputElement>('inp-daemon-url').value.trim()
  const authToken = $<HTMLInputElement>('inp-auth-token').value.trim()
  const blockedDomains = $<HTMLInputElement>('inp-blocked-domains')
    .value.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  updateConfig({
    daemonUrl,
    authToken,
    domainRules: {
      blockedDomains,
      allowedDomains: currentState?.config.domainRules.allowedDomains ?? [],
    },
  })
  const lang = resolveLang(currentState?.config.language)
  $('btn-save-settings').textContent = `${MESSAGES[lang].saved} ✓`
  if (saveFeedbackTimer) clearTimeout(saveFeedbackTimer)
  saveFeedbackTimer = setTimeout(() => {
    saveFeedbackTimer = null
    const l = resolveLang(currentState?.config.language)
    $('btn-save-settings').textContent = MESSAGES[l].save
  }, 1400)
})

$('ext-id-row').addEventListener('click', () => {
  const extId = currentState?.extensionId
  if (!extId) return
  void navigator.clipboard?.writeText(extId).catch(() => {})
  const lang = resolveLang(currentState?.config.language)
  $('lbl-ext-id').textContent = `${MESSAGES[lang].copied} ✓`
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
  copyFeedbackTimer = setTimeout(() => {
    copyFeedbackTimer = null
    const l = resolveLang(currentState?.config.language)
    $('lbl-ext-id').textContent = MESSAGES[l].extIdLabel
  }, 1200)
})

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'browserpilot:state-update' && msg.state) {
    render(msg.state as ExtensionState)
  }
})

void refresh()
