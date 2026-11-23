/**
 * DevPilot Content Script (Isolated World)
 * Renders all visual feedback (action highlight box, animated ghost cursor,
 * element picker, and toast notifications) inside a closed Shadow Root
 * so it never interferes with page DOM queries or styles.
 */

let lastRightClicked: Element | null = null
let pinCounter = 0

let shadowRoot: ShadowRoot | null = null
let highlightEl: HTMLDivElement | null = null
let highlightLabelEl: HTMLSpanElement | null = null
let highlightTimer: ReturnType<typeof setTimeout> | null = null

let cursorEl: HTMLDivElement | null = null
let cursorIdleTimer: ReturnType<typeof setTimeout> | null = null

let toastEl: HTMLDivElement | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null

let pickerActive = false
let pickerHoverBox: HTMLDivElement | null = null

function ensureOverlay(): ShadowRoot {
  if (shadowRoot) return shadowRoot
  const host = document.createElement('div')
  host.id = '__devpilot_ui_host'
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;'
  shadowRoot = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = `
    .dp-highlight {
      position: fixed;
      pointer-events: none;
      box-sizing: border-box;
      border: 2px solid #10b981;
      background: rgba(16, 185, 129, 0.12);
      border-radius: 5px;
      transition: opacity 220ms ease;
      opacity: 0;
    }
    .dp-highlight-label {
      position: absolute;
      top: -22px;
      left: 0;
      background: #0f172a;
      color: #34d399;
      border: 1px solid rgba(52, 211, 153, 0.45);
      font: 600 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 2px 6px;
      border-radius: 4px;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    }
    .dp-cursor {
      position: fixed;
      width: 18px;
      height: 18px;
      border-radius: 999px;
      border: 2px solid #34d399;
      background: rgba(16, 185, 129, 0.25);
      transform: translate(-50%, -50%) scale(1);
      transition: left 90ms linear, top 90ms linear, opacity 280ms ease, transform 120ms ease;
      pointer-events: none;
      opacity: 0;
      box-shadow: 0 0 12px rgba(16, 185, 129, 0.55);
    }
    .dp-cursor.clicking {
      transform: translate(-50%, -50%) scale(0.7);
      background: rgba(52, 211, 153, 0.65);
    }
    .dp-toast {
      position: fixed;
      bottom: 18px;
      right: 18px;
      background: #0f172a;
      color: #f8fafc;
      border: 1px solid #334155;
      font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
      padding: 8px 12px;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      opacity: 0;
      transition: opacity 200ms ease;
      pointer-events: none;
    }
    .dp-picker-box {
      position: fixed;
      border: 2px dashed #38bdf8;
      background: rgba(56, 189, 248, 0.14);
      border-radius: 4px;
      pointer-events: none;
      display: none;
    }
  `
  shadowRoot.appendChild(style)

  highlightEl = document.createElement('div')
  highlightEl.className = 'dp-highlight'
  highlightLabelEl = document.createElement('span')
  highlightLabelEl.className = 'dp-highlight-label'
  highlightEl.appendChild(highlightLabelEl)
  shadowRoot.appendChild(highlightEl)

  cursorEl = document.createElement('div')
  cursorEl.className = 'dp-cursor'
  shadowRoot.appendChild(cursorEl)

  toastEl = document.createElement('div')
  toastEl.className = 'dp-toast'
  shadowRoot.appendChild(toastEl)

  pickerHoverBox = document.createElement('div')
  pickerHoverBox.className = 'dp-picker-box'
  shadowRoot.appendChild(pickerHoverBox)

  ;(document.documentElement || document.body)?.appendChild(host)
  return shadowRoot
}

function showHighlight(box: { x: number; y: number; width: number; height: number }, label?: string): void {
  ensureOverlay()
  if (!highlightEl || !highlightLabelEl) return
  highlightEl.style.left = `${box.x}px`
  highlightEl.style.top = `${box.y}px`
  highlightEl.style.width = `${box.width}px`
  highlightEl.style.height = `${box.height}px`
  highlightLabelEl.textContent = label || 'DevPilot'
  highlightEl.style.opacity = '1'
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => {
    if (highlightEl) highlightEl.style.opacity = '0'
  }, 950)
}

function moveGhostCursor(x: number, y: number, clicking?: boolean): void {
  ensureOverlay()
  if (!cursorEl) return
  cursorEl.style.left = `${x}px`
  cursorEl.style.top = `${y}px`
  cursorEl.style.opacity = '1'
  cursorEl.classList.toggle('clicking', Boolean(clicking))
  if (cursorIdleTimer) clearTimeout(cursorIdleTimer)
  cursorIdleTimer = setTimeout(() => {
    if (cursorEl) cursorEl.style.opacity = '0'
  }, 4000)
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
  showToast(`DevPilot picked: ${selector}`)
  chrome.runtime.sendMessage({
    type: 'devpilot:picked-element',
    selector,
    tag: target.tagName.toLowerCase(),
    text,
  }).catch(() => {})
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

  if (msg.type === 'devpilot:highlight' && msg.box) {
    showHighlight(msg.box, msg.label)
    sendResponse({ ok: true })
    return false
  }
  if (msg.type === 'devpilot:ghost-cursor') {
    moveGhostCursor(Number(msg.x ?? 0), Number(msg.y ?? 0), Boolean(msg.clicking))
    sendResponse({ ok: true })
    return false
  }
  if (msg.type === 'devpilot:start-picker') {
    ensureOverlay()
    pickerActive = true
    document.addEventListener('mousemove', onPickerMove, true)
    document.addEventListener('click', onPickerClick, true)
    document.addEventListener('keydown', onPickerKey, true)
    showToast('Click any element to inspect with DevPilot (Esc to cancel)')
    sendResponse({ ok: true })
    return false
  }
  if (msg.type === 'devpilot:pin-last-right-clicked') {
    if (!lastRightClicked) {
      sendResponse({ ok: false })
      return false
    }
    pinCounter++
    const varName = `__devpilotPinned${pinCounter}`
    ;(globalThis as Record<string, unknown>)[varName] = lastRightClicked
    const selector = computeStableSelector(lastRightClicked)
    void navigator.clipboard?.writeText(selector).catch(() => {})
    showToast(`Pinned as ${varName} (${selector})`)
    sendResponse({ ok: true, globalVar: `globalThis.${varName}`, selector })
    return false
  }
  return false
})
