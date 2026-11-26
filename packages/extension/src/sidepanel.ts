import {
  formatStepsAsCode,
  type ApprovalMode,
  type CodegenFormat,
  type ExtensionLanguage,
  type ExtensionState,
} from '@browserpilot/protocol'
import { MESSAGES, resolveLang } from './i18n.js'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
let state: ExtensionState | null = null
let activeTab: 'activity' | 'record' | 'security' | 'errors' | 'network' = 'activity'
let codeFormat: CodegenFormat = 'playwright'

function downloadFlowJson(name: string, steps: Array<Record<string, unknown>>): void {
  const payload = JSON.stringify({ name, steps }, null, 2) + '\n'
  const blob = new Blob([payload], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `browserpilot-flow-${Date.now()}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

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
  $('rec-export').textContent = t.exportFlow
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

function renderDomainChips(
  containerId: string,
  domains: string[],
  kind: 'blocked' | 'allowed' | 'trusted',
  emptyText: string,
): void {
  const box = $(containerId)
  box.innerHTML = ''
  if (!domains.length) {
    box.innerHTML = `<span class="muted">${escapeHtml(emptyText)}</span>`
    return
  }
  for (const domain of domains) {
    const chip = document.createElement('span')
    chip.className = `chip ${kind === 'trusted' ? 'allowed' : kind}`
    chip.innerHTML = `${escapeHtml(domain)}<button data-remove="${escapeHtml(domain)}" title="Remove">×</button>`
    box.appendChild(chip)
  }
  box.querySelectorAll<HTMLButtonElement>('button[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state) return
      const target = btn.dataset.remove
      const current = state.config.domainRules
      const nextRules =
        kind === 'blocked'
          ? { ...current, blockedDomains: current.blockedDomains.filter((d) => d !== target) }
          : kind === 'trusted'
            ? { ...current, trustedDomains: (current.trustedDomains ?? []).filter((d) => d !== target) }
            : { ...current, allowedDomains: current.allowedDomains.filter((d) => d !== target) }
      void safeSendMessage({ type: 'browserpilot:update-config', patch: { domainRules: nextRules } }).then(() =>
        refresh(),
      )
    })
  })
}

function renderSecurityPanel(next: ExtensionState): void {
  const lang = resolveLang(next.config.language)
  const t = MESSAGES[lang]
  const mode: ApprovalMode = next.config.approvalMode ?? 'off'

  $('sec-approval-heading').textContent = t.securityApprovalHeading
  $('appr-off').textContent = t.approvalOff
  $('appr-high').textContent = t.approvalHighRisk
  $('appr-strict').textContent = t.approvalStrict
  $('appr-off').classList.toggle('active-pill', mode === 'off')
  $('appr-high').classList.toggle('active-pill', mode === 'high-risk')
  $('appr-strict').classList.toggle('active-pill', mode === 'strict')
  $('sec-approval-desc').textContent =
    mode === 'strict' ? t.approvalDescStrict : mode === 'high-risk' ? t.approvalDescHighRisk : t.approvalDescOff

  $('sec-profile-heading').textContent = t.profileLabelHeading
  const profInput = $<HTMLInputElement>('sec-profile-input')
  profInput.placeholder = t.profileLabelPlaceholder
  if (document.activeElement !== profInput) {
    profInput.value = next.config.profileLabel ?? ''
  }
  $('sec-profile-save').textContent = t.save

  $('sec-blocked-heading').textContent = t.blockedHeading
  $('sec-allowed-heading').textContent = t.allowedHeading
  $('sec-trusted-heading').textContent = t.trustedHeading
  $('sec-trusted-hint').textContent = t.trustedHint
  $<HTMLInputElement>('sec-blocked-input').placeholder = t.domainInputPlaceholder
  $<HTMLInputElement>('sec-allowed-input').placeholder = t.domainInputPlaceholder
  $('sec-blocked-add').textContent = t.addDomain
  $('sec-allowed-add').textContent = t.addDomain
  $('sec-block-current').textContent = t.blockCurrentSite
  $('sec-allowed-hint').textContent = t.allowedDomainsHint

  renderDomainChips('sec-blocked-chips', next.config.domainRules.blockedDomains, 'blocked', t.noDomainsConfigured)
  renderDomainChips('sec-allowed-chips', next.config.domainRules.allowedDomains, 'allowed', t.noDomainsConfigured)
  renderDomainChips('sec-trusted-chips', next.config.domainRules.trustedDomains ?? [], 'trusted', t.noDomainsConfigured)
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
  $('tab-security').textContent =
    (next.config.approvalMode && next.config.approvalMode !== 'off') ||
    next.config.domainRules.blockedDomains.length > 0 ||
    next.config.domainRules.allowedDomains.length > 0
      ? `● ${t.tabSecurity}`
      : t.tabSecurity
  $('lbl-tab-errors').textContent = t.tabErrors
  $('lbl-tab-network').textContent = t.tabNetwork
  $('tabs-heading').textContent = t.activeTabsHeading
  $('sp-organize-tabs').textContent = t.organizeTabs
  $('act-export').textContent = t.exportFlow
  $('act-clear').textContent = t.clearActivity

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
  $('tab-security').classList.toggle('active', activeTab === 'security')
  $('tab-errors').classList.toggle('active', activeTab === 'errors')
  $('tab-network').classList.toggle('active', activeTab === 'network')

  const isRecordTab = activeTab === 'record'
  const isSecurityTab = activeTab === 'security'
  $('tabs-section').style.display = isRecordTab || isSecurityTab ? 'none' : ''
  $('feed-section').style.display = isRecordTab || isSecurityTab ? 'none' : ''
  $('record-section').style.display = isRecordTab ? '' : 'none'
  $('security-section').style.display = isSecurityTab ? '' : 'none'
  $('activity-actions').style.display = activeTab === 'activity' ? 'flex' : 'none'

  if (isRecordTab) {
    renderRecordPanel(next)
    return
  }
  if (isSecurityTab) {
    renderSecurityPanel(next)
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
$('tab-security').addEventListener('click', () => {
  activeTab = 'security'
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

$('rec-export').addEventListener('click', () => {
  const steps = state?.codegen?.steps ?? []
  const lang = resolveLang(state?.config.language)
  if (!steps.length) {
    $('rec-export').textContent = MESSAGES[lang].noExportableSteps
    setTimeout(() => {
      if (state) $('rec-export').textContent = MESSAGES[resolveLang(state.config.language)].exportFlow
    }, 1200)
    return
  }
  const replaySteps = steps.map((s) => ({
    action: s.action,
    ...(s.action === 'navigate' ? { url: s.url } : {}),
    ...(s.target ? { target: s.target } : {}),
    ...(s.value !== undefined ? { value: s.value } : {}),
    ...(s.key ? { key: s.key } : {}),
  }))
  downloadFlowJson('BrowserPilot Recorded Workflow', replaySteps)
  $('rec-export').textContent = MESSAGES[lang].exported
  setTimeout(() => {
    if (state) $('rec-export').textContent = MESSAGES[resolveLang(state.config.language)].exportFlow
  }, 1200)
})

$('act-clear').addEventListener('click', () => {
  void safeSendMessage({ type: 'browserpilot:clear-activity' }).then(() => refresh())
})

$('act-export').addEventListener('click', () => {
  const lang = resolveLang(state?.config.language)
  const steps = (state?.recentActivity ?? [])
    .filter((entry) => entry.status === 'ok' && entry.step && typeof entry.step === 'object')
    .map((entry) => entry.step as Record<string, unknown>)
  if (!steps.length) {
    $('act-export').textContent = MESSAGES[lang].noExportableSteps
    setTimeout(() => {
      if (state) $('act-export').textContent = MESSAGES[resolveLang(state.config.language)].exportFlow
    }, 1200)
    return
  }
  downloadFlowJson('BrowserPilot AI Session Flow', steps)
  $('act-export').textContent = MESSAGES[lang].exported
  setTimeout(() => {
    if (state) $('act-export').textContent = MESSAGES[resolveLang(state.config.language)].exportFlow
  }, 1200)
})

function setApprovalMode(mode: ApprovalMode): void {
  void safeSendMessage({ type: 'browserpilot:update-config', patch: { approvalMode: mode } }).then(() => refresh())
}
$('appr-off').addEventListener('click', () => setApprovalMode('off'))
$('appr-high').addEventListener('click', () => setApprovalMode('high-risk'))
$('appr-strict').addEventListener('click', () => setApprovalMode('strict'))

$('sec-profile-save').addEventListener('click', () => {
  const val = $<HTMLInputElement>('sec-profile-input').value.trim()
  const lang = resolveLang(state?.config.language)
  void safeSendMessage({ type: 'browserpilot:update-config', patch: { profileLabel: val } }).then(() => {
    $('sec-profile-save').textContent = MESSAGES[lang].saved
    setTimeout(() => {
      if (state) $('sec-profile-save').textContent = MESSAGES[resolveLang(state.config.language)].save
    }, 1000)
    void refresh()
  })
})

function addDomainRule(kind: 'blocked' | 'allowed', rawInput: string): void {
  if (!state) return
  const normalized = rawInput.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]
  if (!normalized) return
  const rules = state.config.domainRules
  const list = kind === 'blocked' ? rules.blockedDomains : rules.allowedDomains
  if (list.includes(normalized)) return
  const nextRules =
    kind === 'blocked'
      ? { ...rules, blockedDomains: [...rules.blockedDomains, normalized] }
      : { ...rules, allowedDomains: [...rules.allowedDomains, normalized] }
  void safeSendMessage({ type: 'browserpilot:update-config', patch: { domainRules: nextRules } }).then(() => refresh())
}

$('sec-blocked-add').addEventListener('click', () => {
  const inp = $<HTMLInputElement>('sec-blocked-input')
  addDomainRule('blocked', inp.value)
  inp.value = ''
})
$('sec-allowed-add').addEventListener('click', () => {
  const inp = $<HTMLInputElement>('sec-allowed-input')
  addDomainRule('allowed', inp.value)
  inp.value = ''
})
$('sec-block-current').addEventListener('click', () => {
  void safeSendMessage<{ hostname?: string | null }>({ type: 'browserpilot:get-active-domain' }).then((res) => {
    if (res?.hostname) addDomainRule('blocked', res.hostname)
  })
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
$('sp-organize-tabs').addEventListener('click', () => {
  const lang = resolveLang(state?.config.language)
  void safeSendMessage({ type: 'browserpilot:organize-tabs', strategy: 'domain' }).then(() => {
    $('sp-organize-tabs').textContent = MESSAGES[lang].organizedTabs
    setTimeout(() => {
      if (state) $('sp-organize-tabs').textContent = MESSAGES[resolveLang(state.config.language)].organizeTabs
    }, 1200)
    void refresh()
  })
})

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'browserpilot:state-update' && msg.state) {
    render(msg.state as ExtensionState)
  }
})

void refresh()
