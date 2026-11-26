/**
 * Closed Shadow Root visual overlay for BrowserPilot Content Script:
 * - Breathing viewport glow border while AI controls the tab
 * - Interactive floating control capsule (status + Pause/Resume + Stop/Take Over)
 * - Action highlight box, smooth SVG ghost cursor + click ripple, toast, and picker hover box
 */

let hostEl: HTMLDivElement | null = null
let shadowRoot: ShadowRoot | null = null
let borderEl: HTMLDivElement | null = null
let pillEl: HTMLDivElement | null = null
let pillDotEl: HTMLSpanElement | null = null
let pillStatusEl: HTMLSpanElement | null = null
let pillPauseBtn: HTMLButtonElement | null = null
let pillStopBtn: HTMLButtonElement | null = null

let highlightEl: HTMLDivElement | null = null
let highlightLabelEl: HTMLSpanElement | null = null
let highlightTimer: ReturnType<typeof setTimeout> | null = null

let cursorEl: HTMLDivElement | null = null
let cursorIdleTimer: ReturnType<typeof setTimeout> | null = null

let toastEl: HTMLDivElement | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null

let pickerHoverBox: HTMLDivElement | null = null
let currentLanguage: 'zh' | 'en' = 'zh'

export function getContentLanguage(): 'zh' | 'en' {
  return currentLanguage
}

export function setContentLanguage(lang?: string): void {
  currentLanguage = lang === 'en' ? 'en' : 'zh'
}

export function removeOrphanedOverlayHost(): void {
  const existing = document.getElementById('__browserpilot_ui_host')
  if (existing && existing !== hostEl) {
    existing.remove()
  }
}

function localizeBannerStatus(status: string | undefined, isEn: boolean): string {
  const fallback = isEn ? 'Active' : '运行中'
  if (!status) return fallback
  if (isEn) {
    if (status === '运行中') return 'Active'
    if (status === '已暂停') return 'Paused'
    return status
  }
  if (status === 'Active') return '运行中'
  if (status === 'Paused') return '已暂停'
  if (status === 'Waiting for you...') return '等待你操作…'
  if (status.startsWith('Clicking ')) return `正在点击 ${status.slice('Clicking '.length)}`
  if (status.startsWith('Filling ')) return `正在输入 ${status.slice('Filling '.length)}`
  if (status === 'Scrolling down') return '向下滚动'
  if (status === 'Scrolling up') return '向上滚动'
  if (status === 'Scrolling left') return '向左滚动'
  if (status === 'Scrolling right') return '向右滚动'
  if (status.startsWith('Scrolling ')) return `正在滚动 ${status.slice('Scrolling '.length)}`
  return status
}

function localizeHighlightLabel(label: string | undefined, isEn: boolean): string {
  if (!label) return 'BrowserPilot'
  if (isEn) return label
  if (label.startsWith('click ')) return `点击 ${label.slice('click '.length)}`
  if (label.startsWith('fill ')) return `输入 ${label.slice('fill '.length)}`
  if (label.startsWith('hover ')) return `悬停 ${label.slice('hover '.length)}`
  return label
}

export function safeSendRuntimeMessage<T = unknown>(message: unknown): Promise<T | null> {
  try {
    if (!chrome?.runtime?.id) return Promise.resolve(null)
    return Promise.resolve(chrome.runtime.sendMessage(message) as Promise<T>).catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}

export function ensureOverlay(): ShadowRoot {
  if (shadowRoot && hostEl?.isConnected) return shadowRoot
  removeOrphanedOverlayHost()
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
      font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
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
  pillStatusEl.textContent = currentLanguage === 'en' ? 'Active' : '运行中'
  pillPauseBtn = document.createElement('button')
  pillPauseBtn.className = 'bp-pill-btn'
  pillPauseBtn.textContent = currentLanguage === 'en' ? 'Pause' : '暂停'
  pillPauseBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    void safeSendRuntimeMessage({ type: 'browserpilot:toggle-pause' })
  })
  pillStopBtn = document.createElement('button')
  pillStopBtn.className = 'bp-pill-btn stop'
  pillStopBtn.textContent = currentLanguage === 'en' ? 'Take Over' : '接管'
  pillStopBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    void safeSendRuntimeMessage({ type: 'browserpilot:stop-this-tab' })
  })
  pillEl.append(pillDotEl, brand, pillStatusEl, pillPauseBtn, pillStopBtn)
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

export function setOverlayVisible(visible: boolean): void {
  if (hostEl) {
    hostEl.style.visibility = visible ? '' : 'hidden'
  }
}

export function getPickerHoverBox(): HTMLDivElement | null {
  ensureOverlay()
  return pickerHoverBox
}

export function updateControlBanner(opts: {
  active: boolean
  status?: string
  paused?: boolean
  theme?: 'dark' | 'light'
  language?: 'zh' | 'en'
  mode?: 'working' | 'handoff'
}): void {
  if (opts.language) {
    setContentLanguage(opts.language)
  }
  if (!opts.active) {
    removeOrphanedOverlayHost()
    if (borderEl) borderEl.className = 'bp-border'
    if (pillEl) pillEl.classList.remove('visible')
    return
  }
  ensureOverlay()
  if (!borderEl || !pillEl || !pillDotEl || !pillStatusEl || !pillPauseBtn || !pillStopBtn) return

  const isLight = opts.theme === 'light'
  const isEn = (opts.language ?? currentLanguage) === 'en'
  pillEl.classList.toggle('light', isLight)

  if (opts.mode === 'handoff') {
    borderEl.className = 'bp-border handoff'
    pillEl.classList.remove('visible')
    return
  }

  borderEl.className = opts.paused ? 'bp-border paused' : 'bp-border active'
  pillDotEl.className = opts.paused ? 'bp-pill-dot paused' : 'bp-pill-dot'
  pillPauseBtn.textContent = opts.paused ? (isEn ? 'Resume' : '恢复') : isEn ? 'Pause' : '暂停'
  pillStopBtn.textContent = isEn ? 'Take Over' : '接管'
  const defaultPaused = isEn ? 'Paused' : '已暂停'
  if (opts.paused) {
    pillStatusEl.textContent = defaultPaused
  } else {
    pillStatusEl.textContent = localizeBannerStatus(opts.status, isEn)
  }
  pillEl.classList.add('visible')
}

export function showHighlight(box: { x: number; y: number; width: number; height: number }, label?: string): void {
  ensureOverlay()
  if (!highlightEl || !highlightLabelEl) return
  highlightEl.style.left = `${box.x}px`
  highlightEl.style.top = `${box.y}px`
  highlightEl.style.width = `${box.width}px`
  highlightEl.style.height = `${box.height}px`
  highlightLabelEl.textContent = localizeHighlightLabel(label, currentLanguage === 'en')
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

export function moveGhostCursor(x: number, y: number, clicking?: boolean): void {
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

export function showToast(text: string): void {
  ensureOverlay()
  if (!toastEl) return
  toastEl.textContent = text
  toastEl.style.opacity = '1'
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    if (toastEl) toastEl.style.opacity = '0'
  }, 2400)
}
