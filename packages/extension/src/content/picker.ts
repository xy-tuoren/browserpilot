import { computeStableDomSelector } from '@browserpilot/protocol'
import {
  ensureOverlay,
  getContentLanguage,
  getPickerHoverBox,
  safeSendRuntimeMessage,
  showToast,
} from './overlay.js'

let pickerActive = false
let lastRightClicked: Element | null = null
let pinCounter = 0

function stopPicker(): void {
  pickerActive = false
  const box = getPickerHoverBox()
  if (box) box.style.display = 'none'
  document.removeEventListener('mousemove', onPickerMove, true)
  document.removeEventListener('click', onPickerClick, true)
  document.removeEventListener('keydown', onPickerKey, true)
}

function onPickerMove(e: MouseEvent): void {
  if (!pickerActive) return
  const box = getPickerHoverBox()
  if (!box) return
  const target = document.elementFromPoint(e.clientX, e.clientY)
  if (!target) return
  const r = target.getBoundingClientRect()
  box.style.display = 'block'
  box.style.left = `${r.left}px`
  box.style.top = `${r.top}px`
  box.style.width = `${r.width}px`
  box.style.height = `${r.height}px`
}

function onPickerClick(e: MouseEvent): void {
  if (!pickerActive) return
  e.preventDefault()
  e.stopPropagation()
  const target = document.elementFromPoint(e.clientX, e.clientY)
  stopPicker()
  if (!target) return
  const selector = computeStableDomSelector(target)
  const text = (target.textContent || '').trim().slice(0, 80)
  void navigator.clipboard?.writeText(selector).catch(() => {})
  showToast(getContentLanguage() === 'en' ? `BrowserPilot picked: ${selector}` : `已选取并复制：${selector}`)
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
    showToast(getContentLanguage() === 'en' ? 'Element picker cancelled' : '已取消选取元素')
  }
}

export function startElementPicker(): void {
  ensureOverlay()
  pickerActive = true
  document.addEventListener('mousemove', onPickerMove, true)
  document.addEventListener('click', onPickerClick, true)
  document.addEventListener('keydown', onPickerKey, true)
  showToast(
    getContentLanguage() === 'en'
      ? 'Click any element to inspect with BrowserPilot (Esc to cancel)'
      : '点击页面任意元素即可选取（按 Esc 取消）',
  )
}

export function recordContextMenuTarget(target: EventTarget | null): void {
  lastRightClicked = target && typeof target === 'object' && (target as Node).nodeType === 1 ? (target as Element) : null
}

export function pinLastRightClickedElement(): { ok: boolean; globalVar?: string; selector?: string } {
  if (!lastRightClicked) {
    return { ok: false }
  }
  pinCounter++
  const varName = `__browserpilotPinned${pinCounter}`
  ;(globalThis as Record<string, unknown>)[varName] = lastRightClicked
  const selector = computeStableDomSelector(lastRightClicked)
  void navigator.clipboard?.writeText(selector).catch(() => {})
  showToast(
    getContentLanguage() === 'en'
      ? `Pinned as ${varName} (${selector})`
      : `已固定为 ${varName}（${selector}）`,
  )
  return { ok: true, globalVar: `globalThis.${varName}`, selector }
}
