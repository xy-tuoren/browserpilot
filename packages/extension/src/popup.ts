import type { ExtensionState } from '@browserpilot/protocol'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let currentState: ExtensionState | null = null
let currentWindowId: number | undefined

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

function render(state: ExtensionState): void {
  currentState = state
  const isDark = state.config.theme !== 'light'
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
  $<HTMLInputElement>('opt-dark-mode').checked = isDark
  $('theme-mode-label').textContent = isDark ? 'Dark' : 'Light'

  const dot = $('status-dot')
  const badge = $('status-badge')
  const btnPause = $<HTMLButtonElement>('btn-pause')

  if (state.config.paused) {
    dot.className = 'dot paused'
    badge.className = 'badge paused'
    badge.textContent = 'PAUSED'
    btnPause.textContent = 'Resume'
    btnPause.className = 'warn'
  } else if (state.connected) {
    dot.className = 'dot on'
    badge.className = 'badge on'
    badge.textContent = state.transport === 'native' ? 'NATIVE' : 'WS LIVE'
    btnPause.textContent = 'Pause'
    btnPause.className = ''
  } else {
    dot.className = 'dot'
    badge.className = 'badge'
    badge.textContent = 'OFFLINE'
    btnPause.textContent = 'Pause'
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

  const list = $('tab-list')
  list.innerHTML = ''
  if (state.attachedTabs.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'muted'
    empty.textContent = 'No tabs attached yet — AI attaches automatically on demand.'
    list.appendChild(empty)
  } else {
    for (const tab of state.attachedTabs) {
      const item = document.createElement('div')
      item.className = 'tab-item'
      const meta = document.createElement('div')
      meta.className = 'tab-meta'
      meta.textContent = tab.title || tab.url || `Tab #${tab.tabId}`
      meta.title = tab.url
      const btn = document.createElement('button')
      btn.className = 'sm'
      btn.textContent = 'Detach'
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

$('opt-dark-mode').addEventListener('change', (e) => {
  const isDark = (e.target as HTMLInputElement).checked
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
  $('theme-mode-label').textContent = isDark ? 'Dark' : 'Light'
  updateConfig({ theme: isDark ? 'dark' : 'light' })
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
})

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'browserpilot:state-update' && msg.state) {
    render(msg.state as ExtensionState)
  }
})

void refresh()
