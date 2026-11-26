import { computeStableDomSelector } from '@browserpilot/protocol'
import { safeSendRuntimeMessage, showToast } from './overlay.js'

let codegenActive = false
let codegenAssertMode = false
let codegenBound = false
const pendingCodegenInputs = new Map<Element, ReturnType<typeof setTimeout>>()
const lastCodegenEmittedValue = new WeakMap<Element, string>()

function isElementNode(raw: unknown): raw is Element {
  return Boolean(raw && typeof raw === 'object' && (raw as Node).nodeType === 1)
}

function resolveInteractiveTarget(raw: EventTarget | null): Element | null {
  if (!isElementNode(raw)) return null
  if (raw.closest('#__browserpilot_ui_host')) return null
  return (
    raw.closest(
      'button, a, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [contenteditable="true"], label',
    ) || raw
  )
}

function emitCodegenStep(step: Record<string, unknown>): void {
  void safeSendRuntimeMessage({
    type: 'browserpilot:recorded-step',
    step: { timestamp: Date.now(), url: location.href, ...step },
  })
}

function recordCodegenInputNow(el: Element): void {
  const tag = el.tagName.toLowerCase()
  const sel = computeStableDomSelector(el)
  if (tag === 'select') {
    const v = (el as HTMLSelectElement).value
    if (lastCodegenEmittedValue.get(el) === v) return
    lastCodegenEmittedValue.set(el, v)
    emitCodegenStep({ action: 'select_option', target: sel, value: v })
    return
  }
  if (tag === 'input' && ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio')) {
    return
  }
  const isPwd = tag === 'input' && (el as HTMLInputElement).type === 'password'
  const val = (el as HTMLElement).isContentEditable
    ? (el as HTMLElement).innerText || ''
    : (el as HTMLInputElement).value || ''
  const masked = isPwd ? '<REDACTED_PASSWORD>' : val
  if (lastCodegenEmittedValue.get(el) === masked) return
  lastCodegenEmittedValue.set(el, masked)
  emitCodegenStep({ action: 'fill', target: sel, value: masked })
}

export function flushCodegenInputs(): void {
  for (const [el, timer] of pendingCodegenInputs.entries()) {
    clearTimeout(timer)
    pendingCodegenInputs.delete(el)
    recordCodegenInputNow(el)
  }
}

function bindDocumentListeners(doc: Document): void {
  const flagged = doc as Document & { __bpCodegenDocBound?: boolean }
  if (flagged.__bpCodegenDocBound) return
  flagged.__bpCodegenDocBound = true

  doc.addEventListener(
    'click',
    (e) => {
      if (!codegenActive) return
      const raw = e.composedPath?.()[0] ?? e.target
      const el = resolveInteractiveTarget(raw)
      if (!el) return
      flushCodegenInputs()

      if ((e.altKey && e.shiftKey) || codegenAssertMode) {
        e.preventDefault()
        e.stopPropagation()
        codegenAssertMode = false
        const sel = computeStableDomSelector(el)
        const tag = el.tagName.toLowerCase()
        if ((tag === 'input' || tag === 'textarea' || tag === 'select') && typeof (el as HTMLInputElement).value === 'string') {
          emitCodegenStep({ action: 'assert_value', target: sel, value: (el as HTMLInputElement).value })
        } else {
          const txt = ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
          if (txt) emitCodegenStep({ action: 'assert_text', target: sel, value: txt, text: txt })
          else emitCodegenStep({ action: 'assert_visible', target: sel })
        }
        showToast(`BrowserPilot: + assert ${sel}`)
        return
      }

      const tag = el.tagName.toLowerCase()
      const role = (el.getAttribute('role') || '').toLowerCase()
      const sel = computeStableDomSelector(el)
      if ((tag === 'input' && (el as HTMLInputElement).type === 'checkbox') || role === 'checkbox' || role === 'switch') {
        const checked = tag === 'input' ? Boolean((el as HTMLInputElement).checked) : el.getAttribute('aria-checked') !== 'true'
        emitCodegenStep({ action: checked ? 'check' : 'uncheck', target: sel })
        return
      }
      const txt = ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) || undefined
      emitCodegenStep({
        action: 'click',
        target: sel,
        text: txt,
        coordinates: { x: Math.round(e.clientX), y: Math.round(e.clientY) },
      })
    },
    true,
  )

  doc.addEventListener(
    'dblclick',
    (e) => {
      if (!codegenActive) return
      const el = resolveInteractiveTarget(e.composedPath?.()[0] ?? e.target)
      if (!el) return
      flushCodegenInputs()
      emitCodegenStep({ action: 'dblclick', target: computeStableDomSelector(el) })
    },
    true,
  )

  doc.addEventListener(
    'input',
    (e) => {
      if (!codegenActive) return
      const raw = e.composedPath?.()[0] ?? e.target
      if (!isElementNode(raw) || raw.closest('#__browserpilot_ui_host')) return
      const prev = pendingCodegenInputs.get(raw)
      if (prev) clearTimeout(prev)
      pendingCodegenInputs.set(
        raw,
        setTimeout(() => {
          pendingCodegenInputs.delete(raw)
          recordCodegenInputNow(raw)
        }, 300),
      )
    },
    true,
  )

  doc.addEventListener(
    'change',
    (e) => {
      if (!codegenActive) return
      const raw = e.composedPath?.()[0] ?? e.target
      if (!isElementNode(raw) || raw.closest('#__browserpilot_ui_host')) return
      const prev = pendingCodegenInputs.get(raw)
      if (prev) {
        clearTimeout(prev)
        pendingCodegenInputs.delete(raw)
      }
      recordCodegenInputNow(raw)
    },
    true,
  )

  doc.addEventListener(
    'keydown',
    (e) => {
      if (!codegenActive) return
      if (e.key === 'Enter' || e.key === 'Escape') {
        flushCodegenInputs()
        emitCodegenStep({ action: 'press_key', key: e.key })
      }
    },
    true,
  )
}

function ensureCodegenListeners(): void {
  if (codegenBound) return
  codegenBound = true
  bindDocumentListeners(document)

  const bindSameOriginIframes = () => {
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) bindDocumentListeners(frame.contentDocument)
        const hooked = frame as HTMLIFrameElement & { __bpCodegenLoadHooked?: boolean }
        if (!hooked.__bpCodegenLoadHooked) {
          hooked.__bpCodegenLoadHooked = true
          frame.addEventListener('load', () => {
            try {
              if (frame.contentDocument) bindDocumentListeners(frame.contentDocument)
            } catch {}
          })
        }
      } catch {}
    }
  }

  bindSameOriginIframes()
  if (document.documentElement) {
    const mo = new MutationObserver(() => {
      if (codegenActive) bindSameOriginIframes()
    })
    mo.observe(document.documentElement, { childList: true, subtree: true })
  }
}

export function setSidePanelCodegenState(active: boolean, assertMode = false): void {
  if (!active) flushCodegenInputs()
  codegenActive = active
  codegenAssertMode = assertMode
  if (codegenActive) ensureCodegenListeners()
}
