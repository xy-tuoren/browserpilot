import type { ExtensionState } from '@devpilot/protocol'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
let state: ExtensionState | null = null

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return d.toTimeString().slice(0, 8)
}

function render(next: ExtensionState): void {
  state = next
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

  const feedEl = $('sp-feed')
  feedEl.innerHTML = ''
  const entries = [...next.recentActivity].reverse()
  if (entries.length === 0) {
    feedEl.textContent = 'Waiting for agent commands…'
  } else {
    for (const item of entries) {
      const card = document.createElement('div')
      card.className = 'card'
      const dur = item.durationMs !== undefined ? ` (${item.durationMs}ms)` : ''
      card.innerHTML =
        `<div class="entry-head"><span class="${item.status}">${escapeHtml(item.action)}${dur}</span><span class="time">${fmtTime(item.timestamp)}</span></div>` +
        (item.detail ? `<div class="detail">${escapeHtml(item.detail)}</div>` : '')
      feedEl.appendChild(card)
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function refresh(): Promise<void> {
  const s = (await chrome.runtime.sendMessage({ type: 'devpilot:get-state' })) as ExtensionState
  if (s) render(s)
}

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
