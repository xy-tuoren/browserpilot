/**
 * BrowserPilot Content Script (Isolated World)
 * Renders all visual feedback inside a closed Shadow Root (never pollutes page DOM/CSS):
 * - Breathing fresh cyan-mint viewport glow border while AI controls this tab
 * - Floating interactive control capsule (live action text + Pause/Resume + Stop/Take Over)
 * - Action highlight box, smooth SVG pointer ghost cursor + click ripple animation
 * - Element picker, right-click Pin, and toast notifications
 */

let lastRightClicked: Element | null = null
let pinCounter = 0

let hostEl: HTMLDivElement | null = null
let shadowRoot: ShadowRoot | null = null
let borderEl: HTMLDivElement | null = null
let pillEl: HTMLDivElement | null = null
let pillDotEl: HTMLSpanElement | null = null
let pillStatusEl: HTMLSpanElement | null = null
let pillPauseBtn: HTMLButtonElement | null = null

let highlightEl: HTMLDivElement | null = null
let highlightLabelEl: HTMLSpanElement | null = null
let highlightTimer: ReturnType<typeof setTimeout> | null = null

let cursorEl: HTMLDivElement | null = null
let cursorIdleTimer: ReturnType<typeof setTimeout> | null = null

let toastEl: HTMLDivElement | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null

let pickerActive = false
let pickerHoverBox: HTMLDivElement | null = null

function safeSendRuntimeMessage<T = unknown>(message: unknown): Promise<T | null> {
  try {
    if (!chrome?.runtime?.id) return Promise.resolve(null)
    return Promise.resolve(chrome.runtime.sendMessage(message) as Promise<T>).catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}

function ensureOverlay(): ShadowRoot {
  if (shadowRoot && hostEl?.isConnected) return shadowRoot
  hostEl?.remove()
  hostEl = document.createElement('div')
  hostEl.id = '__browserpilot_ui_host'
  hostEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;'
  shadowRoot = hostEl.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = `
    @keyframes bp-breathe {
      0%, 100% {
        box-shadow: inset 0 0 0 2.5px rgba(45, 212, 191, 0.72), inset 0 0 22px rgba(6, 182, 212, 0.16);
      }
      50% {
        box-shadow: inset 0 0 0 3px rgba(56, 189, 248, 0.92), inset 0 0 32px rgba(45, 212, 191, 0.24);
      }
    }
    @keyframes bp-pulse-dot {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.25); opacity: 0.72; }
    }
    @keyframes bp-ripple {
      0% { transform: translate(-50%, -50%) scale(0.35); opacity: 0.9; }
      100% { transform: translate(-50%, -50%) scale(2.4); opacity: 0; }
    }
    .bp-border {
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0;
      transition: opacity 220ms ease;
    }
    .bp-border.active {
      opacity: 1;
      animation: bp-breathe 2.6s ease-in-out infinite;
    }
    .bp-border.paused {
      opacity: 1;
      animation: none;
      box-shadow: inset 0 0 0 2.5px rgba(245, 158, 11, 0.72), inset 0 0 20px rgba(245, 158, 11, 0.16);
    }
    .bp-border.handoff {
      opacity: 0;
    }

    .bp-pill {
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translate(-50%, 14px);
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 6px 10px 6px 12px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.88);
      color: #f8fafc;
      border: 1px solid rgba(45, 212, 191, 0.42);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 10px 28px rgba(2, 6, 23, 0.34), 0 0 0 1px rgba(56, 189, 248, 0.14);
      font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: none;
      opacity: 0;
      transition: opacity 180ms ease, transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
      max-width: min(520px, calc(100vw - 32px));
    }
    .bp-pill.visible {
      opacity: 1;
      pointer-events: auto;
      transform: translate(-50%, 0);
    }
    .bp-pill.light {
      background: rgba(255, 255, 255, 0.92);
      color: #0f172a;
      border-color: rgba(6, 182, 212, 0.45);
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
    }
    .bp-pill-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      flex: none;
      background: #2dd4bf;
      box-shadow: 0 0 8px rgba(45, 212, 191, 0.85);
      animation: bp-pulse-dot 1.8s ease-in-out infinite;
    }
    .bp-pill-dot.paused {
      background: #f59e0b;
      box-shadow: 0 0 8px rgba(245, 158, 11, 0.8);
      animation: none;
    }
    .bp-pill-brand {
      font-weight: 700;
      font-size: 11px;
      letter-spacing: 0.02em;
      background: linear-gradient(135deg, #2dd4bf, #38bdf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      flex: none;
    }
    .bp-pill.light .bp-pill-brand {
      background: linear-gradient(135deg, #0d9488, #0284c7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .bp-pill-status {
      color: #cbd5e1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 240px;
    }
    .bp-pill.light .bp-pill-status {
      color: #334155;
    }
    .bp-pill-btn {
      cursor: pointer;
      border: 1px solid rgba(148, 163, 184, 0.28);
      background: rgba(148, 163, 184, 0.14);
      color: inherit;
      border-radius: 999px;
      padding: 4px 9px;
      font: 600 11px/1 -apple-system, BlinkMacSystemFont, sans-serif;
      transition: background 120ms ease, border-color 120ms ease;
      flex: none;
    }
    .bp-pill-btn:hover {
      background: rgba(45, 212, 191, 0.22);
      border-color: rgba(45, 212, 191, 0.55);
    }
    .bp-pill-btn.stop:hover {
      background: rgba(244, 63, 94, 0.22);
      border-color: rgba(244, 63, 94, 0.6);
      color: #fda4af;
    }
    .bp-pill.light .bp-pill-btn.stop:hover {
      color: #be123c;
    }

    .dp-highlight {
      position: fixed;
      pointer-events: none;
      box-sizing: border-box;
      border: 2px solid #06b6d4;
      background: rgba(45, 212, 191, 0.14);
      border-radius: 6px;
      transition: opacity 220ms ease, left 90ms ease, top 90ms ease, width 90ms ease, height 90ms ease;
      opacity: 0;
      box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.28);
    }
    .dp-highlight-label {
      position: absolute;
      top: -22px;
      left: 0;
      background: rgba(15, 23, 42, 0.92);
      color: #5eead4;
      border: 1px solid rgba(45, 212, 191, 0.5);
      font: 600 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 2px 6px;
      border-radius: 5px;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .dp-cursor {
      position: fixed;
      width: 24px;
      height: 24px;
      transform: translate(-3px, -2px) scale(1);
      transition: left 60ms linear, top 60ms linear, opacity 240ms ease, transform 100ms ease;
      pointer-events: none;
      opacity: 0;
      filter: drop-shadow(0 2px 6px rgba(6, 182, 212, 0.55));
    }
    .dp-cursor.clicking {
      transform: translate(-3px, -2px) scale(0.84);
    }
    .dp-ripple {
      position: fixed;
      width: 22px;
      height: 22px;
      border-radius: 999px;
      border: 2px solid #2dd4bf;
      background: rgba(6, 182, 212, 0.2);
      pointer-events: none;
      animation: bp-ripple 420ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    .dp-toast {
      position: fixed;
      bottom: 62px;
      right: 18px;
      background: rgba(15, 23, 42, 0.92);
      color: #f8fafc;
      border: 1px solid rgba(45, 212, 191, 0.38);
      font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
      padding: 8px 12px;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
      opacity: 0;
      transition: opacity 200ms ease;
      pointer-events: none;
    }
    .dp-picker-box {
      position: fixed;
      border: 2px dashed #06b6d4;
      background: rgba(6, 182, 212, 0.14);
      border-radius: 5px;
      pointer-events: none;
      display: none;
    }
  `
  shadowRoot.appendChild(style)

  borderEl = document.createElement('div')
  borderEl.className = 'bp-border'
  shadowRoot.appendChild(borderEl)

  pillEl = document.createElement('div')
  pillEl.className = 'bp-pill'
  pillDotEl = document.createElement('span')
  pillDotEl.className = 'bp-pill-dot'
  const brand = document.createElement('span')
  brand.className = 'bp-pill-brand'
  brand.textContent = '>_ BrowserPilot'
  pillStatusEl = document.createElement('span')
  pillStatusEl.className = 'bp-pill-status'
  pillStatusEl.textContent = 'Active'
  pillPauseBtn = document.createElement('button')
  pillPauseBtn.className = 'bp-pill-btn'
  pillPauseBtn.textContent = 'Pause'
  pillPauseBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    void safeSendRuntimeMessage({ type: 'browserpilot:toggle-pause' })
  })
  const stopBtn = document.createElement('button')
  stopBtn.className = 'bp-pill-btn stop'
  stopBtn.textContent = 'Take Over'
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    void safeSendRuntimeMessage({ type: 'browserpilot:stop-this-tab' })
  })
  pillEl.append(pillDotEl, brand, pillStatusEl, pillPauseBtn, stopBtn)
  shadowRoot.appendChild(pillEl)

  highlightEl = document.createElement('div')
  highlightEl.className = 'dp-highlight'
  highlightLabelEl = document.createElement('span')
  highlightLabelEl.className = 'dp-highlight-label'
  highlightEl.appendChild(highlightLabelEl)
  shadowRoot.appendChild(highlightEl)

  cursorEl = document.createElement('div')
  cursorEl.className = 'dp-cursor'
  cursorEl.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.5 3.5L19.5 11.2L12.6 13.1L9.8 19.8L4.5 3.5Z" fill="#06b6d4" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/></svg>`
  shadowRoot.appendChild(cursorEl)

  toastEl = document.createElement('div')
  toastEl.className = 'dp-toast'
  shadowRoot.appendChild(toastEl)

  pickerHoverBox = document.createElement('div')
  pickerHoverBox.className = 'dp-picker-box'
  shadowRoot.appendChild(pickerHoverBox)

  ;(document.documentElement || document.body)?.appendChild(hostEl)
  return shadowRoot
}

function updateControlBanner(opts: {
  active: boolean
  status?: string
  paused?: boolean
  theme?: 'dark' | 'light'
  mode?: 'working' | 'handoff'
}): void {
  if (!opts.active) {
    if (borderEl) borderEl.className = 'bp-border'
    if (pillEl) pillEl.classList.remove('visible')
    return
  }
  ensureOverlay()
  if (!borderEl || !pillEl || !pillDotEl || !pillStatusEl || !pillPauseBtn) return

  const isLight = opts.theme === 'light'
  pillEl.classList.toggle('light', isLight)

  if (opts.mode === 'handoff') {
    borderEl.className = 'bp-border handoff'
    pillEl.classList.remove('visible')
    return
  }

  borderEl.className = opts.paused ? 'bp-border paused' : 'bp-border active'
  pillDotEl.className = opts.paused ? 'bp-pill-dot paused' : 'bp-pill-dot'
  pillPauseBtn.textContent = opts.paused ? 'Resume' : 'Pause'
  if (opts.status !== undefined) {
    pillStatusEl.textContent = opts.paused ? 'Paused' : opts.status || 'Active'
  } else if (opts.paused) {
    pillStatusEl.textContent = 'Paused'
  }
  pillEl.classList.add('visible')
}

function showHighlight(box: { x: number; y: number; width: number; height: number }, label?: string): void {
  ensureOverlay()
  if (!highlightEl || !highlightLabelEl) return
  highlightEl.style.left = `${box.x}px`
  highlightEl.style.top = `${box.y}px`
  highlightEl.style.width = `${box.width}px`
  highlightEl.style.height = `${box.height}px`
  highlightLabelEl.textContent = label || 'BrowserPilot'
  highlightEl.style.opacity = '1'
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => {
    if (highlightEl) highlightEl.style.opacity = '0'
  }, 950)
}

function spawnClickRipple(x: number, y: number): void {
  const root = ensureOverlay()
  const ripple = document.createElement('div')
  ripple.className = 'dp-ripple'
  ripple.style.left = `${x}px`
  ripple.style.top = `${y}px`
  root.appendChild(ripple)
  setTimeout(() => ripple.remove(), 450)
}

function moveGhostCursor(x: number, y: number, clicking?: boolean): void {
  ensureOverlay()
  if (!cursorEl) return
  cursorEl.style.left = `${x}px`
  cursorEl.style.top = `${y}px`
  cursorEl.style.opacity = '1'
  cursorEl.classList.toggle('clicking', Boolean(clicking))
  if (clicking) spawnClickRipple(x, y)
  if (cursorIdleTimer) clearTimeout(cursorIdleTimer)
  cursorIdleTimer = setTimeout(() => {
    if (cursorEl) cursorEl.style.opacity = '0'
  }, 3500)
}

function showToast(text: string): void {
  ensureOverlay()
  if (!toastEl) return
  toastEl.textContent = text
  toastEl.style.opacity = '1'
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    if (toastEl) toastEl.style.opacity = '0'
  }, 2400)
}

function computeStableSelector(el: Element): string {
  const testId = el.getAttribute('data-testid')
  if (testId) return `[data-testid="${testId}"]`
  if (el.id) return `#${CSS.escape(el.id)}`
  const tag = el.tagName.toLowerCase()
  const name = el.getAttribute('name')
  if (name) return `${tag}[name="${name}"]`
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) return `${tag}[aria-label="${ariaLabel}"]`
  const classes = Array.from(el.classList).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('')
  return `${tag}${classes}`
}

function stopPicker(): void {
  pickerActive = false
  if (pickerHoverBox) pickerHoverBox.style.display = 'none'
  document.removeEventListener('mousemove', onPickerMove, true)
  document.removeEventListener('click', onPickerClick, true)
  document.removeEventListener('keydown', onPickerKey, true)
}

function onPickerMove(e: MouseEvent): void {
  if (!pickerActive || !pickerHoverBox) return
  const target = document.elementFromPoint(e.clientX, e.clientY)
  if (!target) return
  const r = target.getBoundingClientRect()
  pickerHoverBox.style.display = 'block'
  pickerHoverBox.style.left = `${r.left}px`
  pickerHoverBox.style.top = `${r.top}px`
  pickerHoverBox.style.width = `${r.width}px`
  pickerHoverBox.style.height = `${r.height}px`
}

function onPickerClick(e: MouseEvent): void {
  if (!pickerActive) return
  e.preventDefault()
  e.stopPropagation()
  const target = document.elementFromPoint(e.clientX, e.clientY)
  stopPicker()
  if (!target) return
  const selector = computeStableSelector(target)
  const text = (target.textContent || '').trim().slice(0, 80)
  void navigator.clipboard?.writeText(selector).catch(() => {})
  showToast(`BrowserPilot picked: ${selector}`)
  void safeSendRuntimeMessage({
    type: 'browserpilot:picked-element',
    selector,
    tag: target.tagName.toLowerCase(),
    text,
  })
}

function onPickerKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    stopPicker()
    showToast('Element picker cancelled')
  }
}

document.addEventListener(
  'contextmenu',
  (e) => {
    lastRightClicked = e.target instanceof Element ? e.target : null
  },
  true,
)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false

  if (msg.type === 'browserpilot:control-banner') {
    updateControlBanner(msg)
    sendResponse({ ok: true })
    return false
  }
  if (msg.type === 'browserpilot:set-overlay-visible') {
    if (hostEl) {
      hostEl.style.visibility = msg.visible ? '' : 'hidden'
    }
    sendResponse({ ok: true })
    return false
  }
  if (msg.type === 'browserpilot:highlight' && msg.box) {
    showHighlight(msg.box, msg.label)
    sendResponse({ ok: true })
    return false
  }
  if (msg.type === 'browserpilot:ghost-cursor') {
    moveGhostCursor(Number(msg.x ?? 0), Number(msg.y ?? 0), Boolean(msg.clicking))
    sendResponse({ ok: true })
    return false
  }
  if (msg.type === 'browserpilot:start-picker') {
    ensureOverlay()
    pickerActive = true
    document.addEventListener('mousemove', onPickerMove, true)
    document.addEventListener('click', onPickerClick, true)
    document.addEventListener('keydown', onPickerKey, true)
    showToast('Click any element to inspect with BrowserPilot (Esc to cancel)')
    sendResponse({ ok: true })
    return false
  }
  if (msg.type === 'browserpilot:pin-last-right-clicked') {
    if (!lastRightClicked) {
      sendResponse({ ok: false })
      return false
    }
    pinCounter++
    const varName = `__browserpilotPinned${pinCounter}`
    ;(globalThis as Record<string, unknown>)[varName] = lastRightClicked
    const selector = computeStableSelector(lastRightClicked)
    void navigator.clipboard?.writeText(selector).catch(() => {})
    showToast(`Pinned as ${varName} (${selector})`)
    sendResponse({ ok: true, globalVar: `globalThis.${varName}`, selector })
    return false
  }
  return false
})

// Re-sync in-page control banner after navigation inside an attached tab
void safeSendRuntimeMessage<{ active?: boolean; status?: string; paused?: boolean; theme?: 'dark' | 'light' }>({
  type: 'browserpilot:get-tab-banner',
}).then((res) => {
  if (res && typeof res === 'object' && res.active) {
    updateControlBanner({ ...res, active: true })
  }
})
