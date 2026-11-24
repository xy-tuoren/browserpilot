import type { ExtensionState } from '@devpilot/protocol'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
let state: ExtensionState | null = null
let activeTab: 'activity' | 'errors' | 'network' = 'activity'

function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function render(next: ExtensionState): void {
  state = next
  const isDark = next.config.theme !== 'light'
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
  $('sp-theme').textContent = isDark ? 'Light' : 'Dark'

  const statusEl = $('sp-status')
  if (next.config.paused) {
    statusEl.textContent = 'PAUSED'
    statusEl.className = 'pill'
    $('sp-pause').textContent = 'Resume'
  } else if (next.connected) {
    statusEl.textContent = next.transport === 'native' ? 'NATIVE' : 'WS LIVE'
    statusEl.className = 'pill on'
    $('sp-pause').textContent = 'Pause'
  } else {
    statusEl.textContent = 'OFFLINE'
    statusEl.className = 'pill'
  }

  const errs = next.recentErrors ?? []
  const nets = next.recentFailedRequests ?? []
  $('err-count').textContent = String(errs.length)
  $('net-count').textContent = String(nets.length)

  $('tab-activity').classList.toggle('active', activeTab === 'activity')
  $('tab-errors').classList.toggle('active', activeTab === 'errors')
  $('tab-network').classList.toggle('active', activeTab === 'network')

  const tabsEl = $('sp-tabs')
  tabsEl.innerHTML = ''
  if (next.attachedTabs.length === 0) {
    tabsEl.textContent = 'No tabs attached yet.'
  } else {
    for (const tab of next.attachedTabs) {
      const card = document.createElement('div')
      card.className = 'card'
      card.innerHTML = `<div class="entry-head"><span>#${tab.tabId} ${escapeHtml(tab.title || 'Untitled')}</span><span class="ok">CDP</span></div><div class="detail">${escapeHtml(tab.url)}</div>`
      tabsEl.appendChild(card)
    }
  }

  const heading = $('feed-heading')
  const feedEl = $('sp-feed')
  feedEl.innerHTML = ''

  if (activeTab === 'activity') {
    heading.textContent = 'Live AI Activity Timeline'
    const entries = [...next.recentActivity].reverse()
    if (!entries.length) {
      feedEl.textContent = 'Waiting for agent commands…'
      return
    }
    for (const item of entries) {
      const card = document.createElement('div')
      card.className = 'card'
      const dur = item.durationMs !== undefined ? ` (${item.durationMs}ms)` : ''
      card.innerHTML =
        `<div class="entry-head"><span class="${item.status}">${escapeHtml(item.action)}${dur}</span><span class="time">${fmtTime(item.timestamp)}</span></div>` +
        (item.detail ? `<div class="detail">${escapeHtml(item.detail)}</div>` : '')
      feedEl.appendChild(card)
    }
  } else if (activeTab === 'errors') {
    heading.textContent = 'Captured Console Errors & Exceptions'
    const list = [...errs].reverse()
    if (!list.length) {
      feedEl.textContent = 'No console errors captured.'
      return
    }
    for (const item of list) {
      const card = document.createElement('div')
      card.className = 'card'
      card.innerHTML =
        `<div class="entry-head"><span class="error">Tab #${item.tabId}</span><span class="time">${fmtTime(item.timestamp)}</span></div>` +
        `<div class="detail">${escapeHtml(item.text)}</div>`
      feedEl.appendChild(card)
    }
  } else {
    heading.textContent = 'Failed Network Requests (4xx / 5xx / Blocked)'
    const list = [...nets].reverse()
    if (!list.length) {
      feedEl.textContent = 'No failed requests captured.'
      return
    }
    for (const item of list) {
      const card = document.createElement('div')
      card.className = 'card'
      const badge = item.status ? `${item.method} ${item.status}` : `${item.method} ${item.errorText || 'ERR'}`
      card.innerHTML =
        `<div class="entry-head"><span class="error">${escapeHtml(badge)}</span><span class="time">${fmtTime(item.timestamp)}</span></div>` +
        `<div class="detail">${escapeHtml(item.url)}</div>`
      feedEl.appendChild(card)
    }
  }
}

async function refresh(): Promise<void> {
  const s = (await chrome.runtime.sendMessage({ type: 'devpilot:get-state' })) as ExtensionState
  if (s) render(s)
}

$('tab-activity').addEventListener('click', () => {
  activeTab = 'activity'
  if (state) render(state)
})
$('tab-errors').addEventListener('click', () => {
  activeTab = 'errors'
  if (state) render(state)
})
$('tab-network').addEventListener('click', () => {
  activeTab = 'network'
  if (state) render(state)
})

$('sp-theme').addEventListener('click', () => {
  if (!state) return
  const nextTheme = state.config.theme === 'light' ? 'dark' : 'light'
  document.documentElement.dataset.theme = nextTheme
  void chrome.runtime.sendMessage({
    type: 'devpilot:update-config',
    patch: { theme: nextTheme },
  })
})
$('sp-pick').addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'devpilot:start-picker' })
})
$('sp-pause').addEventListener('click', () => {
  if (!state) return
  void chrome.runtime.sendMessage({
    type: 'devpilot:update-config',
    patch: { paused: !state.config.paused },
  })
})
$('sp-detach-all').addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'devpilot:detach-all' })
})

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'devpilot:state-update' && msg.state) {
    render(msg.state as ExtensionState)
  }
})

void refresh()
