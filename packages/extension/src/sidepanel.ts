import {
  formatStepsAsCode,
  type CodegenFormat,
  type ExtensionLanguage,
  type ExtensionState,
} from '@browserpilot/protocol'
import { MESSAGES, resolveLang } from './i18n.js'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
let state: ExtensionState | null = null
let activeTab: 'activity' | 'record' | 'errors' | 'network' = 'activity'
let codeFormat: CodegenFormat = 'playwright'

function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function safeSendMessage<T = unknown>(message: unknown): Promise<T | null> {
  try {
    return Promise.resolve(chrome.runtime.sendMessage(message) as Promise<T>).catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}

function renderRecordPanel(next: ExtensionState): void {
  const lang = resolveLang(next.config.language)
  const t = MESSAGES[lang]
  const cg = next.codegen ?? { active: false, assertMode: false, steps: [] }

  const toggleBtn = $('rec-toggle')
  toggleBtn.textContent = cg.active ? t.recordStop : t.recordStart
  toggleBtn.className = cg.active ? 'danger' : 'primary'

  const assertBtn = $('rec-assert') as HTMLButtonElement
  assertBtn.disabled = !cg.active
  assertBtn.textContent = cg.assertMode ? t.recordAssertWait : t.recordAssert
  assertBtn.classList.toggle('active-pill', Boolean(cg.assertMode))

  $('rec-clear').textContent = t.recordClear
  $('rec-code-heading').textContent = t.recordCodeHeading
  $('rec-steps-heading').textContent = `${t.recordHeading} (${cg.steps.length})`
  $('rec-copy').textContent = t.recordCopy

  $('fmt-pw').classList.toggle('active-pill', codeFormat === 'playwright')
  $('fmt-bp').classList.toggle('active-pill', codeFormat === 'browserpilot')
  $('fmt-skill').classList.toggle('active-pill', codeFormat === 'skill')
  $('fmt-batch').classList.toggle('active-pill', codeFormat === 'batch')

  const codeEl = $('rec-code')
  const stepsEl = $('rec-steps')
  stepsEl.innerHTML = ''

  if (cg.steps.length === 0) {
    codeEl.style.display = 'none'
    stepsEl.textContent = t.recordEmpty
    return
  }

  codeEl.style.display = 'block'
  codeEl.textContent = formatStepsAsCode(cg.steps, codeFormat)

  cg.steps.forEach((step, idx) => {
    const card = document.createElement('div')
    card.className = 'card'
    const summary =
      step.action === 'navigate'
        ? step.url
        : step.action === 'press_key'
          ? step.key || ''
          : step.value !== undefined
            ? `${step.target || ''} = "${step.value}"`
            : step.target || ''
    card.innerHTML =
      `<div class="entry-head"><span class="ok">#${idx + 1} ${escapeHtml(step.action)}</span>` +
      `<button class="step-del" data-del="${idx}" title="Delete">×</button></div>` +
      (summary ? `<div class="detail">${escapeHtml(summary)}</div>` : '')
    stepsEl.appendChild(card)
  })

  stepsEl.querySelectorAll<HTMLButtonElement>('.step-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      void safeSendMessage({ type: 'browserpilot:codegen-delete-step', index: Number(btn.dataset.del) }).then(() =>
        refresh(),
      )
    })
  })
}

function render(next: ExtensionState): void {
  state = next
  const lang = resolveLang(next.config.language)
  const t = MESSAGES[lang]
  const isDark = next.config.theme !== 'light'
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
  document.title = t.companionTitle

  $('sp-title').textContent = t.companionTitle
  $('sp-lang').textContent = lang === 'zh' ? 'EN' : '中文'
  $('sp-lang').title = t.langToggleTitle
  $('sp-theme').textContent = isDark ? t.themeDark : t.themeLight
  $('sp-theme').title = t.themeTitle

  $('sp-pick').textContent = t.pickElement
  $('sp-detach-all').textContent = t.detachAll
  $('tab-activity').textContent = t.tabActivity
  $('tab-record').textContent = next.codegen?.active ? `● ${t.tabRecord}` : t.tabRecord
  $('lbl-tab-errors').textContent = t.tabErrors
  $('lbl-tab-network').textContent = t.tabNetwork
  $('tabs-heading').textContent = t.activeTabsHeading

  const statusEl = $('sp-status')
  if (next.config.paused) {
    statusEl.textContent = t.statusPaused
    statusEl.className = 'pill'
    $('sp-pause').textContent = t.resume
  } else if (next.connected) {
    statusEl.textContent = next.transport === 'native' ? t.statusNative : t.statusWs
    statusEl.className = 'pill on'
    $('sp-pause').textContent = t.pause
  } else {
    statusEl.textContent = t.statusOffline
    statusEl.className = 'pill'
    $('sp-pause').textContent = t.pause
  }

  const errs = next.recentErrors ?? []
  const nets = next.recentFailedRequests ?? []
  $('err-count').textContent = String(errs.length)
  $('net-count').textContent = String(nets.length)

  $('tab-activity').classList.toggle('active', activeTab === 'activity')
  $('tab-record').classList.toggle('active', activeTab === 'record')
  $('tab-errors').classList.toggle('active', activeTab === 'errors')
  $('tab-network').classList.toggle('active', activeTab === 'network')

  const isRecordTab = activeTab === 'record'
  $('tabs-section').style.display = isRecordTab ? 'none' : ''
  $('feed-section').style.display = isRecordTab ? 'none' : ''
  $('record-section').style.display = isRecordTab ? '' : 'none'

  if (isRecordTab) {
    renderRecordPanel(next)
    return
  }

  const tabsEl = $('sp-tabs')
  tabsEl.innerHTML = ''
  if (next.attachedTabs.length === 0) {
    tabsEl.textContent = t.noTabsShort
  } else {
    for (const tab of next.attachedTabs) {
      const card = document.createElement('div')
      card.className = 'card'
      card.innerHTML = `<div class="entry-head"><span>#${tab.tabId} ${escapeHtml(tab.title || t.untitled)}</span><span class="ok">CDP</span></div><div class="detail">${escapeHtml(tab.url)}</div>`
      tabsEl.appendChild(card)
    }
  }

  const heading = $('feed-heading')
  const feedEl = $('sp-feed')
  feedEl.innerHTML = ''

  if (activeTab === 'activity') {
    heading.textContent = t.activityHeading
    const entries = [...next.recentActivity].reverse()
    if (!entries.length) {
      feedEl.textContent = t.waitingCommands
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
    heading.textContent = t.errorsHeading
    const list = [...errs].reverse()
    if (!list.length) {
      feedEl.textContent = t.noErrors
      return
    }
    for (const item of list) {
      const card = document.createElement('div')
      card.className = 'card'
      card.innerHTML =
        `<div class="entry-head"><span class="error">${escapeHtml(t.tabPrefix)}${item.tabId}</span><span class="time">${fmtTime(item.timestamp)}</span></div>` +
        `<div class="detail">${escapeHtml(item.text)}</div>`
      feedEl.appendChild(card)
    }
  } else {
    heading.textContent = t.networkHeading
    const list = [...nets].reverse()
    if (!list.length) {
      feedEl.textContent = t.noFailedRequests
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
  const s = await safeSendMessage<ExtensionState>({ type: 'browserpilot:get-state' })
  if (s) render(s)
}

$('tab-activity').addEventListener('click', () => {
  activeTab = 'activity'
  if (state) render(state)
})
$('tab-record').addEventListener('click', () => {
  activeTab = 'record'
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

$('rec-toggle').addEventListener('click', () => {
  const active = Boolean(state?.codegen?.active)
  void safeSendMessage({ type: active ? 'browserpilot:codegen-stop' : 'browserpilot:codegen-start' }).then(() =>
    refresh(),
  )
})
$('rec-assert').addEventListener('click', () => {
  void safeSendMessage({ type: 'browserpilot:codegen-assert' }).then(() => refresh())
})
$('rec-clear').addEventListener('click', () => {
  void safeSendMessage({ type: 'browserpilot:codegen-clear' }).then(() => refresh())
})
$('fmt-pw').addEventListener('click', () => {
  codeFormat = 'playwright'
  if (state) render(state)
})
$('fmt-bp').addEventListener('click', () => {
  codeFormat = 'browserpilot'
  if (state) render(state)
})
$('fmt-skill').addEventListener('click', () => {
  codeFormat = 'skill'
  if (state) render(state)
})
$('fmt-batch').addEventListener('click', () => {
  codeFormat = 'batch'
  if (state) render(state)
})
$('rec-copy').addEventListener('click', () => {
  const steps = state?.codegen?.steps ?? []
  if (!steps.length) return
  const code = formatStepsAsCode(steps, codeFormat)
  void navigator.clipboard?.writeText(code)
  const lang = resolveLang(state?.config.language)
  $('rec-copy').textContent = MESSAGES[lang].copied
  setTimeout(() => {
    if (state) $('rec-copy').textContent = MESSAGES[resolveLang(state.config.language)].recordCopy
  }, 1100)
})

$('sp-lang').addEventListener('click', () => {
  const curr = resolveLang(state?.config.language)
  const nextLang: ExtensionLanguage = curr === 'zh' ? 'en' : 'zh'
  void safeSendMessage({
    type: 'browserpilot:update-config',
    patch: { language: nextLang },
  }).then(() => refresh())
})

$('sp-theme').addEventListener('click', () => {
  if (!state) return
  const nextTheme = state.config.theme === 'light' ? 'dark' : 'light'
  document.documentElement.dataset.theme = nextTheme
  void safeSendMessage({
    type: 'browserpilot:update-config',
    patch: { theme: nextTheme },
  }).then(() => refresh())
})
$('sp-pick').addEventListener('click', () => {
  void safeSendMessage({ type: 'browserpilot:start-picker' })
})
$('sp-pause').addEventListener('click', () => {
  if (!state) return
  void safeSendMessage({
    type: 'browserpilot:update-config',
    patch: { paused: !state.config.paused },
  }).then(() => refresh())
})
$('sp-detach-all').addEventListener('click', () => {
  void safeSendMessage({ type: 'browserpilot:detach-all' }).then(() => refresh())
})

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'browserpilot:state-update' && msg.state) {
    render(msg.state as ExtensionState)
  }
})

void refresh()
